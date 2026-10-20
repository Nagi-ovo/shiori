// Reaping a terminal session's process tree, on close (terminal_kill) and at
// app quit (shutdown_sessions).

use super::{TerminalSession, TerminalState};

// Reap a terminal session's ENTIRE process tree, not just the shell PID. The
// shell is spawned as a setsid session leader (portable-pty), so on Unix its
// PID == PGID and killpg() reaches every foreground/background child (claude,
// codex, node, running builds). On Windows `taskkill /T` walks the child tree.
// Killing only the shell handle would reparent those grandchildren and leave
// them running — the Task Manager residue users saw accumulate across
// open/close/quit cycles.
//
// The caller owns `session`; dropping it after this returns releases the PTY
// master Arc, which closes the slave / fires ConPTY ClosePseudoConsole and lets
// the detached reader thread (spawn_terminal_session) unblock and exit.
pub(super) fn kill_session_tree(session: &mut TerminalSession) {
    let pid = session.child.process_id();

    #[cfg(unix)]
    if let Some(pid) = pid {
        // pgid == pid for the session leader; never signal pgid 0/1.
        if pid > 1 {
            // SIGHUP first (lets shells run traps / agents flush), a short
            // grace, then SIGKILL the group as a guarantee.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGHUP);
            }
            std::thread::sleep(std::time::Duration::from_millis(80));
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }

    #[cfg(windows)]
    if let Some(pid) = pid {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }

    // Direct handle kill (covers process_id() == None) plus a BOUNDED reap so a
    // pathological un-reapable child can never hang app-quit — the OS reclaims
    // it when our process exits anyway.
    let _ = session.child.kill();
    for _ in 0..30 {
        match session.child.try_wait() {
            Ok(Some(_)) | Err(_) => break,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }
}

// Reaps every live session at app quit (shutdown_cleanup). Takes sessions
// out under the lock, then releases it before the (bounded-blocking) reap so
// the global map mutex is never held across process kills.
pub(crate) fn shutdown_sessions(state: &TerminalState) {
    let drained: Vec<TerminalSession> = match state.sessions.lock() {
        Ok(mut sessions) => sessions.drain().map(|(_, session)| session).collect(),
        Err(_) => Vec::new(),
    };
    for mut session in drained {
        kill_session_tree(&mut session);
        // `session` drops here → PTY master Arc released → reader unblocks.
    }
}
