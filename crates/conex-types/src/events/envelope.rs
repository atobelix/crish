//! 事件信封（emit 层统一注入 runId/sequence/schemaVersion/traceId）。
//!
//! 序列化为扁平顶层 JSON：`{ type, runId, sequence, schemaVersion, sessionId,
//! ...事件字段 }`，与 daemon WS 广播同构（03 §3.1）。`run-terminal` 事件体
//! 自带 runId，与信封注入字段同名，故序列化/反序列化经 `serde_json::Value`
//! 手工合并：注入值覆盖同名事件字段。

use serde::{Deserialize, Serialize};

use super::AgentEvent;

/// 事件信封（emit 层统一注入 runId/sequence/schemaVersion，03 §5.3-2/6）
#[derive(Debug, Clone, PartialEq)]
pub struct AgentEventEnvelope {
    pub event: AgentEvent,
    /// 事件归属 run id（缺失时前端放行不过滤但多 run 并发过滤失效）。
    /// 定时器/cron 事件无 run 归属，发射方置空串或 `timer-<id>` /
    /// `cron-<id>` 伪 runId。
    pub run_id: Option<String>,
    pub sequence: Option<u64>,
    /// 信封 schema 版本（wire 层注入，camelCase `schemaVersion`；当前恒为 1）
    pub schema_version: u32,
    /// run 级追踪 id（wire 键 `traceId`，可选；None 兼容既有事件语义）
    pub trace_id: Option<String>,
}

/// 事件信封 wire schema 版本（PE-03 T03.10 / PE-12 T12.5）。
pub const EVENT_ENVELOPE_SCHEMA_VERSION: u32 = 1;

impl Serialize for AgentEventEnvelope {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::Error as _;
        let mut value = serde_json::to_value(&self.event).map_err(S::Error::custom)?;
        let map = value
            .as_object_mut()
            .ok_or_else(|| S::Error::custom("事件必须序列化为 JSON 对象"))?;
        if let Some(run_id) = &self.run_id {
            map.insert("runId".into(), serde_json::json!(run_id));
        }
        if let Some(sequence) = self.sequence {
            map.insert("sequence".into(), serde_json::json!(sequence));
        }
        if let Some(trace_id) = &self.trace_id {
            map.insert("traceId".into(), serde_json::json!(trace_id));
        }
        map.insert(
            "schemaVersion".into(),
            serde_json::json!(self.schema_version),
        );
        map.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for AgentEventEnvelope {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let value = serde_json::Value::deserialize(deserializer)?;
        let map = value
            .as_object()
            .ok_or_else(|| D::Error::custom("事件信封必须是 JSON 对象"))?;
        // 事件体保留顶层 runId（run-terminal 依赖它），其余事件忽略该键
        let event = AgentEvent::deserialize(value.clone()).map_err(D::Error::custom)?;
        let run_id = map
            .get("runId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let sequence = map.get("sequence").and_then(serde_json::Value::as_u64);
        let trace_id = map
            .get("traceId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        // 旧帧无 schemaVersion 字段时缺省补 1（PE-03 T03.10：向后兼容）
        let schema_version = map
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .map(|v| v as u32)
            .unwrap_or(EVENT_ENVELOPE_SCHEMA_VERSION);
        Ok(Self {
            event,
            run_id,
            sequence,
            schema_version,
            trace_id,
        })
    }
}

impl AgentEventEnvelope {
    /// 构造信封（schema 版本默认取当前 [EVENT_ENVELOPE_SCHEMA_VERSION]）。
    pub fn new(event: AgentEvent, run_id: Option<String>, sequence: Option<u64>) -> Self {
        Self {
            event,
            run_id,
            sequence,
            schema_version: EVENT_ENVELOPE_SCHEMA_VERSION,
            trace_id: None,
        }
    }

    /// 注入 run 级 trace_id（仅当信封未显式携带时由 emit 层覆盖）。
    pub fn with_trace_id(mut self, trace_id: Option<String>) -> Self {
        self.trace_id = trace_id;
        self
    }

    /// 事件类型名（顶层 `type` 值；委托 [AgentEvent::type_name]）。
    pub fn type_name(&self) -> &'static str {
        self.event.type_name()
    }
}
