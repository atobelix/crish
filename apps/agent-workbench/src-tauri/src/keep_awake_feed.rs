//! 防休眠事件面喂数（Emitter 装饰器）：事件流 → [KeepAwakeGuard] 计数。
//!
//! # 为什么挂在 Emitter 上
//!
//! 三个「工作进行中」信号源（run 生命周期 / 引擎后台工具 / 壳后台
//! 任务）的事件最终都汇聚到 EventBridge 的出站 Emitter（同一条
//! `workbench-run-event` 通道）：run 事件经 BufferedRunEventBridge
//! flush、任务事件经 task_event_consumer 的 emit_envelope——桥的
//! 监听器接口（attach_listener）只覆盖 emit_envelope 路径，覆盖不全；
//! Emitter 是唯一全量汇聚点。装饰器先转发后观察，观察逻辑故障绝不
//! 影响事件投递本身（解析失败即跳过，无 panic 路径）。
//!
//! # 观察口径（system 级）
//!
//! - `agent-start`（信封 runId）→ acquire `run:{runId}`；
//! - `run-terminal` / `agent-end` → release（终态冗余双路，任一先到
//!   即释放；release 幂等，迟到的另一路为空操作）；
//! - `tool-backgrounded`（callId）→ acquire `tool:{runId}:{callId}`
//!   （无 runId 时退化 `tool:{callId}`；run 归属供托盘计数去重，
//!   见 power::count_active_work）；`tool-settled` → release；
//! - `task-started`（taskId）→ acquire `task:{taskId}`；
//!   `task-completed` / `task-failed` / `task-killed` → release。
//!
//! 热路径纪律：流式 message-delta 是高频事件，观察前先做字面量
//! contains 预筛（候选 type 字面量未命中直接返回）；命中后才做
//! serde 借用解析，并以解析出的 `type` 字段**精确等值**为准——
//! 消息正文里出现 `"run-terminal"` 字样只会多一次解析，不会误触发。
//!
//! # 电脑操作（display 级）
//!
//! [ComputerAwakeFeedEmitter] 装饰 ComputerSlot 的状态发射器
//! （`computer://state-changed` 通道）：payload 的 `mode` 域为
//! `"desktop"` 时 acquire display 持有，迁出即 release；仅携带
//! `enabled:false` 的事件（run 停止收尾）同样 release 兜底。
//! 已知边界：ComputerSlot 的惰性恢复（ensure_restored）可能在
//! emitter 挂接前发出首个状态事件（槽为空即丢弃）——此后任一状态
//! 迁移（enable/disable/run 停止）都会再发事件，计数可自愈。

use std::sync::Arc;

use conex_run::core_event_bridge::Emitter;
use serde::Deserialize;

use crate::power::{AwakeKind, KeepAwakeGuard};

/// 候选事件 type 字面量（含引号的 JSON 形态，预筛用）
const CANDIDATE_LITERALS: [&str; 11] = [
    "\"agent-start\"",
    "\"agent-end\"",
    "\"run-terminal\"",
    "\"tool-backgrounded\"",
    "\"tool-settled\"",
    "\"task-started\"",
    "\"task-completed\"",
    "\"task-failed\"",
    "\"task-killed\"",
    "\"approval-requested\"",
    "\"approval-resolved\"",
];

/// 事件探针（借用解析：只取计数需要的字段，其余忽略）
#[derive(Deserialize)]
struct EventProbe<'a> {
    #[serde(rename = "type")]
    event_type: &'a str,
    #[serde(rename = "runId", default)]
    run_id: Option<&'a str>,
    #[serde(rename = "callId", default)]
    call_id: Option<&'a str>,
    #[serde(rename = "taskId", default)]
    task_id: Option<&'a str>,
}

/// run 事件通道喂数装饰器（挂 EventBridge 出站 Emitter 最外层）
pub struct KeepAwakeFeedEmitter {
    inner: Arc<dyn Emitter>,
    guard: Arc<KeepAwakeGuard>,
    /// 托盘状态钩子（完整档）：审批挂起/消解事件到达时回调——托盘
    /// 待审批数无守卫账本可挂监听，借同一事件流触发重算（重算读
    /// CoreRunState 真源，钩子本身不计数、不漂移）
    status_hook: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl KeepAwakeFeedEmitter {
    pub fn new(inner: Arc<dyn Emitter>, guard: Arc<KeepAwakeGuard>) -> Self {
        Self {
            inner,
            guard,
            status_hook: None,
        }
    }

    /// 注入托盘状态钩子（见字段注；壳 setup 装配）
    pub fn with_status_hook(mut self, hook: Arc<dyn Fn() + Send + Sync>) -> Self {
        self.status_hook = Some(hook);
        self
    }

    fn observe(&self, payload: &str) {
        if !CANDIDATE_LITERALS.iter().any(|lit| payload.contains(lit)) {
            return;
        }
        let Ok(probe) = serde_json::from_str::<EventProbe>(payload) else {
            return;
        };
        match probe.event_type {
            "agent-start" => {
                if let Some(run_id) = probe.run_id {
                    self.guard.acquire(AwakeKind::System, &run_key(run_id));
                }
            }
            "run-terminal" | "agent-end" => {
                if let Some(run_id) = probe.run_id {
                    self.guard.release(AwakeKind::System, &run_key(run_id));
                }
            }
            "tool-backgrounded" => {
                if let Some(call_id) = probe.call_id {
                    self.guard
                        .acquire(AwakeKind::System, &tool_key(probe.run_id, call_id));
                }
            }
            "tool-settled" => {
                if let Some(call_id) = probe.call_id {
                    self.guard
                        .release(AwakeKind::System, &tool_key(probe.run_id, call_id));
                }
            }
            "task-started" => {
                if let Some(task_id) = probe.task_id {
                    self.guard.acquire(AwakeKind::System, &task_key(task_id));
                }
            }
            "task-completed" | "task-failed" | "task-killed" => {
                if let Some(task_id) = probe.task_id {
                    self.guard.release(AwakeKind::System, &task_key(task_id));
                }
            }
            _ => {}
        }
        // 审批事件不进守卫账本，仅触发托盘计数重算（真源在 CoreRunState）
        if matches!(probe.event_type, "approval-requested" | "approval-resolved") {
            if let Some(hook) = &self.status_hook {
                hook();
            }
        }
    }
}

impl Emitter for KeepAwakeFeedEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        // 先转发（观察不得影响投递），后计数
        self.inner.emit(channel, payload);
        self.observe(payload);
    }
}

fn run_key(run_id: &str) -> String {
    format!("run:{run_id}")
}

fn tool_key(run_id: Option<&str>, call_id: &str) -> String {
    match run_id {
        Some(run_id) => format!("tool:{run_id}:{call_id}"),
        None => format!("tool:{call_id}"),
    }
}

fn task_key(task_id: &str) -> String {
    format!("task:{task_id}")
}

/// display 级持有键（进程内单例语义：电脑操作会话全局唯一）
const COMPUTER_DISPLAY_KEY: &str = "computer-session";

/// ComputerSlot 状态通道喂数装饰器（display 级）
pub struct ComputerAwakeFeedEmitter {
    inner: Arc<dyn Emitter>,
    guard: Arc<KeepAwakeGuard>,
}

impl ComputerAwakeFeedEmitter {
    pub fn new(inner: Arc<dyn Emitter>, guard: Arc<KeepAwakeGuard>) -> Self {
        Self { inner, guard }
    }

    fn observe(&self, payload: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            return;
        };
        match value.get("mode").and_then(|m| m.as_str()) {
            Some("desktop") => self.guard.acquire(AwakeKind::Display, COMPUTER_DISPLAY_KEY),
            Some(_) => self.guard.release(AwakeKind::Display, COMPUTER_DISPLAY_KEY),
            None => {
                // 无 mode 域（仅 enabled 变更）：禁用即释放兜底
                if value.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
                    self.guard.release(AwakeKind::Display, COMPUTER_DISPLAY_KEY);
                }
            }
        }
    }
}

impl Emitter for ComputerAwakeFeedEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        self.inner.emit(channel, payload);
        self.observe(payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingEmitter {
        sent: Mutex<Vec<String>>,
    }

    impl Emitter for RecordingEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.sent.lock().unwrap().push(payload.to_string());
        }
    }

    fn envelope(event_type: &str, extra: &str) -> String {
        format!(
            "{{\"type\":\"{event_type}\",\"runId\":\"run-1\",\"sequence\":1,\"schemaVersion\":1,\"sessionId\":\"s1\"{extra}}}"
        )
    }

    #[test]
    fn run_lifecycle_acquires_and_releases() {
        let guard = KeepAwakeGuard::new();
        let feed = KeepAwakeFeedEmitter::new(
            Arc::new(RecordingEmitter::default()),
            Arc::clone(&guard),
        );
        feed.emit("workbench-run-event", &envelope("agent-start", ""));
        assert!(guard.current_request().system);
        // run-terminal 的 runId 在事件体（与信封同名同层）同样可读
        feed.emit("workbench-run-event", &envelope("run-terminal", ""));
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
    }

    #[test]
    fn agent_end_is_release_backstop() {
        let guard = KeepAwakeGuard::new();
        let feed = KeepAwakeFeedEmitter::new(
            Arc::new(RecordingEmitter::default()),
            Arc::clone(&guard),
        );
        feed.emit("workbench-run-event", &envelope("agent-start", ""));
        feed.emit("workbench-run-event", &envelope("agent-end", ""));
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
        // 迟到的 run-terminal 再 release 为空操作
        feed.emit("workbench-run-event", &envelope("run-terminal", ""));
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
    }

    #[test]
    fn tool_and_task_cycles() {
        let guard = KeepAwakeGuard::new();
        let feed = KeepAwakeFeedEmitter::new(
            Arc::new(RecordingEmitter::default()),
            Arc::clone(&guard),
        );
        feed.emit(
            "workbench-run-event",
            &envelope("tool-backgrounded", ",\"callId\":\"call-9\""),
        );
        feed.emit(
            "workbench-run-event",
            &envelope("task-started", ",\"taskId\":\"task-7\""),
        );
        assert!(guard.current_request().system);
        feed.emit(
            "workbench-run-event",
            &envelope("tool-settled", ",\"callId\":\"call-9\""),
        );
        assert!(guard.current_request().system, "task 仍在运行应保持");
        feed.emit(
            "workbench-run-event",
            &envelope("task-failed", ",\"taskId\":\"task-7\""),
        );
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
    }

    #[test]
    fn backgrounded_tool_is_covered_by_its_run_until_run_ends() {
        let guard = KeepAwakeGuard::new();
        let feed = KeepAwakeFeedEmitter::new(
            Arc::new(RecordingEmitter::default()),
            Arc::clone(&guard),
        );
        feed.emit("workbench-run-event", &envelope("agent-start", ""));
        feed.emit(
            "workbench-run-event",
            &envelope("tool-backgrounded", ",\"callId\":\"call-9\""),
        );
        // 信封 runId 归属：工具被 run 单元涵盖（托盘计数不重复）
        assert_eq!(guard.active_work_count(), 1);
        feed.emit("workbench-run-event", &envelope("agent-end", ""));
        assert_eq!(guard.active_work_count(), 1, "工具脱离续跑独立计 1");
        assert!(guard.current_request().system, "脱离工具仍应保持唤醒");
        feed.emit(
            "workbench-run-event",
            &envelope("tool-settled", ",\"callId\":\"call-9\""),
        );
        assert_eq!(guard.active_work_count(), 0);
    }

    #[test]
    fn status_hook_fires_only_on_approval_events() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hits = Arc::new(AtomicUsize::new(0));
        let feed = KeepAwakeFeedEmitter::new(
            Arc::new(RecordingEmitter::default()),
            KeepAwakeGuard::new(),
        )
        .with_status_hook(Arc::new({
            let hits = Arc::clone(&hits);
            move || {
                hits.fetch_add(1, Ordering::SeqCst);
            }
        }));
        feed.emit("workbench-run-event", &envelope("approval-requested", ""));
        feed.emit("workbench-run-event", &envelope("approval-resolved", ""));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        feed.emit("workbench-run-event", &envelope("agent-start", ""));
        feed.emit("workbench-run-event", &envelope("tool-backgrounded", ",\"callId\":\"c\""));
        assert_eq!(hits.load(Ordering::SeqCst), 2, "非审批事件不触发钩子");
    }

    #[test]
    fn message_text_mentioning_type_does_not_trigger() {
        let guard = KeepAwakeGuard::new();
        let feed = KeepAwakeFeedEmitter::new(
            Arc::new(RecordingEmitter::default()),
            Arc::clone(&guard),
        );
        // 正文含候选字面量但 type 是 message-delta：预筛命中后精确校验拦截
        let payload = "{\"type\":\"message-delta\",\"runId\":\"run-1\",\"text\":\"see \\\"run-terminal\\\" docs\"}";
        feed.emit("workbench-run-event", payload);
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
    }

    #[test]
    fn forwarding_is_unchanged() {
        let inner = Arc::new(RecordingEmitter::default());
        let feed = KeepAwakeFeedEmitter::new(
            Arc::clone(&inner) as Arc<dyn Emitter>,
            KeepAwakeGuard::new(),
        );
        feed.emit("workbench-run-event", &envelope("agent-start", ""));
        feed.emit("workbench-run-event", "{\"type\":\"message-delta\"}");
        assert_eq!(inner.sent.lock().unwrap().len(), 2);
    }

    #[test]
    fn computer_mode_drives_display_hold() {
        let guard = KeepAwakeGuard::new();
        let feed = ComputerAwakeFeedEmitter::new(
            Arc::new(RecordingEmitter::default()),
            Arc::clone(&guard),
        );
        feed.emit("computer://state-changed", "{\"mode\":\"desktop\"}");
        let request = guard.current_request();
        assert!(request.display && request.system);
        feed.emit("computer://state-changed", "{\"mode\":\"idle\"}");
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
        // enabled:false 单域事件兜底释放
        feed.emit("computer://state-changed", "{\"mode\":\"desktop\"}");
        feed.emit("computer://state-changed", "{\"enabled\":false}");
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
        // browser 模式不点亮屏幕
        feed.emit("computer://state-changed", "{\"mode\":\"browser\"}");
        assert_eq!(guard.current_request(), crate::power::AwakeRequest::NONE);
    }
}
