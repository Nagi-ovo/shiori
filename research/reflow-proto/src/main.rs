mod layout;
mod metrics;

use serde_json::{Value, json};
use std::{fs, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let input: Vec<Value> = serde_json::from_slice(&fs::read("tmp/input.json")?)?;
    let mut rows = Vec::new();
    for sample in input {
        let identity = layout::run(&sample, "identity")?;
        let native_identity_max = identity["native_stationary_x_max"].as_f64().unwrap();
        for edit in ["identity", "insert", "delete", "+10%", "+30%"] {
            let mut row = if edit == "identity" {
                identity.clone()
            } else {
                layout::run(&sample, edit)?
            };
            row["native_identity_control_x_max"] = json!(native_identity_max);
            row["native_comparison_scope"] = json!(if edit == "identity" || edit == "delete" {
                "remaining-source"
            } else {
                "prefix-only"
            });
            row["notes"].as_array_mut().unwrap().push(json!(format!(
                "identity-control native source x max {native_identity_max:.6} pt{}",
                if native_identity_max > 0.005 {
                    " exceeds 0.005 pt target"
                } else {
                    ""
                }
            )));
            rows.push(row);
        }
    }
    let probe = layout::kinsoku_probe();
    let mut result = json!({
        "engine": "PDF metrics + HarfRust 0.16.0 + unicode-linebreak 0.1.5 + unicode-bidi 0.3.18",
        "kinsoku": probe, "rows": rows,
        "release_binary_bytes": fs::metadata(Path::new("target/release/shiori-reflow-proto"))?.len()
    });
    fs::write("tmp/layouts.json", serde_json::to_vec(&result)?)?;
    for row in result["rows"].as_array_mut().unwrap() {
        row.as_object_mut().unwrap().remove("glyphs");
    }
    fs::write(
        "artifacts/metrics.json",
        serde_json::to_vec_pretty(&result)?,
    )?;
    println!("Wrote {} cases and kinsoku probe", rows.len());
    Ok(())
}
