//! BG3 事件面接缝：宿主状态迁移 → 事件 sink + 结果同构转换。
//!
//! 发射纪律（渲染整改合并方案 BG3 + 波 4-5 补全 §二定案）：
//! - 发射只发生在状态迁移成功之后、且恰好一次——幂等由宿主的
//!   发射点结构保证（settle 的 bool 返回 / cancel 包装的受影响清单 /
//!   backgrounded 的宿主侧已发集合）；
//! - sink 失败不回滚状态迁移：桥 sink 为 fire-and-forget（仅记日志），
//!   本接缝的任何实现都不得以发射失败反噬注册表语义；
//! - 结果载荷与 tool-end 的 `result` 同构复用 [ToolBatchResult]——
//!   转换口径与 session-loop 翻译层 `tool_output_from_parts` 逐项同
//!   语义（成功透传输出；失败 text=错误文案 + json={code}），保证
//!   tool-settled 与同 callId 的占位 tool-end 在消费侧可直接互换。

use conex_types::events::ToolSettledStatus;
use conex_types::tool::{ToolBatchResult, ToolOutput};
use session_loop::tool_events::{ClassifiedToolResult, ToolErrorKind};

use super::registry::{CANCELLED_NOTE, OUTCOME_UNKNOWN_NOTE};

/// 一次后台工具调用的身份摘要（事件 / 唤醒两通道的共同载荷）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolBackgroundCallSummary {
    /// 会话 id
    pub session_id: String,
    /// 工具调用 id（全局唯一键）
    pub call_id: String,
    /// 工具名
    pub tool_name: String,
}

/// 后台事件 sink（BG3 发射接缝；生产实现 = [super::bridge_sink::
/// ToolBackgroundBridgeSink]，测试 / 无头装配可不注入——宿主缺省
/// 无 sink 时不发射任何事件）
pub trait ToolBackgroundEventSink: Send + Sync + std::fmt::Debug {
    /// 条目获执行槽位（登记即获槽 / 排队后获槽的状态迁移点调用，
    /// 同一 callId 至多一次）；`elapsed_ms` 为注册表口径的已运行时长
    /// （自登记起算，与 BG2 占位信封 elapsedMs 的宿主侧同源值）
    fn on_backgrounded(&self, summary: &ToolBackgroundCallSummary, elapsed_ms: u64);

    /// 条目落入终态（落定 / 取消的状态迁移点调用，同一 callId 至多
    /// 一次）；`status` 与注册表终态子集 1:1，`result` 为与
    /// tool-end 同构的终态结果
    fn on_settled(
        &self,
        summary: &ToolBackgroundCallSummary,
        status: ToolSettledStatus,
        result: &ToolBatchResult,
    );
}

/// 落定结果 → 事件终态分类（与注册表终态子集 1:1）
///
/// 注册表以 is_ok 二分记 SettledOk / SettledErr；取消经包装任务以
/// Cancelled 分类结果 settle（或经注册表 cancel 路径直接收口），
/// 事件侧按结果本义报 cancelled，不被 Err 吞并。
pub fn settled_status_of(result: &ClassifiedToolResult) -> ToolSettledStatus {
    if result.is_ok() {
        ToolSettledStatus::Ok
    } else if result.error_kind == Some(ToolErrorKind::Cancelled) {
        ToolSettledStatus::Cancelled
    } else {
        ToolSettledStatus::Error
    }
}

/// [ClassifiedToolResult] → [ToolBatchResult]（与 session-loop 翻译层
/// 的 tool-end 载荷构造逐项同语义，消费侧以其原位替换占位结果）
pub fn tool_batch_result_from_classified(result: &ClassifiedToolResult) -> ToolBatchResult {
    let is_error = !result.is_ok();
    let output = if is_error {
        ToolOutput {
            text: result.error_message.clone(),
            json: Some(serde_json::json!({
                "code": result
                    .error_kind
                    .map(|k| k.error_code())
                    .unwrap_or("tool.error"),
            })),
            artifacts: None,
        }
    } else if result.output.is_null() {
        ToolOutput::empty()
    } else if let Some(text) = result.output.as_str() {
        ToolOutput::text(text.to_string())
    } else if let Some(obj) = result.output.as_object() {
        let has_known = ["text", "json", "artifacts"]
            .iter()
            .any(|k| obj.contains_key(*k));
        if has_known {
            serde_json::from_value((*result.output).clone()).unwrap_or_default()
        } else {
            ToolOutput {
                text: None,
                json: Some((*result.output).clone()),
                artifacts: None,
            }
        }
    } else {
        ToolOutput {
            text: None,
            json: Some((*result.output).clone()),
            artifacts: None,
        }
    };
    ToolBatchResult {
        id: result.id.clone(),
        tool_name: result.tool_name.clone(),
        output,
        is_error,
        duration_ms: result.duration_ms,
    }
}

/// 无真实执行结果的终态（取消 / 结果未知）合成结果：文案与注册表
/// 留痕同源（[CANCELLED_NOTE] / [OUTCOME_UNKNOWN_NOTE]），错误码走
/// conex-types 生成常量，与执行器 Cancelled / OutcomeUnknown 分类
/// 结果的 tool-end 载荷同码同形。
fn synthesized_error_result(
    summary: &ToolBackgroundCallSummary,
    note: &str,
    code: &str,
    duration_ms: u64,
) -> ToolBatchResult {
    ToolBatchResult {
        id: summary.call_id.clone(),
        tool_name: summary.tool_name.clone(),
        output: ToolOutput {
            text: Some(note.to_string()),
            json: Some(serde_json::json!({ "code": code })),
            artifacts: None,
        },
        is_error: true,
        duration_ms,
    }
}

/// 取消终态的合成结果（注册表 cancel / cancel_run / close_session
/// 收口后发射 tool-settled(cancelled) 用）
pub fn cancelled_tool_batch_result(
    summary: &ToolBackgroundCallSummary,
    duration_ms: u64,
) -> ToolBatchResult {
    synthesized_error_result(
        summary,
        CANCELLED_NOTE,
        conex_types::error::codes::TOOL_CANCELLED,
        duration_ms,
    )
}

/// 结果未知终态的合成结果（冷启动合成发射
/// tool-settled(outcome-unknown) 用）
pub fn outcome_unknown_tool_batch_result(
    summary: &ToolBackgroundCallSummary,
    duration_ms: u64,
) -> ToolBatchResult {
    synthesized_error_result(
        summary,
        OUTCOME_UNKNOWN_NOTE,
        conex_types::error::codes::TOOL_OUTCOME_UNKNOWN,
        duration_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary() -> ToolBackgroundCallSummary {
        ToolBackgroundCallSummary {
            session_id: "s1".to_string(),
            call_id: "c1".to_string(),
            tool_name: "read_file".to_string(),
        }
    }

    #[test]
    fn classified_ok_maps_to_batch_result_with_output_passthrough() {
        let r = ClassifiedToolResult::ok(
            "c1",
            "read_file",
            serde_json::json!({ "done": true }),
            42,
        );
        assert_eq!(settled_status_of(&r), ToolSettledStatus::Ok);
        let batch = tool_batch_result_from_classified(&r);
        assert_eq!(batch.id, "c1");
        assert!(!batch.is_error);
        assert_eq!(batch.duration_ms, 42);
        assert_eq!(
            batch.output.json,
            Some(serde_json::json!({ "done": true })),
            "普通对象输出走 json 透传（与 tool-end 同语义）"
        );
    }

    #[test]
    fn classified_cancelled_maps_to_cancelled_not_error() {
        let r = ClassifiedToolResult::error(
            "c1",
            "read_file",
            ToolErrorKind::Cancelled,
            "aborted",
            7,
        );
        assert_eq!(settled_status_of(&r), ToolSettledStatus::Cancelled);
        let batch = tool_batch_result_from_classified(&r);
        assert!(batch.is_error);
        assert_eq!(batch.output.text.as_deref(), Some("aborted"));
        assert_eq!(
            batch.output.json,
            Some(serde_json::json!({ "code": "tool.cancelled" }))
        );
    }

    #[test]
    fn synthesized_results_carry_registry_notes_and_generated_codes() {
        let cancelled = cancelled_tool_batch_result(&summary(), 5);
        assert!(cancelled.is_error);
        assert_eq!(cancelled.output.text.as_deref(), Some(CANCELLED_NOTE));
        assert_eq!(
            cancelled.output.json,
            Some(serde_json::json!({ "code": "tool.cancelled" }))
        );
        let unknown = outcome_unknown_tool_batch_result(&summary(), 0);
        assert_eq!(unknown.output.text.as_deref(), Some(OUTCOME_UNKNOWN_NOTE));
        assert_eq!(
            unknown.output.json,
            Some(serde_json::json!({ "code": "tool.outcome_unknown" }))
        );
    }
}
