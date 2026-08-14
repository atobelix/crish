//! 任务事件消费面（30 方案 P3，裁决 D1 案 A：终态即入队）
//!
//! 消费 [orchestrator::task_events] 的生产入口（A10 N-02：task_events.rs
//! 838 行全套测试壳层零调用——本模块接线后全部 pub 入口转正）：
//!
//! - **唤醒摘要注入**（REQ-C04 / T-AB-18）：终态事件（completed / failed /
//!   killed）按 owner_run_id 归组 → [TaskWakeBatch] → 终态即
//!   drain_merged → [build_wake_steering_entry] → 共享
//!   [PendingMessageQueue]（group_id = `task-wake` 原位替换去重，同 run
//!   多终态合并语义 v1 由 group 去重降级表达，owner 聚合完整语义留 v2）；
//! - **security-audit 审计留痕**：[TaskAuditAccumulator] 聚合
//!   started / completed / failed / killed → 新记录即
//!   [build_task_audit_event] → [EventBridge] 直发（域隔离：**不经**
//!   engine audit_sink——30 文档 §9 接口约定；实时轨 runId/sequence 不注入）；
//! - **无归属任务**（owner_run_id 空串 / 缺失 started 记忆）→ 跳过唤醒
//!   只留审计（30 文档登记决策：daemon 任务不打扰主 agent）。
//!
//! task-failed 的 C7 `steer_for_task_failed` 专属分支 v1 不启用（案 A 已
//! 覆盖 failed 摘要注入；C7 与 recovery 阶梯 2 衔接留 v2 登记）。
//!
//! 装配：消费器实例由 [crate::core_run_commands::CoreRunState] 持有
//! （与引擎 steering 队列同实例）；[crate::background] 注册表经
//! `set_task_event_consumer` 注入槽，EventBridgeSink 构造时读取快照——
//! 顺序契约：先 `set_task_event_consumer` 后 `set_event_bridge`
//! （批 3 main.rs 装配轮按此序，30 文档 §5 改动点 3）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use conex_types::events::{AgentEvent, AgentEventEnvelope};
use orchestrator::steering_queue::PendingMessageQueue;
use orchestrator::task_events::{
    build_task_audit_event, build_wake_steering_entry, TaskAuditAccumulator, TaskAuditOperator,
    TaskAuditResult, TaskWakeBatch,
};

use crate::core_event_bridge::EventBridge;

/// 任务事件消费器（生产实例 = [crate::core_run_commands::CoreRunState] 的
/// `task_events` 字段；注册表侧注入槽持有同一 Arc）。
pub(crate) struct TaskEventConsumer {
    /// 引擎共享 steering 队列（同实例：定时器 / Cron / 任务唤醒共用，
    /// 条目形状一致——SteeringInputEntry，drain 按会话取）
    queue: Arc<Mutex<PendingMessageQueue>>,
    /// 事件桥（security-audit 直发；域隔离不经 engine audit_sink）
    bridge: EventBridge,
    /// 事件体 session_id（空串占位，与 EventBridgeSink 先例一致——任务
    /// 为会话级存活，归属经 payload ownerRunId 表达）
    session_id: String,
    /// 按 owner_run_id 归组的唤醒批次（None 组 = 无归属任务，仅审计不注入）
    batches: Mutex<HashMap<Option<String>, TaskWakeBatch>>,
    /// task_id → owner_run_id（task-started 记忆；None = daemon 无归属）
    owners: Mutex<HashMap<String, Option<String>>>,
    /// 任务审计聚合器（启停/终止留痕；同 task+result 原位替换防无限增长）
    audit: Mutex<TaskAuditAccumulator>,
}

impl TaskEventConsumer {
    /// 新建消费器（queue 必须与引擎 steering 队列同实例——P3 装配点
    /// [crate::core_run_commands::CoreRunState::new] 传入）
    pub(crate) fn new(
        queue: Arc<Mutex<PendingMessageQueue>>,
        bridge: EventBridge,
        session_id: String,
    ) -> Self {
        Self {
            queue,
            bridge,
            session_id,
            batches: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            audit: Mutex::new(TaskAuditAccumulator::new()),
        }
    }

    /// 挂接点入口：task 七事件到达时同步调用（[crate::background] 的
    /// EventBridgeSink::emit 在构造 AgentEvent 后调用；消费器未注入时
    /// （None）仅发射事件不消费——装配前后行为一致）。
    ///
    /// 逻辑（裁决 D1 案 A：终态即入队）：
    /// 1. 审计聚合 started / completed / failed / killed → 新记录即
    ///    security-audit 直发（operation=command-exec，对齐 agent-tools
    ///    shell.rs 红线先例形态）；
    /// 2. task-started 记忆 owner_run_id（终态归组依据）；
    /// 3. 终态事件（completed / failed / killed）查归属 → 批次 push →
    ///    终态即 drain_merged → build_wake_steering_entry → 共享队列
    ///    replace_or_enqueue（group_id = `task-wake` 原位替换去重）；
    /// 4. 无归属任务 → 跳过唤醒只留审计（daemon 不打扰主 agent）。
    pub(crate) fn on_task_event(&self, event: &AgentEvent) {
        // 1. 审计聚合 + 新记录 security-audit 直发
        self.emit_audit_record(event);
        // 2. task-started 记忆 owner_run_id（终态归组依据）
        self.remember_owner(event);
        // 3. 终态事件 → 归组唤醒入队（案 A）
        if matches!(
            event,
            AgentEvent::TaskCompleted { .. }
                | AgentEvent::TaskFailed { .. }
                | AgentEvent::TaskKilled { .. }
        ) {
            self.enqueue_wake_summary(event);
        }
    }

    /// 审计聚合与直发：聚合器产生新记录（同 task+result 原位替换也视为
    /// 新记录——替换后记录内容已更新，需重发保持审计流最新状态）。
    fn emit_audit_record(&self, event: &AgentEvent) {
        let audit_key: Option<(String, TaskAuditResult)> = match event {
            AgentEvent::TaskStarted { task_id, .. } => {
                Some((task_id.clone(), TaskAuditResult::Started))
            }
            AgentEvent::TaskCompleted { task_id, .. } => {
                Some((task_id.clone(), TaskAuditResult::Completed))
            }
            AgentEvent::TaskFailed { task_id, .. } => {
                Some((task_id.clone(), TaskAuditResult::Failed))
            }
            AgentEvent::TaskKilled { task_id, .. } => {
                Some((task_id.clone(), TaskAuditResult::Killed))
            }
            _ => return,
        };
        let Some((task_id, result)) = audit_key else {
            return;
        };
        // 操作者：壳层任务域事件链当前无工具调用上下文可注入（task wire
        // 事件不携带 tool_call_id；任务注册表亦无记忆）——置 None 而非空串
        // （LK-03 空串消解：禁空串；工具发起传真值的注入点留待任务 adopt
        // 链路携带 call id 后接线，届时与「真值」同为有效完成态）
        let operator = TaskAuditOperator::AiTool { tool_call_id: None };
        let record = {
            let mut audit = self.audit.lock().unwrap_or_else(|e| e.into_inner());
            if !audit.push(event, operator) {
                return;
            }
            audit
                .records()
                .iter()
                .find(|r| r.task_id == task_id && r.result == result)
                .cloned()
        };
        if let Some(record) = record {
            // security-audit 直发（实时轨：runId/sequence 不注入，对齐
            // EventBridgeSink 信封先例——前端对无 runId 事件放行不过滤）
            let audit_event = build_task_audit_event(&self.session_id, &record);
            self.bridge
                .emit_envelope(&AgentEventEnvelope::new(audit_event, None, None));
        }
    }

    /// task-started 记忆任务归属（空串 owner_run_id = daemon 无归属）。
    fn remember_owner(&self, event: &AgentEvent) {
        if let AgentEvent::TaskStarted {
            task_id,
            owner_run_id,
            ..
        } = event
        {
            let owner = (!owner_run_id.is_empty()).then(|| owner_run_id.clone());
            self.owners
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(task_id.clone(), owner);
        }
    }

    /// 终态事件归组唤醒入队（裁决 D1 案 A：终态即入队——不等待 idle
    /// 边界，事件到达即 drain 当前 owner 批次写共享队列；「同 run 合并
    /// 一条」语义 v1 由 group_id = `task-wake` 原位替换去重降级表达，
    /// owner 聚合完整语义留 v2）。
    fn enqueue_wake_summary(&self, event: &AgentEvent) {
        let task_id = match event {
            AgentEvent::TaskCompleted { task_id, .. }
            | AgentEvent::TaskFailed { task_id, .. }
            | AgentEvent::TaskKilled { task_id, .. } => task_id.clone(),
            _ => return,
        };
        // 查归属（无 started 记忆 / daemon 任务 → 无归属，跳过唤醒只留审计）
        let owner = self
            .owners
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&task_id)
            .cloned()
            .flatten();
        let Some(owner) = owner else {
            tracing::debug!(
                target: "task_events",
                task_id = %task_id,
                "无归属任务终态：跳过唤醒注入（daemon 或缺失 started 记忆），审计已留痕"
            );
            return;
        };
        // 终态即入队：归组批次 push（同任务多终态原位替换）→ 合并文本 →
        // steering 条目（is_steering 受保护位）→ 共享队列 replace_or_enqueue
        let mut batches = self.batches.lock().unwrap_or_else(|e| e.into_inner());
        let batch = batches.entry(Some(owner)).or_default();
        if batch.push(event) {
            if let Some(text) = batch.drain_merged() {
                let entry = build_wake_steering_entry(text);
                self.queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .replace_or_enqueue(entry);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::events::SecurityAuditDecision;
    use conex_types::events::SecurityAuditOperation;
    use orchestrator::task_events::TASK_WAKE_GROUP_ID;

    /// 记录型事件发射器（出站边界记录调用，不 mock 被测消费链——对齐
    /// background.rs 测试替身同型）。
    #[derive(Default)]
    struct RecordingEmitter {
        calls: Mutex<Vec<(String, String)>>,
    }

    impl RecordingEmitter {
        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl crate::core_event_bridge::Emitter for RecordingEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.calls
                .lock()
                .unwrap()
                .push((channel.to_string(), payload.to_string()));
        }
    }

    /// 测试装配：内存桥（记录发射器）+ 真实 PendingMessageQueue（30 文档
    /// 测试可信标准：队列用真实实现，仅出站边界用替身）。
    fn consumer() -> (
        TaskEventConsumer,
        Arc<RecordingEmitter>,
        Arc<Mutex<PendingMessageQueue>>,
    ) {
        let emitter = Arc::new(RecordingEmitter::default());
        let bridge = EventBridge::new(
            "workbench-run-event",
            Arc::clone(&emitter) as Arc<dyn crate::core_event_bridge::Emitter>,
        );
        let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
        let consumer = TaskEventConsumer::new(Arc::clone(&queue), bridge, String::new());
        (consumer, emitter, queue)
    }

    /// 从记录载荷解析信封（顶层扁平 JSON → [AgentEventEnvelope]，字段级断言用）。
    fn parse_envelope(payload: &str) -> AgentEventEnvelope {
        serde_json::from_str(payload).expect("事件载荷必须可解析为信封")
    }

    fn started(task_id: &str, owner_run_id: &str) -> AgentEvent {
        AgentEvent::TaskStarted {
            session_id: String::new(),
            task_id: task_id.into(),
            command: "cargo build".into(),
            cwd: "/ws".into(),
            owner_run_id: owner_run_id.into(),
            is_daemon: false,
        }
    }

    fn completed(task_id: &str, exit_code: i32) -> AgentEvent {
        AgentEvent::TaskCompleted {
            session_id: String::new(),
            task_id: task_id.into(),
            exit_code,
            duration_ms: 1200,
            line_count: 99,
        }
    }

    fn killed(task_id: &str) -> AgentEvent {
        AgentEvent::TaskKilled {
            session_id: String::new(),
            task_id: task_id.into(),
            via_force: true,
            diagnostics: None,
        }
    }

    /// 验收（30 方案 P3）：终态事件 → steering 条目（group_id = task-wake
    /// 去重、is_steering 受保护位、摘要文本快照「任务 <id> 已完成，退出码 N」）。
    #[test]
    fn consumer_terminal_event_enqueues_wake_steering() {
        let (consumer, _emitter, queue) = consumer();
        consumer.on_task_event(&started("t-1", "run-main"));
        consumer.on_task_event(&completed("t-1", 0));

        let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(queue.len(), 1, "completed 终态即入队");
        let entry = queue.peek().expect("队列必有唤醒条目");
        assert_eq!(entry.group_id.as_deref(), Some(TASK_WAKE_GROUP_ID));
        assert!(entry.is_steering, "唤醒条目为 steering 受保护位");
        assert_eq!(entry.text, "任务 t-1 已完成，退出码 0", "摘要文本快照");
    }

    /// 验收（30 方案 P3）：started + completed → security-audit 两记录
    /// （Started / Completed，approval 决策 approved，operation=command-exec）。
    #[test]
    fn consumer_audit_accumulates_command_exec() {
        let (consumer, emitter, _queue) = consumer();
        consumer.on_task_event(&started("t-1", "run-main"));
        consumer.on_task_event(&completed("t-1", 0));

        let envelopes: Vec<AgentEventEnvelope> = emitter
            .calls()
            .iter()
            .map(|(_, p)| parse_envelope(p))
            .collect();
        assert_eq!(
            envelopes.len(),
            2,
            "started + completed 各直发一条 security-audit"
        );
        for envelope in &envelopes {
            assert_eq!(envelope.type_name(), "security-audit");
            let AgentEvent::SecurityAudit {
                operation,
                targets,
                decision,
                ..
            } = &envelope.event
            else {
                panic!("应为 security-audit 变体");
            };
            assert_eq!(*operation, SecurityAuditOperation::CommandExec);
            assert_eq!(targets[0], "t-1", "targets 承载任务 id（审计可检索）");
            assert_eq!(
                *decision,
                SecurityAuditDecision::Approved,
                "启动/成功 → approved"
            );
        }
    }

    /// 验收（30 方案 P3）：owner_run_id 空串（daemon）→ 无队列条目、
    /// 审计仍在（跳过唤醒只留审计的登记决策）。
    #[test]
    fn consumer_unowned_task_skips_wake_keeps_audit() {
        let (consumer, emitter, queue) = consumer();
        consumer.on_task_event(&started("t-d", ""));
        consumer.on_task_event(&completed("t-d", 0));

        assert_eq!(
            queue.lock().unwrap_or_else(|e| e.into_inner()).len(),
            0,
            "无归属任务不写 steering 队列"
        );
        let envelopes: Vec<AgentEventEnvelope> = emitter
            .calls()
            .iter()
            .map(|(_, p)| parse_envelope(p))
            .collect();
        assert_eq!(envelopes.len(), 2, "审计留痕不受影响");
    }

    /// LK-03 空串消解：任务域审计事件 tool_call_id 置 None（禁空串）——
    /// 壳层任务事件链无工具调用上下文（task wire 事件不携带 call id、
    /// 注册表无记忆），不得以空串冒充真值
    #[test]
    fn consumer_audit_tool_call_id_none_not_empty() {
        let (consumer, emitter, _queue) = consumer();
        consumer.on_task_event(&started("t-1", "run-main"));
        consumer.on_task_event(&completed("t-1", 0));

        let envelopes: Vec<AgentEventEnvelope> = emitter
            .calls()
            .iter()
            .map(|(_, p)| parse_envelope(p))
            .collect();
        assert_eq!(
            envelopes.len(),
            2,
            "started + completed 各直发一条 security-audit"
        );
        for envelope in &envelopes {
            let AgentEvent::SecurityAudit { tool_call_id, .. } = &envelope.event else {
                panic!("应为 security-audit 变体");
            };
            assert!(
                tool_call_id.is_none(),
                "无工具调用上下文 → None（禁空串）: {tool_call_id:?}"
            );
        }
    }

    /// 验收（30 方案 P3）：同任务两次终态 → 队列原位替换（len 不变，
    /// 条目携带最新退出码——group_id = task-wake 去重）。
    #[test]
    fn consumer_same_task_terminal_dedup() {
        let (consumer, _emitter, queue) = consumer();
        consumer.on_task_event(&started("t-1", "run-main"));
        consumer.on_task_event(&completed("t-1", 1));
        consumer.on_task_event(&completed("t-1", 0));

        let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(queue.len(), 1, "同任务二次终态原位替换去重");
        assert_eq!(
            queue.peek().unwrap().text,
            "任务 t-1 已完成，退出码 0",
            "替换后条目携带最新退出码"
        );
    }

    /// 验收（30 方案 P3）：killed 终态摘要快照（「任务 <id> 已被终止」）
    /// 与 failed 摘要模板同走唤醒注入。
    #[test]
    fn consumer_killed_and_failed_summaries_enqueue() {
        let (consumer, _emitter, queue) = consumer();
        consumer.on_task_event(&started("t-k", "run-main"));
        consumer.on_task_event(&killed("t-k"));

        let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue.peek().unwrap().text,
            "任务 t-k 已被终止",
            "killed 摘要快照"
        );
    }
}
