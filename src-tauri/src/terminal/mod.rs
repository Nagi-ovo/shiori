// Embedded terminal: PTY sessions (portable-pty) behind the terminal_*
// commands, with output and exit streamed to the main webview as events.
// Desktop only; mobile keeps the commands as unsupported stubs. Interactive
// `open https://…` inside a session is routed by open_routing.

#[cfg(not(mobile))]
mod open_routing;
#[cfg(all(test, unix, not(mobile)))]
mod pty_tests;
#[cfg(not(mobile))]
mod reaper;

#[cfg(not(mobile))]
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
#[cfg(not(mobile))]
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
#[cfg(not(mobile))]
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Runtime, State, Webview};

use crate::enforce_main_webview;
#[cfg(not(mobile))]
use crate::{emit_to_main, runtime_guard::enforce_runtime_guard};
#[cfg(not(mobile))]
use open_routing::configure_open_routing;
#[cfg(not(mobile))]
use reaper::kill_session_tree;
#[cfg(not(mobile))]
pub(crate) use reaper::shutdown_sessions;

#[cfg(not(mobile))]
static TERMINAL_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
#[cfg(not(mobile))]
pub(crate) struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

#[derive(Default)]
#[cfg(mobile)]
pub(crate) struct TerminalState;

#[cfg(not(mobile))]
struct TerminalSession {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    input: mpsc::Sender<Vec<u8>>,
    size: Arc<Mutex<TerminalDimensions>>,
}

#[cfg(not(mobile))]
impl TerminalSession {
    fn new(
        child: Box<dyn portable_pty::Child + Send + Sync>,
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        size: TerminalDimensions,
    ) -> Self {
        Self {
            child,
            master: Arc::new(Mutex::new(master)),
            input: spawn_input_writer(writer),
            size: Arc::new(Mutex::new(size)),
        }
    }
}

// The PTY write blocks once the tty input queue is full and the program in
// the terminal is not reading it, so it runs on this per-session thread, never
// on the caller. terminal_write stays sync on purpose: sync commands run on
// the main thread in IPC arrival order, which keeps keystrokes in order. The
// writer drops here too (its Drop writes EOF to the PTY).
#[cfg(not(mobile))]
fn spawn_input_writer(mut writer: Box<dyn Write + Send>) -> mpsc::Sender<Vec<u8>> {
    let (input, chunks) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        for chunk in chunks {
            if writer
                .write_all(&chunk)
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    input
}

#[cfg(not(mobile))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TerminalDimensions {
    cols: u16,
    rows: u16,
}

#[cfg(not(mobile))]
impl TerminalDimensions {
    fn as_pty_size(self) -> PtySize {
        PtySize {
            rows: self.rows,
            cols: self.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

#[derive(Serialize, Clone, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSpawnInfo {
    session_id: String,
    cwd: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
    session_id: String,
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn terminal_spawn<R: Runtime>(
    caller: Webview<R>,
    app: AppHandle<R>,
    state: State<'_, TerminalState>,
    session_id: String,
    working_directory: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<TerminalSpawnInfo, String> {
    enforce_main_webview(&caller)?;
    enforce_runtime_guard()?;
    let cwd = resolve_terminal_cwd(working_directory)?;
    let session_id = normalize_terminal_session_id(session_id);
    spawn_terminal_session(app, state, session_id, cwd, cols, rows)
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn terminal_spawn<R: Runtime>(
    caller: Webview<R>,
    _app: AppHandle<R>,
    _state: State<'_, TerminalState>,
    _session_id: String,
    _working_directory: Option<String>,
    _cols: u16,
    _rows: u16,
) -> Result<TerminalSpawnInfo, String> {
    enforce_main_webview(&caller)?;
    Err("terminal-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn terminal_write<R: Runtime>(
    caller: Webview<R>,
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    write_terminal_bytes(state.inner(), &session_id, data.as_bytes())
}

#[cfg(not(mobile))]
fn write_terminal_bytes(
    state: &TerminalState,
    session_id: &str,
    data: &[u8],
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|_| "terminal-unavailable")?;
    let session = sessions
        .get(session_id)
        .ok_or_else(|| "terminal-session-missing".to_string())?;
    session
        .input
        .send(data.to_vec())
        .map_err(|_| "terminal-unavailable".to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn terminal_write<R: Runtime>(
    caller: Webview<R>,
    _state: State<'_, TerminalState>,
    _session_id: String,
    _data: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("terminal-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn terminal_write_binary<R: Runtime>(
    caller: Webview<R>,
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let bytes = decode_terminal_binary(&data)?;
    write_terminal_bytes(state.inner(), &session_id, &bytes)
}

#[cfg(not(mobile))]
fn decode_terminal_binary(data: &str) -> Result<Vec<u8>, String> {
    BASE64_STANDARD
        .decode(data)
        .map_err(|_| "terminal-binary-invalid".to_string())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn terminal_write_binary<R: Runtime>(
    caller: Webview<R>,
    _state: State<'_, TerminalState>,
    _session_id: String,
    _data: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("terminal-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn terminal_resize<R: Runtime>(
    caller: Webview<R>,
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let (master, size) = {
        let sessions = state.sessions.lock().map_err(|_| "terminal-unavailable")?;
        sessions
            .get(&session_id)
            .map(|session| (session.master.clone(), session.size.clone()))
            .ok_or_else(|| "terminal-session-missing".to_string())?
    };
    let next = normalize_terminal_dimensions(cols, rows);
    let mut current = size.lock().map_err(|_| "terminal-unavailable")?;
    if *current == next {
        return Ok(());
    }
    let master = master.lock().map_err(|_| "terminal-unavailable")?;
    master
        .resize(next.as_pty_size())
        .map_err(|_| "terminal-unavailable".to_string())?;
    *current = next;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn terminal_resize<R: Runtime>(
    caller: Webview<R>,
    _state: State<'_, TerminalState>,
    _session_id: String,
    _cols: u16,
    _rows: u16,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("terminal-unsupported".into())
}

#[tauri::command]
#[specta::specta]
#[cfg(not(mobile))]
pub(crate) fn terminal_kill<R: Runtime>(
    caller: Webview<R>,
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    let session = {
        let mut sessions = state.sessions.lock().map_err(|_| "terminal-unavailable")?;
        sessions.remove(&session_id)
    };
    if let Some(mut session) = session {
        // Reap the whole process tree (shell + foreground children like
        // claude / codex / node / builds), not just the shell PID — otherwise
        // closing a terminal orphans them. `session` drops at the end of this
        // block, releasing the PTY master Arc so the reader thread unblocks.
        kill_session_tree(&mut session);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[cfg(mobile)]
pub(crate) fn terminal_kill<R: Runtime>(
    caller: Webview<R>,
    _state: State<'_, TerminalState>,
    _session_id: String,
) -> Result<(), String> {
    enforce_main_webview(&caller)?;
    Err("terminal-unsupported".into())
}

#[cfg(not(mobile))]
fn spawn_terminal_session<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, TerminalState>,
    session_id: String,
    cwd: PathBuf,
    cols: u16,
    rows: u16,
) -> Result<TerminalSpawnInfo, String> {
    {
        let sessions = state.sessions.lock().map_err(|_| "terminal-unavailable")?;
        if sessions.contains_key(&session_id) {
            return Err("terminal-session-exists".into());
        }
    }

    let initial_size = normalize_terminal_dimensions(cols, rows);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(initial_size.as_pty_size())
        .map_err(|_| "terminal-unavailable".to_string())?;
    let mut command = terminal_command();
    configure_terminal_environment(&mut command);
    configure_open_routing(&app, &mut command);
    command.cwd(&cwd);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| "terminal-unavailable".to_string())?;
    drop(pair.slave);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("terminal-unavailable".into());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("terminal-unavailable".into());
        }
    };

    {
        let mut sessions = state.sessions.lock().map_err(|_| "terminal-unavailable")?;
        if sessions.contains_key(&session_id) {
            drop(sessions);
            let _ = child.kill();
            let _ = child.wait();
            return Err("terminal-session-exists".into());
        }
        sessions.insert(
            session_id.clone(),
            TerminalSession::new(child, pair.master, writer, initial_size),
        );
    }

    let emit_id = session_id.clone();
    let sessions = state.sessions.clone();
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = TerminalOutputPayload {
                        session_id: emit_id.clone(),
                        data: BASE64_STANDARD.encode(&buffer[..n]),
                    };
                    let _ = emit_to_main(&app, "terminal-output", payload);
                }
                Err(_) => break,
            }
        }
        let _ = emit_to_main(
            &app,
            "terminal-exit",
            TerminalExitPayload {
                session_id: emit_id.clone(),
            },
        );
        let removed = sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&emit_id));
        if let Some(mut session) = removed {
            let _ = session.child.wait();
        }
    });

    Ok(TerminalSpawnInfo {
        session_id,
        cwd: cwd.to_string_lossy().to_string(),
    })
}

#[cfg(not(mobile))]
fn normalize_terminal_session_id(input: String) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        let id = TERMINAL_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
        return format!("terminal-{id}");
    }
    trimmed.to_string()
}

#[cfg(not(mobile))]
fn normalize_terminal_dimensions(cols: u16, rows: u16) -> TerminalDimensions {
    TerminalDimensions {
        rows: rows.clamp(2, 200),
        cols: cols.clamp(2, 400),
    }
}

#[cfg(not(mobile))]
fn resolve_terminal_cwd(input: Option<String>) -> Result<PathBuf, String> {
    let Some(raw) = input
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return default_terminal_cwd();
    };
    let mut path = PathBuf::from(raw);
    if path.is_file() {
        path = path
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "terminal-cwd-unavailable".to_string())?;
    }
    if !path.is_dir() {
        return Err("terminal-cwd-not-directory".into());
    }
    Ok(path)
}

#[cfg(not(mobile))]
fn default_terminal_cwd() -> Result<PathBuf, String> {
    home_dir()
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| "terminal-cwd-unavailable".into())
}

#[cfg(not(mobile))]
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .or_else(|| {
            let drive = std::env::var_os("HOMEDRIVE")?;
            let path = std::env::var_os("HOMEPATH")?;
            let mut joined = PathBuf::from(drive);
            joined.push(path);
            Some(joined.into_os_string())
        })
        .map(PathBuf::from)
}

#[cfg(not(mobile))]
fn configure_terminal_environment(command: &mut CommandBuilder) {
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Shiori");
    command.env("CLICOLOR", "1");
    command.env("FORCE_COLOR", "1");
    configure_terminal_locale(command);
    if std::env::var_os("ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE").is_none() {
        command.env("ZSH_AUTOSUGGEST_HIGHLIGHT_STYLE", "fg=8");
    }
}

#[cfg(target_os = "macos")]
fn configure_terminal_locale(command: &mut CommandBuilder) {
    if std::env::var_os("LC_ALL").is_some() {
        return;
    }
    if std::env::var_os("LC_CTYPE").is_none() {
        command.env("LC_CTYPE", "UTF-8");
    }
    if std::env::var_os("LANG").is_none() {
        command.env("LANG", "en_US.UTF-8");
    }
}

// Desktop-only twin: CommandBuilder comes from portable-pty, which the
// mobile targets never compile (the embedded terminal is desktop-only), so
// a bare not(macos) gate breaks iOS/Android checks.
#[cfg(all(not(mobile), not(target_os = "macos")))]
fn configure_terminal_locale(_command: &mut CommandBuilder) {}

#[cfg(all(not(mobile), windows))]
fn terminal_command() -> CommandBuilder {
    let shell = std::env::var("COMSPEC")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "powershell.exe".to_string());
    let mut command = CommandBuilder::new(shell.clone());
    let lower = shell.to_ascii_lowercase();
    if lower.contains("powershell") || lower.ends_with("pwsh.exe") {
        command.arg("-NoLogo");
    }
    command
}

#[cfg(all(not(mobile), not(windows)))]
fn terminal_command() -> CommandBuilder {
    CommandBuilder::new(user_unix_shell())
}

#[cfg(all(not(mobile), not(windows)))]
fn user_unix_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_unix_shell().to_string())
}

#[cfg(target_os = "macos")]
fn default_unix_shell() -> &'static str {
    "/bin/zsh"
}

#[cfg(all(not(mobile), unix, not(target_os = "macos")))]
fn default_unix_shell() -> &'static str {
    "/bin/sh"
}

#[cfg(test)]
mod tests {
    #[cfg(not(mobile))]
    use base64::Engine;

    #[test]
    #[cfg(not(mobile))]
    fn terminal_resize_dimensions_deduplicate_after_normalization() {
        let current = super::normalize_terminal_dimensions(400, 200);
        assert_eq!(super::normalize_terminal_dimensions(400, 200), current,);
        assert_eq!(
            super::normalize_terminal_dimensions(u16::MAX, u16::MAX),
            current,
        );
        assert_ne!(super::normalize_terminal_dimensions(399, 200), current);
    }

    #[test]
    #[cfg(not(mobile))]
    fn terminal_binary_payload_preserves_non_utf8_bytes() {
        let payload = super::BASE64_STANDARD.encode([0x00, 0x1b, 0x80, 0xff]);
        assert_eq!(
            super::decode_terminal_binary(&payload).unwrap(),
            vec![0x00, 0x1b, 0x80, 0xff],
        );
        assert_eq!(
            super::decode_terminal_binary("not base64").unwrap_err(),
            "terminal-binary-invalid",
        );
    }
}
