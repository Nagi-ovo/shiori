use serde::Serialize;
use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCliAvailability {
    pub(crate) claude_code: bool,
    pub(crate) codex: bool,
}

/// Detect the local agent CLIs without launching them or evaluating the user's
/// shell profile. Finder/Dock launches inherit a sparse PATH, so the probe also
/// covers the standard user-level package-manager locations on every desktop.
pub(crate) fn installed_agent_clis() -> AgentCliAvailability {
    let directories = executable_search_directories();
    detect_agent_clis_in_directories(&directories, executable_file_exists)
}

fn detect_agent_clis_in_directories(
    directories: &[PathBuf],
    exists: impl Fn(&Path) -> bool,
) -> AgentCliAvailability {
    AgentCliAvailability {
        claude_code: executable_exists_in("claude", directories, &exists),
        codex: executable_exists_in("codex", directories, &exists),
    }
}

fn executable_exists_in(
    name: &str,
    directories: &[PathBuf],
    exists: &impl Fn(&Path) -> bool,
) -> bool {
    directories.iter().any(|directory| {
        executable_names(name)
            .iter()
            .any(|candidate| exists(&directory.join(candidate)))
    })
}

#[cfg(windows)]
fn executable_names(name: &str) -> Vec<String> {
    [".exe", ".cmd", ".bat", ""]
        .iter()
        .map(|extension| format!("{name}{extension}"))
        .collect()
}

#[cfg(not(windows))]
fn executable_names(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

fn executable_search_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut seen = HashSet::new();
    if let Some(path) = env::var_os("PATH") {
        for directory in env::split_paths(&path) {
            push_unique(&mut directories, &mut seen, directory);
        }
    }

    #[cfg(unix)]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        push_unique(&mut directories, &mut seen, PathBuf::from(directory));
    }

    if let Some(home) = home_dir() {
        for relative in [
            ".local/bin",
            ".bun/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".local/share/pnpm",
            "Library/pnpm",
        ] {
            push_unique(&mut directories, &mut seen, home.join(relative));
        }
        push_child_bin_directories(
            &home.join(".nvm/versions/node"),
            "bin",
            &mut directories,
            &mut seen,
        );
        push_child_bin_directories(
            &home.join(".local/share/fnm/node-versions"),
            "installation/bin",
            &mut directories,
            &mut seen,
        );
    }

    #[cfg(windows)]
    if let Some(app_data) = env::var_os("APPDATA") {
        push_unique(
            &mut directories,
            &mut seen,
            PathBuf::from(app_data).join("npm"),
        );
    }

    directories
}

fn push_child_bin_directories(
    root: &Path,
    suffix: &str,
    directories: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            push_unique(directories, seen, path.join(suffix));
        }
    }
}

fn push_unique(directories: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, directory: PathBuf) {
    if directory.as_os_str().is_empty() || !seen.insert(directory.clone()) {
        return;
    }
    directories.push(directory);
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .or_else(|| {
            let drive = env::var_os("HOMEDRIVE")?;
            let path = env::var_os("HOMEPATH")?;
            let mut joined = PathBuf::from(drive);
            joined.push(path);
            Some(joined.into_os_string())
        })
        .map(PathBuf::from)
}

fn executable_file_exists(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    return metadata.permissions().mode() & 0o111 != 0;
    #[cfg(not(unix))]
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_claude_and_codex_independently() {
        let directories = vec![PathBuf::from("/tools/a"), PathBuf::from("/tools/b")];
        let availability = detect_agent_clis_in_directories(&directories, |candidate| {
            let Some(parent) = candidate.parent() else {
                return false;
            };
            let Some(stem) = candidate.file_stem().and_then(|value| value.to_str()) else {
                return false;
            };
            (parent == Path::new("/tools/a") && stem == "claude")
                || (parent == Path::new("/tools/b") && stem == "codex")
        });

        assert_eq!(
            availability,
            AgentCliAvailability {
                claude_code: true,
                codex: true,
            }
        );
        assert!(availability.claude_code || availability.codex);
    }

    #[test]
    fn reports_unavailable_when_neither_executable_exists() {
        let availability = detect_agent_clis_in_directories(&[PathBuf::from("/tools")], |_| false);
        assert_eq!(availability, AgentCliAvailability::default());
        assert!(!availability.claude_code && !availability.codex);
    }
}
