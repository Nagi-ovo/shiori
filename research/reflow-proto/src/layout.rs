use crate::measured::{LineSlot, break_measured, legal_break, opportunities};
use crate::metrics::{Fonts, Token, num};
use serde_json::{Value, json};
use unicode_segmentation::UnicodeSegmentation;

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len().max(1) as f64
}
fn max(values: &[f64]) -> f64 {
    values.iter().copied().fold(0., f64::max)
}

pub fn run(sample: &Value, edit: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let chinese = sample["id"].as_str().unwrap().starts_with("zh");
    let fonts = Fonts::load(sample, chinese)?;
    let raw = sample["glyphs"].as_array().unwrap();
    let original: Vec<Token> = raw
        .iter()
        .enumerate()
        .map(|(i, g)| fonts.source(g, i))
        .collect();
    let original_text = sample["original"].as_str().unwrap();
    let bidi = unicode_bidi::BidiInfo::new(original_text, None);
    if bidi.levels.iter().any(|l| l.is_rtl()) {
        return Err("bidi outside stage scope".into());
    }
    // Chinese: fixed token boundary 8 (can split a word). English: first space.
    // Deletion uses the first matching Chinese word / a real first-line word.
    let mut at = if chinese {
        8.min(original.len())
    } else {
        original.iter().position(|t| t.text == " ").unwrap_or(6) + 1
    };
    let mut remove = 0;
    let phrase = if chinese {
        "在实际应用中"
    } else {
        "carefully "
    };
    let insert = match edit {
        "identity" => {
            at = original.len();
            String::new()
        }
        "delete" => {
            if chinese {
                at = original_text
                    .find("人工智能")
                    .map(|b| original_text[..b].chars().count())
                    .unwrap_or(at);
                remove = 4;
            } else {
                remove = original[at..]
                    .iter()
                    .position(|t| t.text == " ")
                    .unwrap_or(1)
                    + 1;
            }
            String::new()
        }
        "insert" => phrase.into(),
        "+10%" | "+30%" => {
            let ratio = if edit == "+10%" { 0.10 } else { 0.30 };
            let target = (original_text.chars().count() as f64 * ratio).round() as usize;
            let prose = if chinese {
                "这也需要结合具体情况进行分析，并在实践中持续改进。"
            } else {
                "with further analysis of the available evidence and practical implications "
            };
            let mut s = prose.repeat(target / prose.chars().count() + 2);
            if chinese {
                s = s.chars().take(target).collect();
            } else {
                let cut = s
                    .char_indices()
                    .filter(|(_, c)| *c == ' ')
                    .map(|(i, _)| i + 1)
                    .min_by_key(|i| i.abs_diff(target))
                    .unwrap_or(target);
                s.truncate(cut);
            }
            s
        }
        _ => unreachable!(),
    };
    let style = &raw[at.min(raw.len() - 1)];
    let mut tokens = original[..at].to_vec();
    let mut shaping_failure = None;
    for cluster in insert.graphemes(true) {
        match fonts.replacement(cluster, style, sample) {
            Ok(t) => tokens.push(t),
            Err(e) => {
                shaping_failure = Some(e);
                break;
            }
        }
    }
    tokens.extend_from_slice(&original[(at + remove).min(original.len())..]);
    let expected_text = tokens.iter().map(|t| t.text.as_str()).collect::<String>();
    let slots = sample["slots"].as_array().unwrap();
    let measured_slots: Vec<LineSlot> = serde_json::from_value(sample["slots"].clone())?;
    let mut measured_origins = Vec::new();
    let mut ranges = Vec::new();
    let mut start = 0;
    let mut break_failure = false;
    if edit == "identity" || edit == "delete" {
        // §4.1: ordinary deletions retain suffix origins and original gaps.
        for row in 0..slots.len() {
            let end = (start..tokens.len())
                .find(|i| {
                    tokens[*i]
                        .source
                        .is_some_and(|s| num(&raw[s], "row") as usize > row)
                })
                .unwrap_or(tokens.len());
            ranges.push((start, end));
            start = end;
        }
    } else {
        let layout = break_measured(&tokens, &measured_slots)?;
        ranges = layout.ranges;
        measured_origins = layout.origins;
        break_failure = layout.break_failure;
    }
    let mut positioned = Vec::new();
    let mut outside_ink = 0;
    let mut prohibition_breaks = 0;
    let mut baseline_drift = Vec::new();
    let mut stationary_native_drift = Vec::new();
    for (row, (a, b)) in ranges.iter().copied().enumerate() {
        let slot = slots.get(row);
        let mut x = slot.map(|s| num(s, "left")).unwrap_or(0.);
        for i in a..b {
            let t = &tokens[i];
            let mut y = slot.map(|s| num(s, "baseline"));
            if edit != "identity" && edit != "delete" {
                x = measured_origins[i].map(|p| p[0]).unwrap_or(0.);
                y = measured_origins[i].map(|p| p[1]);
            }
            if edit == "identity" || edit == "delete" {
                // Inferred spaces have no source address; debug only.
                if let Some(src) = t.source {
                    x = num(&raw[src], "x");
                    y = Some(num(&raw[src], "y"));
                }
            }
            if let Some(src) = t.source {
                if num(&raw[src], "row") as usize == row
                    && let Some(y) = y
                {
                    baseline_drift.push((y - num(&raw[src], "y")).abs());
                }
                if (edit == "identity" || edit == "delete" || src < at)
                    && !raw[src]["nativeOrigin"].is_null()
                {
                    stationary_native_drift
                        .push((x - raw[src]["nativeOrigin"][0].as_f64().unwrap()).abs());
                }
            }
            let ink = y.map(|y| [x + t.ink[0], y + t.ink[1], x + t.ink[2], y + t.ink[3]]);
            if let Some(ink) = ink {
                let bb = &sample["box"];
                if ink[0] < bb[0].as_f64().unwrap() - 0.005
                    || ink[1] < bb[1].as_f64().unwrap() - 0.005
                    || ink[2] > bb[2].as_f64().unwrap() + 0.005
                    || ink[3] > bb[3].as_f64().unwrap() + 0.005
                {
                    outside_ink += 1;
                }
            }
            positioned.push(json!({ "text": t.text, "source_index": t.source, "font": t.font,
                "gid": t.gid, "origin": y.map(|y| [x,y]), "advance": t.advance, "ink": ink, "row": row }));
            x += t.advance;
            if i + 1 < b && t.source.is_some() && tokens[i + 1].source == t.source.map(|s| s + 1) {
                x += t.gap;
            }
        }
        if b < tokens.len() && !legal_break(&tokens[b - 1].text, &tokens[b].text) {
            prohibition_breaks += 1;
        }
    }
    let pdf_errors: Vec<f64> = tokens.iter().filter_map(|t| t.pdf_error).collect();
    let raw_errors: Vec<f64> = tokens.iter().filter_map(|t| t.raw_error).collect();
    let mut notes = Vec::new();
    if num(sample, "stroke_geometry_only_ops") > 0. {
        notes.push("research extraction neutralizes Tr 1/2 for advances only; stroke paint semantics remain unsupported".into());
    }
    if ranges.len() > slots.len() {
        notes.push("wrap overflow: no additional baseline is authorised".to_string());
    }
    if break_failure {
        notes.push("reflow-break-unsupported (unbreakable span exceeds slot)".into());
    }
    if outside_ink > 0 {
        notes.push(format!("{outside_ink} ink envelopes outside fixed box"));
    }
    if let Some(e) = shaping_failure.as_ref() {
        notes.push(e.clone());
    }
    let left = slots
        .iter()
        .map(|s| num(s, "left"))
        .fold(f64::INFINITY, f64::min);
    if num(&slots[0], "left") - left > 0.5 {
        notes.push(format!(
            "first-line indent retained: first slot {:.3} vs body {:.3} pt; geometry alone is not RegionProof",
            num(&slots[0], "left"),
            left
        ));
    }
    if slots.len() > 8 {
        notes.push(format!(
            "{} source lines exceed Stage-5 eight-line cap",
            slots.len()
        ));
    }
    if num(sample, "inferred_spaces") > 0. {
        notes.push("inferred gap/soft-join spaces lack source-code proof (§4.2/§4.6)".into());
        if edit != "identity"
            && edit != "delete"
            && ranges.iter().any(|(_, b)| {
                *b < tokens.len() && tokens[*b - 1].text == " " && tokens[*b - 1].source.is_none()
            })
        {
            notes.push("wrap uses inferred gap spaces: §4.6 would refuse".into());
        }
    }
    if sample["id"] == "zh-hans-education" && edit == "insert" {
        notes.push("diagnostic breaks after · / 。 are outside §4.6 whitelist".into());
    }
    if max(&stationary_native_drift) > 0.005 {
        notes.push(format!(
            "{} native source x drift {:.6} pt exceeds 0.005 pt target",
            if edit == "identity" || edit == "delete" {
                "remaining-source"
            } else {
                "prefix-only"
            },
            max(&stationary_native_drift)
        ));
    }
    let fits = ranges.len() <= slots.len()
        && !break_failure
        && outside_ink == 0
        && shaping_failure.is_none();
    Ok(json!({"id": sample["id"], "edit": edit, "fits": fits,
        "before_lines": slots.len(), "after_lines": ranges.len(),
        "length_change_percent": (expected_text.chars().count() as f64 / original_text.chars().count() as f64 - 1.) * 100.,
        "baseline_drift_max": max(&baseline_drift), "pdf_advance_max": max(&pdf_errors),
        "pdf_advance_mean": mean(&pdf_errors), "unchanged_count": pdf_errors.len(),
        "raw_font_advance_max": if raw_errors.is_empty() { None } else { Some(max(&raw_errors)) },
        "raw_font_advance_mean": if raw_errors.is_empty() { None } else { Some(mean(&raw_errors)) },
        "native_stationary_x_max": max(&stationary_native_drift),
        "replacement_fallback_glyphs": tokens.iter().filter(|t| t.fallback).count(),
        "prohibition_breaks": prohibition_breaks, "notes": notes,
        "text": expected_text, "glyphs": positioned,
        "line_break_utf8": ranges.iter().map(|(_,b)| tokens[..*b].iter().map(|t| t.text.len()).sum::<usize>()).collect::<Vec<_>>(),
        "visual_lines": ranges.iter().map(|(a,b)| tokens[*a..*b].iter().map(|t| t.text.as_str()).collect::<String>()).collect::<Vec<_>>() }))
}

pub fn kinsoku_probe() -> Value {
    let texts = [
        "甲乙（丙丁）戊，己。",
        "甲乙《丙丁》戊、己。",
        "Han中文（PDF）测试。",
    ];
    json!(
        texts
            .iter()
            .map(|text| {
                let rejected: Vec<usize> = unicode_linebreak::linebreaks(text)
                    .filter_map(|(i, _)| {
                        if i < text.len() && !legal_break(&text[..i], &text[i..]) {
                            Some(i)
                        } else {
                            None
                        }
                    })
                    .collect();
                let tokens: Vec<Token> = text
                    .chars()
                    .map(|c| Token {
                        text: c.to_string(),
                        advance: 1.,
                        gap: 0.,
                        source: None,
                        font: "probe".into(),
                        gid: None,
                        ink: [0.; 4],
                        pdf_error: None,
                        raw_error: None,
                        fallback: false,
                    })
                    .collect();
                let allowed = opportunities(&tokens);
                let wraps: Vec<Value> = (3..=6).map(|width| {
            let mut start = 0;
            let mut lines = Vec::new();
            let mut unsupported = false;
            while start < tokens.len() {
                let end = (start + 1..=(start + width).min(tokens.len()))
                    .rfind(|i| allowed.contains(i));
                let Some(end) = end else { unsupported = true; break; };
                lines.push(tokens[start..end].iter().map(|t| t.text.as_str()).collect::<String>());
                start = end;
            }
            json!({"unit_width": width, "visual_lines": lines, "unsupported": unsupported})
        }).collect();
                json!({"text": text, "uax_prohibited_candidates": rejected, "wraps": wraps,
            "note": "unit-advance diagnostic wraps; corpus glyphs use their real PDF metrics"})
            })
            .collect::<Vec<_>>()
    )
}
