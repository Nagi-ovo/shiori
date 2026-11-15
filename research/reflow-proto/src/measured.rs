//! L1 measured-cluster breaker. PDF advances/ink are supplied by TS; this
//! module never opens a font, discovers OS fonts or parses Type1/Type3.
use crate::metrics::Token;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use unicode_segmentation::UnicodeSegmentation;

const CLOSE: &str = "，。、；：？！）］｝〉》」』】〕’”％‰,.!?;:%)]}";
const OPEN: &str = "（［｛〈《「『【〔‘“([{";
const FIT_EPSILON: f64 = 1e-7;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct LineSlot {
    pub baseline: f64,
    pub left: f64,
    pub right: f64,
}

#[derive(Debug)]
pub struct MeasuredLayout {
    pub ranges: Vec<(usize, usize)>,
    /// No destination origin is returned for diagnostic overflow rows.
    pub origins: Vec<Option<[f64; 2]>>,
    pub break_failure: bool,
}

pub fn legal_break(left: &str, right: &str) -> bool {
    !left.chars().last().is_some_and(|c| OPEN.contains(c))
        && !right.chars().next().is_some_and(|c| CLOSE.contains(c))
}

pub fn opportunities(tokens: &[Token]) -> HashSet<usize> {
    let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
    let uax: HashSet<usize> = unicode_linebreak::linebreaks(&text)
        .map(|(n, _)| n)
        .collect();
    let grapheme_ends: HashSet<usize> = text
        .grapheme_indices(true)
        .map(|(i, g)| i + g.len())
        .collect();
    let mut offset = 0;
    let mut breaks = HashSet::new();
    for (i, t) in tokens.iter().enumerate() {
        offset += t.text.len();
        if i + 1 == tokens.len()
            || (uax.contains(&offset)
                && grapheme_ends.contains(&offset)
                && legal_break(&t.text, &tokens[i + 1].text))
        {
            breaks.insert(i + 1);
        }
    }
    breaks
}

fn retained_gap(tokens: &[Token], i: usize) -> f64 {
    let t = &tokens[i];
    if i + 1 < tokens.len() && t.source.is_some() && tokens[i + 1].source == t.source.map(|s| s + 1)
    {
        t.gap
    } else {
        0.
    }
}

/// Diagnostic UAX14/prohibition-filter layout, consuming EACH slot's bounds.
/// R7/L2 must additionally intersect the §4.6 whitelist and prove numeric TJ
/// boundary ownership before production. Required overflow rows reuse only the
/// final capacity to count demand; they are never granted a new baseline.
pub fn break_measured(tokens: &[Token], slots: &[LineSlot]) -> Result<MeasuredLayout, String> {
    if slots.is_empty()
        || slots.iter().any(|s| {
            !s.left.is_finite()
                || !s.right.is_finite()
                || !s.baseline.is_finite()
                || s.left >= s.right
        })
        || slots.windows(2).any(|s| s[0].baseline <= s[1].baseline)
    {
        return Err("invalid line slots".into());
    }
    if tokens.iter().any(|t| {
        t.text.is_empty()
            || !t.advance.is_finite()
            || t.advance < 0.
            || !t.gap.is_finite()
            || t.ink.iter().any(|x| !x.is_finite())
            || t.ink[0] > t.ink[2]
            || t.ink[1] > t.ink[3]
    }) {
        return Err("invalid measured cluster".into());
    }
    let text: String = tokens.iter().map(|t| t.text.as_str()).collect();
    if unicode_bidi::BidiInfo::new(&text, None)
        .levels
        .iter()
        .any(|l| l.is_rtl())
        || text.chars().any(|c| {
            matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err("bidi outside stage scope".into());
    }
    let legal = opportunities(tokens);
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut break_failure = false;
    while start < tokens.len() {
        let row = ranges.len();
        let slot = &slots[row.min(slots.len() - 1)];
        let mut x = slot.left;
        let mut last_break = None;
        let mut end = start;
        while end < tokens.len() {
            let t = &tokens[end];
            if x + t.advance.max(t.ink[2]) > slot.right + FIT_EPSILON {
                break;
            }
            x += t.advance + retained_gap(tokens, end);
            end += 1;
            if legal.contains(&end) {
                last_break = Some(end);
            }
        }
        if end < tokens.len() {
            end = last_break.unwrap_or(start);
        }
        if end == start {
            break_failure = true;
            break;
        }
        ranges.push((start, end));
        start = end;
    }
    let mut origins = vec![None; tokens.len()];
    for (row, (a, b)) in ranges.iter().copied().enumerate() {
        if let Some(slot) = slots.get(row) {
            let mut x = slot.left;
            for i in a..b {
                origins[i] = Some([x, slot.baseline]);
                x += tokens[i].advance + retained_gap(tokens, i);
            }
        }
    }
    Ok(MeasuredLayout {
        ranges,
        origins,
        break_failure,
    })
}

#[cfg(test)]
#[path = "measured_tests.rs"]
mod tests;
