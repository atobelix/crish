use super::*;
use crate::cdp::types::CdpEvent;
use serde_json::json;
use serde_json::Value;

fn raw(method: &str, params: Value, session: Option<&str>) -> CdpEvent {
    CdpEvent {
        method: method.to_string(),
        params,
        session_id: session.map(String::from),
    }
}

mod classify_table_a;
mod classify_table_b;
mod pump_frames;
