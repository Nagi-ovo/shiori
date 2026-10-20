// Tests that drive a real PTY: a /bin/sh session stands in for the user's
// shell, so what they check is what the kernel tty actually does.

use super::{TerminalDimensions, TerminalSession, TerminalState};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty};
use std::{
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const SESSION_ID: &str = "pty-test";

// Spawns `/bin/sh -c script` on a fresh PTY and registers it in `state`.
// Returns the master so a test can wait on tty state.
fn spawn_sh(state: &TerminalState, script: &str) -> Arc<Mutex<Box<dyn MasterPty + Send>>> {
    let size = TerminalDimensions { cols: 80, rows: 24 };
    let pair = native_pty_system().openpty(size.as_pty_size()).unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", script]);
    let child = pair.slave.spawn_command(command).unwrap();
    drop(pair.slave);
    let writer = pair.master.take_writer().unwrap();
    let session = TerminalSession::new(child, pair.master, writer, size);
    let master = session.master.clone();
    state
        .sessions
        .lock()
        .unwrap()
        .insert(SESSION_ID.into(), session);
    master
}

// `stty raw` runs in the child, so poll the tty until it has taken effect.
fn wait_for_raw_mode(master: &Mutex<Box<dyn MasterPty + Send>>) {
    let fd = master.lock().unwrap().as_raw_fd().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut termios = unsafe { std::mem::zeroed::<libc::termios>() };
        assert_eq!(unsafe { libc::tcgetattr(fd, &mut termios) }, 0);
        if termios.c_lflag & libc::ICANON == 0 {
            return;
        }
        assert!(Instant::now() < deadline, "stty raw never took effect");
        thread::sleep(Duration::from_millis(10));
    }
}

fn kill_session(state: &TerminalState) {
    let session = state.sessions.lock().unwrap().remove(SESSION_ID);
    if let Some(mut session) = session {
        super::kill_session_tree(&mut session);
    }
}

// B004: terminal_write runs on the Tauri main thread. A paste larger than the
// tty input queue, into a program that is not reading, must not block it.
#[test]
fn a_paste_into_a_pty_that_is_not_reading_does_not_block_the_caller() {
    let state = Arc::new(TerminalState::default());
    let master = spawn_sh(&state, "stty raw -echo; exec sleep 60");
    wait_for_raw_mode(&master);

    let (done, finished) = mpsc::channel();
    let writer_state = state.clone();
    thread::spawn(move || {
        let paste = vec![b'x'; 1 << 20];
        let _ = done.send(super::write_terminal_bytes(
            &writer_state,
            SESSION_ID,
            &paste,
        ));
    });
    let result = finished.recv_timeout(Duration::from_secs(3));
    kill_session(&state);
    assert_eq!(result, Ok(Ok(())), "terminal write blocked its caller");
}

// Keystrokes arrive as many small writes; the PTY must see them in order.
#[test]
fn small_writes_reach_the_pty_in_the_order_they_were_sent() {
    let state = TerminalState::default();
    let master = spawn_sh(&state, "stty raw -echo; exec cat");
    wait_for_raw_mode(&master);
    let mut reader = master.lock().unwrap().try_clone_reader().unwrap();
    let (chunks, received) = mpsc::channel();
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(n @ 1..) = std::io::Read::read(&mut reader, &mut buffer) {
            if chunks.send(buffer[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    let expected: String = (0..300).map(|i| format!("{i},")).collect();
    for i in 0..300 {
        super::write_terminal_bytes(&state, SESSION_ID, format!("{i},").as_bytes()).unwrap();
    }
    let mut echoed = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(5);
    while echoed.len() < expected.len() && Instant::now() < deadline {
        if let Ok(chunk) = received.recv_timeout(Duration::from_millis(100)) {
            echoed.extend(chunk);
        }
    }
    kill_session(&state);
    assert_eq!(String::from_utf8_lossy(&echoed), expected);
}

fn process_exists(pid: libc::pid_t) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

// B085: an interactive shell runs every job in its own process group, so
// signalling only the shell's group misses a job that ignores SIGHUP.
#[test]
fn closing_a_terminal_kills_a_job_in_another_process_group() {
    let state = TerminalState::default();
    let master = spawn_sh(
        &state,
        "set -m; (trap '' HUP; exec sleep 60) & echo \"job=$!\"; wait",
    );
    let mut reader = master.lock().unwrap().try_clone_reader().unwrap();
    let mut output = Vec::new();
    let mut buffer = [0_u8; 256];
    let job = loop {
        let n = std::io::Read::read(&mut reader, &mut buffer).unwrap();
        assert!(n > 0, "shell exited before printing the job pid");
        output.extend_from_slice(&buffer[..n]);
        let text = String::from_utf8_lossy(&output);
        let digits = text.split("job=").nth(1).map(|rest| {
            rest.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        });
        if let Some(pid) = digits.filter(|_| text.contains('\n')) {
            break pid.parse::<libc::pid_t>().unwrap();
        }
    };
    let shell = {
        let sessions = state.sessions.lock().unwrap();
        sessions[SESSION_ID].child.process_id().unwrap() as libc::pid_t
    };
    // Without its own group the old killpg(shell) would reach it anyway.
    assert_ne!(unsafe { libc::getpgid(job) }, shell);

    kill_session(&state);
    let deadline = Instant::now() + Duration::from_secs(3);
    while process_exists(job) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let survived = process_exists(job);
    if survived {
        unsafe { libc::kill(job, libc::SIGKILL) };
    }
    assert!(!survived, "job {job} outlived its terminal");
}
