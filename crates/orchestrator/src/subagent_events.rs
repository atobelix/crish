//! 子代理域事件源唯一发射方（I5-M7 契约；I7-M14 收口）
//!
//! 定位（02 方案 M7 内容 4 / M14 内容 2）：`subagent-started` /
//! `subagent-event` / `subagent-ended` 三事件由本模块**唯一发射**——03 方案
//! E1 的 `subagent.start` / `subagent.end` 钩子只消费本发射面、**只挂钩
//! 不补源**（E1 不得在 orchestrator 域重复发射）。
//!
//! 信封对齐基准：`apps/crish-desktop/src/api/chat-bridge/handlers/
//! subagentHandlers.ts:12-63`（前端解析器，本模块不改前端）：
//! - `subagent-started`：subagentId / subagentRunId / parentRunId（信封
//!   runId = 父 run）/ parentToolCallId / description / mode；
//! - `subagent-event`：subagentId / subagentRunId / event（结构化负载）；
//! - `subagent-ended`：subagentId / subagentRunId / status / summary。
//!
//! 背压分级（M7 注册表锁定，registry_drift 护栏）：
//! - `subagent-started` / `subagent-ended`：**Critical**（必达，EventQueue
//!   落库不丢）；
//! - `subagent-event`：按 kind——progress=**Delta**（不落库不阻塞 drive
//!   loop）、message/tool=**Soft**（尽力落库）。
//!
//! 发射点（引擎侧接线位）：
//! - spawn 成功 → [SubagentEventEmitter::emit_started]（FlowScheduler 已接）；
//! - 运行中增量 → [SubagentEventEmitter::emit_event]（子代理 run 实时事件
//!   流派生，引擎侧接线）；
//! - 收口（终态）→ [SubagentEventEmitter::emit_ended]（FlowScheduler 已接）。
//!
//! 序列语义：经 [EventQueue] 推送（store 端会话级原子计数器取号，T08.12），
//! 会话内全局单调；runId（父 run）由信封 emit 层注入（03 §5.3-2），本模块
//! 只推事件体，`parent_run_id` 经 [SubagentEmitContext] 随调用携带。
//!
//! 广播（D-02 LK-05，主控裁决 F-01）：`subagent-started` / `subagent-ended`
//! 落库成功后经 [SubagentEventBroadcaster] 槽广播（**先落库后广播**，
//! runId=父 run，与 progress 同轨对称；广播失败不回滚落库）。广播槽为
//! 可选接线（None = 只落库不广播）；壳层经 [SubagentEventEmitter::with_broadcast]
//! 注入事件桥实现（PC-03 禁止项：orchestrator 不依赖壳层桥）。

use std::sync::Arc;

use conex_types::events::{
    AgentEvent, AgentEventEnvelope, SubagentEndStatus, SubagentEventKind, SubagentEventPayload,
};

use crate::events::{EventQueue, PersistError, SequencedEvent};
use crate::persist::Store;
use conex_shared::time::now_iso_utc;

/// 发射上下文（父 run 归属：信封 runId = parent_run_id，03 §5.3-2）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentEmitContext {
    /// 事件归属会话（父会话）
    pub session_id: String,
    /// 父 run id（信封 runId 注入值 = 父 run，01 B1-2 ParentID 语义）
    pub parent_run_id: String,
}

/// `subagent-started` 载荷（信封对齐 subagentHandlers.ts:17-26）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentStartedInfo {
    /// 子代理 id（session_agents.agent_id）
    pub subagent_id: String,
    /// 子代理 run id（同一 run 续跑不变，C1 硬约束）
    pub subagent_run_id: String,
    /// 角色（wire 名；缺省 researcher，前端 AgentBrowsePad 语义）
    pub role: String,
    /// 能力模式（wire 名；缺省 read-write）
    pub capability_mode: String,
    /// ISO8601 时间戳（首次创建时间，M4 started_at 同源）
    pub started_at: String,
    /// 人读描述（前端缺省 '协作 agent'）
    pub description: Option<String>,
    /// 调度模式（research/research_single/solve/write，前端缺省 research）
    pub mode: Option<String>,
    /// 父 run 发起 spawn 的工具调用 id
    pub parent_tool_call_id: Option<String>,
    /// 子会话 id（D-02 LK-04 跨会话导航键：父会话三事件视图 → 子会话
    /// 事件流；None = 发射面未接线/旧帧，前端回退行级反查）
    pub subagent_session_id: Option<String>,
}

/// `subagent-event` 载荷（event 为结构化负载，前端整体透传）
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentEventInfo {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 事件类别（progress/message/tool；背压随 kind）
    pub kind: SubagentEventKind,
    /// 类别负载（progress 携带进度片段、message 携带消息、tool 携带工具摘要）
    pub payload: Option<serde_json::Value>,
}

/// `subagent-ended` 载荷（status 规范值 completed/failed/cancelled，
/// 前端正则映射 stopped/failed/completed，subagentHandlers.ts:50-56）
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentEndedInfo {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 终态（Rust 只发规范值，不产生 stopped）
    pub status: SubagentEndStatus,
    /// 收尾摘要（可选）
    pub summary: Option<String>,
    /// 子会话 id（D-02 LK-04 跨会话导航键：SubagentEnded(subagent_run_id)
    /// → 子会话事件流 / session_agents 行反查；None = 发射面未接线/旧帧）
    pub subagent_session_id: Option<String>,
}

impl SubagentEndedInfo {
    /// 从 M2 三方状态机终态构造（completed→Completed；其余终态→Failed，
    /// 被终止 run 归一 failed，I0 裁决；cancelled 由引擎侧显式传）
    pub fn from_subagent_state(
        subagent_id: impl Into<String>,
        subagent_run_id: impl Into<String>,
        state: agent_tools::tools::subagent::SubagentState,
    ) -> Self {
        let status = match state {
            agent_tools::tools::subagent::SubagentState::Completed => SubagentEndStatus::Completed,
            _ => SubagentEndStatus::Failed,
        };
        Self {
            subagent_id: subagent_id.into(),
            subagent_run_id: subagent_run_id.into(),
            status,
            summary: None,
            // D-02 LK-04：子会话 id 由发射方装配（spawner 反查 runs 注册表
            // 后置赋值）；本构造点缺省 None，避免 from_subagent_state 签名
            // 携带非状态语义参数
            subagent_session_id: None,
        }
    }
}

/// 构造 `subagent-started` 事件（信封对齐 subagentHandlers.ts:17-26）
pub fn build_subagent_started(ctx: &SubagentEmitContext, info: &SubagentStartedInfo) -> AgentEvent {
    AgentEvent::SubagentStarted {
        session_id: ctx.session_id.clone(),
        subagent_id: info.subagent_id.clone(),
        subagent_run_id: info.subagent_run_id.clone(),
        role: info.role.clone(),
        capability_mode: info.capability_mode.clone(),
        started_at: info.started_at.clone(),
        description: info.description.clone(),
        mode: info.mode.clone(),
        parent_tool_call_id: info.parent_tool_call_id.clone(),
        subagent_session_id: info.subagent_session_id.clone(),
    }
}

/// 构造 `subagent-event` 事件（event 为结构化负载）
pub fn build_subagent_event(ctx: &SubagentEmitContext, info: &SubagentEventInfo) -> AgentEvent {
    AgentEvent::SubagentEvent {
        session_id: ctx.session_id.clone(),
        subagent_id: info.subagent_id.clone(),
        subagent_run_id: info.subagent_run_id.clone(),
        event: SubagentEventPayload {
            kind: info.kind,
            payload: info.payload.clone(),
        },
    }
}

/// 构造 `subagent-ended` 事件（status 规范值 + endedAt 时间戳）
pub fn build_subagent_ended(ctx: &SubagentEmitContext, info: &SubagentEndedInfo) -> AgentEvent {
    AgentEvent::SubagentEnded {
        session_id: ctx.session_id.clone(),
        subagent_id: info.subagent_id.clone(),
        subagent_run_id: info.subagent_run_id.clone(),
        status: info.status,
        summary: info.summary.clone(),
        ended_at: now_iso_utc(),
        subagent_session_id: info.subagent_session_id.clone(),
    }
}

/// 广播接收器（壳层事件桥接线面；None = 只落库不广播——编排纯逻辑域零广播）。
///
/// D-02 LK-05（主控裁决 F-01 归位）：`subagent-started` / `subagent-ended`
/// 落库成功后经本槽广播（**先落库后广播**，runId=父 run，与 progress 同轨
/// 对称）；广播失败仅告警、**不回滚落库**（Critical 必达语义不动）。
/// 壳层实现把信封经事件桥（EventBridge）发射；orchestrator 不依赖壳层桥
/// （PC-03 禁止项：广播必须壳层接线）。
pub trait SubagentEventBroadcaster: Send + Sync {
    /// 广播一条已落库事件的信封（Err = 广播失败，调用方仅告警不阻断）
    fn broadcast(&self, envelope: &AgentEventEnvelope) -> Result<(), String>;
}

/// 子代理事件发射器（唯一发射方落地；经 [EventQueue] 推送）
///
/// 每次发射自建 [EventQueue]（store 端会话级原子计数器取号，T08.12：
/// 会话内全局单调、跨 run 不重置——base_sequence 仅作本地镜像初值，
/// 不破坏序列连续性）。
///
/// 失败语义：发射失败返回错误，由调用方决定（FlowScheduler 接线为
/// 「事件只观测不阻塞编排」，记录日志继续）。
pub struct SubagentEventEmitter {
    store: Arc<dyn Store>,
    /// 广播槽（LK-05：壳层事件桥接线；None = 只落库不广播）
    broadcast: Option<Arc<dyn SubagentEventBroadcaster>>,
}

impl SubagentEventEmitter {
    /// 新建发射器（共享 store；序列由 store 端原子计数器保证）
    pub fn new(store: Arc<dyn Store>) -> Self {
        Self {
            store,
            broadcast: None,
        }
    }

    /// 挂载广播槽（LK-05：壳层注入事件桥；None 默认 = 只落库不广播）
    pub fn with_broadcast(mut self, broadcast: Arc<dyn SubagentEventBroadcaster>) -> Self {
        self.broadcast = Some(broadcast);
        self
    }

    /// LK-05：落库成功后补广播（**先落库后广播**——顺序约束，广播失败
    /// 不回滚落库）。信封 runId = 父 run（与 progress 同轨对称；空父 run
    /// 置 None，前端回退 env.runId）；sequence 随落库序列同源。
    fn broadcast_after_persist(&self, ctx: &SubagentEmitContext, sequenced: &SequencedEvent) {
        let Some(broadcast) = &self.broadcast else {
            return;
        };
        let envelope = AgentEventEnvelope::new(
            sequenced.event.clone(),
            (!ctx.parent_run_id.is_empty()).then(|| ctx.parent_run_id.clone()),
            Some(sequenced.sequence),
        );
        if let Err(error) = broadcast.broadcast(&envelope) {
            tracing::warn!(
                target: "subagent_events",
                event = "broadcast_failed",
                parent_run_id = %ctx.parent_run_id,
                error = %error,
                "subagent 事件广播失败（先落库后广播：落库已成功，不回滚）"
            );
        }
    }

    /// spawn 成功发射 `subagent-started`（Critical 必达落库）
    pub async fn emit_started(
        &self,
        ctx: &SubagentEmitContext,
        info: &SubagentStartedInfo,
    ) -> Result<SequencedEvent, PersistError> {
        // D-01 DM-04：队列构造期绑定父 run 归属（空则 None = 会话域）
        let mut queue = EventQueue::new(
            self.store.clone(),
            1,
            (!ctx.parent_run_id.is_empty()).then(|| ctx.parent_run_id.clone()),
        );
        let sequenced = queue
            .push(&ctx.session_id, build_subagent_started(ctx, info))
            .await?;
        // LK-05：先落库后广播（广播失败不回滚落库）
        self.broadcast_after_persist(ctx, &sequenced);
        Ok(sequenced)
    }

    /// 运行中发射 `subagent-event`（progress=Delta 不落库不阻塞；
    /// message/tool=Soft 尽力落库）
    pub async fn emit_event(
        &self,
        ctx: &SubagentEmitContext,
        info: &SubagentEventInfo,
    ) -> Result<SequencedEvent, PersistError> {
        // D-01 DM-04：队列构造期绑定父 run 归属（空则 None = 会话域）
        let mut queue = EventQueue::new(
            self.store.clone(),
            1,
            (!ctx.parent_run_id.is_empty()).then(|| ctx.parent_run_id.clone()),
        );
        queue
            .push(&ctx.session_id, build_subagent_event(ctx, info))
            .await
    }

    /// 收口发射 `subagent-ended`（Critical 必达落库）
    pub async fn emit_ended(
        &self,
        ctx: &SubagentEmitContext,
        info: &SubagentEndedInfo,
    ) -> Result<SequencedEvent, PersistError> {
        // D-01 DM-04：队列构造期绑定父 run 归属（空则 None = 会话域）
        let mut queue = EventQueue::new(
            self.store.clone(),
            1,
            (!ctx.parent_run_id.is_empty()).then(|| ctx.parent_run_id.clone()),
        );
        let sequenced = queue
            .push(&ctx.session_id, build_subagent_ended(ctx, info))
            .await?;
        // LK-05：先落库后广播（广播失败不回滚落库）
        self.broadcast_after_persist(ctx, &sequenced);
        Ok(sequenced)
    }
}

/// 从 spawn 请求/结果装配 `subagent-started` 信息（FlowScheduler 接线用；
/// role/capability 缺省与前端缺省语义对齐）
pub(crate) fn started_info_from_spawn(
    request: &agent_tools::tools::subagent::SubagentSpawnRequest,
    result: &agent_tools::tools::subagent::SubagentSpawnResult,
) -> SubagentStartedInfo {
    SubagentStartedInfo {
        subagent_id: result.subagent_id.clone(),
        subagent_run_id: result.subagent_run_id.clone(),
        role: request
            .role
            .map(|r| r.as_str())
            .unwrap_or("researcher")
            .to_string(),
        capability_mode: request
            .capability_mode
            .map(|m| m.as_str())
            .unwrap_or("read-write")
            .to_string(),
        started_at: now_iso_utc(),
        description: request.description.clone(),
        mode: request.mode.clone(),
        parent_tool_call_id: request.parent_tool_call_id.clone(),
        // D-02 LK-04：子会话 id 由 spawn 结果信封装配（result.session_id =
        // sub-sess-{depth}-{n}，spawner 与 flow 两路径共用）
        subagent_session_id: Some(result.session_id.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persist::InMemoryStore;
    use agent_tools::tools::subagent::{
        SubagentCapabilityMode, SubagentRole, SubagentSpawnRequest, SubagentSpawnResult,
        SubagentState,
    };
    use conex_types::events::{event_backpressure, BackpressureLevel};

    fn ctx() -> SubagentEmitContext {
        SubagentEmitContext {
            session_id: "sess-main".to_string(),
            parent_run_id: "run-main".to_string(),
        }
    }

    fn started_info() -> SubagentStartedInfo {
        SubagentStartedInfo {
            subagent_id: "sub-1".to_string(),
            subagent_run_id: "sub-run-1".to_string(),
            role: "researcher".to_string(),
            capability_mode: "read-only".to_string(),
            started_at: "2026-08-04T00:00:00.000Z".to_string(),
            description: Some("调研模块 A".to_string()),
            mode: Some("research".to_string()),
            parent_tool_call_id: Some("call_1".to_string()),
            subagent_session_id: Some("sub-sess-1".to_string()),
        }
    }

    fn ended_info(status: SubagentEndStatus) -> SubagentEndedInfo {
        SubagentEndedInfo {
            subagent_id: "sub-1".to_string(),
            subagent_run_id: "sub-run-1".to_string(),
            status,
            summary: Some("完成".to_string()),
            subagent_session_id: Some("sub-sess-1".to_string()),
        }
    }

    // ── D-02 LK-04：started_info_from_spawn 透传链（S5 测钉）──

    fn spawn_request(parent_tool_call_id: Option<String>) -> SubagentSpawnRequest {
        SubagentSpawnRequest {
            agent_id: None,
            prompt: "调研模块 A".to_string(),
            role: Some(SubagentRole::Researcher),
            capability_mode: Some(SubagentCapabilityMode::ReadOnly),
            allowed_tools: None,
            description: Some("调研子代理".to_string()),
            mode: Some("research".to_string()),
            parent_session_id: "sess-main".to_string(),
            parent_run_id: Some("run-main".to_string()),
            parent_tool_call_id,
            flow_node_id: None,
            is_composite: false,
            task_type: None,
            allowed_write_paths: None,
            display_label: None,
            model_override: None,
        }
    }

    fn spawn_result() -> SubagentSpawnResult {
        SubagentSpawnResult {
            subagent_id: "sub-1".to_string(),
            subagent_run_id: "sub-run-1".to_string(),
            session_id: "sub-sess-1".to_string(),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: None,
            display_label: None,
        }
    }

    /// S5 测钉（D-02 LK-04）：started_info_from_spawn 填值断言——
    /// subagent_session_id == result.session_id（spawner 与 flow 两路径
    /// 共用装配点）；parent_tool_call_id / description / mode 自 request
    /// 透传；role/capability_mode 缺省 researcher/read-write（前端缺省对齐）
    #[test]
    fn started_info_from_spawn_fills_values() {
        let info = started_info_from_spawn(
            &spawn_request(Some("call-lk08-1".to_string())),
            &spawn_result(),
        );
        // 子会话 id：result 信封装配（导航键第一段）
        assert_eq!(
            info.subagent_session_id.as_deref(),
            Some("sub-sess-1"),
            "subagent_session_id 必须取 result.session_id"
        );
        // 父工具调用 id：request 透传（LK-02 真键）
        assert_eq!(
            info.parent_tool_call_id.as_deref(),
            Some("call-lk08-1"),
            "parent_tool_call_id 必须自 request 透传"
        );
        // id / 描述 / 模式 / 角色 / 能力模式
        assert_eq!(info.subagent_id, "sub-1");
        assert_eq!(info.subagent_run_id, "sub-run-1");
        assert_eq!(info.description.as_deref(), Some("调研子代理"));
        assert_eq!(info.mode.as_deref(), Some("research"));
        assert_eq!(info.role, "researcher");
        assert_eq!(info.capability_mode, "read-only");
    }

    /// S5 测钉（D-02 LK-04）：无父工具调用上下文 → parent_tool_call_id
    /// 保持 None（flow 路径定案：链路键 = flow_node_id，不编造 id）
    #[test]
    fn started_info_from_spawn_keeps_none_without_tool_call() {
        let info = started_info_from_spawn(&spawn_request(None), &spawn_result());
        assert!(
            info.parent_tool_call_id.is_none(),
            "无工具调用上下文保持 None"
        );
        assert_eq!(
            info.subagent_session_id.as_deref(),
            Some("sub-sess-1"),
            "子会话 id 独立于工具调用链（flow 路径同样携带）"
        );
    }

    /// S5 测钉（D-02 LK-04）：started_info_from_spawn → build_subagent_started
    /// 全链透传——事件体 wire 键 subagentSessionId == result.session_id
    #[test]
    fn started_info_from_spawn_reaches_event_wire() {
        let info = started_info_from_spawn(
            &spawn_request(Some("call-lk08-1".to_string())),
            &spawn_result(),
        );
        let event = build_subagent_started(&ctx(), &info);
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(
            value["subagentSessionId"], "sub-sess-1",
            "事件体 wire 键 subagentSessionId 必须携带子会话 id"
        );
        assert_eq!(value["parentToolCallId"], "call-lk08-1");
    }

    // ── 信封对齐（subagentHandlers.ts 消费字段逐一在场）──

    #[test]
    fn started_envelope_matches_frontend_contract() {
        let event = build_subagent_started(&ctx(), &started_info());
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "subagent-started");
        // 前端消费字段（subagentHandlers.ts:17-26）：subagentId/subagentRunId/
        // description/mode/parentToolCallId（parentRunId 由信封 runId 注入）
        assert_eq!(value["subagentId"], "sub-1");
        assert_eq!(value["subagentRunId"], "sub-run-1");
        assert_eq!(value["description"], "调研模块 A");
        assert_eq!(value["mode"], "research");
        assert_eq!(value["parentToolCallId"], "call_1");
        // 展示字段（role/capabilityMode/startedAt）必填在场
        assert_eq!(value["role"], "researcher");
        assert_eq!(value["capabilityMode"], "read-only");
        assert_eq!(value["startedAt"], "2026-08-04T00:00:00.000Z");
    }

    #[test]
    fn event_envelope_matches_frontend_contract() {
        let info = SubagentEventInfo {
            subagent_id: "sub-1".to_string(),
            subagent_run_id: "sub-run-1".to_string(),
            kind: SubagentEventKind::Progress,
            payload: Some(serde_json::json!({ "text": "50%" })),
        };
        let event = build_subagent_event(&ctx(), &info);
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "subagent-event");
        // 前端整体透传（subagentHandlers.ts:38-42）
        assert_eq!(value["subagentId"], "sub-1");
        assert_eq!(value["subagentRunId"], "sub-run-1");
        assert_eq!(value["event"]["kind"], "progress");
        assert_eq!(value["event"]["payload"]["text"], "50%");
    }

    #[test]
    fn ended_envelope_matches_frontend_contract() {
        let event = build_subagent_ended(&ctx(), &ended_info(SubagentEndStatus::Completed));
        let value = serde_json::to_value(&event).unwrap();
        assert_eq!(value["type"], "subagent-ended");
        // 前端消费字段（subagentHandlers.ts:57-62）：status/summary；
        // completed 命中前端正则 → completed 展示
        assert_eq!(value["subagentId"], "sub-1");
        assert_eq!(value["subagentRunId"], "sub-run-1");
        assert_eq!(value["status"], "completed");
        assert_eq!(value["summary"], "完成");
        assert!(value["endedAt"].is_string(), "endedAt 必填 ISO8601");
    }

    // ── 背压分级（M7 注册表锁定）──

    #[test]
    fn backpressure_classification() {
        assert_eq!(
            event_backpressure(&build_subagent_started(&ctx(), &started_info())),
            BackpressureLevel::Critical,
            "subagent-started 必达落库"
        );
        assert_eq!(
            event_backpressure(&build_subagent_ended(
                &ctx(),
                &ended_info(SubagentEndStatus::Failed)
            )),
            BackpressureLevel::Critical,
            "subagent-ended 必达落库"
        );
        for (kind, expected) in [
            (SubagentEventKind::Progress, BackpressureLevel::Delta),
            (SubagentEventKind::Message, BackpressureLevel::Soft),
            (SubagentEventKind::Tool, BackpressureLevel::Soft),
        ] {
            let info = SubagentEventInfo {
                subagent_id: "sub-1".to_string(),
                subagent_run_id: "sub-run-1".to_string(),
                kind,
                payload: None,
            };
            assert_eq!(
                event_backpressure(&build_subagent_event(&ctx(), &info)),
                expected,
                "subagent-event {:?} 背压分级不符",
                kind
            );
        }
    }

    // ── 发射点（mock 生命周期触发事件）──

    #[tokio::test]
    async fn emitter_pushes_started_and_ended_exactly_once() {
        let mem = Arc::new(InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let emitter = SubagentEventEmitter::new(store);

        // 完整生命周期：spawn → 运行中增量 → 收口
        emitter.emit_started(&ctx(), &started_info()).await.unwrap();
        emitter
            .emit_event(
                &ctx(),
                &SubagentEventInfo {
                    subagent_id: "sub-1".to_string(),
                    subagent_run_id: "sub-run-1".to_string(),
                    kind: SubagentEventKind::Progress,
                    payload: None,
                },
            )
            .await
            .unwrap();
        emitter
            .emit_ended(&ctx(), &ended_info(SubagentEndStatus::Completed))
            .await
            .unwrap();

        let stored = mem.events();
        let types: Vec<&str> = stored.iter().map(|e| e.event_type.as_str()).collect();
        // started/ended Critical 落库；progress 为 Delta 不落库
        assert_eq!(
            types,
            vec!["subagent-started", "subagent-ended"],
            "started/ended 落库且各一次，progress 不落库"
        );
        // T-D1-A（NoPersist-first）：progress 不取号——落库序列连续
        // started=1、ended=2（progress 无序号空洞）
        let seqs: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
        assert_eq!(
            seqs,
            vec![1, 2],
            "started=1、progress 不取号、ended=2（NoPersist-first 无空洞）"
        );
    }

    #[tokio::test]
    async fn emitter_soft_kind_is_persisted() {
        let mem = Arc::new(InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let emitter = SubagentEventEmitter::new(store);

        // message/tool 类为 Soft：尽力落库
        for kind in [SubagentEventKind::Message, SubagentEventKind::Tool] {
            emitter
                .emit_event(
                    &ctx(),
                    &SubagentEventInfo {
                        subagent_id: "sub-1".to_string(),
                        subagent_run_id: "sub-run-1".to_string(),
                        kind,
                        payload: None,
                    },
                )
                .await
                .unwrap();
        }
        let stored = mem.events();
        assert_eq!(stored.len(), 2, "Soft 类事件落库");
        assert!(stored.iter().all(|e| e.event_type == "subagent-event"));
    }

    /// D-01 DM-04 验收锚：subagent 事件落库 run_id 列 == parent_run_id
    /// （信封 runId 与列值同源，防双写漂移；父 run 归属语义 01 §2.6-②）
    #[tokio::test]
    async fn eventqueue_subagent_events_parent_run() {
        let mem = Arc::new(InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        let emitter = SubagentEventEmitter::new(store);

        emitter.emit_started(&ctx(), &started_info()).await.unwrap();
        emitter
            .emit_ended(&ctx(), &ended_info(SubagentEndStatus::Completed))
            .await
            .unwrap();

        let stored = mem.events();
        assert_eq!(stored.len(), 2, "started/ended 均落库");
        for row in &stored {
            assert_eq!(
                row.run_id.as_deref(),
                Some("run-main"),
                "subagent 事件 run_id 列 == parent_run_id"
            );
            let envelope: conex_types::events::AgentEventEnvelope =
                serde_json::from_str(&row.payload).unwrap();
            assert_eq!(
                envelope.run_id.as_deref(),
                Some("run-main"),
                "信封 runId == parent_run_id（与列同源）"
            );
            assert_eq!(
                envelope.sequence,
                Some(row.sequence),
                "信封 sequence == 行 sequence"
            );
        }
    }

    #[tokio::test]
    async fn ended_from_state_maps_terminal_status() {
        // completed → Completed；failed（含被终止归一）→ Failed
        let completed =
            SubagentEndedInfo::from_subagent_state("sub-1", "sub-run-1", SubagentState::Completed);
        assert_eq!(completed.status, SubagentEndStatus::Completed);
        let failed =
            SubagentEndedInfo::from_subagent_state("sub-1", "sub-run-1", SubagentState::Failed);
        assert_eq!(failed.status, SubagentEndStatus::Failed);
    }
}
