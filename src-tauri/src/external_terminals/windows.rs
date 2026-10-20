// Windows launchers for "Open in external terminal": Windows Terminal,
// WezTerm and Command Prompt.

#[cfg(windows)]
use super::{find_executable, ExternalTerminalApp, ExternalTerminalId, LaunchSpec};
#[cfg(windows)]
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

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

#[cfg(windows)]
pub(super) fn windows_launch_spec(
    id: ExternalTerminalId,
    cwd: &Path,
) -> Result<LaunchSpec, String> {
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
