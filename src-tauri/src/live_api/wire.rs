//! Wire types the live API exchanges with the webview and the CLI, and the
//! checks native applies to them before trusting either side.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveApiActivePage {
    pub(crate) page: u32,
    pub(crate) width_pt: f64,
    pub(crate) height_pt: f64,
    pub(crate) rotation: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveApiContext {
    pub(crate) document_id: String,
    pub(crate) name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    pub(crate) sha256: String,
    pub(crate) page_topology_hash: String,
    pub(crate) page_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) active_page: Option<LiveApiActivePage>,
    pub(crate) annotation_count: u32,
    pub(crate) dirty: bool,
    /// Content-only digest of the readable annotations — the agent's read
    /// path. Always shorter than `annotation_count`: geometry-only
    /// annotations have nothing to read. See src/live/annotationDigest.ts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) annotations: Option<Vec<LiveApiAnnotationDigest>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) annotations_truncated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveApiThreadTurn {
    pub(crate) role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) author: Option<String>,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveApiAnnotationDigest {
    pub(crate) id: String,
    #[serde(rename = "type")]
    pub(crate) kind: String,
    pub(crate) page: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) thread: Option<Vec<LiveApiThreadTurn>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveApiTarget {
    pub(crate) document_id: String,
    pub(crate) sha256: String,
    pub(crate) page_topology_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AnnotationRequestBody {
    pub(super) target: LiveApiTarget,
    pub(super) spec: Value,
    pub(super) operation_id: String,
    #[serde(default)]
    pub(super) dry_run: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AnnotationRequestEvent {
    pub(super) request_id: String,
    pub(super) expires_at_ms: u64,
    pub(super) target: LiveApiTarget,
    pub(super) spec: Value,
    pub(super) operation_id: String,
    pub(super) dry_run: bool,
}

// Native re-checks the digest caps the frontend already applies. The context
// is serialized into every GET /v1/context response, so a frontend bug that
// stopped truncating would turn a large document into a multi-megabyte
// response body — this is the ceiling that keeps that impossible. Kept a
// little above the frontend's own limits so ordinary payloads never graze it;
// see MAX_TOTAL_CHARACTERS in src/live/annotationDigest.ts.
const MAX_CONTEXT_ANNOTATIONS: usize = 200;
const MAX_CONTEXT_THREAD_TURNS: usize = 12;
const MAX_CONTEXT_ANNOTATION_CHARS: usize = 64 * 1024;

pub(super) fn validate_context(context: &LiveApiContext) -> Result<(), String> {
    if context.document_id.trim().is_empty()
        || context.name.trim().is_empty()
        || !valid_sha256(&context.sha256)
        || !valid_sha256(&context.page_topology_hash)
    {
        return Err("live-api-context-invalid".into());
    }
    if let Some(page) = context.active_page.as_ref() {
        if page.page == 0
            || page.page > context.page_count
            || !page.width_pt.is_finite()
            || page.width_pt <= 0.0
            || !page.height_pt.is_finite()
            || page.height_pt <= 0.0
            || !matches!(page.rotation, 0 | 90 | 180 | 270)
        {
            return Err("live-api-context-invalid".into());
        }
    }
    if let Some(annotations) = context.annotations.as_ref() {
        if annotations.len() > MAX_CONTEXT_ANNOTATIONS {
            return Err("live-api-context-invalid".into());
        }
        let mut spent = 0usize;
        for annotation in annotations {
            if annotation.id.trim().is_empty()
                || annotation.kind.trim().is_empty()
                || annotation.page == 0
                || annotation.page > context.page_count
            {
                return Err("live-api-context-invalid".into());
            }
            spent += annotation.id.len() + annotation.kind.len();
            spent += annotation.text.as_ref().map_or(0, String::len);
            spent += annotation.quote.as_ref().map_or(0, String::len);
            if let Some(thread) = annotation.thread.as_ref() {
                if thread.len() > MAX_CONTEXT_THREAD_TURNS {
                    return Err("live-api-context-invalid".into());
                }
                for turn in thread {
                    if turn.role != "user" && turn.role != "agent" {
                        return Err("live-api-context-invalid".into());
                    }
                    spent += turn.text.len() + turn.author.as_ref().map_or(0, String::len);
                }
            }
            if spent > MAX_CONTEXT_ANNOTATION_CHARS {
                return Err("live-api-context-invalid".into());
            }
        }
    }
    Ok(())
}

pub(super) fn validate_target(target: &LiveApiTarget) -> bool {
    !target.document_id.trim().is_empty()
        && valid_sha256(&target.sha256)
        && valid_sha256(&target.page_topology_hash)
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

pub(super) fn valid_operation_id(value: &str) -> bool {
    valid_sha256(value)
}

pub(super) fn context_matches_target(
    context: Option<&LiveApiContext>,
    target: &LiveApiTarget,
) -> bool {
    context.is_some_and(|context| {
        context.document_id == target.document_id
            && context.sha256 == target.sha256
            && context.page_topology_hash == target.page_topology_hash
    })
}

#[cfg(test)]
mod tests {
    use super::super::{
        completion_response, LiveApiCompletionResult, LiveApiDescriptor, LIVE_API_EVENT,
        LIVE_API_SCHEMA,
    };
    use super::*;
    use serde_json::json;

    fn sha(byte: char) -> String {
        std::iter::repeat_n(byte, 64).collect()
    }

    #[test]
    fn annotation_body_requires_and_forwards_lowercase_hex_operation_id() {
        let operation_id = sha('c');
        let body: AnnotationRequestBody = serde_json::from_value(json!({
            "target": {
                "documentId": "document-1",
                "sha256": sha('a'),
                "pageTopologyHash": sha('b'),
            },
            "spec": { "schema": "shiori.annotations/v1", "annotations": [] },
            "operationId": operation_id,
        }))
        .unwrap();
        assert!(valid_operation_id(&body.operation_id));
        assert!(validate_target(&body.target));
        assert!(!body.dry_run);

        let event = AnnotationRequestEvent {
            request_id: "request-1".into(),
            expires_at_ms: 1_893_456_000_000,
            target: body.target,
            spec: body.spec,
            operation_id: body.operation_id.clone(),
            dry_run: body.dry_run,
        };
        let event = serde_json::to_value(event).unwrap();
        assert_eq!(event["operationId"], operation_id);
        assert_eq!(event["expiresAtMs"], 1_893_456_000_000u64);

        let missing = serde_json::from_value::<AnnotationRequestBody>(json!({
            "target": {
                "documentId": "document-1",
                "sha256": sha('a'),
                "pageTopologyHash": sha('b'),
            },
            "spec": { "schema": "shiori.annotations/v1", "annotations": [] },
        }));
        assert!(missing.is_err());
        let missing_topology = serde_json::from_value::<AnnotationRequestBody>(json!({
            "target": {
                "documentId": "document-1",
                "sha256": sha('a'),
            },
            "spec": { "schema": "shiori.annotations/v1", "annotations": [] },
            "operationId": sha('c'),
        }));
        assert!(missing_topology.is_err());
        assert!(!valid_operation_id(&sha('A')));
        assert!(!valid_operation_id("abcd"));
    }

    // Cross-language contract tripwire. The wire types are hand-duplicated in
    // src/platform/liveApi.ts and cli/src/liveApp.ts; with deny_unknown_fields
    // a frontend-side field addition would otherwise fail only at runtime, as
    // a silent live_api_update_context error that turns every CLI call into
    // NO_PDF. The TS suites pin their literals to the same fixture file, so
    // any drift breaks one of the three suites at build/test time. See
    // src/live/liveApiContract.test.ts for the full chain.
    #[test]
    fn contract_fixtures_match_wire_types() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../src/live/liveApiContract.fixtures.json"
        ))
        .expect("contract fixtures parse");
        assert_eq!(fixtures["schema"], LIVE_API_SCHEMA);
        assert_eq!(fixtures["event"], LIVE_API_EVENT);

        // Context: deserialize under deny_unknown_fields, then serialize back
        // and require the exact fixture bytes-shape (field names, camelCase,
        // and optional-field omission all round-trip).
        for key in ["full", "minimal"] {
            let fixture = fixtures["context"][key].clone();
            let context: LiveApiContext = serde_json::from_value(fixture.clone())
                .unwrap_or_else(|error| panic!("context.{key} fixture must deserialize: {error}"));
            validate_context(&context).expect("fixture context is valid");
            assert_eq!(
                serde_json::to_value(&context).unwrap(),
                fixture,
                "context.{key} must round-trip"
            );
        }

        // The exact body the CLI posts must stay accepted.
        let body: AnnotationRequestBody =
            serde_json::from_value(fixtures["annotationRequestBody"].clone())
                .expect("annotationRequestBody fixture must deserialize");
        assert!(validate_target(&body.target));
        assert!(valid_operation_id(&body.operation_id));

        // The event payload the frontend receives must keep its wire shape.
        let event_fixture = fixtures["annotationRequestEvent"].clone();
        let event = AnnotationRequestEvent {
            request_id: event_fixture["requestId"].as_str().unwrap().to_string(),
            expires_at_ms: event_fixture["expiresAtMs"].as_u64().unwrap(),
            target: serde_json::from_value(event_fixture["target"].clone()).unwrap(),
            spec: event_fixture["spec"].clone(),
            operation_id: event_fixture["operationId"].as_str().unwrap().to_string(),
            dry_run: event_fixture["dryRun"].as_bool().unwrap(),
        };
        assert_eq!(serde_json::to_value(&event).unwrap(), event_fixture);

        // Completions coming back from the frontend must keep deserializing
        // and mapping onto the documented statuses, details included.
        let success: LiveApiCompletionResult =
            serde_json::from_value(fixtures["completion"]["success"].clone())
                .expect("completion.success fixture must deserialize");
        let response = completion_response(success);
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["data"],
            fixtures["completion"]["success"]["data"]
        );
        let spec_invalid: LiveApiCompletionResult =
            serde_json::from_value(fixtures["completion"]["specInvalid"].clone())
                .expect("completion.specInvalid fixture must deserialize");
        let response = completion_response(spec_invalid);
        assert_eq!(response.status, 422);
        assert_eq!(
            response.body["error"],
            fixtures["completion"]["specInvalid"]["error"]
        );

        // Descriptor: what the CLI reads from disk.
        let descriptor: LiveApiDescriptor = serde_json::from_value(fixtures["descriptor"].clone())
            .expect("descriptor fixture must deserialize");
        assert_eq!(
            serde_json::to_value(&descriptor).unwrap(),
            fixtures["descriptor"]
        );
    }
}
