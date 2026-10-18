#[cfg(target_os = "macos")]
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
#[cfg(unix)]
use std::{
    process::Child,
    sync::{mpsc, OnceLock},
    thread,
    time::Duration,
};
#[cfg(target_os = "macos")]
use std::{
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ExternalTerminalId {
    Terminal,
    Ghostty,
    Iterm2,
    Wezterm,
    WindowsTerminal,
    SystemTerminal,
}

impl ExternalTerminalId {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "terminal" => Ok(Self::Terminal),
            "ghostty" => Ok(Self::Ghostty),
            "iterm2" => Ok(Self::Iterm2),
            "wezterm" => Ok(Self::Wezterm),
            "windowsTerminal" => Ok(Self::WindowsTerminal),
            "systemTerminal" => Ok(Self::SystemTerminal),
            _ => Err("external-terminal-unknown-id".into()),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Terminal => "terminal",
            Self::Ghostty => "ghostty",
            Self::Iterm2 => "iterm2",
            Self::Wezterm => "wezterm",
            Self::WindowsTerminal => "windowsTerminal",
            Self::SystemTerminal => "systemTerminal",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalTerminalApp {
    id: &'static str,
    name: &'static str,
    icon_data_url: Option<String>,
}

impl ExternalTerminalApp {
    fn new(id: ExternalTerminalId, name: &'static str) -> Self {
        Self {
            id: id.id(),
            name,
            icon_data_url: None,
        }
    }

    #[cfg(target_os = "macos")]
    fn with_icon_data_url(mut self, icon_data_url: Option<String>) -> Self {
        self.icon_data_url = icon_data_url;
        self
    }
}

#[derive(Debug, Eq, PartialEq)]
struct LaunchSpec {
    program: PathBuf,
    args: Vec<OsString>,
    current_dir: PathBuf,
    wait_for_exit: bool,
    #[cfg(windows)]
    new_console: bool,
}

impl LaunchSpec {
    fn new(
        program: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
        current_dir: &Path,
    ) -> Self {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
            current_dir: current_dir.to_path_buf(),
            wait_for_exit: false,
            #[cfg(windows)]
            new_console: false,
        }
    }

    fn with_wait_for_exit(mut self) -> Self {
        self.wait_for_exit = true;
        self
    }

    #[cfg(windows)]
    fn with_new_console(mut self) -> Self {
        self.new_console = true;
        self
    }
}

pub(crate) fn installed_external_terminals() -> Vec<ExternalTerminalApp> {
    #[cfg(target_os = "macos")]
    {
        return installed_macos_external_terminals();
    }
    #[cfg(windows)]
    {
        return installed_windows_external_terminals();
    }
    #[cfg(target_os = "linux")]
    {
        return installed_linux_external_terminals();
    }
    #[allow(unreachable_code)]
    Vec::new()
}

pub(crate) fn open_external_terminal(
    terminal_id: &str,
    working_directory: Option<String>,
) -> Result<(), String> {
    let terminal_id = ExternalTerminalId::parse(terminal_id)?;
    let cwd = resolve_external_terminal_cwd(working_directory)?;
    let spec = launch_spec(terminal_id, &cwd)?;
    spawn_launch_spec(spec)
}

fn resolve_external_terminal_cwd(input: Option<String>) -> Result<PathBuf, String> {
    resolve_external_terminal_cwd_with(input, default_external_terminal_cwd)
}

fn resolve_external_terminal_cwd_with(
    input: Option<String>,
    default: impl FnOnce() -> Option<PathBuf>,
) -> Result<PathBuf, String> {
    // Whitespace-only means "use the default", but otherwise preserve the
    // string byte-for-byte. Leading/trailing spaces are legal path characters.
    let path = match input {
        Some(value) if !value.trim().is_empty() => PathBuf::from(value),
        _ => default().ok_or_else(|| "external-terminal-cwd-unavailable".to_string())?,
    };
    if !path.is_absolute() {
        return Err("external-terminal-cwd-not-absolute".into());
    }
    let metadata =
        fs::metadata(&path).map_err(|_| "external-terminal-cwd-unavailable".to_string())?;
    if !metadata.is_dir() {
        return Err("external-terminal-cwd-not-directory".into());
    }
    // Deliberately do not canonicalize: Windows prefixes canonical paths with
    // `\\?\`, which terminal CLIs do not consistently accept, and resolving a
    // symlink would also change the directory the user recognizes in prompts.
    Ok(path)
}

fn default_external_terminal_cwd() -> Option<PathBuf> {
    home_dir()
        .filter(|path| path.is_absolute() && path.is_dir())
        .or_else(|| std::env::current_dir().ok().filter(|path| path.is_dir()))
}

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

fn spawn_launch_spec(spec: LaunchSpec) -> Result<(), String> {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args).current_dir(&spec.current_dir);
    #[cfg(windows)]
    if spec.new_console {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        command.creation_flags(CREATE_NEW_CONSOLE);
    }
    if spec.wait_for_exit {
        return match command.status() {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("external-terminal-launch-failed:{status}")),
            Err(err) => Err(format!("external-terminal-launch-failed:{err}")),
        };
    }
    let child = command
        .spawn()
        .map_err(|err| format!("external-terminal-launch-failed:{err}"))?;
    // Windows reaps a process when its handles are released. Unix requires an
    // explicit wait, so hand every launcher to one shared reaper instead of
    // pinning a thread per long-lived terminal window.
    #[cfg(windows)]
    drop(child);
    #[cfg(unix)]
    enqueue_launch_child_for_reaping(child);
    #[cfg(not(any(unix, windows)))]
    drop(child);
    Ok(())
}

#[cfg(unix)]
static LAUNCH_CHILD_REAPER: OnceLock<mpsc::Sender<Child>> = OnceLock::new();

#[cfg(unix)]
fn enqueue_launch_child_for_reaping(child: Child) {
    let sender = LAUNCH_CHILD_REAPER.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || run_launch_child_reaper(receiver));
        sender
    });
    if let Err(error) = sender.send(child) {
        // The shared reaper should live for the process lifetime. If it ever
        // exits unexpectedly, retain the old one-child fallback so Unix still
        // cannot accumulate zombies.
        let mut child = error.0;
        thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

#[cfg(unix)]
fn run_launch_child_reaper(receiver: mpsc::Receiver<Child>) {
    let mut children = Vec::<Child>::new();
    loop {
        let received = if children.is_empty() {
            receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
        } else {
            receiver.recv_timeout(Duration::from_millis(250))
        };
        match received {
            Ok(child) => children.push(child),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        while let Ok(child) = receiver.try_recv() {
            children.push(child);
        }
        children.retain_mut(|child| matches!(child.try_wait(), Ok(None)));
    }
}

fn launch_spec(id: ExternalTerminalId, cwd: &Path) -> Result<LaunchSpec, String> {
    #[cfg(target_os = "macos")]
    {
        return macos_launch_spec(id, cwd);
    }
    #[cfg(windows)]
    {
        return windows_launch_spec(id, cwd);
    }
    #[cfg(target_os = "linux")]
    {
        return linux_launch_spec(id, cwd);
    }
    #[allow(unreachable_code)]
    Err("external-terminal-unsupported".into())
}

fn find_executable(names: &[&str], extra_candidates: &[PathBuf]) -> Option<PathBuf> {
    for candidate in extra_candidates {
        if is_executable_file(candidate) {
            return Some(absolutize_existing(candidate));
        }
    }
    let path = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&path) {
        // Ignore empty/relative PATH entries. A desktop launcher must never
        // resolve a program relative to a document-controlled cwd.
        if !directory.is_absolute() {
            continue;
        }
        for name in names {
            let candidate = directory.join(name);
            if is_executable_file(&candidate) {
                return Some(absolutize_existing(&candidate));
            }
        }
    }
    None
}

#[cfg(any(target_os = "linux", test))]
fn option_with_path(prefix: &str, path: &Path) -> OsString {
    let mut option = OsString::from(prefix);
    option.push(path.as_os_str());
    option
}

fn version_at_least(raw: &str, required_major: u64, required_minor: u64) -> bool {
    raw.split_whitespace().any(|token| {
        let candidate = token.trim_matches(|ch: char| !ch.is_ascii_digit() && ch != '.');
        let mut parts = candidate.split('.');
        let Some(major) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
            return false;
        };
        let Some(minor) = parts.next().and_then(|part| part.parse::<u64>().ok()) else {
            return false;
        };
        major > required_major || (major == required_major && minor >= required_minor)
    })
}

fn executable_version_at_least(binary: &Path, major: u64, minor: u64) -> bool {
    Command::new(binary)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            let mut raw = String::from_utf8_lossy(&output.stdout).into_owned();
            raw.push_str(&String::from_utf8_lossy(&output.stderr));
            version_at_least(&raw, major, minor)
        })
        .unwrap_or(false)
}

fn absolutize_existing(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        true
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct MacTerminalSpec {
    id: ExternalTerminalId,
    name: &'static str,
    bundle_id: &'static str,
    app_name: &'static str,
    fixed_paths: &'static [&'static str],
}

#[cfg(target_os = "macos")]
const MAC_TERMINAL_SPECS: &[MacTerminalSpec] = &[
    MacTerminalSpec {
        id: ExternalTerminalId::Terminal,
        name: "Terminal",
        bundle_id: "com.apple.Terminal",
        app_name: "Terminal.app",
        fixed_paths: &[
            "/System/Applications/Utilities/Terminal.app",
            "/Applications/Utilities/Terminal.app",
        ],
    },
    MacTerminalSpec {
        id: ExternalTerminalId::Ghostty,
        name: "Ghostty",
        bundle_id: "com.mitchellh.ghostty",
        app_name: "Ghostty.app",
        fixed_paths: &["/Applications/Ghostty.app"],
    },
    MacTerminalSpec {
        id: ExternalTerminalId::Iterm2,
        name: "iTerm2",
        bundle_id: "com.googlecode.iterm2",
        app_name: "iTerm.app",
        fixed_paths: &["/Applications/iTerm.app"],
    },
];

#[cfg(target_os = "macos")]
const MAX_MACOS_ICON_SOURCE_BYTES: u64 = 16 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_MACOS_ICON_PNG_BYTES: usize = 512 * 1024;
#[cfg(target_os = "macos")]
static MACOS_ICON_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "macos")]
struct MacosIconTempDir {
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl MacosIconTempDir {
    fn create() -> Option<Self> {
        let base = std::env::temp_dir();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos();
        for _ in 0..8 {
            let sequence = MACOS_ICON_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = base.join(format!(
                "shiori-terminal-icon-{}-{timestamp}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Some(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return None,
            }
        }
        None
    }
}

#[cfg(target_os = "macos")]
impl Drop for MacosIconTempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(any(target_os = "macos", test))]
fn normalized_macos_icon_file_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return None;
    }
    if name.to_ascii_lowercase().ends_with(".icns") {
        Some(name.to_string())
    } else {
        Some(format!("{name}.icns"))
    }
}

#[cfg(target_os = "macos")]
fn macos_plist_string(plist: &Path, key: &str) -> Option<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > 1024 {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(target_os = "macos")]
fn usable_macos_icns(path: &Path) -> Option<(PathBuf, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let size = metadata.len();
    (metadata.is_file() && size > 0 && size <= MAX_MACOS_ICON_SOURCE_BYTES)
        .then(|| (path.to_path_buf(), size))
}

#[cfg(target_os = "macos")]
fn macos_app_icon_path(app_bundle: &Path) -> Option<PathBuf> {
    let contents = app_bundle.join("Contents");
    let resources = contents.join("Resources");
    if let Some(file_name) = macos_plist_string(&contents.join("Info.plist"), "CFBundleIconFile")
        .as_deref()
        .and_then(normalized_macos_icon_file_name)
    {
        if let Some((path, _)) = usable_macos_icns(&resources.join(file_name)) {
            return Some(path);
        }
    }

    // Older and third-party bundles do not always declare CFBundleIconFile.
    // In that case prefer the largest bounded .icns resource; the app bundle
    // itself remains the source, so this still uses the installed official art.
    fs::read_dir(resources)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("icns"))
                .then(|| usable_macos_icns(&path))
                .flatten()
        })
        .max_by(|(left_path, left_size), (right_path, right_size)| {
            left_size
                .cmp(right_size)
                .then_with(|| left_path.cmp(right_path))
        })
        .map(|(path, _)| path)
}

#[cfg(target_os = "macos")]
fn macos_app_icon_data_url(app_bundle: &Path) -> Option<String> {
    let source = macos_app_icon_path(app_bundle)?;
    let temp_dir = MacosIconTempDir::create()?;
    let output_path = temp_dir.path.join("icon.png");
    let status = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-z", "40", "40"])
        .arg(&source)
        .arg("--out")
        .arg(&output_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    let metadata = fs::metadata(&output_path).ok()?;
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_MACOS_ICON_PNG_BYTES as u64
    {
        return None;
    }
    let bytes = fs::read(output_path).ok()?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes.len() > MAX_MACOS_ICON_PNG_BYTES {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

#[cfg(target_os = "macos")]
fn installed_macos_external_terminals() -> Vec<ExternalTerminalApp> {
    // LaunchServices may take over a second per lookup on a cold machine.
    // Resolve every app in parallel (standard paths short-circuit), and this
    // whole function itself runs under the command's spawn_blocking boundary.
    let handles = MAC_TERMINAL_SPECS
        .iter()
        .map(|spec| {
            let spec = *spec;
            thread::spawn(move || {
                let installed = macos_terminal_installed(&spec);
                let icon_data_url = installed
                    .then(|| macos_app_at_standard_path(&spec))
                    .flatten()
                    .and_then(|app_bundle| macos_app_icon_data_url(&app_bundle));
                (spec, installed, icon_data_url)
            })
        })
        .collect::<Vec<_>>();
    let mut apps = handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .filter(|(_, installed, _)| *installed)
        .map(|(spec, _, icon_data_url)| {
            ExternalTerminalApp::new(spec.id, spec.name).with_icon_data_url(icon_data_url)
        })
        .collect::<Vec<_>>();
    if macos_wezterm_binary().is_some() {
        let icon_data_url =
            macos_wezterm_app_path().and_then(|app_bundle| macos_app_icon_data_url(&app_bundle));
        apps.push(
            ExternalTerminalApp::new(ExternalTerminalId::Wezterm, "WezTerm")
                .with_icon_data_url(icon_data_url),
        );
    }
    // The picker preselects the first entry, so ordering IS the default, and
    // leading with Apple Terminal unconditionally was wrong for anyone who
    // uses a different terminal. Two signals, strongest first:
    //
    // 1. An explicit LaunchServices claim on shell scripts — the closest thing
    //    macOS has to a user-set default terminal.
    // 2. Failing that, any third-party terminal the user installed. Apple
    //    Terminal ships on every Mac, so its presence signals nothing, while
    //    installing another terminal is itself the preference. macOS has no
    //    setting to read here, so this is a guess — but the pick is
    //    remembered after one click, which caps the cost of guessing wrong.
    let preferred = macos_default_terminal_id()
        .and_then(|id| apps.iter().position(|app| app.id == id.id()))
        .or_else(|| {
            apps.iter()
                .position(|app| app.id != ExternalTerminalId::Terminal.id())
        });
    if let Some(index) = preferred.filter(|index| *index > 0) {
        let app = apps.remove(index);
        apps.insert(0, app);
    }
    apps
}

/// The bundle identifier macOS uses to open a shell script — the closest thing
/// the OS has to a "default terminal" setting. There is no dedicated
/// preference: a terminal claims the role by registering as the handler for
/// `.command` files, which is what "set as default" does in every terminal that
/// offers it. Absent an explicit user choice there is no entry at all, and
/// Apple Terminal genuinely is the default — so `None` leaves the built-in
/// order alone rather than guessing.
#[cfg(target_os = "macos")]
fn macos_default_terminal_id() -> Option<ExternalTerminalId> {
    let bundle_id = macos_default_shell_script_handler()?;
    let bundle_id = bundle_id.to_ascii_lowercase();
    MAC_TERMINAL_SPECS
        .iter()
        .find(|spec| spec.bundle_id.eq_ignore_ascii_case(&bundle_id))
        .map(|spec| spec.id)
}

#[cfg(target_os = "macos")]
fn macos_default_shell_script_handler() -> Option<String> {
    let home = home_dir()?;
    let plist = home
        .join("Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    if !plist.is_file() {
        return None;
    }
    // plutil ships with macOS; converting to JSON avoids taking a plist
    // dependency just to read one override list.
    let output = Command::new("/usr/bin/plutil")
        .args(["-convert", "json", "-o", "-", "--"])
        .arg(&plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let json = String::from_utf8(output.stdout).ok()?;
    macos_shell_script_handler_from_json(&json)
}

/// Scans the `LSHandlers` array for the entry that claims shell scripts, by
/// either content type or the `.command` extension, and returns its handler
/// bundle id. Hand-rolled rather than pulling in a JSON crate for one field:
/// the file is a flat array of small string maps.
#[cfg(target_os = "macos")]
fn macos_shell_script_handler_from_json(json: &str) -> Option<String> {
    const MAX_SCANNED_BYTES: usize = 4 * 1024 * 1024;
    let json = json.get(..json.len().min(MAX_SCANNED_BYTES))?;
    let handlers_at = json.find("\"LSHandlers\"")?;
    let mut best: Option<String> = None;
    for entry in json[handlers_at..].split('{').skip(1) {
        let entry = entry.split('}').next().unwrap_or(entry);
        let claims_shell_script = json_string_field(entry, "LSHandlerContentType")
            .is_some_and(|value| value.eq_ignore_ascii_case("com.apple.terminal.shell-script"))
            || json_string_field(entry, "LSHandlerContentTag")
                .is_some_and(|value| value.eq_ignore_ascii_case("command"));
        if !claims_shell_script {
            continue;
        }
        // A shell role is the precise claim; fall back to the all-roles entry.
        if let Some(shell) = json_string_field(entry, "LSHandlerRoleShell") {
            return Some(shell.to_string());
        }
        if best.is_none() {
            best = json_string_field(entry, "LSHandlerRoleAll").map(|value| value.to_string());
        }
    }
    best
}

#[cfg(target_os = "macos")]
fn json_string_field<'a>(entry: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let start = entry.find(&needle)? + needle.len();
    let rest = entry.get(start..)?;
    let colon = rest.find(':')?;
    let after_colon = rest.get(colon + 1..)?;
    let open = after_colon.find('"')?;
    let value = after_colon.get(open + 1..)?;
    let end = value.find('"')?;
    value.get(..end)
}

#[cfg(target_os = "macos")]
fn macos_bundle_registered(bundle_id: &str) -> bool {
    use std::process::Stdio;

    Command::new("/usr/bin/open")
        .args(["-Rb", bundle_id])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(target_os = "macos")]
fn macos_app_at_standard_path(spec: &MacTerminalSpec) -> Option<PathBuf> {
    spec.fixed_paths
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_dir())
        .or_else(|| {
            home_dir()
                .map(|home| home.join("Applications").join(spec.app_name))
                .filter(|path| path.is_dir())
        })
}

#[cfg(target_os = "macos")]
fn macos_ghostty_binary() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from(
        "/Applications/Ghostty.app/Contents/MacOS/ghostty",
    )];
    if let Some(home) = home_dir() {
        candidates.push(
            home.join("Applications")
                .join("Ghostty.app/Contents/MacOS/ghostty"),
        );
    }
    find_executable(&["ghostty"], &candidates)
}

#[cfg(target_os = "macos")]
fn macos_terminal_installed(spec: &MacTerminalSpec) -> bool {
    if spec.id == ExternalTerminalId::Ghostty {
        // Opening directories on macOS arrived in Ghostty 1.3. Older app
        // bundles are installed but cannot honor this feature's cwd contract.
        let version_supported = macos_ghostty_binary()
            .filter(|binary| executable_version_at_least(binary, 1, 3))
            .is_some();
        return version_supported
            && (macos_app_at_standard_path(spec).is_some()
                || macos_bundle_registered(spec.bundle_id));
    }
    macos_app_at_standard_path(spec).is_some() || macos_bundle_registered(spec.bundle_id)
}

#[cfg(target_os = "macos")]
fn macos_wezterm_binary() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from(
        "/Applications/WezTerm.app/Contents/MacOS/wezterm",
    )];
    if let Some(home) = home_dir() {
        candidates.push(
            home.join("Applications")
                .join("WezTerm.app/Contents/MacOS/wezterm"),
        );
    }
    find_executable(&["wezterm"], &candidates)
}

#[cfg(target_os = "macos")]
fn macos_wezterm_app_path() -> Option<PathBuf> {
    [PathBuf::from("/Applications/WezTerm.app")]
        .into_iter()
        .chain(home_dir().map(|home| home.join("Applications/WezTerm.app")))
        .find(|path| path.is_dir())
}

#[cfg(target_os = "macos")]
fn macos_launch_spec(id: ExternalTerminalId, cwd: &Path) -> Result<LaunchSpec, String> {
    if id == ExternalTerminalId::Wezterm {
        let binary =
            macos_wezterm_binary().ok_or_else(|| "external-terminal-not-installed".to_string())?;
        return Ok(LaunchSpec::new(
            binary,
            [OsString::from("start"), OsString::from("--cwd"), cwd.into()],
            cwd,
        ));
    }
    let spec = MAC_TERMINAL_SPECS
        .iter()
        .find(|spec| spec.id == id)
        .ok_or_else(|| "external-terminal-not-supported".to_string())?;
    if !macos_terminal_installed(spec) {
        return Err("external-terminal-not-installed".into());
    }
    Ok(LaunchSpec::new(
        "/usr/bin/open",
        [
            OsString::from("-b"),
            OsString::from(spec.bundle_id),
            cwd.as_os_str().to_os_string(),
        ],
        cwd,
    )
    .with_wait_for_exit())
}

#[cfg(windows)]
fn windows_extra_candidate(relative: &str, env_key: &str) -> Option<PathBuf> {
    std::env::var_os(env_key).map(|root| PathBuf::from(root).join(relative))
}

#[cfg(windows)]
fn windows_terminal_binary() -> Option<PathBuf> {
    let candidates = [windows_extra_candidate(
        r"Microsoft\WindowsApps\wt.exe",
        "LOCALAPPDATA",
    )]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    find_executable(&["wt.exe"], &candidates)
}

#[cfg(windows)]
fn windows_wezterm_binary() -> Option<PathBuf> {
    let candidates = [
        windows_extra_candidate(r"WezTerm\wezterm.exe", "ProgramFiles"),
        windows_extra_candidate(r"Programs\WezTerm\wezterm.exe", "LOCALAPPDATA"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    find_executable(&["wezterm.exe"], &candidates)
}

#[cfg(windows)]
fn windows_cmd_binary() -> Option<PathBuf> {
    let candidates = [windows_extra_candidate(r"System32\cmd.exe", "SystemRoot")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    find_executable(&["cmd.exe"], &candidates)
}

#[cfg(windows)]
fn windows_path_is_unc(path: &Path) -> bool {
    use std::path::{Component, Prefix};

    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..))
    )
}

#[cfg(windows)]
fn installed_windows_external_terminals() -> Vec<ExternalTerminalApp> {
    let mut apps = Vec::new();
    if windows_terminal_binary().is_some() {
        apps.push(ExternalTerminalApp::new(
            ExternalTerminalId::WindowsTerminal,
            "Windows Terminal",
        ));
    }
    if windows_wezterm_binary().is_some() {
        apps.push(ExternalTerminalApp::new(
            ExternalTerminalId::Wezterm,
            "WezTerm",
        ));
    }
    if windows_cmd_binary().is_some() {
        apps.push(ExternalTerminalApp::new(
            ExternalTerminalId::SystemTerminal,
            "Command Prompt",
        ));
    }
    apps
}

#[cfg(windows)]
fn windows_launch_spec(id: ExternalTerminalId, cwd: &Path) -> Result<LaunchSpec, String> {
    match id {
        ExternalTerminalId::WindowsTerminal => Ok(LaunchSpec::new(
            windows_terminal_binary()
                .ok_or_else(|| "external-terminal-not-installed".to_string())?,
            [
                OsString::from("-w"),
                OsString::from("-1"),
                OsString::from("new-tab"),
                OsString::from("-d"),
                cwd.into(),
            ],
            cwd,
        )),
        ExternalTerminalId::Wezterm => Ok(LaunchSpec::new(
            windows_wezterm_binary()
                .ok_or_else(|| "external-terminal-not-installed".to_string())?,
            [OsString::from("start"), OsString::from("--cwd"), cwd.into()],
            cwd,
        )),
        ExternalTerminalId::SystemTerminal => {
            // cmd.exe cannot use a UNC current directory and silently falls
            // back elsewhere. Fail instead of opening in the wrong folder;
            // Windows Terminal and WezTerm continue to accept UNC paths.
            if windows_path_is_unc(cwd) {
                return Err("external-terminal-cwd-unsupported".into());
            }
            Ok(LaunchSpec::new(
                windows_cmd_binary()
                    .ok_or_else(|| "external-terminal-not-installed".to_string())?,
                std::iter::empty::<OsString>(),
                cwd,
            )
            .with_new_console())
        }
        _ => Err("external-terminal-not-supported".into()),
    }
}

#[cfg(target_os = "linux")]
fn linux_terminal_binary(name: &str) -> Option<PathBuf> {
    find_executable(&[name], &[])
}

#[cfg(target_os = "linux")]
fn installed_linux_external_terminals() -> Vec<ExternalTerminalApp> {
    let mut apps = Vec::new();
    if linux_terminal_binary("xdg-terminal-exec").is_some() {
        apps.push(ExternalTerminalApp::new(
            ExternalTerminalId::SystemTerminal,
            "System Terminal",
        ));
    }
    if linux_terminal_binary("ghostty")
        .filter(|binary| executable_version_at_least(binary, 1, 3))
        .is_some()
    {
        apps.push(ExternalTerminalApp::new(
            ExternalTerminalId::Ghostty,
            "Ghostty",
        ));
    }
    if linux_terminal_binary("wezterm").is_some() {
        apps.push(ExternalTerminalApp::new(
            ExternalTerminalId::Wezterm,
            "WezTerm",
        ));
    }
    apps
}

#[cfg(target_os = "linux")]
fn linux_launch_spec(id: ExternalTerminalId, cwd: &Path) -> Result<LaunchSpec, String> {
    match id {
        ExternalTerminalId::SystemTerminal => Ok(LaunchSpec::new(
            linux_terminal_binary("xdg-terminal-exec")
                .ok_or_else(|| "external-terminal-not-installed".to_string())?,
            [option_with_path("--dir=", cwd)],
            cwd,
        )),
        ExternalTerminalId::Ghostty => {
            let binary = linux_terminal_binary("ghostty")
                .filter(|binary| executable_version_at_least(binary, 1, 3))
                .ok_or_else(|| "external-terminal-not-installed".to_string())?;
            Ok(LaunchSpec::new(
                binary,
                [
                    OsString::from("+new-window"),
                    option_with_path("--working-directory=", cwd),
                ],
                cwd,
            ))
        }
        ExternalTerminalId::Wezterm => Ok(LaunchSpec::new(
            linux_terminal_binary("wezterm")
                .ok_or_else(|| "external-terminal-not-installed".to_string())?,
            [
                OsString::from("start"),
                OsString::from("--cwd"),
                cwd.as_os_str().to_os_string(),
            ],
            cwd,
        )),
        _ => Err("external-terminal-not-supported".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_the_shell_script_handler_from_launch_services() {
        // Shape of the real plist after `plutil -convert json`: a flat array of
        // handler maps, most of them for unrelated content types.
        let json = r#"{"LSHandlers":[
            {"LSHandlerContentType":"public.html","LSHandlerRoleAll":"com.apple.safari"},
            {"LSHandlerContentType":"com.apple.terminal.shell-script","LSHandlerRoleShell":"com.mitchellh.ghostty"}
        ]}"#;
        assert_eq!(
            macos_shell_script_handler_from_json(json).as_deref(),
            Some("com.mitchellh.ghostty"),
        );

        // The `.command` extension is the other way a terminal claims the role.
        let by_extension = r#"{"LSHandlers":[
            {"LSHandlerContentTag":"command","LSHandlerContentTagClass":"public.filename-extension","LSHandlerRoleAll":"com.googlecode.iterm2"}
        ]}"#;
        assert_eq!(
            macos_shell_script_handler_from_json(by_extension).as_deref(),
            Some("com.googlecode.iterm2"),
        );

        // No claim at all: Apple Terminal really is the default, so report
        // nothing and leave the built-in order untouched.
        let unrelated = r#"{"LSHandlers":[{"LSHandlerContentType":"public.html","LSHandlerRoleAll":"com.apple.safari"}]}"#;
        assert!(macos_shell_script_handler_from_json(unrelated).is_none());
        assert!(macos_shell_script_handler_from_json("{}").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn maps_a_handler_bundle_id_to_a_known_terminal() {
        let json = r#"{"LSHandlers":[
            {"LSHandlerContentType":"com.apple.terminal.shell-script","LSHandlerRoleShell":"com.example.unknown-terminal"}
        ]}"#;
        // An unknown handler must not match one of ours by accident.
        let bundle = macos_shell_script_handler_from_json(json).unwrap();
        assert!(MAC_TERMINAL_SPECS
            .iter()
            .all(|spec| !spec.bundle_id.eq_ignore_ascii_case(&bundle)));
    }

    fn test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "shiori-external-terminal-{label}-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ids_are_a_closed_allowlist() {
        for id in [
            "terminal",
            "ghostty",
            "iterm2",
            "wezterm",
            "windowsTerminal",
            "systemTerminal",
        ] {
            assert_eq!(ExternalTerminalId::parse(id).unwrap().id(), id);
        }
        for value in [
            "",
            "Ghostty",
            "ghostty; rm -rf /",
            "../../bin/zsh",
            "systemTerminal --args",
        ] {
            assert_eq!(
                ExternalTerminalId::parse(value).unwrap_err(),
                "external-terminal-unknown-id"
            );
        }
    }

    #[test]
    fn response_serializes_the_optional_icon_with_a_camel_case_key() {
        let mut app = ExternalTerminalApp::new(ExternalTerminalId::Ghostty, "Ghostty");
        app.icon_data_url = Some("data:image/png;base64,iVBORw0KGgo=".into());
        assert_eq!(
            serde_json::to_value(app).unwrap(),
            serde_json::json!({
                "id": "ghostty",
                "name": "Ghostty",
                "iconDataUrl": "data:image/png;base64,iVBORw0KGgo="
            })
        );
    }

    #[test]
    fn declared_macos_icon_names_cannot_escape_the_resources_directory() {
        assert_eq!(
            normalized_macos_icon_file_name("Ghostty"),
            Some("Ghostty.icns".into())
        );
        assert_eq!(
            normalized_macos_icon_file_name("Terminal.icns"),
            Some("Terminal.icns".into())
        );
        for raw in ["", ".", "..", "../secret", "/tmp/icon", "dir\\icon"] {
            assert_eq!(normalized_macos_icon_file_name(raw), None);
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_system_terminal_exposes_its_bundle_icon_as_a_bounded_png() {
        let spec = MAC_TERMINAL_SPECS
            .iter()
            .find(|spec| spec.id == ExternalTerminalId::Terminal)
            .unwrap();
        let app_bundle = macos_app_at_standard_path(spec).unwrap();
        let source = macos_app_icon_path(&app_bundle).unwrap();
        assert_eq!(
            source.extension().and_then(|extension| extension.to_str()),
            Some("icns")
        );
        let data_url = macos_app_icon_data_url(&app_bundle).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,iVBORw0KGgo"));
        assert!(data_url.len() < MAX_MACOS_ICON_PNG_BYTES * 2);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_standard_ghostty_exposes_its_bundle_icon_when_installed() {
        let spec = MAC_TERMINAL_SPECS
            .iter()
            .find(|spec| spec.id == ExternalTerminalId::Ghostty)
            .unwrap();
        let Some(app_bundle) = macos_app_at_standard_path(spec) else {
            return;
        };
        let data_url = macos_app_icon_data_url(&app_bundle).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,iVBORw0KGgo"));
        assert!(data_url.len() < MAX_MACOS_ICON_PNG_BYTES * 2);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_icon_temp_directory_is_removed_on_drop() {
        let temp_dir = MacosIconTempDir::create().unwrap();
        let path = temp_dir.path.clone();
        assert!(path.is_dir());
        drop(temp_dir);
        assert!(!path.exists());
    }

    #[test]
    fn cwd_requires_an_existing_absolute_directory() {
        let dir = test_dir("cwd");
        let file = dir.join("note.pdf");
        fs::write(&file, b"pdf").unwrap();

        assert_eq!(
            resolve_external_terminal_cwd_with(Some(dir.to_string_lossy().into()), || None)
                .unwrap(),
            dir
        );
        assert_eq!(
            resolve_external_terminal_cwd_with(Some("relative".into()), || None).unwrap_err(),
            "external-terminal-cwd-not-absolute"
        );
        assert_eq!(
            resolve_external_terminal_cwd_with(Some(file.to_string_lossy().into()), || None)
                .unwrap_err(),
            "external-terminal-cwd-not-directory"
        );
        assert_eq!(
            resolve_external_terminal_cwd_with(
                Some(dir.join("missing").to_string_lossy().into()),
                || None
            )
            .unwrap_err(),
            "external-terminal-cwd-unavailable"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cwd_preserves_unicode_spaces_and_default_semantics() {
        let parent = test_dir("unicode");
        let dir = parent.join("项目 folder ");
        fs::create_dir_all(&dir).unwrap();
        let raw = dir.to_string_lossy().into_owned();

        assert_eq!(
            resolve_external_terminal_cwd_with(Some(raw.clone()), || None).unwrap(),
            PathBuf::from(&raw)
        );
        assert_eq!(
            resolve_external_terminal_cwd_with(Some("   ".into()), || Some(dir.clone())).unwrap(),
            dir
        );
        assert_eq!(
            resolve_external_terminal_cwd_with(None, || None).unwrap_err(),
            "external-terminal-cwd-unavailable"
        );
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn version_gate_rejects_ghostty_before_directory_launch_support() {
        assert!(!version_at_least("Ghostty 1.2.3", 1, 3));
        assert!(version_at_least("Ghostty 1.3.0", 1, 3));
        assert!(version_at_least(
            "Ghostty 1.3.1\nVersion\n  - channel: stable",
            1,
            3
        ));
        assert!(version_at_least("ghostty 2.0.0-dev", 1, 3));
        assert!(!version_at_least("version unknown", 1, 3));
    }

    #[test]
    fn option_argv_preserves_shell_metacharacters_as_data() {
        let cwd = PathBuf::from("/tmp/项目; $(touch nope) && folder ");
        let argument = option_with_path("--working-directory=", &cwd);
        let launch = LaunchSpec::new(
            "/usr/bin/ghostty",
            [OsString::from("+new-window"), argument.clone()],
            &cwd,
        );

        let mut expected = OsString::from("--working-directory=");
        expected.push(cwd.as_os_str());
        assert_eq!(argument, expected);
        assert_eq!(launch.args.len(), 2);
        assert_eq!(launch.args[1], expected);
        assert!(!launch.args.iter().any(|arg| arg == "sh" || arg == "-c"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn macos_launch_spec_uses_bundle_id_and_argv_not_a_shell() {
        let cwd = test_dir("mac-spec");
        let spec = MAC_TERMINAL_SPECS
            .iter()
            .find(|spec| spec.id == ExternalTerminalId::Ghostty)
            .unwrap();
        let launch = LaunchSpec::new(
            "/usr/bin/open",
            [
                OsString::from("-b"),
                OsString::from(spec.bundle_id),
                cwd.as_os_str().to_os_string(),
            ],
            &cwd,
        )
        .with_wait_for_exit();
        assert_eq!(launch.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(
            launch.args,
            vec![
                OsString::from("-b"),
                OsString::from("com.mitchellh.ghostty"),
                cwd.as_os_str().to_os_string(),
            ]
        );
        assert!(!launch.args.iter().any(|arg| arg == "sh" || arg == "-c"));
        assert!(launch.wait_for_exit);
        let _ = fs::remove_dir_all(&cwd);
    }
}
