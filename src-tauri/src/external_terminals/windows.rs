// Windows launchers for "Open in external terminal": Windows Terminal,
// WezTerm and Command Prompt.

#[cfg(windows)]
use super::{find_executable, ExternalTerminalApp, ExternalTerminalId, LaunchSpec};
#[cfg(windows)]
use std::path::PathBuf;
use std::{ffi::OsString, path::Path};

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
pub(super) fn installed_windows_external_terminals() -> Vec<ExternalTerminalApp> {
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

// wt.exe parses its own command line and starts a new subcommand at every
// ';' not preceded by '\', even inside one quoted argument; argv quoting
// cannot stop that. Escape each ';' in the folder as '\;', which wt turns
// back into ';'.
fn windows_terminal_args(cwd: &Path) -> Result<Vec<OsString>, String> {
    let directory = if cwd.as_os_str().as_encoded_bytes().contains(&b';') {
        let text = cwd
            .to_str()
            .ok_or_else(|| "external-terminal-cwd-unsupported".to_string())?;
        OsString::from(text.replace(';', r"\;"))
    } else {
        cwd.into()
    };
    Ok(vec![
        OsString::from("-w"),
        OsString::from("-1"),
        OsString::from("new-tab"),
        OsString::from("-d"),
        directory,
    ])
}

#[cfg(windows)]
pub(super) fn windows_launch_spec(
    id: ExternalTerminalId,
    cwd: &Path,
) -> Result<LaunchSpec, String> {
    match id {
        ExternalTerminalId::WindowsTerminal => Ok(LaunchSpec::new(
            windows_terminal_binary()
                .ok_or_else(|| "external-terminal-not-installed".to_string())?,
            windows_terminal_args(cwd)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn directory_arg(cwd: &str) -> OsString {
        windows_terminal_args(Path::new(cwd)).unwrap().remove(4)
    }

    // B020: wt.exe starts a new subcommand at every ';' not preceded by '\',
    // even inside one quoted argv element, so `C:\papers\x;calc` would open
    // a tab in C:\papers\x and then run `calc`.
    #[test]
    fn windows_terminal_keeps_a_semicolon_in_the_folder_as_data() {
        assert_eq!(
            windows_terminal_args(Path::new(r"C:\papers\x;calc")).unwrap(),
            ["-w", "-1", "new-tab", "-d", r"C:\papers\x\;calc"].map(OsString::from),
        );
        assert_eq!(directory_arg(r"C:\a;;b"), r"C:\a\;\;b");
        // A folder named ";b": wt removes only the escape it reads.
        assert_eq!(directory_arg(r"C:\a\;b"), r"C:\a\\;b");
        // Without a ';' the folder passes through untouched.
        assert_eq!(directory_arg(r"C:\项目 folder "), r"C:\项目 folder ");
    }
}
