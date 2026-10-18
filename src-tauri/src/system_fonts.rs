use fontdb::Database;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const FONT_FAMILY_MAX_LENGTH: usize = 128;
const FONT_FAMILY_LIMIT: usize = 4096;
const FONT_ALIAS_LIMIT: usize = 16;
const SYSTEM_FONT_CACHE_TTL: Duration = Duration::from_secs(60);

static SYSTEM_FONT_CACHE: OnceLock<Mutex<Option<CachedSystemFonts>>> = OnceLock::new();

struct CachedSystemFonts {
    scanned_at: Instant,
    fonts: Vec<SystemFontFamily>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemFontFamily {
    pub(crate) family: String,
    pub(crate) aliases: Vec<String>,
    pub(crate) monospaced: bool,
}

pub(crate) fn installed_system_fonts() -> Vec<SystemFontFamily> {
    let cache = SYSTEM_FONT_CACHE.get_or_init(|| Mutex::new(None));
    let mut cached = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = cached.as_ref() {
        if existing.scanned_at.elapsed() < SYSTEM_FONT_CACHE_TTL {
            return existing.fonts.clone();
        }
    }
    let fonts = scan_system_fonts();
    *cached = Some(CachedSystemFonts {
        scanned_at: Instant::now(),
        fonts: fonts.clone(),
    });
    fonts
}

fn scan_system_fonts() -> Vec<SystemFontFamily> {
    let mut database = Database::new();
    database.load_system_fonts();
    aggregate_faces(database.faces().filter_map(|face| {
        let families = face
            .families
            .iter()
            .map(|(family, _language)| family.clone())
            .collect::<Vec<_>>();
        (!families.is_empty()).then_some((families, face.monospaced))
    }))
}

fn valid_family(family: &str) -> bool {
    !family.is_empty()
        // macOS exposes many dot-prefixed private UI/fallback families. They
        // are implementation details rather than user-selectable fonts and
        // otherwise swamp the top of the alphabetical picker.
        && !family.starts_with('.')
        && family.trim() == family
        && family.chars().count() <= FONT_FAMILY_MAX_LENGTH
        && !family
            .chars()
            .any(|character| character.is_control() || disallowed_format_character(character))
}

fn disallowed_format_character(character: char) -> bool {
    matches!(
        character as u32,
        0x061c | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x206f | 0xfeff
    )
}

fn aggregate_faces(faces: impl IntoIterator<Item = (Vec<String>, bool)>) -> Vec<SystemFontFamily> {
    let mut families = BTreeMap::<String, SystemFontFamily>::new();
    for (names, monospaced) in faces {
        let valid_names = names
            .into_iter()
            .filter(|name| valid_family(name))
            .collect::<Vec<_>>();
        let Some(canonical) = valid_names.first() else {
            continue;
        };
        let key = canonical.to_lowercase();
        let entry = families.entry(key).or_insert_with(|| SystemFontFamily {
            family: canonical.clone(),
            aliases: Vec::new(),
            monospaced: false,
        });
        entry.monospaced |= monospaced;

        let canonical_key = entry.family.to_lowercase();
        let mut aliases = entry
            .aliases
            .iter()
            .cloned()
            .map(|alias| (alias.to_lowercase(), alias))
            .collect::<BTreeMap<_, _>>();
        for alias in valid_names.into_iter().skip(1) {
            let alias_key = alias.to_lowercase();
            if alias_key != canonical_key {
                aliases.entry(alias_key).or_insert(alias);
            }
        }
        entry.aliases = aliases.into_values().take(FONT_ALIAS_LIMIT).collect();
    }

    let mut result = families.into_values().collect::<Vec<_>>();
    result.sort_by(|left, right| {
        left.family
            .to_lowercase()
            .cmp(&right.family.to_lowercase())
            .then_with(|| left.family.cmp(&right.family))
    });
    result.truncate(FONT_FAMILY_LIMIT);
    result
}

#[cfg(test)]
mod tests {
    use super::{aggregate_faces, SystemFontFamily, FONT_FAMILY_MAX_LENGTH};

    #[test]
    fn aggregates_faces_aliases_and_monospace_metadata() {
        let fonts = aggregate_faces([
            (vec!["Example Sans".into(), "示例黑体".into()], false),
            (
                vec!["Example Sans".into(), "示例黑体".into(), "Ex Sans".into()],
                true,
            ),
            (vec!["Alpha Serif".into()], false),
        ]);

        assert_eq!(
            fonts,
            vec![
                SystemFontFamily {
                    family: "Alpha Serif".into(),
                    aliases: vec![],
                    monospaced: false,
                },
                SystemFontFamily {
                    family: "Example Sans".into(),
                    aliases: vec!["Ex Sans".into(), "示例黑体".into()],
                    monospaced: true,
                },
            ]
        );
    }

    #[test]
    fn filters_unsafe_names_and_keeps_stable_order() {
        let fonts = aggregate_faces([
            (vec![" zeta ".into()], false),
            (vec![".Private UI Font".into()], false),
            (vec!["Beta".into()], false),
            (vec!["Alpha\nInjected".into()], false),
            (vec!["Safe\u{202e}spoofed".into()], false),
            (vec!["A".repeat(FONT_FAMILY_MAX_LENGTH + 1)], false),
            (vec!["alpha".into()], false),
        ]);

        assert_eq!(
            fonts
                .into_iter()
                .map(|font| font.family)
                .collect::<Vec<_>>(),
            vec!["alpha", "Beta"]
        );
    }
}
