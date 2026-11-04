//! BG3 桥 sink：宿主事件接缝的生产实现——事件经引擎自己的
//! [EventBridge] 实时轨直发，落定同时喂 tool-wake 唤醒通道。
//!
//! 发射口径（波 4-5 补全 §二定案）：
//! - 与 ToolStart / ToolEnd 同轨：同一 EventBridge、同一扁平信封
//!   序列化；信封 runId / sequence **缺省**（实时轨）——落定事件的
//!   发起 run 可能早已收口，携带旧 runId 反而会被前端按 run 过滤；
//!   与 TaskEventConsumer 的 security-audit 直发先例同型（前端对无
//!   runId 事件放行不过滤）；
//! - 不带批收口语义：不经 session-loop 的 emit 循环，不落事件流
//!   sequence；
//! - fire-and-forget：发射失败只记日志，绝不回滚已完成的注册表
//!   状态迁移（迁移先行、发射在后，见 [super::host] 发射点）。
//!
//! 一次状态迁移只在此一处双通道扇出（事件 + 唤醒），禁止在宿主与
//! 本 sink 两处各挂一半造成双发 / 漏发。

use std::sync::Arc;

use conex_types::events::{AgentEvent, AgentEventEnvelope, ToolSettledStatus};
use conex_types::tool::ToolBatchResult;

use crate::core_event_bridge::EventBridge;
use crate::tool_wake_consumer::ToolWakeConsumer;

use super::events::{ToolBackgroundCallSummary, ToolBackgroundEventSink};

/// 后台事件桥 sink（CoreRunState 装配单例：构造后注入
/// EngineHandle 供宿主逐调用发射，同时供冷启动合成直调）
pub struct ToolBackgroundBridgeSink {
    bridge: EventBridge,
    wake: Arc<ToolWakeConsumer>,
}

/// 手写 Debug（EventBridge 本体不实现 Debug——sink 接缝要求
/// Debug 超 trait 以支撑宿主 derive，只报类型名不展开桥内状态）
impl std::fmt::Debug for ToolBackgroundBridgeSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolBackgroundBridgeSink")
            .field("wake", &self.wake)
            .finish_non_exhaustive()
    }
}

impl ToolBackgroundBridgeSink {
    pub fn new(bridge: EventBridge, wake: Arc<ToolWakeConsumer>) -> Self {
        Self { bridge, wake }
    }

    /// 实时轨直发（无 run 归属帧）；未送达只记日志
    fn emit(&self, event: AgentEvent) {
        let report = self
            .bridge
            .emit_envelope(&AgentEventEnvelope::new(event, None, None));
        if report.emitted == 0 {
            tracing::warn!(
                target: "tool_background",
                "后台工具事件发射未送达（序列化失败或桥异常），状态迁移不受影响"
            );
        }
    }

    /// 冷启动合成专用面：事件同 tool-settled(outcome-unknown)，
    /// 唤醒文案走「上次会话有后台工具未完成」专用模板（与常规落定
    /// 的结果摘要模板区分——冷启动条目没有可摘要的执行结果）
    pub fn emit_cold_start_unsettled(
        &self,
        summary: &ToolBackgroundCallSummary,
        result: &ToolBatchResult,
    ) {
        self.emit(AgentEvent::ToolSettled {
            session_id: summary.session_id.clone(),
            call_id: summary.call_id.clone(),
            tool_name: summary.tool_name.clone(),
            status: ToolSettledStatus::OutcomeUnknown,
            result: result.clone(),
        });
        self.wake
            .on_cold_start_unsettled(&summary.session_id, &summary.tool_name);
    }
}

impl ToolBackgroundEventSink for ToolBackgroundBridgeSink {
    fn on_backgrounded(&self, summary: &ToolBackgroundCallSummary, elapsed_ms: u64) {
        self.emit(AgentEvent::ToolBackgrounded {
            session_id: summary.session_id.clone(),
            call_id: summary.call_id.clone(),
            tool_name: summary.tool_name.clone(),
            elapsed_ms,
        });
    }

    fn on_settled(
        &self,
        summary: &ToolBackgroundCallSummary,
        status: ToolSettledStatus,
        result: &ToolBatchResult,
    ) {
        self.emit(AgentEvent::ToolSettled {
            session_id: summary.session_id.clone(),
            call_id: summary.call_id.clone(),
            tool_name: summary.tool_name.clone(),
            status,
            result: result.clone(),
        });
        // 同一迁移的第二通道：tool-wake steering 条目（run 空闲时由
        // WakeWatcher 在护栏内拉起新 run 续接——护栏在 watcher 侧，
        // 本通道只负责入队）
        self.wake
            .on_settled(&summary.session_id, &summary.tool_name, status, result);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_event_bridge::Emitter;
    use orchestrator::steering_queue::PendingMessageQueue;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingEmitter {
        calls: Mutex<Vec<String>>,
    }

    impl Emitter for RecordingEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.calls.lock().unwrap().push(payload.to_string());
        }
    }

    fn sink_and_queue() -> (
        ToolBackgroundBridgeSink,
        Arc<RecordingEmitter>,
        Arc<Mutex<PendingMessageQueue>>,
    ) {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn Emitter>,
        );
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let wake = Arc::new(ToolWakeConsumer::new(Arc::clone(&queue)));
        (ToolBackgroundBridgeSink::new(bridge, wake), emitter, queue)
    }

    fn summary() -> ToolBackgroundCallSummary {
        ToolBackgroundCallSummary {
            session_id: "s1".to_string(),
            call_id: "c1".to_string(),
            tool_name: "read_file".to_string(),
        }
    }

    #[test]
    fn backgrounded_emits_flat_envelope_without_run_frame() {
        let (sink, emitter, _queue) = sink_and_queue();
        sink.on_backgrounded(&summary(), 20_000);
        let calls = emitter.calls.lock().unwrap();
        assert_eq!(calls.len(), 1, "backgrounded 只发一帧");
        let frame: serde_json::Value = serde_json::from_str(&calls[0]).unwrap();
        assert_eq!(frame["type"], "tool-backgrounded");
        assert_eq!(frame["sessionId"], "s1");
        assert_eq!(frame["callId"], "c1");
        assert_eq!(frame["elapsedMs"], 20_000);
        assert!(
            frame.get("runId").is_none() || frame["runId"].is_null(),
            "实时轨帧不带 runId（发起 run 可能已收口）"
        );
    }

    #[test]
    fn settled_emits_event_and_enqueues_tool_wake_in_one_call() {
        let (sink, emitter, queue) = sink_and_queue();
        let result = ToolBatchResult {
            id: "c1".to_string(),
            tool_name: "read_file".to_string(),
            output: conex_types::tool::ToolOutput::text("文件内容".to_string()),
            is_error: false,
            duration_ms: 61_000,
        };
        sink.on_settled(&summary(), ToolSettledStatus::Ok, &result);
        let calls = emitter.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let frame: serde_json::Value = serde_json::from_str(&calls[0]).unwrap();
        assert_eq!(frame["type"], "tool-settled");
        assert_eq!(frame["status"], "ok");
        assert_eq!(frame["result"]["output"]["text"], "文件内容");
        drop(calls);
        // 唤醒通道同迁移入队（一条 tool-wake 条目，目标会话 s1）
        let mut q = queue.lock().unwrap();
        let entries = q.dequeue_by_group(crate::tool_wake_consumer::TOOL_WAKE_GROUP_ID);
        assert_eq!(entries.len(), 1, "落定必须同迁移写入一条 tool-wake 条目");
        assert_eq!(entries[0].session_id, "s1");
        assert!(entries[0].text.contains("read_file"));
    }
}
