use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const INSPECTOR_EVENT: &str = "browser://inspector-event";
pub const INSPECTOR_CHANNEL: &str = "crish:inspector";
pub const INSPECTOR_CONTROL_MESSAGE: &str = "crish:inspector:control";
pub const MAX_INSPECTOR_MESSAGE_BYTES: usize = 8192;

pub const INSPECTOR_RUNTIME: &str =
    include_str!("../../../../../crates/conex-browser/resources/inspector_runtime.js");

const INSPECTOR_CHALLENGE_PLACEHOLDER: &str = "__CONEX_INSPECTOR_HOST_CHALLENGE__";
const INSPECTOR_MESSAGE_LIMIT_PLACEHOLDER: &str = "__CONEX_INSPECTOR_MAX_MESSAGE_BYTES__";
const INSPECTOR_CONTROL_PLACEHOLDER: &str = "__CONEX_INSPECTOR_CONTROL_MESSAGE__";

pub fn inspector_runtime_script(challenge: &str) -> Result<String, &'static str> {
    if challenge.len() != 64
        || !challenge
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Inspector challenge must be 32 bytes of lowercase hexadecimal");
    }

    Ok(INSPECTOR_RUNTIME
        .replace(INSPECTOR_CHALLENGE_PLACEHOLDER, challenge)
        .replace(
            INSPECTOR_MESSAGE_LIMIT_PLACEHOLDER,
            &MAX_INSPECTOR_MESSAGE_BYTES.to_string(),
        )
        .replace(INSPECTOR_CONTROL_PLACEHOLDER, INSPECTOR_CONTROL_MESSAGE))
}

pub fn inspector_control_message(generation: u64, enabled: bool) -> String {
    format!(
        "{INSPECTOR_CONTROL_MESSAGE}:{generation}:{}",
        if enabled { 1 } else { 0 }
    )
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawInspectorMessage {
    channel: String,
    challenge: String,
    document_generation: String,
    #[serde(rename = "type")]
    event_type: String,
    payload: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InspectorRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InspectorReadyPayload {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InspectorTogglePayload {
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InspectorHoverPayload {
    pub tag_name: String,
    pub selector: String,
    pub rect: InspectorRect,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InspectorComputedStyles {
    pub display: String,
    pub position: String,
    pub color: String,
    pub background_color: String,
    pub font_size: String,
    pub margin: String,
    pub padding: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InspectorSelectPayload {
    pub tag_name: String,
    pub id: Option<String>,
    pub classes: Vec<String>,
    pub attributes: BTreeMap<String, String>,
    pub best_selector: String,
    pub xpath: String,
    pub rect: InspectorRect,
    pub computed_styles: InspectorComputedStyles,
    pub outer_html_snippet: String,
    pub text_content: String,
}

#[derive(Debug)]
pub enum InspectorMessage {
    Ready,
    ToggleOff,
    Hover(InspectorHoverPayload),
    Select(Box<InspectorSelectPayload>),
}

pub fn inspector_ready_may_mark_available(
    message: &InspectorMessage,
    is_current_generation: bool,
    navigation_pending: bool,
) -> bool {
    matches!(message, InspectorMessage::Ready) && is_current_generation && !navigation_pending
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectorEventEnvelope {
    pub tab_id: String,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub payload: serde_json::Value,
}

impl InspectorMessage {
    pub fn requires_enabled_inspector(&self) -> bool {
        matches!(self, Self::Hover(_) | Self::Select(_))
    }

    pub fn envelope(self, tab_id: impl Into<String>) -> InspectorEventEnvelope {
        let (event_type, payload) = match self {
            Self::Ready => (
                "INSPECT_READY",
                serde_json::to_value(InspectorReadyPayload {}).expect("ready payload serializes"),
            ),
            Self::ToggleOff => (
                "INSPECT_TOGGLE",
                serde_json::to_value(InspectorTogglePayload { enabled: false })
                    .expect("toggle payload serializes"),
            ),
            Self::Hover(payload) => (
                "INSPECT_HOVER",
                serde_json::to_value(payload).expect("validated hover payload serializes"),
            ),
            Self::Select(payload) => (
                "INSPECT_SELECT",
                serde_json::to_value(payload).expect("validated select payload serializes"),
            ),
        };
        InspectorEventEnvelope {
            tab_id: tab_id.into(),
            event_type,
            payload,
        }
    }
}

pub fn parse_inspector_message(
    raw: &str,
    expected_challenge: &str,
    expected_generation: &str,
) -> Result<InspectorMessage, &'static str> {
    if raw.len() > MAX_INSPECTOR_MESSAGE_BYTES {
        return Err("message exceeds size limit");
    }

    let message: RawInspectorMessage =
        serde_json::from_str(raw).map_err(|_| "message JSON is invalid")?;
    if message.channel != INSPECTOR_CHANNEL {
        return Err("message channel is invalid");
    }
    if message.challenge != expected_challenge {
        return Err("message challenge is invalid");
    }
    if message.document_generation != expected_generation {
        return Err("message document generation is stale");
    }

    match message.event_type.as_str() {
        "INSPECT_READY" => {
            let _: InspectorReadyPayload =
                serde_json::from_value(message.payload).map_err(|_| "ready payload is invalid")?;
            Ok(InspectorMessage::Ready)
        }
        "INSPECT_TOGGLE" => {
            let payload: InspectorTogglePayload =
                serde_json::from_value(message.payload).map_err(|_| "toggle payload is invalid")?;
            if payload.enabled {
                return Err("toggle may only disable inspection");
            }
            Ok(InspectorMessage::ToggleOff)
        }
        "INSPECT_HOVER" => {
            let payload: InspectorHoverPayload =
                serde_json::from_value(message.payload).map_err(|_| "hover payload is invalid")?;
            validate_hover(&payload)?;
            Ok(InspectorMessage::Hover(payload))
        }
        "INSPECT_SELECT" => {
            let payload: InspectorSelectPayload =
                serde_json::from_value(message.payload).map_err(|_| "select payload is invalid")?;
            validate_select(&payload)?;
            Ok(InspectorMessage::Select(Box::new(payload)))
        }
        _ => Err("message type is not allowed"),
    }
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes
}

fn valid_tag_name(value: &str) -> bool {
    valid_text(value, 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_rect(rect: &InspectorRect) -> bool {
    [rect.x, rect.y, rect.width, rect.height]
        .iter()
        .all(|value| value.is_finite() && value.abs() <= 100_000.0)
        && rect.width >= 0.0
        && rect.height >= 0.0
}

fn validate_hover(payload: &InspectorHoverPayload) -> Result<(), &'static str> {
    if !valid_tag_name(&payload.tag_name)
        || !valid_text(&payload.selector, 128)
        || !valid_rect(&payload.rect)
    {
        return Err("hover payload is outside allowed bounds");
    }
    Ok(())
}

fn validate_select(payload: &InspectorSelectPayload) -> Result<(), &'static str> {
    if !valid_tag_name(&payload.tag_name)
        || payload.id.as_deref().is_some_and(|value| value.len() > 128)
        || payload.classes.len() > 16
        || payload.classes.iter().any(|value| value.len() > 64)
        || payload.attributes.len() > 16
        || payload
            .attributes
            .iter()
            .any(|(key, value)| key.is_empty() || key.len() > 64 || value.len() > 256)
        || !valid_text(&payload.best_selector, 256)
        || !valid_text(&payload.xpath, 512)
        || !valid_rect(&payload.rect)
        || payload.outer_html_snippet.len() > 500
        || payload.text_content.len() > 200
        || [
            &payload.computed_styles.display,
            &payload.computed_styles.position,
            &payload.computed_styles.color,
            &payload.computed_styles.background_color,
            &payload.computed_styles.font_size,
            &payload.computed_styles.margin,
            &payload.computed_styles.padding,
        ]
        .iter()
        .any(|value| value.len() > 64)
    {
        return Err("select payload is outside allowed bounds");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspector_accepts_only_the_fixed_channel_and_four_event_types() {
        let ready = r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"INSPECT_READY","payload":{}}"#;
        assert!(matches!(
            parse_inspector_message(ready, "secret", "1"),
            Ok(InspectorMessage::Ready)
        ));
        let toggle = r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"INSPECT_TOGGLE","payload":{"enabled":false}}"#;
        assert!(matches!(
            parse_inspector_message(toggle, "secret", "1"),
            Ok(InspectorMessage::ToggleOff)
        ));
        assert!(parse_inspector_message(
            r#"{"channel":"other","challenge":"secret","documentGeneration":"1","type":"INSPECT_READY","payload":{}}"#,
            "secret",
            "1"
        )
        .is_err());
        assert!(parse_inspector_message(
            r#"{"channel":"crish:inspector","challenge":"wrong","documentGeneration":"1","type":"INSPECT_READY","payload":{}}"#,
            "secret",
            "1"
        )
        .is_err());
        assert!(parse_inspector_message(
            r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"wrong","type":"INSPECT_READY","payload":{}}"#,
            "secret",
            "1"
        )
        .is_err());
        assert!(parse_inspector_message(
            r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"invoke","payload":{}}"#,
            "secret",
            "1"
        )
        .is_err());
        assert!(parse_inspector_message(
            r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"INSPECT_TOGGLE","payload":{"enabled":true}}"#,
            "secret",
            "1"
        )
        .is_err());
    }

    #[test]
    fn inspector_accepts_well_formed_hover_and_selection_payloads() {
        let hover = r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"INSPECT_HOVER","payload":{"tagName":"button","selector":"button.primary","rect":{"x":1.5,"y":2.0,"width":80.0,"height":24.0}}}"#;
        assert!(matches!(
            parse_inspector_message(hover, "secret", "1"),
            Ok(InspectorMessage::Hover(_))
        ));

        let select = r##"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"INSPECT_SELECT","payload":{"tagName":"button","id":"save","classes":["primary"],"attributes":{"type":"button"},"bestSelector":"#save","xpath":"/html/body[1]/button[1]","rect":{"x":1.5,"y":2.0,"width":80.0,"height":24.0},"computedStyles":{"display":"inline-block","position":"static","color":"rgb(0, 0, 0)","backgroundColor":"rgb(255, 255, 255)","fontSize":"16px","margin":"0px","padding":"4px"},"outerHtmlSnippet":"<button id=\"save\">Save</button>","textContent":"Save"}}"##;
        let message = parse_inspector_message(select, "secret", "1")
            .expect("selection contract should parse");
        let value = serde_json::to_value(message.envelope("tab-9")).unwrap();
        assert_eq!(value["tabId"], "tab-9");
        assert_eq!(value["type"], "INSPECT_SELECT");
        assert_eq!(value["payload"]["tagName"], "button");
        assert_eq!(
            value["payload"]["computedStyles"]["backgroundColor"],
            "rgb(255, 255, 255)"
        );
        assert!(value.get("challenge").is_none());
        assert!(value.get("documentGeneration").is_none());
    }

    #[test]
    fn inspector_rejects_unknown_fields_oversized_messages_and_invalid_geometry() {
        assert!(parse_inspector_message(
            r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"INSPECT_READY","payload":{"extra":true}}"#,
            "secret",
            "1"
        )
        .is_err());
        assert!(parse_inspector_message(
            &"x".repeat(MAX_INSPECTOR_MESSAGE_BYTES + 1),
            "secret",
            "1"
        )
        .is_err());

        let hover = r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"1","type":"INSPECT_HOVER","payload":{"tagName":"button","selector":"button","rect":{"x":0,"y":0,"width":-1,"height":1}}}"#;
        assert!(parse_inspector_message(hover, "secret", "1").is_err());
    }

    #[test]
    fn inspector_unicode_payload_stays_within_the_utf8_message_budget() {
        let attributes = BTreeMap::from([("aria-label".to_string(), "保存 🧪".to_string())]);
        let payload = InspectorSelectPayload {
            tag_name: "button".to_string(),
            id: Some("提交🚀".to_string()),
            classes: vec!["主要颜色🌱".to_string()],
            attributes,
            best_selector: "button.主要颜色🌱".to_string(),
            xpath: "/html/body[1]/button[1]".to_string(),
            rect: InspectorRect {
                x: 1.0,
                y: 2.0,
                width: 3.0,
                height: 4.0,
            },
            computed_styles: InspectorComputedStyles {
                display: "块级".to_string(),
                position: "static".to_string(),
                color: "rgb(20, 30, 40)".to_string(),
                background_color: "rgb(255, 255, 255)".to_string(),
                font_size: "16px".to_string(),
                margin: "0px".to_string(),
                padding: "4px".to_string(),
            },
            outer_html_snippet: "<button>提交🚀</button>".to_string(),
            text_content: "保存更改 👍🌟".to_string(),
        };
        assert!(payload.id.as_ref().unwrap().len() > payload.id.as_ref().unwrap().chars().count());
        assert!(payload.text_content.len() > payload.text_content.chars().count());
        let expected_payload = serde_json::to_value(&payload).unwrap();

        let raw = serde_json::json!({
            "channel": INSPECTOR_CHANNEL,
            "challenge": "secret",
            "documentGeneration": "1",
            "type": "INSPECT_SELECT",
            "payload": expected_payload,
        })
        .to_string();
        // `String::len` 返回 UTF-8 字节数，与宿主侧契约一致。
        assert!(raw.len() <= MAX_INSPECTOR_MESSAGE_BYTES);
        let InspectorMessage::Select(parsed_payload) =
            parse_inspector_message(&raw, "secret", "1").unwrap()
        else {
            panic!("selection message should round-trip");
        };
        assert_eq!(
            serde_json::to_value(parsed_payload).unwrap(),
            serde_json::to_value(payload).unwrap()
        );
    }

    #[test]
    fn inspector_envelope_adds_the_authoritative_tab_id() {
        let value = serde_json::to_value(InspectorMessage::Ready.envelope("tab-7")).unwrap();
        assert_eq!(value["tabId"], "tab-7");
        assert_eq!(value["type"], "INSPECT_READY");
        assert_eq!(value["payload"], serde_json::json!({}));
    }

    #[test]
    fn inspector_control_messages_bind_generation_and_desired_state() {
        assert_eq!(
            inspector_control_message(7, true),
            "crish:inspector:control:7:1"
        );
        assert_eq!(
            inspector_control_message(8, false),
            "crish:inspector:control:8:0"
        );
        assert!(!inspector_control_message(7, true).contains('('));
    }

    #[test]
    fn inspector_runtime_stays_small_and_does_not_open_an_arbitrary_script_channel() {
        let runtime = inspector_runtime_script(&"a".repeat(64)).unwrap();
        assert!(runtime.len() < MAX_INSPECTOR_MESSAGE_BYTES);
        assert!(runtime.contains(&"a".repeat(64)));
        assert!(runtime.contains("reserved"));
        assert!(runtime.contains("installed"));
        assert!(runtime.contains("8192"));
        assert!(runtime.contains(INSPECTOR_CONTROL_MESSAGE));
        assert!(runtime.contains("documentGeneration"));
        assert!(INSPECTOR_RUNTIME.contains(INSPECTOR_CONTROL_PLACEHOLDER));
        assert!(INSPECTOR_RUNTIME.contains("new TextEncoder"));
        assert!(INSPECTOR_RUNTIME.contains("postMessage"));
        assert!(INSPECTOR_RUNTIME.contains("writable:!1,configurable:!1"));
        assert!(INSPECTOR_RUNTIME.contains("):\"unavailable:\"+document.readyState"));
        assert!(INSPECTOR_RUNTIME.contains("if(!0!==e.isTrusted||!c)return"));
        assert!(INSPECTOR_RUNTIME
            .contains("if(!0!==e.isTrusted||!(c&&e.target instanceof Element))return"));
        assert!(INSPECTOR_RUNTIME.contains("!0===e.isTrusted&&c&&\"Escape\"===e.key"));
        let isolation_complete = INSPECTOR_RUNTIME
            .find("})()?(i(r,t,[\"message\"")
            .expect("message listener is registered only after successful isolation");
        let unavailable_status = INSPECTOR_RUNTIME
            .find("):\"unavailable:\"+document.readyState")
            .expect("isolation failure reports unavailable");
        assert!(isolation_complete < unavailable_status);
        assert!(!runtime.contains("__CONEX_INSPECTOR_"));
        assert!(!INSPECTOR_RUNTIME.contains("eval("));
        assert!(!INSPECTOR_RUNTIME.contains("new Function("));
        assert!(!INSPECTOR_RUNTIME.contains("__TAURI__"));
        assert!(inspector_runtime_script("bad'challenge").is_err());
    }

    #[test]
    fn inspector_challenge_blocks_cross_tab_replay() {
        let message = r#"{"channel":"crish:inspector","challenge":"tab-a-secret","documentGeneration":"17","type":"INSPECT_READY","payload":{}}"#;
        assert!(matches!(
            parse_inspector_message(message, "tab-a-secret", "17"),
            Ok(InspectorMessage::Ready)
        ));
        assert!(parse_inspector_message(message, "tab-b-secret", "17").is_err());
    }

    #[test]
    fn inspector_rejects_delayed_ready_from_an_older_document_generation() {
        let old_ready = r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"41","type":"INSPECT_READY","payload":{}}"#;
        let new_ready = r#"{"channel":"crish:inspector","challenge":"secret","documentGeneration":"42","type":"INSPECT_READY","payload":{}}"#;
        assert!(parse_inspector_message(old_ready, "secret", "42").is_err());
        assert!(matches!(
            parse_inspector_message(new_ready, "secret", "42"),
            Ok(InspectorMessage::Ready)
        ));
    }

    #[test]
    fn inspector_availability_requires_a_current_ready_after_navigation() {
        let ready = InspectorMessage::Ready;
        assert!(inspector_ready_may_mark_available(&ready, true, false));
        assert!(!inspector_ready_may_mark_available(&ready, false, false));
        assert!(!inspector_ready_may_mark_available(&ready, true, true));
        assert!(!inspector_ready_may_mark_available(
            &InspectorMessage::ToggleOff,
            true,
            false
        ));
    }

    #[test]
    fn inspector_runtime_emits_a_valid_root_xpath_and_consumes_escape() {
        assert!(
            INSPECTOR_RUNTIME.contains("segments.length ? '/html/' + segments.join('/') : '/html'")
                || INSPECTOR_RUNTIME.contains("t.length?\"/html/\"+t.join(\"/\"):\"/html\"")
        );
        assert!(
            INSPECTOR_RUNTIME.contains("event.preventDefault();\n    event.stopPropagation();")
                || INSPECTOR_RUNTIME.contains("stopPropagation()")
        );
    }
}
