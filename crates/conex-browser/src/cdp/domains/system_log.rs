//! SystemInfo / Log 域类型。

use serde::Deserialize;
use serde_json::Value;

// ---------------------------------------------------------------------------
// SystemInfo 域（browser 级，能力探测与诊断）
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetInfoResult {
    pub gpu: Value,
    pub model_name: String,
    pub model_version: String,
    pub command_line: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetProcessInfoResult {
    pub process_info: Vec<ProcessInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    #[serde(rename = "type")]
    pub process_type: String,
    pub id: i64,
    pub cpu_time: f64,
}

// ---------------------------------------------------------------------------
// Log 域（调试场景可选启用，默认不启用）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub source: String,
    pub level: String,
    pub text: String,
    pub timestamp: f64,
    pub url: Option<String>,
    pub line_number: Option<i64>,
}

/// Log.entryAdded 事件参数（默认不订阅，调试场景开）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryAddedEvent {
    pub entry: LogEntry,
}
