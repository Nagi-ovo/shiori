// ── Terminal `open` routing ────────────────────────────────────────────
//
// We prepend an app-managed shim directory to the embedded terminal's PATH
// and export a private request endpoint. The shim intercepts `open`/`xdg-open`
// (plus an explicit `shiori-open`): web URLs are written to Rust, which routes
// them into the embedded Browser panel; everything else execs the real system
// command. An absolute `/usr/bin/open` bypasses the shim entirely (escape
// hatch), and a missing endpoint falls through to the system opener so a
// command is never swallowed.
//
// NOTE: the shim only wins if its directory stays ahead of /usr/bin on the
// shell's PATH. We spawn a NON-login interactive shell, so /etc/zprofile's
// path_helper (which would reorder PATH) does not run; a `~/.zshrc` that
// *prepends* keeps our dir ahead of /usr/bin (the common case). A shell rc
// that fully *rebuilds* PATH from scratch would defeat it — documented in
// docs/POSTMORTEMS.md. Windows gets equivalent routing by loading a tiny
// shell bootstrap: PowerShell overrides Start-Process/start, and cmd.exe gets
// a doskey macro for interactive `start https://...`.

use portable_pty::CommandBuilder;
#[cfg(windows)]
use std::io::Read;
#[cfg(unix)]
use std::process::Command;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};
use tauri::{AppHandle, Manager, Runtime};

use super::home_dir;
use crate::emit_to_main;
use crate::web_panel::{parse_web_url, WebPanelOpenRequest};

#[cfg(all(not(mobile), any(unix, windows)))]
#[derive(Clone)]
struct OpenRouting {
    shim_dir: PathBuf,
    request_path: PathBuf,
}

#[cfg(all(not(mobile), any(unix, windows)))]
static OPEN_ROUTING: Mutex<Option<OpenRouting>> = Mutex::new(None);

#[cfg(all(not(mobile), any(unix, windows)))]
pub(super) fn configure_open_routing<R: Runtime>(app: &AppHandle<R>, command: &mut CommandBuilder) {
    let Some(routing) = ensure_open_routing(app) else {
        return;
    };
    let shim = routing.shim_dir.to_string_lossy().to_string();
    let existing = std::env::var("PATH").unwrap_or_default();
    #[cfg(all(not(mobile), windows))]
    let path_separator = ";";
    #[cfg(all(not(mobile), not(windows)))]
    let path_separator = ":";
    let new_path = if existing.is_empty() {
        shim
    } else {
        format!("{shim}{path_separator}{existing}")
    };
    command.env("PATH", new_path);
    #[cfg(all(not(mobile), unix))]
    command.env(
        "SHIORI_OPEN_PIPE",
        routing.request_path.to_string_lossy().to_string(),
    );
    #[cfg(all(not(mobile), windows))]
    {
        command.env(
            "SHIORI_OPEN_FILE",
            routing.request_path.to_string_lossy().to_string(),
        );
        configure_windows_open_routing(command, &routing);
    }
}

#[cfg(all(not(mobile), not(any(unix, windows))))]
pub(super) fn configure_open_routing<R: Runtime>(
    _app: &AppHandle<R>,
    _command: &mut CommandBuilder,
) {
}

#[cfg(all(not(mobile), any(unix, windows)))]
fn ensure_open_routing<R: Runtime>(app: &AppHandle<R>) -> Option<OpenRouting> {
    let mut guard = OPEN_ROUTING.lock().ok()?;
    if let Some(existing) = guard.as_ref() {
        return Some(existing.clone());
    }
    let routing = setup_open_routing(app)?;
    *guard = Some(routing.clone());
    Some(routing)
}

#[cfg(all(not(mobile), any(unix, windows)))]
fn setup_open_routing<R: Runtime>(app: &AppHandle<R>) -> Option<OpenRouting> {
    let base_dir = open_routing_base_dir(app)?;
    prepare_private_dir(&base_dir).ok()?;
    let shim_dir = base_dir.join("bin");
    prepare_private_dir(&shim_dir).ok()?;
    for (name, body) in open_shim_scripts() {
        let path = shim_dir.join(name);
        write_open_routing_script(&path, &body).ok()?;
    }
    let request_path = prepare_open_routing_request(&base_dir)?;
    start_open_routing_reader(app.clone(), request_path.clone());
    Some(OpenRouting {
        shim_dir,
        request_path,
    })
}

#[cfg(all(not(mobile), any(unix, windows)))]
fn open_routing_base_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .or_else(|| home_dir().map(|home| home.join(".shiori-cache")))
        .map(|base| base.join("terminal-open-routing"))
}

#[cfg(all(not(mobile), unix))]
fn prepare_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "open-routing-path-not-directory",
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(all(not(mobile), windows))]
fn prepare_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)
}

#[cfg(all(not(mobile), any(unix, windows)))]
fn write_open_routing_script(path: &Path, body: &str) -> std::io::Result<()> {
    let temp_path = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temp_path, body)?;
    #[cfg(all(not(mobile), unix))]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp_path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(all(not(mobile), windows))]
    {
        let _ = fs::remove_file(path);
    }
    fs::rename(&temp_path, path)?;
    #[cfg(all(not(mobile), unix))]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(all(not(mobile), unix))]
fn prepare_open_routing_request(base_dir: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let request_path = base_dir.join(format!("open-{}.fifo", std::process::id()));
    let _ = fs::remove_file(&request_path);
    match Command::new("mkfifo").arg(&request_path).status() {
        Ok(status) if status.success() => {}
        _ => return None,
    }
    let _ = fs::set_permissions(&request_path, fs::Permissions::from_mode(0o600));
    Some(request_path)
}

#[cfg(all(not(mobile), windows))]
fn prepare_open_routing_request(base_dir: &Path) -> Option<PathBuf> {
    let request_path = base_dir.join(format!("open-{}.log", std::process::id()));
    let _ = fs::remove_file(&request_path);
    fs::OpenOptions::new()
        .create_new(true)
        .append(true)
        .open(&request_path)
        .ok()?;
    Some(request_path)
}

#[cfg(all(not(mobile), unix))]
fn start_open_routing_reader<R: Runtime>(app: AppHandle<R>, request_path: PathBuf) {
    thread::spawn(move || run_open_pipe_reader(app, request_path));
}

#[cfg(all(not(mobile), windows))]
fn start_open_routing_reader<R: Runtime>(app: AppHandle<R>, request_path: PathBuf) {
    thread::spawn(move || run_open_file_reader(app, request_path));
}

// Also compiled for tests so the argv it builds is checked on every host.
#[cfg(all(not(mobile), any(windows, test)))]
fn configure_windows_open_routing(command: &mut CommandBuilder, routing: &OpenRouting) {
    let program = command
        .get_argv()
        .first()
        .and_then(|program| Path::new(program).file_name())
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if program == "cmd.exe" || program == "cmd" {
        // No quotes of our own: portable-pty adds one pair when the path has
        // spaces, which is the form cmd's /K accepts.
        command.arg("/K");
        command.arg(routing.shim_dir.join("shiori-cmd-init.cmd"));
        return;
    }
    if program == "powershell.exe"
        || program == "powershell"
        || program == "pwsh.exe"
        || program == "pwsh"
    {
        let script = routing.shim_dir.join("shiori-powershell-profile.ps1");
        command.arg("-NoExit");
        command.arg("-ExecutionPolicy");
        command.arg("Bypass");
        command.arg("-File");
        command.arg(script);
    }
}

#[cfg(all(not(mobile), windows))]
fn run_open_file_reader<R: Runtime>(app: AppHandle<R>, request_path: PathBuf) {
    use std::io::{Seek, SeekFrom};
    let mut offset = 0_u64;
    loop {
        thread::sleep(std::time::Duration::from_millis(120));
        let metadata = match fs::metadata(&request_path) {
            Ok(metadata) => metadata,
            Err(_) => return,
        };
        if metadata.len() < offset {
            offset = 0;
        }
        let mut file = match fs::File::open(&request_path) {
            Ok(file) => file,
            Err(_) => return,
        };
        if file.seek(SeekFrom::Start(offset)).is_err() {
            offset = 0;
            continue;
        }
        let mut buffer = String::new();
        if file.read_to_string(&mut buffer).is_err() {
            continue;
        }
        if buffer.is_empty() {
            continue;
        }
        if let Ok(next) = file.stream_position() {
            offset = next;
        }
        for line in buffer.lines() {
            let url = line.trim();
            if !url.is_empty() {
                route_terminal_open(&app, url);
            }
        }
    }
}

#[cfg(all(not(mobile), unix))]
fn run_open_pipe_reader<R: Runtime>(app: AppHandle<R>, pipe_path: PathBuf) {
    use std::io::BufRead;
    loop {
        // Open O_RDWR so our own write handle keeps the FIFO from hitting a
        // permanent EOF between shim invocations; without it the reader
        // would spin reopening after the first writer disconnects.
        let file = match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&pipe_path)
        {
            Ok(file) => file,
            Err(_) => return,
        };
        let reader = std::io::BufReader::new(file);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let url = line.trim();
            if url.is_empty() {
                continue;
            }
            route_terminal_open(&app, url);
        }
    }
}

#[cfg(all(not(mobile), any(unix, windows)))]
fn route_terminal_open<R: Runtime>(app: &AppHandle<R>, url: &str) {
    // The shim only forwards http(s), but re-validate before acting on it.
    if parse_web_url(url).is_err() {
        return;
    }
    // Focus the main window and route the URL into the embedded Browser panel
    // on every desktop OS — including Windows, now that the WebView2 freeze
    // (per-frame show()) is fixed. Unconditional body so it cannot diverge
    // per-platform.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
    let _ = emit_to_main(
        app,
        "web-panel-open",
        WebPanelOpenRequest {
            url: url.to_string(),
        },
    );
}

#[cfg(all(not(mobile), any(unix, windows)))]
fn open_shim_scripts() -> Vec<(&'static str, String)> {
    let mut scripts: Vec<(&'static str, String)> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        scripts.push(("open", macos_open_shim()));
    }
    #[cfg(all(not(mobile), unix, not(target_os = "macos")))]
    {
        scripts.push(("xdg-open", linux_xdg_open_shim()));
    }
    #[cfg(all(not(mobile), windows))]
    {
        scripts.push(("shiori-open.cmd", windows_shiori_open_cmd()));
        scripts.push(("open.cmd", windows_shiori_open_cmd()));
        scripts.push(("shiori-cmd-init.cmd", windows_cmd_init()));
        scripts.push((
            "shiori-powershell-profile.ps1",
            windows_powershell_profile(),
        ));
    }
    #[cfg(all(not(mobile), unix))]
    scripts.push(("shiori-open", shiori_open_shim()));
    scripts
}

#[cfg(target_os = "macos")]
fn macos_open_shim() -> String {
    String::from(
        r#"#!/bin/sh
# Shiori terminal integration. Route web URLs to the embedded Browser
# panel; defer everything else to the real macOS `open`.
for arg in "$@"; do
  case "$arg" in
    -*) continue ;;
    [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*)
      if [ -n "$SHIORI_OPEN_PIPE" ] && [ -p "$SHIORI_OPEN_PIPE" ]; then
        printf '%s\n' "$arg" > "$SHIORI_OPEN_PIPE" && exit 0
      fi
      break ;;
    *) break ;;
  esac
done
exec /usr/bin/open "$@"
"#,
    )
}

#[cfg(all(not(mobile), unix, not(target_os = "macos")))]
fn linux_xdg_open_shim() -> String {
    String::from(
        r#"#!/bin/sh
# Shiori terminal integration. Route web URLs to the embedded Browser
# panel; defer everything else to the real xdg-open.
case "$1" in
  [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*)
    if [ -n "$SHIORI_OPEN_PIPE" ] && [ -p "$SHIORI_OPEN_PIPE" ]; then
      printf '%s\n' "$1" > "$SHIORI_OPEN_PIPE" && exit 0
    fi ;;
esac
for real in /usr/bin/xdg-open /bin/xdg-open /usr/local/bin/xdg-open; do
  [ -x "$real" ] && exec "$real" "$@"
done
exit 127
"#,
    )
}

#[cfg(all(not(mobile), unix))]
fn shiori_open_shim() -> String {
    String::from(
        r#"#!/bin/sh
# Explicit Shiori opener. Web URLs go to the embedded Browser panel; other
# targets fall through to the system opener.
case "$1" in
  [Hh][Tt][Tt][Pp]://*|[Hh][Tt][Tt][Pp][Ss]://*)
    if [ -n "$SHIORI_OPEN_PIPE" ] && [ -p "$SHIORI_OPEN_PIPE" ]; then
      printf '%s\n' "$1" > "$SHIORI_OPEN_PIPE" && exit 0
    fi ;;
esac
if [ -x /usr/bin/open ]; then exec /usr/bin/open "$@"; fi
for real in /usr/bin/xdg-open /bin/xdg-open /usr/local/bin/xdg-open; do
  [ -x "$real" ] && exec "$real" "$@"
done
exit 127
"#,
    )
}

#[cfg(all(not(mobile), windows))]
fn windows_shiori_open_cmd() -> String {
    String::from(
        r#"@echo off
setlocal
set "target=%~1"
if /I "%target:~0,7%"=="http://" goto shiori_route
if /I "%target:~0,8%"=="https://" goto shiori_route
if "%target%"=="" exit /b 0
start "" %*
exit /b %ERRORLEVEL%

:shiori_route
if not "%SHIORI_OPEN_FILE%"=="" (
  set "SHIORI_OPEN_TARGET=%target%"
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Content -LiteralPath $env:SHIORI_OPEN_FILE -Value $env:SHIORI_OPEN_TARGET -Encoding UTF8"
  set "SHIORI_OPEN_TARGET="
  exit /b %ERRORLEVEL%
)
start "" %*
exit /b %ERRORLEVEL%
"#,
    )
}

#[cfg(all(not(mobile), windows))]
fn windows_cmd_init() -> String {
    String::from(
        r#"@echo off
doskey start=shiori-open $*
doskey open=shiori-open $*
"#,
    )
}

#[cfg(all(not(mobile), windows))]
fn windows_powershell_profile() -> String {
    String::from(
        r#"$ErrorActionPreference = "Continue"
function global:Start-Process {
  $target = $null
  foreach ($arg in $args) {
    if ($arg -is [string] -and -not $arg.StartsWith("-")) {
      $target = $arg
      break
    }
  }
  if ($target -match '^(?i:https?://)') {
    if ($env:SHIORI_OPEN_FILE) {
      Add-Content -LiteralPath $env:SHIORI_OPEN_FILE -Value $target -Encoding utf8
      return
    }
  }
  Microsoft.PowerShell.Management\Start-Process @args
}
Set-Alias -Name start -Value Start-Process -Scope Global -Force
"#,
    )
}

#[cfg(all(test, not(mobile)))]
mod tests {
    use super::*;

    // B087: portable-pty quotes Windows arguments by CRT rules, so a quote
    // inside one becomes \", which cmd's /K parser does not decode. The init
    // script must go in as one bare argument (quoted once if it has spaces).
    #[test]
    fn cmd_exe_receives_its_init_script_as_one_unquoted_argument() {
        let shim_dir = PathBuf::from("C:/Users/Jo Doe/AppData/Local/shiori/bin");
        let routing = OpenRouting {
            shim_dir: shim_dir.clone(),
            request_path: PathBuf::from("open.log"),
        };
        let mut command = CommandBuilder::new("cmd.exe");
        configure_windows_open_routing(&mut command, &routing);
        let argv = command.get_argv();
        assert_eq!(argv.len(), 3);
        assert_eq!(argv[1], "/K");
        assert_eq!(
            argv[2],
            shim_dir.join("shiori-cmd-init.cmd").into_os_string()
        );
    }
}
