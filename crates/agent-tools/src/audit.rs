//! 安全审计发射（I2-S8：高危操作审计事件）
//!
//! 删除接管/重定向/红线拦截等发射点把 `security-audit` 事件经
//! [SecurityAuditSink] 交出发射面；未接线时回退 [NoopAuditSink]
//! （结构化 tracing 审计日志始终照发，见 delete.rs / shell.rs 发射点）。
//!
//! 接线路径（I3 遗留，登记于 01-安全监控与删除接管方案 §2 S8）：
//! 引擎侧（session-loop / workbench engine.rs）在注册工具时注入真实 sink
//! （经 `BuiltinToolConfig.audit_sink` 或工具 `with_audit_sink` 构造器），
//! 把事件汇入会话事件流 → EventQueue append_event 落库（agent-tools 为
//! 叶子依赖，不能依赖 orchestrator，依赖方向为 orchestrator → session-loop
//! → agent-tools，故落库面只能在引擎侧接线）。
//!
//! `runId`/`permissionMode` 由 emit 层注入（任务卡约定）：runId 经信封
//! 注入（03 §5.3-2），permissionMode 属会话级属性，工具侧恒为 None。

use conex_types::events::{AgentEvent, SecurityAuditDecision, SecurityAuditOperation};
use conex_types::impact::ImpactAssessment;
use std::sync::Mutex;

/// 安全审计 sink（工具/引擎命令发射 `security-audit` 事件的出口）
pub trait SecurityAuditSink: Send + Sync + std::fmt::Debug {
    /// 发射一条审计事件（实现方自行决定收集/广播/落库）
    fn emit(&self, event: &AgentEvent);
}

/// 默认 no-op 审计 sink：未接线时静默丢弃（审计日志仍经 tracing 输出）
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopAuditSink;

impl SecurityAuditSink for NoopAuditSink {
    fn emit(&self, _event: &AgentEvent) {}
}

/// 记录型审计 sink（测试断言 / 接线调试用：收集发射的全部审计事件）
#[derive(Debug, Default)]
pub struct RecordingAuditSink {
    emitted: Mutex<Vec<AgentEvent>>,
}

impl RecordingAuditSink {
    /// 新建空记录器
    pub fn new() -> Self {
        Self::default()
    }

    /// 已收集的审计事件（按发射顺序）
    pub fn emitted(&self) -> Vec<AgentEvent> {
        self.emitted.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 已收集事件的类型名列表（`security-audit` 断言用）
    pub fn type_names(&self) -> Vec<&'static str> {
        self.emitted()
            .iter()
            .map(AgentEvent::type_name)
            .collect()
    }
}

impl SecurityAuditSink for RecordingAuditSink {
    fn emit(&self, event: &AgentEvent) {
        self.emitted
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(event.clone());
    }
}

/// 审计 sink 类型别名（`Arc` 共享；与 `AskCallback` 形态对齐）
pub type AuditSink = std::sync::Arc<dyn SecurityAuditSink>;

/// 构造安全审计事件（时间戳统一取 UTC ISO8601；permissionMode 由 emit
/// 层注入恒为 None，toolCallId 由调用方按上下文填充）
pub fn security_audit_event(
    session_id: &str,
    operation: SecurityAuditOperation,
    targets: Vec<String>,
    impact: ImpactAssessment,
    decision: SecurityAuditDecision,
    tool_call_id: Option<String>,
) -> AgentEvent {
    AgentEvent::SecurityAudit {
        session_id: session_id.to_string(),
        timestamp: now_iso_utc(),
        operation,
        targets,
        impact,
        decision,
        permission_mode: None,
        tool_call_id,
    }
}

/// 当前 UTC 时间 ISO8601 字符串（毫秒精度，`2026-07-31T08:00:00.000Z`）
///
/// 无 chrono 依赖，手工换算（Howard Hinnant civil-from-days 算法，
/// 与 orchestrator / session-loop 同源）。
fn now_iso_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let (hours, mins, sec) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    let (year, month, day) = civil_from_days((secs / 86400) as i64);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{mins:02}:{sec:02}.{millis:03}Z")
}

/// 从 Unix 天数换算公历年月日（Howard Hinnant 算法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn impact() -> ImpactAssessment {
        ImpactAssessment {
            file_count: 2,
            total_size_bytes: 8,
            directory_count: 1,
            cross_directory: true,
            flagged: false,
        }
    }

    #[test]
    fn builder_emits_security_audit_shape() {
        let event = security_audit_event(
            "s1",
            SecurityAuditOperation::Delete,
            vec!["a.txt".into(), "b.txt".into()],
            impact(),
            SecurityAuditDecision::Redirected,
            Some("tc-1".into()),
        );
        assert_eq!(event.type_name(), "security-audit");
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["operation"], "delete");
        assert_eq!(json["decision"], "redirected");
        assert_eq!(json["impact"]["fileCount"], 2);
        assert_eq!(json["targets"][1], "b.txt");
        // permissionMode 由 emit 层注入，构造器不携带
        assert!(json.get("permissionMode").is_none());
    }

    #[test]
    fn recording_sink_collects_events_in_order() {
        let sink = RecordingAuditSink::new();
        assert!(sink.emitted().is_empty());
        sink.emit(&security_audit_event(
            "s1",
            SecurityAuditOperation::Delete,
            vec![],
            impact(),
            SecurityAuditDecision::Redirected,
            None,
        ));
        sink.emit(&security_audit_event(
            "s1",
            SecurityAuditOperation::CommandExec,
            vec![],
            impact(),
            SecurityAuditDecision::Blocked,
            None,
        ));
        assert_eq!(
            sink.type_names(),
            vec!["security-audit", "security-audit"]
        );
        assert_eq!(sink.emitted().len(), 2);
    }

    #[test]
    fn iso_timestamp_formats_ms_precision_utc() {
        let ts = now_iso_utc();
        assert!(ts.ends_with('Z'), "UTC 后缀：{ts}");
        let bytes = ts.as_bytes();
        assert_eq!(bytes[4], b'-', "年份-月 分隔：{ts}");
        assert_eq!(bytes[10], b'T', "日期与时间分隔：{ts}");
        assert!(ts.len() >= 24, "毫秒精度：{ts}");
    }

    #[test]
    fn civil_from_days_known_epochs() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2026-08-03（I2 方案日期）：1970-01-01 起 20668 天
        assert_eq!(civil_from_days(20_668), (2026, 8, 3));
    }
}
