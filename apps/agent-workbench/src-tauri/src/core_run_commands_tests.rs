// G2 禁令豁免：
// - 测试临时目录清理（非产品删除路径，可恢复语义不适用）；
// - 测试 mod 子进程拉起面：真实 spawn 探测（红线 Blocked 断言 +
//   tasklist / kill -0 存活探测辅助，T-AB-06/07 验收），非产品执行面；
//   测试 mod 内 allow + 理由（裁决 D8 背书）。
#![allow(clippy::disallowed_methods)]

use super::*;
use conex_types::message::{
    AgentMessageBlock, AgentMessageMetadataKind, AgentMessageRole, ToolCallBlock,
};
use conex_types::session::AgentEndReason;
use conex_types::tool::ToolOutput;
use orchestrator::steering_queue::SteeringInputEntry;
// T-D-13 集成测试面：TestProvider 脚本驱动 + ProviderCall
use crate::engine::EngineProviderConfig;
use agent_provider::config::Endpoint;
use session_loop::provider::ProviderCall;
use session_loop::stream::{ProviderStreamEvent, StopReason};
use session_loop::testing::TestProvider;
use std::collections::BTreeMap;
// T4.3-R2：本地 HTTP 请求捕获服务器（真实 wire 层载荷断言）
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 便捷构造 HistoryMessage（缺省无 thinking/无 JSON 载荷字段）
fn hmsg(id: &str, sender: &str, text: Option<&str>) -> HistoryMessage {
    HistoryMessage {
        id: id.into(),
        sender: sender.into(),
        text: text.map(String::from),
        thinking: None,
        blocks_json: None,
        tool_calls_json: None,
        tool_call_results_json: None,
        status: Some("completed".into()),
        timestamp: 1_785_456_000_000,
    }
}

/// 便捷构造 AgentMessage（固定 created_at 锚点 2026-07-31T00:00:00.123Z）
fn amsg(id: &str, role: AgentMessageRole, blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    AgentMessage {
        id: id.into(),
        role,
        created_at: "2026-07-31T00:00:00.123Z".into(),
        blocks,
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text { text: text.into() }
}

fn tool_call_block(id: &str, name: &str) -> AgentMessageBlock {
    AgentMessageBlock::ToolCall(ToolCallBlock {
        id: id.into(),
        tool_name: name.into(),
        input: serde_json::json!({"path": "/a"}),
    })
}

fn tool_result_block(id: &str, output: &str) -> AgentMessageBlock {
    AgentMessageBlock::ToolResult {
        tool_call_id: id.into(),
        tool_name: "read_file".into(),
        output: ToolOutput::text(output.to_string()),
        is_error: false,
    }
}

/// 错误文案 → payload：77 码兜底 + 人读文案
#[test]
fn failure_payload_uses_common_unknown_code() {
    let payload = crish_payload_from_message("provider 调用失败");
    assert_eq!(payload.code, codes::COMMON_UNKNOWN);
    assert!(payload.message.contains("provider 调用失败"));
    assert!(!payload.retryable);
}

/// 审批映射：wire 决策规范值（approved / denied / expired，03 §5.3-3）
#[test]
fn approval_decisions_map_to_wire_values() {
    let json = serde_json::to_string(&WireApprovalDecision::Denied).unwrap();
    assert_eq!(json, "\"denied\"");
    let approved = serde_json::to_string(&WireApprovalDecision::Approved).unwrap();
    assert_eq!(approved, "\"approved\"");
}

// ── T-D-14 权限传递层：审批门载荷与裁决者路由 ──

/// 组装子代理 run 的审批门（父 run 归属注入；广播落到记录发射器）
async fn subagent_gate(
    state: &CoreRunState,
    session_id: &str,
    run_id: &str,
    parent_run_id: Option<&str>,
    deadlock_detector: Option<Box<dyn Fn(&str) -> bool + Send + Sync>>,
) -> (Arc<ApprovalGateImpl>, Arc<RecordingEmitter>) {
    let handle = Arc::new(tokio::sync::Mutex::new(
        state
            .run_manager
            .start_run(session_id, run_id)
            .await
            .expect("start_run"),
    ));
    let (bridge, emitter) = recording_bridge();
    let broadcast_bridge = Arc::new(BufferedRunEventBridge::new(bridge, run_id.to_string()));
    let broadcast_run_id = run_id.to_string();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    let mut gate = ApprovalGateImpl::new(
        run_id.to_string(),
        session_id.to_string(),
        parent_run_id.map(str::to_string),
        broadcast,
        handle,
        state.store.clone(),
        None,
    );
    if let Some(detector) = deadlock_detector {
        gate = gate.with_deadlock_detector(detector);
    }
    (Arc::new(gate), emitter)
}

/// 子代理审批请求 → 广播载荷携带 requesterRunId/reason + 路由
/// metadata.arbiter=main-agent（转呈主 agent 裁决面）；主 agent 裁决
/// 复用 core_approve_tool/core_deny_tool 的 resolve 入口 → Approved
#[tokio::test]
async fn gate_routes_subagent_request_to_main_agent_arbiter() {
    let (state, _registry) = state_with_background();
    let (gate, emitter) =
        subagent_gate(&state, "sess-gate", "run-sub-1", Some("run-main"), None).await;
    let requester = ApprovalRequester {
        run_id: "run-sub-1".to_string(),
        task_type: None,
        reason: Some("需要写入默认范围外的路径".to_string()),
    };
    let gate_owner = Arc::clone(&gate);
    let rq = requester.clone();
    let wait = tokio::spawn(async move {
        gate_owner
            .request_approval(
                "tc-1",
                "write_file",
                &serde_json::json!({ "path": "x.md" }),
                Some(&rq),
            )
            .await
    });
    // 等待广播 + pending 注册后裁决（主 agent 裁决 = 同一 resolve 入口）
    tokio::time::sleep(Duration::from_millis(100)).await;
    gate.resolve("tc-1", ApprovalDecision::Approved)
        .await
        .expect("resolve 应放行（I-02 校验通过）");
    let decision = tokio::time::timeout(Duration::from_secs(2), wait)
        .await
        .expect("审批应在时限内返回")
        .expect("request_approval 不应 panic");
    assert_eq!(decision, ApprovalDecision::Approved);
    // 广播载荷：requesterRunId / reason / 路由 arbiter=main-agent
    let payloads = emitter.0.lock().unwrap().clone();
    let envelope: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
    assert_eq!(envelope["type"], "approval-requested");
    assert_eq!(envelope["request"]["requesterRunId"], "run-sub-1");
    assert_eq!(envelope["request"]["reason"], "需要写入默认范围外的路径");
    assert_eq!(envelope["request"]["metadata"]["arbiter"], "main-agent");
}

// ── R1-10 T-10：审批伪造（对不存在 tool_call_id 发批准）──

/// 组装 T-10 活动 run：记录型发射桥 + 审批门（与 build_active_run 同
/// 装配面，仅事件桥替换为可捕获发射器——断言「无 approval-resolved 落地」）。
/// `approval_timeout`：审批等待超时注入（P1 竞态测试用短超时验证过期收场；
/// 既有调用传 [APPROVAL_TIMEOUT] 保持原语义）。
async fn t10_active_run(
    state: &CoreRunState,
    session_id: &str,
    run_id: &str,
    approval_timeout: Duration,
) -> (Arc<ActiveRun>, Arc<RecordingEmitter>) {
    let handle = Arc::new(tokio::sync::Mutex::new(
        state
            .run_manager
            .start_run(session_id, run_id)
            .await
            .expect("start_run"),
    ));
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        0,
        None,
    )));
    let (bridge, emitter) = recording_bridge();
    let bridge = Arc::new(BufferedRunEventBridge::new(bridge, run_id.to_string()));
    let broadcast_bridge = Arc::clone(&bridge);
    let broadcast_run_id = run_id.to_string();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    let approval = Arc::new(
        ApprovalGateImpl::new(
            run_id.to_string(),
            session_id.to_string(),
            None,
            broadcast,
            Arc::clone(&handle),
            state.store.clone(),
            None,
        )
        .with_approval_timeout(approval_timeout),
    );
    let active = Arc::new(ActiveRun {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        handle,
        queue,
        control_bus: Arc::new(Mutex::new(ControlBus::new())),
        abort_signal: AbortSignal::new(),
        approval,
        bridge,
        delta_sink_active: true,
        driver: Mutex::new(None),
        user_touched: AtomicBool::new(false),
        subagent: None,
        audit_persist: Mutex::new(None),
    });
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.to_string(), Arc::clone(&active));
    (active, emitter)
}

/// 等待审批请求进入待审批集合（request_approval 先广播后注册，轮询
/// 而非固定 sleep——T-10 伪造审批时序确定性）
async fn wait_pending(gate: &ApprovalGateImpl, tool_call_id: &str, timeout_ms: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while !gate.contains_pending(tool_call_id) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "审批请求未在窗口内进入待审批集合"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// T-10 审批伪造：对不存在 tool_call_id 的审批（D-2 攻击场景——伪造端
/// 企图批准不存在的审批）→ resolve NotFound + 无 approval-resolved 落地；
/// 真实待审批请求不受影响（仍 pending、仍可正常裁决）
#[tokio::test]
async fn t10_approve_forged_tool_call_id_returns_not_found_no_event() {
    let (state, _registry) = state_with_background();
    let (active, emitter) = t10_active_run(&state, "sess-t10", "run-t10", APPROVAL_TIMEOUT).await;
    let gate = Arc::clone(&active.approval);

    // 真实审批请求（tc-real）进入待审批集合
    let gate_owner = Arc::clone(&gate);
    let wait = tokio::spawn(async move {
        gate_owner
            .request_approval(
                "tc-real",
                "write_file",
                &serde_json::json!({ "path": "x.md" }),
                None,
            )
            .await
    });
    wait_pending(&gate, "tc-real", 3_000).await;

    // 伪造审批（不存在的 tool_call_id）：approve 必须 NotFound
    let err = approve_tool_impl(&state, "run-t10", "tc-fake", Some("approved".to_string()))
        .await
        .expect_err("伪造审批必须被拒");
    assert!(
        matches!(&err, CoreError::NotFound(_)),
        "伪造审批必须 NotFound，实际：{err:?}"
    );
    assert!(
        err.to_string().contains("not in pending approvals"),
        "NotFound 文案必须含 pending 关键字（移动端据此收敛冲突）：{err}"
    );
    // 无 approval-resolved 落地（事件桥零条——杜绝伪造审计事件）
    let payloads = emitter.0.lock().unwrap().clone();
    assert!(
        !payloads.iter().any(|p| p.contains("approval-resolved")),
        "伪造审批不得落地 approval-resolved 审计事件"
    );
    // 真实请求仍 pending；伪造 id 不在集合
    assert!(gate.contains_pending("tc-real"), "真实审批必须仍 pending");
    assert!(
        !gate.contains_pending("tc-fake"),
        "伪造 id 不得进入待审批集合"
    );

    // 拒绝路径对称：deny 伪造 id 同样 NotFound
    let err = deny_tool_impl(&state, "run-t10", "tc-fake", Some("风险过高"))
        .await
        .expect_err("伪造 deny 必须被拒");
    assert!(matches!(err, CoreError::NotFound(_)));
    assert!(
        gate.contains_pending("tc-real"),
        "伪造 deny 后真实审批仍 pending"
    );

    // 收尾：真实审批仍可正常裁决（伪造审批不破坏审批链路）——经命令面
    // approve_tool_impl 裁决（与 T-10 场景同一入口，落 approval-resolved）
    approve_tool_impl(&state, "run-t10", "tc-real", Some("approved".to_string()))
        .await
        .expect("真实审批必须可裁决");
    let decision = tokio::time::timeout(Duration::from_secs(2), wait)
        .await
        .expect("审批应在时限内返回")
        .expect("request_approval 不应 panic");
    assert_eq!(decision, ApprovalDecision::Approved);
    // 裁决后落地 approval-resolved（真实验证：事件只在真实裁决后出现）
    let payloads = emitter.0.lock().unwrap().clone();
    assert!(
        payloads.iter().any(|p| p.contains("approval-resolved")),
        "真实裁决后必须落地 approval-resolved"
    );
}

// ── P1 审批竞态红线（主控裁决 4 / 详案 P1 §5.1）──

/// P1 审批竞态红线：构造「前端自动 approve 超车落地」场景——approve 先于
/// 引擎注册 / 审批已过期收场 / 审批已被 Deny 三种时序下，引擎
/// [ApprovalGateImpl::resolve]（run_approval.rs，I-02/AA-05 pending 校验）
/// 均返回 NotFound，不伪造放行；且全程不落地 approval-resolved(approved)
/// 审计事件。P1-β 下线前端自动放行（D1）后本红线恒绿。
#[tokio::test]
async fn p1_approval_race_auto_approve_before_engine_registers_not_found() {
    let (state, _registry) = state_with_background();
    // 短超时门（800ms）：验证「已过期」权威收场（生产 120s 兜底语义不变；
    // 场景 3 的裁决远快于超时，无竞态 flaky）
    let (active, emitter) = t10_active_run(
        &state,
        "sess-p1race",
        "run-p1race",
        Duration::from_millis(800),
    )
    .await;
    let gate = Arc::clone(&active.approval);

    // 场景 1 非待审批（超车）：approve 在引擎 request_approval 注册前落地
    //（前端自动放行先于引擎 authoritative 判定）→ NotFound
    let err = approve_tool_impl(
        &state,
        "run-p1race",
        "tc-before-register",
        Some("approved".to_string()),
    )
    .await
    .expect_err("未注册审批的 approve 必须 NotFound");
    assert!(
        matches!(&err, CoreError::NotFound(_)),
        "非待审批 approve 必须 NotFound，实际：{err:?}"
    );
    assert!(
        err.to_string().contains("not in pending approvals"),
        "NotFound 文案必须含 pending 关键字（移动端据此收敛冲突）：{err}"
    );

    // 场景 2 已过期：request_approval 超时 → Expired 权威收场 → 待审批集合
    // 已清除 → 迟到 approve → NotFound（不伪造放行）
    let gate_owner = Arc::clone(&gate);
    let wait = tokio::spawn(async move {
        gate_owner
            .request_approval(
                "tc-expired",
                "write_file",
                &serde_json::json!({ "path": "x.md" }),
                None,
            )
            .await
    });
    wait_pending(&gate, "tc-expired", 3_000).await;
    let decision = tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .expect("短超时应在时限内返回")
        .expect("request_approval 不应 panic");
    assert_eq!(
        decision,
        ApprovalDecision::Expired,
        "超时必须是 Expired 权威收场"
    );
    assert!(
        !gate.contains_pending("tc-expired"),
        "过期后待审批集合必须清除（迟到裁决 NotFound 的前提）"
    );
    let err = approve_tool_impl(
        &state,
        "run-p1race",
        "tc-expired",
        Some("approved".to_string()),
    )
    .await
    .expect_err("过期后迟到 approve 必须 NotFound");
    assert!(
        matches!(&err, CoreError::NotFound(_)),
        "已过期 approve 必须 NotFound，实际：{err:?}"
    );

    // 场景 3 已 Deny：首次裁决（deny）后条目清除 → 二次 approve → NotFound
    let gate_owner = Arc::clone(&gate);
    let wait = tokio::spawn(async move {
        gate_owner
            .request_approval(
                "tc-denied",
                "write_file",
                &serde_json::json!({ "path": "x.md" }),
                None,
            )
            .await
    });
    wait_pending(&gate, "tc-denied", 3_000).await;
    deny_tool_impl(&state, "run-p1race", "tc-denied", Some("风险过高"))
        .await
        .expect("首次 deny 应成功（真实裁决）");
    let decision = tokio::time::timeout(Duration::from_secs(5), wait)
        .await
        .expect("裁决应在时限内返回")
        .expect("request_approval 不应 panic");
    assert!(
        matches!(decision, ApprovalDecision::Denied { .. }),
        "首次裁决应为 Denied"
    );
    let err = approve_tool_impl(
        &state,
        "run-p1race",
        "tc-denied",
        Some("approved".to_string()),
    )
    .await
    .expect_err("已 Deny 后再 approve 必须 NotFound");
    assert!(
        matches!(&err, CoreError::NotFound(_)),
        "已 Deny approve 必须 NotFound，实际：{err:?}"
    );

    // 全程不得落地 approval-resolved(approved)（不伪造放行审计事件；
    // 场景 3 的 deny 会落地 approval-resolved(denied)——只检查 approved）
    let payloads = emitter.0.lock().unwrap().clone();
    assert!(
        !payloads
            .iter()
            .any(|p| p.contains("\"decision\":\"approved\"")),
        "不得伪造 approval-resolved(approved) 审计事件"
    );
}

/// 死锁防护（开放问题 6.4）：裁决者（主 agent）正在 wait 该子代理 →
/// 路由转用户（metadata 不标注 main-agent，载荷仍携带请求方身份）；
/// 未检测到 wait → 保持主 agent 裁决（metadata.arbiter=main-agent）
#[tokio::test]
async fn gate_deflects_approval_when_arbiter_waiting_on_subagent() {
    let (state, _registry) = state_with_background();
    // detector 命中（主 agent 正在 wait run-sub-1）
    let (gate_waiting, emitter_waiting) = subagent_gate(
        &state,
        "sess-gate",
        "run-sub-1",
        Some("run-main"),
        Some(Box::new(|_subagent_run_id| true)),
    )
    .await;
    // detector 未命中
    let (gate_clear, emitter_clear) = subagent_gate(
        &state,
        "sess-gate",
        "run-sub-2",
        Some("run-main"),
        Some(Box::new(|_subagent_run_id| false)),
    )
    .await;
    let requester_waiting = ApprovalRequester {
        run_id: "run-sub-1".to_string(),
        task_type: None,
        reason: None,
    };
    let requester_clear = ApprovalRequester {
        run_id: "run-sub-2".to_string(),
        task_type: None,
        reason: None,
    };
    for (gate, emitter, requester, expecting_main_agent) in [
        (
            Arc::clone(&gate_waiting),
            emitter_waiting,
            requester_waiting,
            false,
        ),
        (
            Arc::clone(&gate_clear),
            emitter_clear,
            requester_clear,
            true,
        ),
    ] {
        let gate_owner = Arc::clone(&gate);
        let rq = requester.clone();
        let wait = tokio::spawn(async move {
            gate_owner
                .request_approval("tc-1", "write_file", &serde_json::json!({}), Some(&rq))
                .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        gate.resolve("tc-1", ApprovalDecision::Approved)
            .await
            .expect("resolve 应放行");
        let _decision = tokio::time::timeout(Duration::from_secs(2), wait)
            .await
            .expect("审批应在时限内返回")
            .expect("request_approval 不应 panic");
        let payloads = emitter.0.lock().unwrap().clone();
        let envelope: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
        assert_eq!(envelope["request"]["requesterRunId"], requester.run_id);
        if expecting_main_agent {
            assert_eq!(envelope["request"]["metadata"]["arbiter"], "main-agent");
        } else {
            assert!(
                envelope["request"]["metadata"].is_null()
                    || envelope["request"]["metadata"].get("arbiter").is_none(),
                "死锁防护转用户：不应标注 main-agent 裁决面"
            );
        }
    }
}

/// 不回归：主 agent run（无父 run）审批 requester=None → 载荷缺省
/// requesterRunId/reason/metadata（既有 UI 审批流程载荷字节不变）
#[tokio::test]
async fn main_agent_gate_payload_legacy_byte_identical() {
    let (state, _registry) = state_with_background();
    let (gate, emitter) = subagent_gate(&state, "sess-main", "run-main", None, None).await;
    let gate_owner = Arc::clone(&gate);
    let wait = tokio::spawn(async move {
        gate_owner
            .request_approval("tc-1", "write_file", &serde_json::json!({}), None)
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    gate.resolve("tc-1", ApprovalDecision::Approved)
        .await
        .expect("resolve 应放行");
    let _decision = tokio::time::timeout(Duration::from_secs(2), wait)
        .await
        .expect("审批应在时限内返回")
        .expect("request_approval 不应 panic");
    let payloads = emitter.0.lock().unwrap().clone();
    let envelope: serde_json::Value = serde_json::from_str(&payloads[0]).unwrap();
    let request = &envelope["request"];
    assert!(
        request.get("requesterRunId").is_none(),
        "主 agent 请求不应携带 requesterRunId"
    );
    assert!(
        request.get("reason").is_none(),
        "主 agent 请求不应携带 reason"
    );
    assert!(
        request.get("metadata").is_none(),
        "主 agent 请求不应携带 metadata"
    );
}

/// 用户注入消息形状（L1 soft_inject 落环载荷）
#[test]
fn injected_message_shape() {
    let message = crate::engine::user_message("继续", None);
    assert_eq!(message.role, AgentMessageRole::User);
    assert!(matches!(
        message.blocks.as_slice(),
        [AgentMessageBlock::Text { text }] if text == "继续"
    ));
}

// ── T-29 / DEEPCHECK-01 P0：SessionHistoryCache ────────────────

/// 缓存容量上限（每会话 token 预算）：超预算按「稳定锚点 + 预算尾部」
/// 截断——首条 user 锚点恒在 + 最近消息按预算保留，中间段丢弃
#[test]
fn session_history_cache_keeps_anchor_with_budget_tail() {
    let cache = SessionHistoryCache::with_limits(27, 8);
    let many: Vec<HistoryMessage> = (0..7)
        .map(|i| hmsg(&format!("m{i}"), "user", Some("x")))
        .collect();
    cache.store("s1", many);
    let stored = cache.get("s1").unwrap();
    assert_eq!(cache.message_count("s1"), 3);
    // 预算 27 token：锚点 m0（9）+ 尾部窗口 m5/m6（18）——m4 起超出预算
    let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["m0", "m5", "m6"]);
}

/// DEEPCHECK-01 P0：极端预算（低于单条消息）时锚点仍恒在——
/// 首条 user 永不因截断消失（跨 run 请求前缀的最小稳定单位）
#[test]
fn session_history_cache_keeps_first_user_anchor_over_budget() {
    let cache = SessionHistoryCache::with_limits(5, 4);
    let many: Vec<HistoryMessage> = (0..3)
        .map(|i| hmsg(&format!("m{i}"), "user", Some("x")))
        .collect();
    cache.store("s1", many);
    let stored = cache.get("s1").unwrap();
    let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["m0"]);
    assert_eq!(stored[0].sender, "user");
}

/// DEEPCHECK-01 P0 集成形态：120 条消息会话——第 1 条锚点与最近尾部
/// 恒在，中间段按预算截断（不再固定条数尾部滑窗整体漂移）
#[test]
fn session_history_cache_truncates_middle_keeps_head_and_tail() {
    let cache = SessionHistoryCache::with_limits(270, 4);
    let many: Vec<HistoryMessage> = (0..120)
        .map(|i| hmsg(&format!("m{i}"), "user", Some("x")))
        .collect();
    cache.store("s1", many);
    let stored = cache.get("s1").unwrap();
    assert_eq!(cache.message_count("s1"), 30);
    let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
    // 锚点 m0 恒在 + 尾部窗口 [m91..m119]（29 条 × 9 token 装下预算），
    // m1..m90 中间段全部丢弃
    assert_eq!(ids[0], "m0");
    assert_eq!(ids[ids.len() - 1], "m119");
    assert_eq!(ids[1], "m91");
}

/// DEEPCHECK-01 P0：截断边界 wire 安全——孤儿 tool 首条（其 ToolCall
/// 已被截掉）不得成为窗口起点，逐条让位直到边界安全
#[test]
fn truncation_boundary_drops_orphan_tool_message() {
    let cache = SessionHistoryCache::with_limits(40, 4);
    let mut m1 = hmsg("m1", "assistant", None);
    m1.blocks_json =
        Some(serde_json::to_string(&vec![text_block("工具轮（11 token 估算）")]).unwrap());
    let stored_before = {
        let mut msgs = vec![
            hmsg("m0", "user", Some("x")),
            m1.clone(),
            hmsg("m2", "tool", Some("x")),
            hmsg("m3", "user", Some("x")),
            hmsg("m4", "user", Some("x")),
        ];
        truncate_history_with_anchor(&mut msgs, 40);
        msgs
    };
    assert_eq!(stored_before[0].id, "m0");
    // 预算 40：窗口起点恰好落在 m2（tool，孤儿结果）→ 边界让位到 m3
    let ids: Vec<&str> = stored_before.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["m0", "m3", "m4"]);
    // 与 store 写入路径同语义（store 内部同样先锚点预算截断再安全前缀）
    cache.store("s1", stored_before);
    let stored = cache.get("s1").unwrap();
    let ids: Vec<&str> = stored.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["m0", "m3", "m4"]);
}

/// DEEPCHECK-01 P0：读回路径同样按预算截断（cached_history_to_conversation
/// 对超预算历史自包含截断——锚点 + 尾部，中间丢弃；正常路径 store 已截断，
/// 此处幂等）
#[test]
fn cached_history_read_path_truncates_with_budget() {
    let long_text = "x".repeat(8_000);
    let entries: Vec<HistoryMessage> = (0..100)
        .map(|i| {
            let mut entry = hmsg(&format!("m{i}"), "user", None);
            entry.blocks_json = Some(serde_json::to_string(&vec![text_block(&long_text)]).unwrap());
            entry
        })
        .collect();
    let restored = cached_history_to_conversation(entries);
    // 期望值由同一估算函数自洽推导（不硬编码 count_tokens 细节）
    let mut probe = hmsg("probe", "user", None);
    probe.blocks_json = Some(serde_json::to_string(&vec![text_block(&long_text)]).unwrap());
    let per_message = estimate_history_tokens(&probe);
    let expected_tail = (SESSION_HISTORY_TOKEN_BUDGET - per_message) / per_message;
    assert!(restored.len() >= 50 && restored.len() < 100);
    assert_eq!(restored.len(), 1 + expected_tail);
    // 锚点恒在（首条 user）+ 尾部最近消息恒在 + 中间被截断
    assert_eq!(restored[0].id, "m0");
    assert_eq!(restored.last().unwrap().id, "m99");
    assert_ne!(restored[1].id, "m1");
}

/// 缓存容量上限（会话数）：超出 FIFO 淘汰最久未更新的会话
#[test]
fn session_history_cache_evicts_oldest_session() {
    let cache = SessionHistoryCache::with_limits(64, 2);
    cache.store("s1", vec![hmsg("a", "user", Some("1"))]);
    cache.store("s2", vec![hmsg("b", "user", Some("2"))]);
    cache.store("s3", vec![hmsg("c", "user", Some("3"))]);
    assert_eq!(cache.session_count(), 2);
    // 最久未更新的 s1 被淘汰；s2/s3 存活
    assert!(cache.get("s1").is_none());
    assert_eq!(cache.message_count("s2"), 1);
    assert_eq!(cache.message_count("s3"), 1);
    // 重复写入同一会话 = 刷新其 FIFO 位置（近似 LRU），不再被误淘汰
    cache.store("s2", vec![hmsg("d", "user", Some("4"))]);
    cache.store("s4", vec![hmsg("e", "user", Some("5"))]);
    assert!(cache.get("s3").is_none());
    assert_eq!(cache.message_count("s2"), 1);
    assert_eq!(cache.message_count("s4"), 1);
}

/// 空 history 回退缓存（混合路线：前端水合兜底 + 引擎侧缓存主）
#[test]
fn resolve_history_falls_back_to_cache_when_empty() {
    let cached = vec![hmsg("c1", "user", Some("缓存"))];
    let frontend = vec![hmsg("f1", "user", Some("前端"))];
    // 前端非空 → Frontend 优先（即使缓存有值）
    let (source, payload) =
        resolve_history_source(&Some(frontend.clone()), Some(cached.clone())).unwrap();
    assert_eq!(source, HistorySource::Frontend);
    assert_eq!(payload[0].id, "f1");
    // 前端空数组 → 回退缓存
    let (source, payload) =
        resolve_history_source(&Some(Vec::new()), Some(cached.clone())).unwrap();
    assert_eq!(source, HistorySource::Cache);
    assert_eq!(payload[0].id, "c1");
    // 前端未传 → 回退缓存
    let (source, payload) = resolve_history_source(&None, Some(cached.clone())).unwrap();
    assert_eq!(source, HistorySource::Cache);
    assert_eq!(payload[0].id, "c1");
    // 两者皆空 → None（现状单消息 run，向后兼容）
    assert!(resolve_history_source(&None, None).is_none());
    assert!(resolve_history_source(&Some(Vec::new()), None).is_none());
}

/// 收口写入形状：RunOutcome.messages → HistoryMessage（全角色保真）
#[test]
fn run_outcome_collected_into_history_messages() {
    let outcome = RunOutcome {
        reason: AgentEndReason::Stop,
        error: None,
        // D1 §3.4 兼容：正常 stop 收场 provider_error=None（D7 迁移缺口
        // 收口：session-loop 新增必填字段后本构造点补齐）
        provider_error: None,
        diagnostic: None,
        messages: vec![
            Arc::new(amsg("u1", AgentMessageRole::User, vec![text_block("你好")])),
            Arc::new(amsg(
                "a1",
                AgentMessageRole::Assistant,
                vec![
                    text_block("回复"),
                    AgentMessageBlock::Thought {
                        text: "思考".into(),
                        redacted: None,
                    },
                ],
            )),
            Arc::new(amsg(
                "a2",
                AgentMessageRole::Assistant,
                vec![tool_call_block("c1", "read_file")],
            )),
            Arc::new(amsg(
                "t1",
                AgentMessageRole::Tool,
                vec![tool_result_block("c1", "file content")],
            )),
        ],
        events: Vec::new(),
        turn_index: 2,
        tool_call_count: 1,
        steering_count: 0,
        // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
        cache_stats: None,
    };
    let history = to_history_messages(&outcome);
    assert_eq!(history.len(), 4);
    // 角色保真（tool 角色独立消息保留——缓存路径不过滤）
    let senders: Vec<&str> = history.iter().map(|m| m.sender.as_str()).collect();
    assert_eq!(senders, ["user", "assistant", "assistant", "tool"]);
    // 收口消息均为完成态
    assert!(history
        .iter()
        .all(|m| m.status.as_deref() == Some("completed")));
    // blocks_json 保真：可解析回 AgentMessageBlock 完整序列
    let first_blocks = parse_blocks(&history[0]).unwrap();
    assert_eq!(first_blocks, vec![text_block("你好")]);
    let tool_blocks = parse_blocks(&history[2]).unwrap();
    assert!(matches!(&tool_blocks[0], AgentMessageBlock::ToolCall(call) if call.id == "c1"));
    let result_blocks = parse_blocks(&history[3]).unwrap();
    assert!(matches!(
        &result_blocks[0],
        AgentMessageBlock::ToolResult { tool_call_id, output, is_error: false, .. }
            if tool_call_id == "c1" && output.text.as_deref() == Some("file content")
    ));
    // timestamp = created_at 折算（锚点 2026-07-31T00:00:00.123Z）
    assert_eq!(history[0].timestamp, 1_785_456_000_123);
    // thinking / text 字段裁剪（空 → None）
    assert_eq!(history[1].thinking.as_deref(), Some("思考"));
    assert!(history[3].text.is_none());
    // 合成源字段置 None（有 blocks_json 保真，无需冗余）
    assert!(history.iter().all(|m| m.tool_calls_json.is_none()));
    assert!(history.iter().all(|m| m.tool_call_results_json.is_none()));
}

/// 缓存往返保真：收口 → store → get → 读回水合，tool 配对不拆散
#[test]
fn cached_history_roundtrip_preserves_tool_pairs() {
    let cache = SessionHistoryCache::with_limits(100_000, 4);
    let outcome = RunOutcome {
        reason: AgentEndReason::Stop,
        error: None,
        // D1 §3.4 兼容：正常 stop 收场 provider_error=None（D7 迁移
        // 缺口收口：session-loop 新增必填字段后本构造点补齐）
        provider_error: None,
        diagnostic: None,
        messages: vec![
            Arc::new(amsg("u1", AgentMessageRole::User, vec![text_block("q")])),
            Arc::new(amsg(
                "a1",
                AgentMessageRole::Assistant,
                vec![tool_call_block("c1", "read_file")],
            )),
            Arc::new(amsg(
                "t1",
                AgentMessageRole::Tool,
                vec![tool_result_block("c1", "content")],
            )),
            Arc::new(amsg("u2", AgentMessageRole::User, vec![text_block("q2")])),
        ],
        events: Vec::new(),
        turn_index: 1,
        tool_call_count: 1,
        steering_count: 0,
        // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
        cache_stats: None,
    };
    cache.store("s1", to_history_messages(&outcome));
    let restored = cached_history_to_conversation(cache.get("s1").unwrap());
    // 角色与数量保真（Tool 消息不被过滤——与前端 hydrate 路径互补）
    let roles: Vec<AgentMessageRole> = restored.iter().map(|m| m.role).collect();
    assert_eq!(
        roles,
        [
            AgentMessageRole::User,
            AgentMessageRole::Assistant,
            AgentMessageRole::Tool,
            AgentMessageRole::User,
        ]
    );
    // 工具配对完整：assistant 的 ToolCall id 与 tool 消息的 result id 一致
    assert!(matches!(
        restored[1].blocks[0],
        AgentMessageBlock::ToolCall(ref call) if call.id == "c1"
    ));
    assert!(matches!(
        restored[2].blocks[0],
        AgentMessageBlock::ToolResult { ref tool_call_id, .. } if tool_call_id == "c1"
    ));
    // created_at 还原（时间戳往返一致）
    assert_eq!(restored[0].created_at, "2026-07-31T00:00:00.123Z");
    // metadata 裁剪 + 幂等键对齐
    assert!(restored.iter().all(|m| m.metadata.is_none()));
    assert_eq!(restored[0].client_message_id.as_deref(), Some("u1"));
}

/// 收口写入安全前缀：孤儿 tool/system 首条与带未配对 ToolCall 的
/// assistant 首条被前移掉，缓存序列以 user 开头（wire 合法）
#[test]
fn store_truncates_orphan_prefix() {
    let cache = SessionHistoryCache::with_limits(100_000, 4);
    // 场景 A：assistant(带 ToolCall，结果已不在保留段) 首条 → 前移掉
    let mut orphan_calls = hmsg("a1", "assistant", Some("调用了工具"));
    orphan_calls.blocks_json =
        Some(serde_json::to_string(&vec![tool_call_block("c1", "read_file")]).unwrap());
    cache.store("s1", vec![orphan_calls, hmsg("u1", "user", Some("后续"))]);
    let stored = cache.get("s1").unwrap();
    let senders: Vec<&str> = stored.iter().map(|m| m.sender.as_str()).collect();
    assert_eq!(senders, ["user"]);
    // 场景 B：tool 消息首条（孤儿结果）→ 前移掉
    cache.store(
        "s2",
        vec![
            hmsg("t1", "tool", Some("孤儿结果")),
            hmsg("u1", "user", Some("后续")),
        ],
    );
    let stored = cache.get("s2").unwrap();
    assert_eq!(stored[0].sender, "user");
    assert_eq!(stored.len(), 1);
    // 场景 C：完整配对（assistant + tool 结果）以 assistant 首条 → 保留
    let mut paired = hmsg("a1", "assistant", None);
    paired.blocks_json =
        Some(serde_json::to_string(&vec![tool_call_block("c1", "read_file")]).unwrap());
    let mut result = hmsg("t1", "tool", None);
    result.blocks_json =
        Some(serde_json::to_string(&vec![tool_result_block("c1", "content")]).unwrap());
    cache.store("s3", vec![paired, result, hmsg("u1", "user", Some("尾"))]);
    let stored = cache.get("s3").unwrap();
    let senders: Vec<&str> = stored.iter().map(|m| m.sender.as_str()).collect();
    assert_eq!(senders, ["assistant", "tool", "user"]);
}

/// context_window 入站 → ContextBudget（reserve/safety 取默认，T-33 消费）
#[test]
fn context_window_assembles_into_budget_with_defaults() {
    let budget = assemble_context_budget(128_000);
    assert_eq!(budget.context_window, 128_000);
    assert_eq!(budget.reserve_tokens, 16_384);
    assert_eq!(budget.safety_tokens, 4_096);
}

/// DEEPCHECK-06 P0：预算入站解析（resolve_context_budget 装配分支）——
/// 显式窗口优先；子代理 run（context_window 恒 None）按生效模型 catalog
/// 窗口兜底；普通 run 无窗口 → None（向后兼容不钳制）
#[test]
fn resolve_context_budget_subagent_arm_uses_engine_catalog_window() {
    // live yaml 夹具：qwen2-5-omni-7b contextWindow 32000（plans/04 §2.4
    // 窗口只读 live，不读 bundled catalog）
    crate::engine_provider::protocol::reload_live_catalog_from_yaml_str(
        r#"
version: 2
providers:
  qwen:
    displayName: Qwen
    baseUrl: "https://dashscope.example.com/v1"
    protocol: "openai/chat"
    models:
      - id: qwen2-5-omni-7b
        contextWindow: 32000
"#,
    )
    .expect("qwen 夹具必须解析成功");
    // 生效模型 qwen2-5-omni-7b（catalog 窗口 32000）——小窗口模型保证
    // 兜底臂窗口值可断言（deepseek-v4-flash 窗口 1M 亦可，选小窗口
    // 便于与预检集成测试共用同一模型口径）
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("收口。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, _, _) = run_control_test_state_with_model(provider, "qwen2-5-omni-7b");
    let cfg = Some(crate::subagent_spawner::SubagentRunConfig {
        subagent_id: "sa-1".to_string(),
        subagent_run_id: "run-sa-1".to_string(),
        parent_session_id: "s1".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1_000,
    });
    // 子代理 + 无显式窗口 → catalog 窗口（qwen2-5-omni-7b → 32000，
    // reserve/safety 取默认）
    let budget = resolve_context_budget(None, &cfg, &state.engine)
        .expect("子代理 run 必须装配预算（此前恒 None 裸跑）");
    assert_eq!(budget.context_window, 32_000);
    assert_eq!(budget.reserve_tokens, 16_384);
    assert_eq!(budget.safety_tokens, 4_096);
    // 显式窗口优先（调用方下发 > catalog 兜底）
    let budget = resolve_context_budget(Some(64_000), &cfg, &state.engine).expect("显式窗口优先");
    assert_eq!(budget.context_window, 64_000);
    // 普通 run（无子代理配置 + 无窗口）→ None（向后兼容不钳制）
    assert!(resolve_context_budget(None, &None, &state.engine).is_none());
}

/// 时间戳互逆：ISO8601 ↔ epoch ms 往返一致（锚点 2026-07-31）
#[test]
fn iso8601_epoch_millis_roundtrip() {
    let epoch = 1_785_456_000_123;
    assert_eq!(iso8601_to_epoch_millis("2026-07-31T00:00:00.123Z"), epoch);
    assert_eq!(epoch_millis_to_iso8601(epoch), "2026-07-31T00:00:00.123Z");
    // 宽容解析：无毫秒段
    assert_eq!(
        iso8601_to_epoch_millis("2026-07-31T00:00:01Z"),
        1_785_456_001_000
    );
    // 失败兜底 0
    assert_eq!(iso8601_to_epoch_millis("not-a-date"), 0);
}

// ── T-40：缓存测量收口（R5-D3 轮末合并接线 ②③④）────────────

use conex_db::RunStatus;
use orchestrator::persist::{InMemoryStore, LocalDbStore};

/// 测试用 run 级缓存统计（hit_ratio / write_ratio 置 None——与
/// get_run_usage 读回形状一致，可整型断言）
fn cache_stats(warm_until_ms: Option<u64>, missed_tokens: u64) -> RunCacheStats {
    RunCacheStats {
        prompt_tokens: 10_000,
        completion_tokens: 100,
        total_tokens: 10_100,
        cache_read_tokens: 9_000,
        cache_write_tokens: 500,
        cache_miss_tokens: 500,
        sample_count: 1,
        hit_ratio: None,
        write_ratio: None,
        missed_tokens,
        warm_until_ms,
    }
}

static CORE_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 测试用 CoreRunState（临时目录快照存储 + 记录型事件桥 + 独立诊断）
fn core_state_with_store(store: Arc<dyn Store>) -> Arc<CoreRunState> {
    let (bridge, _emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_core_state_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    Arc::new(CoreRunState::new(
        store,
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ))
}

// ── T-43/T-44（记忆韧性轮次 6）：Summarizer 注入通道 + 配置面 ────

/// T-43：壳层 Summarizer 注入通道——无工厂 → None（不 spawn，纯 stub
/// awaiting 永驻）；注入 fake 工厂 → 按会话解析实例；会话参数透传
#[test]
fn summarizer_factory_injection_channel() {
    struct FakeSummarizer;
    impl conex_compaction::Summarizer for FakeSummarizer {
        fn summarize(
            &self,
            _dropped: &[conex_types::message::AgentMessage],
            _existing: Option<&str>,
        ) -> Result<String, String> {
            Ok(r#"{"schemaVersion":1}"#.to_string())
        }
    }
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);

    // 生产装配（COMPACTION-01 P0-3）：CoreRunState::new 已装配真实
    // 工厂——测试显式清空回到「无注入」基线（provider 未就绪时工厂
    // 本身也解析 None，此处显式清空保证断言与机器配置无关）
    state.set_summarizer_factory(None);
    assert!(state.summarizer_for("s1").is_none(), "无工厂 = 无注入");

    // 注入工厂：per-session 实例（04 §7.1 隔离决议——按会话创建）
    let sessions_seen: Arc<std::sync::Mutex<Vec<String>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    {
        let sessions_seen = Arc::clone(&sessions_seen);
        state.set_summarizer_factory(Some(Box::new(move |session_id: &str| {
            sessions_seen.lock().unwrap().push(session_id.to_string());
            Some(Arc::new(FakeSummarizer) as Arc<dyn conex_compaction::Summarizer>)
        })));
    }
    let s = state.summarizer_for("s1").expect("注入后必须解析出实例");
    let s2 = state.summarizer_for("s2");
    // 工厂被调用的会话参数正确透传
    assert_eq!(
        *sessions_seen.lock().unwrap(),
        vec!["s1".to_string(), "s2".to_string()]
    );
    assert!(s2.is_some(), "工厂返回 Some → 通道解析成功");
    drop(s);

    // 清空工厂（None 语义恢复）
    state.set_summarizer_factory(None);
    assert!(state.summarizer_for("s1").is_none());
}

/// T-44：session_meta 配置面——无键 → None（生产缺省参数语义）；
/// 有键 → 从 session_meta 构造（自定义退避 + 墙钟）
#[test]
fn summary_dispatch_config_reads_session_meta() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db.clone()));
    let state = core_state_with_store(store);

    // 无任何配置键 → None（与轮次 4 summary_dispatch: None 语义一致）
    assert!(state.summary_dispatch_config("s1").is_none());

    // 自定义退避数组 + 墙钟
    db.set_session_meta("compact_summary_backoff_ms", "[2000,6000]")
        .unwrap();
    db.set_session_meta("compact_summary_wall_ms", "45000")
        .unwrap();
    let config = state.summary_dispatch_config("s1").expect("有键时构造配置");
    assert_eq!(config.backoff_ms, vec![2000, 6000]);
    assert_eq!(config.max_wall_ms, 45_000);
    assert_eq!(config.max_attempts, session_loop::MAX_SUMMARY_ATTEMPTS);
}

/// T-44：坏值兜底——配置键存在但值非法 → 回退生产缺省（不 panic）
#[test]
fn summary_dispatch_config_malformed_falls_back_to_defaults() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta("compact_summary_backoff_ms", "oops")
        .unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let config = state
        .summary_dispatch_config("s1")
        .expect("有键即构造（解析失败兜底缺省）");
    assert_eq!(config.backoff_ms, session_loop::SUMMARY_BACKOFF_MS.to_vec());
    assert_eq!(config.max_wall_ms, session_loop::LOOP_SUMMARY_MAX_WALL_MS);
}

/// T-42：会话级协调器注册表挂载——同会话 get 幂等同 Arc（跨 run 单飞
/// 状态延续）；跨会话各自成实例（会话隔离）
#[test]
fn summary_coordinator_registry_is_session_scoped() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);

    let c1 = state.summary_coordinator_for("s1");
    let c1_again = state.summary_coordinator_for("s1");
    let c2 = state.summary_coordinator_for("s2");
    assert!(
        Arc::ptr_eq(&c1, &c1_again),
        "同会话必须同一协调器（跨 run 单飞）"
    );
    assert!(!Arc::ptr_eq(&c1, &c2), "跨会话各自成实例（会话隔离）");
    assert_eq!(c1.session_id(), "s1");
    assert_eq!(c2.session_id(), "s2");
}

// ── COMPACTION-01 P0-1：压缩策略装配（session_meta 键面 + 触发验收）──

/// P0-1 装配：无 session_meta 键 → 常量默认 policy（keep_recent_tokens
/// 20000 / min_recent_turns 2 / max_summary_tokens 1024 / tool_pair
/// protection true）；生产恒装配（LocalDb store 存在即 Some——预检与
/// 溢出触发链解除焊死）
#[test]
fn compaction_policy_assembled_with_defaults() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);

    let policy = state
        .compaction_policy_for("s1")
        .expect("生产必须装配压缩策略（预检可触发）");
    assert_eq!(
        policy.keep_recent_tokens,
        conex_compaction::KEEP_RECENT_TOKENS_DEFAULT,
        "keep_recent_tokens 默认 20000（常量同源）"
    );
    assert_eq!(
        policy.min_recent_turns,
        conex_compaction::MIN_RECENT_TURNS_DEFAULT,
        "min_recent_turns 默认 2"
    );
    assert_eq!(
        policy.max_summary_tokens,
        conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
        "max_summary_tokens 默认 1024"
    );
    assert!(policy.tool_pair_protection, "tool 配对保护默认开启");
}

/// P0-1 覆盖：session_meta 键覆盖生效（compact_summary_max_tokens /
/// compact_keep_recent_tokens / compact_min_recent_turns）；坏值 / 0 值
/// 回退默认 + 不 panic
#[test]
fn compaction_policy_overrides_and_malformed_fall_back() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta(
        conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
        "2048",
    )
    .unwrap();
    db.set_session_meta("compact_keep_recent_tokens", "8000")
        .unwrap();
    db.set_session_meta("compact_min_recent_turns", "4")
        .unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db.clone()));
    let state = core_state_with_store(store);

    let policy = state.compaction_policy_for("s1").expect("装配 policy");
    assert_eq!(
        policy.max_summary_tokens, 2048,
        "compact_summary_max_tokens 覆盖"
    );
    assert_eq!(
        policy.keep_recent_tokens, 8000,
        "compact_keep_recent_tokens 覆盖"
    );
    assert_eq!(policy.min_recent_turns, 4, "compact_min_recent_turns 覆盖");

    // 坏值 → 回退默认（不 panic）
    db.set_session_meta(
        conex_compaction::SESSION_META_KEY_COMPACT_SUMMARY_MAX_TOKENS,
        "oops",
    )
    .unwrap();
    db.set_session_meta("compact_keep_recent_tokens", "-1")
        .unwrap();
    db.set_session_meta("compact_min_recent_turns", "0")
        .unwrap();
    let policy = state.compaction_policy_for("s1").expect("坏值兜底后仍装配");
    assert_eq!(
        policy.max_summary_tokens,
        conex_compaction::MAX_SUMMARY_TOKENS_DEFAULT,
        "坏值回退默认 max_summary_tokens"
    );
    assert_eq!(
        policy.keep_recent_tokens,
        conex_compaction::KEEP_RECENT_TOKENS_DEFAULT,
        "坏值回退默认 keep_recent_tokens"
    );
    assert_eq!(
        policy.min_recent_turns,
        conex_compaction::MIN_RECENT_TURNS_DEFAULT,
        "0 值回退默认 min_recent_turns"
    );
}

/// F4/F5 测试辅助：返回固定 Schema V1 文档的 Summarizer（校验通过，
/// 字段含 goal/progress/nextSteps 供阶段总结提取）
struct FakeLlmSummarizer;
impl conex_compaction::Summarizer for FakeLlmSummarizer {
    fn summarize(
        &self,
        _dropped: &[conex_types::message::AgentMessage],
        _existing: Option<&str>,
    ) -> Result<String, String> {
        Ok(r#"{"schemaVersion":1,"blockId":"fake-1","generation":1,"droppedIds":[],"height":1,"tier":"stage-1","goal":"测试目标","constraints":[],"progress":["进展一"],"decisions":[],"nextSteps":["下一步一"],"criticalContext":"关键上下文"}"#.to_string())
    }
}

/// F4/F5 测试辅助：注入 FakeLlmSummarizer 工厂（会话参数透传）
fn inject_fake_summarizer(state: &Arc<CoreRunState>) {
    state.set_summarizer_factory(Some(Box::new(|_session_id: &str| {
        Some(Arc::new(FakeLlmSummarizer) as Arc<dyn conex_compaction::Summarizer>)
    })));
}

/// P0-1 触发验收（完整 run 链路，mock provider 场景）：历史水合超大
/// 对话 → 首个 prepare_turn 估算超窗（estimate ≥ window - reserve）→
/// 预检压缩真实触发 → context-compression-start / end 事件广播落库 →
/// 压缩后继续请求并正常收口。
#[tokio::test]
async fn compaction_policy_preflight_triggers_compaction_in_full_run() {
    let huge = "x".repeat(160_000);
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("压缩后收口回复。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    inject_fake_summarizer(&state);
    state.run_restore().await;

    // 历史水合：u1,a1,u2,a2,u3,a3,u4(超大)——水合尾部约束要求以 user
    // 收尾（assistant 收尾被截断）；尾部倒推 cut 落在 u4（超大），
    // 保留段首条 = user（T-36 形状护栏：无 system 会话链后首条必须
    // 为 user）→ dropped=[u1..a3] 六条
    let history = vec![
        HistoryMessage {
            id: "h-u1".to_string(),
            sender: "user".to_string(),
            text: Some("第一轮提问".to_string()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_000,
        },
        HistoryMessage {
            id: "h-a1".to_string(),
            sender: "assistant".to_string(),
            text: Some("第一轮回复".to_string()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_001,
        },
        HistoryMessage {
            id: "h-u2".to_string(),
            sender: "user".to_string(),
            text: Some("第二轮提问".to_string()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_002,
        },
        HistoryMessage {
            id: "h-a2".to_string(),
            sender: "assistant".to_string(),
            text: Some("第二轮回复".to_string()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_003,
        },
        HistoryMessage {
            id: "h-u3".to_string(),
            sender: "user".to_string(),
            text: Some("第三轮提问".to_string()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_004,
        },
        HistoryMessage {
            id: "h-a3".to_string(),
            sender: "assistant".to_string(),
            text: Some("第三轮回复".to_string()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_005,
        },
        HistoryMessage {
            id: "h-u4".to_string(),
            sender: "user".to_string(),
            text: Some(huge.clone()),
            thinking: None,
            blocks_json: None,
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_006,
        },
    ];
    let options = RunTaskOptions {
        history: Some(history),
        // 窗口 40000：reserve 16384 → 预算 23616；估算 ≈ 42K+ ≥ 预算
        // → 预检触发（此前 compaction_policy=None 恒不触发）
        context_window: Some(40_000),
        ..test_options("run-compact", "s1", "发起长会话")
    };
    run_task_impl(Arc::clone(&state), options)
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;

    // 压缩事件：start + end 各一条（预检触发链真实走通）
    let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
    let starts = events
        .iter()
        .filter(|e| e.event_type == "context-compression-start")
        .count();
    let ends = events
        .iter()
        .filter(|e| e.event_type == "context-compression-end")
        .count();
    assert_eq!(starts, 1, "预检压缩应广播 context-compression-start");
    assert_eq!(ends, 1, "预检压缩应广播 context-compression-end");
    // 压缩记录载荷：stub 摘要（summarizer 关闭 → awaiting），丢弃消息
    // = 前两轮（u1,a1），保留段从第二轮提问起
    let end = events
        .iter()
        .find(|e| e.event_type == "context-compression-end")
        .expect("end 事件存在");
    let payload: serde_json::Value =
        serde_json::from_str(&end.payload).expect("压缩载荷为合法 JSON");
    let dropped = payload["result"]["compressedMessageIds"]
        .as_array()
        .map(|arr| arr.len())
        .unwrap_or(0);
    assert!(dropped >= 1, "压缩必须丢弃历史消息（dropped={dropped}）");
    assert!(
        payload["result"]["summary"].as_str().is_some(),
        "压缩载荷须携带摘要文本"
    );
}

// ── DEEPCHECK-06 P0：子代理 run 预算装配全链路验收 ────────────

/// DEEPCHECK-06 P0（子代理预算接线验收）：子代理 run 经 run_task_impl
/// 装配——spawner 路径 context_window 恒 None（前端参数不可达）→ 引擎
/// 按生效模型 catalog 解析窗口（qwen2-5-omni-7b → 32000）→
/// context_budget + compaction_policy 双装配（此前子代理 run 预算恒
/// None，预检/溢出压缩三级全裸）→ 超大历史水合估算超窗 → 预检压缩
/// 真实触发（context-compression-start/end 事件落库到子代理会话）。
#[tokio::test]
async fn subagent_run_assembles_catalog_window_budget_and_preflight_compaction() {
    // live yaml 夹具：qwen2-5-omni-7b contextWindow 32000（窗口只读 live）
    crate::engine_provider::protocol::reload_live_catalog_from_yaml_str(
        r#"
version: 2
providers:
  qwen:
    displayName: Qwen
    baseUrl: "https://dashscope.example.com/v1"
    protocol: "openai/chat"
    models:
      - id: qwen2-5-omni-7b
        contextWindow: 32000
"#,
    )
    .expect("qwen 夹具必须解析成功");
    let subagent_session = "sub-sess-budget";
    // 子代理脚本：单轮文本收口（无工具调用）
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("子代理收口回复。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state_with_model(provider, "qwen2-5-omni-7b");
    db.upsert_session_entry(&subagent_test_session_entry(subagent_session))
        .expect("子代理会话条目");
    inject_fake_summarizer(&state);
    state.run_restore().await;
    // 用户裁决：重试预算/上限可配置——注入快速策略防 30s 窗口被缺省 10 次重试拖穿
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));

    // 子代理会话历史预置（spawner 场景 history=None → 走缓存回退；
    // 超大消息 → 水合估算超窗（≈42K tokens ≥ 32000-16384=15616））
    // blocks_json 必须携带：缓存路径水合（cached_history_to_conversation
    // → parse_blocks）只消费 blocks_json（text-only 合成兜底属前端路径
    // hydrate.rs 的规则，缓存路径与收口写入 to_history_message 的形状
    // 契约 = 块保真形态；text-only 条目会被宽容跳过，导致水合为空对话、
    // 预检无从触发）
    let huge = "x".repeat(160_000);
    let history = vec![
        HistoryMessage {
            id: "h-u1".to_string(),
            sender: "user".to_string(),
            text: Some("第一轮提问".to_string()),
            thinking: None,
            blocks_json: Some(serde_json::to_string(&vec![text_block("第一轮提问")]).unwrap()),
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_000,
        },
        HistoryMessage {
            id: "h-a1".to_string(),
            sender: "assistant".to_string(),
            text: Some("第一轮回复".to_string()),
            thinking: None,
            blocks_json: Some(serde_json::to_string(&vec![text_block("第一轮回复")]).unwrap()),
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_001,
        },
        HistoryMessage {
            id: "h-u2".to_string(),
            sender: "user".to_string(),
            text: Some(huge.clone()),
            thinking: None,
            blocks_json: Some(serde_json::to_string(&vec![text_block(&huge)]).unwrap()),
            tool_calls_json: None,
            tool_call_results_json: None,
            status: Some("completed".to_string()),
            timestamp: 1_700_000_000_002,
        },
    ];
    state.session_history.store(subagent_session, history);

    // 子代理 run：context_window 恒 None（spawner 路径真实装配形状）+
    // history None（缓存回退）+ subagent_config 装配
    let options = RunTaskOptions {
        mode: Some("research".to_string()),
        history: None,
        context_window: None,
        subagent_config: Some(crate::subagent_spawner::SubagentRunConfig {
            subagent_id: "sub-1-0".to_string(),
            subagent_run_id: "sub-run-budget".to_string(),
            parent_session_id: "s1".to_string(),
            task_type: Some("analysis".to_string()),
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1_700_000_000_000,
        }),
        ..test_options("sub-run-budget", subagent_session, "调研模块 A")
    };
    run_task_impl(Arc::clone(&state), options)
        .await
        .expect("子代理 run 发起成功");
    wait_run_terminal(&db, subagent_session, Duration::from_secs(90)).await;

    // 预检压缩真实触发：context-compression-start/end 事件落库到子代理
    // 会话（证据链：context_window None + subagent_config Some →
    // catalog 窗口 32000 → budget+policy 双装配 → 预检触发。此前子代理
    // run 预算 None，本事件恒不出现，超窗直接 fatal）
    let events = db
        .query_events(subagent_session, 0, Some(500))
        .expect("事件查询");
    let starts = events
        .iter()
        .filter(|e| e.event_type == "context-compression-start")
        .count();
    let ends = events
        .iter()
        .filter(|e| e.event_type == "context-compression-end")
        .count();
    assert_eq!(starts, 1, "子代理预检压缩应广播 context-compression-start");
    assert_eq!(ends, 1, "子代理预检压缩应广播 context-compression-end");
}

// ── 31 评审 F2（P1）：estop 桥仅主 run 装配（子代理 run 不装配）──

/// estop 桥装配判定（[assemble_browser_estop]）：仅主 run
/// （subagent_config = None）装配 reset_estop + watcher；子代理 run
/// （任意 task_type）一律不装配——「子代理 run 不挂 watcher」的单元
/// 断言，杜绝「子代理 abort → cancel 主 run estop」故障链（31 评审 F2）。
#[test]
fn browser_estop_bridge_main_run_only() {
    assert!(
        assemble_browser_estop(&None),
        "主 run（无子代理配置）必须装配 estop 桥"
    );
    // 子代理 run：缺省 task_type（None）与各显式类型一律不装配
    for task_type in [
        None,
        Some("analysis"),
        Some("implementation"),
        Some("review"),
    ] {
        let config = Some(crate::subagent_spawner::SubagentRunConfig {
            subagent_id: "sub-1-0".to_string(),
            subagent_run_id: "sub-run-estop".to_string(),
            parent_session_id: "s1".to_string(),
            task_type: task_type.map(String::from),
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1_700_000_000_000,
        });
        assert!(
            !assemble_browser_estop(&config),
            "子代理 run（task_type={task_type:?}）不得装配 estop 桥"
        );
    }
}

/// 集成面：子代理 run 的 L3 强停路径正常收场（aborted）——子代理 run
/// 可被中止（触发面不受 estop 桥剔除影响），且 estop 桥装配判定由
/// [browser_estop_bridge_main_run_only] 锁定（子代理 abort 不触达主 run
/// 的 estop 周期）。
#[tokio::test]
async fn subagent_run_abort_terminates_without_estop_bridge() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("子代理第一轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_pause(0, 3_000),
    );
    let (state, db, _emitter) = run_control_test_state_with_model(provider, "qwen2-5-omni-7b");
    state.run_restore().await;
    let session_id = "sub-sess-estop";
    db.upsert_session_entry(&subagent_test_session_entry(session_id))
        .expect("子代理会话条目");
    // 子代理 run：context_window 恒 None（spawner 路径真实装配形状）
    let options = RunTaskOptions {
        mode: Some("research".to_string()),
        history: None,
        context_window: None,
        subagent_config: Some(crate::subagent_spawner::SubagentRunConfig {
            subagent_id: "sub-1-0".to_string(),
            subagent_run_id: "sub-run-estop".to_string(),
            parent_session_id: "s1".to_string(),
            task_type: Some("analysis".to_string()),
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1_700_000_000_000,
        }),
        ..test_options("sub-run-estop", session_id, "子代理 estop 装配面")
    };
    run_task_impl(Arc::clone(&state), options)
        .await
        .expect("子代理 run 发起成功");
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("sub-run-estop")
        .cloned()
        .expect("子代理 run 已注册");
    // L3 强停（用户取消路径：abort_signal + 总线 force_cancel 双写）
    run_control_impl(
        &state,
        "sub-run-estop",
        "force_cancel",
        None,
        Some("测试强停子代理".to_string()),
        None,
    )
    .await
    .expect("force_cancel 应成功");
    // 真实 loop 在下一安全点收场：agent-end reason == aborted
    let end_reason = wait_run_end_reason(&active, Duration::from_secs(30)).await;
    assert_eq!(
        end_reason, "aborted",
        "L3 强停后子代理 run 必须以 aborted 终态"
    );
    let terminal = wait_run_terminal(&db, session_id, Duration::from_secs(90)).await;
    assert_eq!(
        terminal, "cancelled",
        "L3 强停后子代理 loop 的 run-terminal 终态必须为 cancelled（权威映射 aborted→cancelled）"
    );
}

// ── PS-04 T4.3（F4 F1-01）：配置应用后 provider 重载 ──

/// 独立临时 config 目录（不清理：静态 store 在测试结束后仍可能绑定该
/// 目录，删除会触发后续只读初始化的缺省回落——保留无害且避免竞态）。
fn temp_config_dir() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("conex-config-test-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create config dir");
    dir
}

/// 本地 HTTP 请求捕获服务器：T4.3-R2 的「RecordingProvider」——wire 层
/// 真实记录每次 provider 请求的 URL 路径 / Authorization / body model
/// （不 mock 重载行为：重载是否生效由「新实例的请求载荷」证明）。
struct RequestCaptureServer {
    addr: std::net::SocketAddr,
    captured: Arc<std::sync::Mutex<Vec<CapturedRequest>>>,
}

#[derive(Debug, Clone)]
struct CapturedRequest {
    path: String,
    auth_header: Option<String>,
    body_model: Option<String>,
}

impl RequestCaptureServer {
    async fn start() -> Arc<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local server");
        let addr = listener.local_addr().expect("local addr");
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let server = Arc::new(Self {
            addr,
            captured: Arc::clone(&captured),
        });
        tokio::spawn(async move {
            // 接受少量连接（每次请求一条；幂等重试面内都记录）
            for _ in 0..8 {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let captured = Arc::clone(&captured);
                tokio::spawn(async move {
                    if let Some(request) = read_http_request(&mut socket).await {
                        captured
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(request);
                    }
                    // 2xx 即让 client stream() 返回（测试不消费 body）
                    let _ = socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                        .await;
                });
            }
        });
        server
    }

    fn base_url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    /// 等待捕获到 `n` 个请求（5s 超时兜底，防测试悬挂）
    async fn wait_for(&self, n: usize) -> Vec<CapturedRequest> {
        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(5);
        loop {
            let current = self
                .captured
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            if current.len() >= n {
                return current;
            }
            if tokio::time::Instant::now() >= deadline {
                return current;
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        }
    }
}

/// 读一条 HTTP 请求（请求行 + 头 + Content-Length 体；1s 读超时防挂起）
async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Option<CapturedRequest> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    let head_end = loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        let n = match tokio::time::timeout(
            tokio::time::Duration::from_secs(3),
            socket.read(&mut chunk),
        )
        .await
        {
            Ok(Ok(n)) => n,
            Ok(Err(_)) => return None,
            Err(_) => return None,
        };
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let path = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default()
        .to_string();
    let mut content_length = 0usize;
    let mut auth_header = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            } else if name.eq_ignore_ascii_case("authorization") {
                auth_header = Some(value.trim().to_string());
            }
        }
    }
    // 请求头与体可能在同一 TCP 段到达——先消费已读缓冲中越过 head_end 的
    // 字节（否则 body 读会阻塞到超时，误判连接无数据）。
    let mut body = buf[head_end..].to_vec();
    while body.len() < content_length {
        let n = tokio::time::timeout(tokio::time::Duration::from_secs(1), socket.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let body_model = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("model").and_then(|m| m.as_str()).map(str::to_string));
    Some(CapturedRequest {
        path,
        auth_header,
        body_model,
    })
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// T4.3-R2（红 → 绿）：apply 新凭据后**下一次 provider 调用**必须携带
/// 新凭据——真实 HTTP 请求载荷断言（URL 路径 = baseUrl、Authorization =
/// key、请求体 model）。修复前配置应用只写 store 不重载
/// provider，请求仍按旧 baseUrl/key/model 发出 → 红。
#[tokio::test]
async fn provider_apply_swaps_next_request_payload() {
    use tauri::Manager as _;
    let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_config_dir();
    isolate_config_store(&dir);

    let server = RequestCaptureServer::start().await;
    let base_old = server.base_url("/v1-old");
    let base_new = server.base_url("/v1-new");

    // 旧配置 A：单 provider(p1)，key 经 env 注入 sk-a，引擎构造时加载快照 A
    let store = install_tree_models_store(&dir, &base_old);
    // 引擎在 store A 之上构造（构造时快照 A）。注意：reqwest 客户端在
    // 引擎构造时读取 HTTP_PROXY 等环境变量——清空保证请求真实直连本地
    // 服务器（不依赖机器代理配置；其余测试不发起真实 HTTP，无副作用）。
    for var in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::remove_var(var);
    }
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let st = app.state::<Arc<CoreRunState>>();

    // 模拟前端 apply 新凭据（key/baseUrl/model 全换）：env 注入 sk-b + 重应用统一树
    std::env::set_var(TEST_ENV_KEY, "sk-b");
    apply_single_provider(&store, &base_new, "model-b");
    state.engine.reload_provider();

    // 下一次 provider 调用：真实 HTTP 请求，载荷必须用新凭据
    let provider = state.engine.provider().expect("provider 就绪");
    let messages: Vec<Arc<AgentMessage>> = Vec::new();
    let request = session_loop::provider::ProviderRequest {
        messages: &messages,
        tools: Vec::new(),
        max_tokens: None,
        system_prompt: None,
        session_id: None,
        reasoning_effort: None,
    };
    let stream = provider
        .stream(&request)
        .await
        .expect("本地服务器应可发起流");
    drop(stream);

    let captured = server.wait_for(1).await;
    assert_eq!(captured.len(), 1, "应恰好捕获 1 个请求");
    assert!(
        captured[0].path.starts_with("/v1-new/chat/completions"),
        "请求 URL 必须用新 baseUrl：{}",
        captured[0].path
    );
    assert_eq!(
        captured[0].auth_header.as_deref(),
        Some("Bearer sk-b"),
        "Authorization 必须用新 key：{:?}",
        captured[0].auth_header
    );
    assert_eq!(
        captured[0].body_model.as_deref(),
        Some("model-b"),
        "请求体 model 必须用新 model：{:?}",
        captured[0].body_model
    );
}

/// T4.3-R3（红 → 绿，命令级）：配置应用成功返回后
/// `engine.provider_config()` 必须与新 store 值一致（key/baseUrl/model
/// 三件套热更新）。修复前引擎只读构造时快照 → 仍旧值 → 红。
#[tokio::test]
async fn provider_apply_refreshes_engine_provider_config() {
    use tauri::Manager as _;
    let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_config_dir();
    isolate_config_store(&dir);

    // 旧配置 A：单 provider(p1)，key 经 env 注入 sk-a
    let store = install_tree_models_store(&dir, "https://a.example/v1");
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    assert_eq!(
        state.engine.provider_config().expect("构造后就绪").model,
        "model-a"
    );
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let st = app.state::<Arc<CoreRunState>>();

    // apply 新三件套 → 引擎生效配置必须同步刷新
    std::env::set_var(TEST_ENV_KEY, "sk-b");
    apply_single_provider(&store, "https://b.example/v1", "model-b");
    state.engine.reload_provider();

    let config = state.engine.provider_config().expect("重载后就绪");
    assert_eq!(config.api_key, "sk-b", "key 必须热更新");
    assert_eq!(
        config.base_url, "https://b.example/v1",
        "baseUrl 必须热更新"
    );
    assert_eq!(config.model, "model-b", "model 必须热更新");
    assert!(state.engine.ready(), "重载后引擎必须就绪");
    assert!(
        state.engine.provider().is_some(),
        "重载后 provider 必须可调用"
    );
}

/// T4.3-R4（红 → 绿，契约）：apiKey 清空（空串）apply 后引擎必须降级
/// 未就绪——下一次 run 不得再用旧凭据；重填后恢复就绪。修复前 apply
/// 不碰引擎 → 清 key 后仍就绪 → 红。
#[tokio::test]
async fn provider_apply_clearing_key_degrades_engine_ready() {
    use tauri::Manager as _;
    let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_config_dir();
    isolate_config_store(&dir);

    // 旧配置 A：单 provider(p1)，key 经 env 注入 sk-a
    let store = install_tree_models_store(&dir, "https://a.example/v1");
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    assert!(state.engine.ready(), "写 key 后就绪");
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let st = app.state::<Arc<CoreRunState>>();

    // 清空 key（env 移除）：引擎必须降级未就绪（provider=None，不再用旧 key 发请求）
    std::env::remove_var(TEST_ENV_KEY);
    state.engine.reload_provider();
    assert!(!state.engine.ready(), "清 key 后引擎必须未就绪");
    assert!(
        state.engine.provider().is_none(),
        "清 key 后 provider 必须为 None"
    );
    assert!(
        state.engine.provider_config().is_none(),
        "清 key 后 provider_config 必须为 None"
    );

    // 重填后恢复
    std::env::set_var(TEST_ENV_KEY, "sk-c");
    state.engine.reload_provider();
    assert!(state.engine.ready(), "重填 key 后恢复就绪");
    assert_eq!(
        state.engine.provider_config().expect("重填后就绪").api_key,
        "sk-c"
    );
}

// ── T5.2a（G3 收敛 · 引擎侧 profile 服务）───────────────────────────────

/// R5 T5.2a 验收①：引擎可服务前端预置 `opencode-go` profile——
/// 配置应用（"opencode-go", key=DPAPI 槽, baseUrl, model）后，生效
/// 配置即 opencode-go 的端点/模型/凭据，且真实请求命中
/// `https://opencode.ai/zen/go/v1/chat/completions`（chat 轨：deepseek-v4-flash
/// 走 openai-completions 协议，默认端点 chat-completions，00 D3）。密钥不随
/// apply 传入（从前置凭据注入的 DPAPI 槽回读），对齐前端激活路径。
#[tokio::test]
async fn provider_apply_opencode_go_serves_preset_profile() {
    use tauri::Manager as _;
    let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_config_dir();
    isolate_config_store(&dir);

    // 预置 opencode-go 凭据（旧凭据注入落 DPAPI 槽；新单轨改经 env ref
    // 注入，key 与 provider 解耦，等价于 activation path 回读密钥）。
    std::env::set_var("CONEX_TEST_OPENCODE_KEY", "sk-opencode-go");

    let server = RequestCaptureServer::start().await;
    for var in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::remove_var(var);
    }
    // 安装 opencode-go 统一树（provider=opencode-go，active=deepseek-v4-flash，
    // base=server 端点，key 经 env ref 注入），引擎构造时即加载该快照。
    let opencode_yaml = format!(
        "version: 2\n\
         activeModel:\n  providerId: opencode-go\n  modelId: deepseek-v4-flash\n\
         providers:\n  opencode-go:\n    displayName: opencode-go\n    baseUrl: {}\n    protocol: openai/chat\n    apiKeyRef: env:CONEX_TEST_OPENCODE_KEY\n    models:\n      - id: deepseek-v4-flash\n        enabled: true\n",
        server.base_url("/zen/go/v1")
    );
    let _store = install_yaml_store(&dir, &opencode_yaml);
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let _st = app.state::<Arc<CoreRunState>>();

    // 前端激活 opencode-go：key 从 env ref 回读（apiKey 不传），带 baseUrl+model；
    // 重加载引擎使生效配置与统一树一致（等价于旧配置应用的 reload）。
    state.engine.reload_provider();

    // 引擎生效配置 = opencode-go 端点/模型/凭据（profile 投影优先）。
    let config = state.engine.provider_config().expect("opencode-go 就绪");
    assert_eq!(
        config.base_url,
        server.base_url("/zen/go/v1"),
        "生效 baseUrl 必须为 opencode-go 端点"
    );
    assert_eq!(
        config.model, "deepseek-v4-flash",
        "生效 model 必须为 opencode-go"
    );
    assert_eq!(config.api_key, "sk-opencode-go", "生效 key 来自 DPAPI 槽");
    assert!(state.engine.ready(), "opencode-go 三件套齐备引擎就绪");

    // 真实请求：chat 轨 URL 形如 `{base}/chat/completions`（opencode-go 走
    // openai-completions 协议）。
    let provider = state.engine.provider().expect("provider 就绪");
    let messages: Vec<Arc<AgentMessage>> = Vec::new();
    let request = session_loop::provider::ProviderRequest {
        messages: &messages,
        tools: Vec::new(),
        max_tokens: None,
        system_prompt: None,
        session_id: None,
        reasoning_effort: None,
    };
    let stream = provider
        .stream(&request)
        .await
        .expect("opencode-go 本地服务器可发起流");
    drop(stream);
    let captured = server.wait_for(1).await;
    assert_eq!(captured.len(), 1, "应捕获 1 个请求");
    assert!(
        captured[0].path.starts_with("/zen/go/v1/chat/completions"),
        "opencode-go 必须走 chat 轨（chat/completions）：{}",
        captured[0].path
    );
    assert_eq!(
        captured[0].body_model.as_deref(),
        Some("deepseek-v4-flash"),
        "请求体 model 必须为 opencode-go 的 deepseek-v4-flash"
    );
}

/// R5 T5.2a 验收②：多 profile 并存——profile A/B 独立端点/模型互不串扰；
/// 切换后生效配置随之切换（对齐 C2 per-provider 语义）。
#[tokio::test]
async fn provider_apply_switches_profiles_independently() {
    use tauri::Manager as _;
    let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_config_dir();
    isolate_config_store(&dir);

    // profile A/B 凭据经独立 env ref 注入（旧凭据注入落各自 DPAPI 槽）。
    std::env::set_var(TEST_PROFILE_A_KEY, "sk-a");
    std::env::set_var(TEST_PROFILE_B_KEY, "sk-b");

    // 安装双 provider 统一树（active=profile-a）；引擎构造即加载该快照。
    let store = install_yaml_store(&dir, &profile_tree_yaml("profile-a", "model-a"));
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let _app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    // 应用 A
    apply_unified_yaml(&store, &profile_tree_yaml("profile-a", "model-a"));
    state.engine.reload_provider();
    let a = state.engine.provider_config().expect("a 就绪");
    assert_eq!(a.base_url, "https://a.example/v1");
    assert_eq!(a.model, "model-a");
    assert_eq!(a.api_key, "sk-a");

    // 应用 B（切到 B）
    apply_unified_yaml(&store, &profile_tree_yaml("profile-b", "model-b"));
    state.engine.reload_provider();
    let b = state.engine.provider_config().expect("b 就绪");
    assert_eq!(b.base_url, "https://b.example/v1", "B 的 baseUrl 独立");
    assert_eq!(b.model, "model-b", "B 的 model 独立");
    assert_eq!(b.api_key, "sk-b", "B 的 key 独立");

    // 切回 A：A 的端点/模型独立恢复，不被 B 覆盖
    apply_unified_yaml(&store, &profile_tree_yaml("profile-a", "model-a"));
    state.engine.reload_provider();
    let a2 = state.engine.provider_config().expect("a 恢复");
    assert_eq!(a2.base_url, "https://a.example/v1", "A 端点不被 B 串扰");
    assert_eq!(a2.model, "model-a", "A 模型不被 B 串扰");
    assert_eq!(a2.api_key, "sk-a", "A 凭据不被 B 串扰");
}

/// R5 T5.2a 验收③：config_get 快照含 ≥2 提供方（I2：Tauri 壳 config 快照
/// ≥2 提供方）——活跃 profile 与已配置 profile 并列，activeProfileId 暴露。
#[tokio::test]
async fn config_snapshot_exposes_multiple_providers() {
    use tauri::Manager as _;
    let _lock = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_config_dir();
    isolate_config_store(&dir);

    // profile A/B 凭据经独立 env ref 注入（旧凭据注入落各自 DPAPI 槽）。
    std::env::set_var(TEST_PROFILE_A_KEY, "sk-a");
    std::env::set_var(TEST_PROFILE_B_KEY, "sk-b");

    // 安装双 provider 统一树（active=profile-b：最近应用者）；快照直接读统一树。
    let _store = install_yaml_store(&dir, &profile_tree_yaml("profile-b", "model-b"));
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let _app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");

    // config 快照投影（settings_get_impl 替代旧 config_get；providers 为对象键控）
    let snapshot = super::settings_get_impl().expect("settings snapshot");
    let providers = snapshot
        .get("providers")
        .and_then(|v| v.as_object())
        .expect("providers 对象");
    assert!(
        providers.len() >= 2,
        "config 快照应含 ≥2 提供方：{providers:?}"
    );
    assert_eq!(
        snapshot.get("activeProfileId").and_then(|v| v.as_str()),
        Some("profile-b"),
        "activeProfileId 应指向最近应用者"
    );
    let ids: Vec<&str> = providers.keys().map(|s| s.as_str()).collect();
    assert!(
        ids.contains(&"profile-a") && ids.contains(&"profile-b"),
        "providers 应含 A 与 B：{ids:?}"
    );
}

// ── PERSIST-02 P1-2：restore 完成/成功前禁止覆盖主快照 ──

/// restore 完成前（restore_ready=false）保存快照被门禁拒绝——退出钩子
/// /周期任务不得用「0 会话半水合快照」覆盖主快照（会话树分支历史
/// 永久丢失）；restore 成功后放行。
#[tokio::test]
async fn snapshot_skipped_before_restore_ready_preserves_main_snapshot() {
    let (bridge, _emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("conex_p12_guard_{}_{seq}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("snapshot.json");
    let snapshots: Arc<dyn SnapshotStore> =
        Arc::new(orchestrator::restore::SnapshotFileStore::new(&path));
    // 既有主快照（崩溃前最后完好快照，含会话树分支）
    let prior = StateSnapshot::build(
        3,
        42,
        vec![SessionRecord {
            session_id: "s1".to_string(),
            current_leaf_id: Some("leaf_keep".to_string()),
            branches: Vec::new(),
            context_meta: None,
        }],
        Vec::new(),
        Vec::new(),
        HashMap::new(),
    );
    snapshots.save_snapshot(&prior).unwrap();
    let state = Arc::new(CoreRunState::new(
        Arc::new(InMemoryStore::new()),
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    // restore 尚未完成（restore_ready=false）→ 保存被拒绝，主快照原样
    state.save_snapshot_now().await;
    let loaded = orchestrator::restore::SnapshotFileStore::new(&path)
        .load_snapshot()
        .unwrap();
    let (snap, _) = loaded;
    assert!(snap.is_some(), "主快照必须保留");
    assert_eq!(snap.unwrap().generation, 3, "主快照未被半水合快照覆盖");
    assert!(
        state.snapshot_last_error().is_some(),
        "拒绝原因经 snapshot.lastError 可观测"
    );
    assert_eq!(state.snapshot_generation(), 0, "失败保存不推进 generation");
    // restore 成功 → 放行（run_restore 先置 restore_ready 再立即保存）
    state.run_restore().await;
    let loaded = orchestrator::restore::SnapshotFileStore::new(&path)
        .load_snapshot()
        .unwrap();
    let (snap, _) = loaded;
    let snap = snap.expect("restore 后快照必须保存");
    assert_eq!(
        snap.generation, 1,
        "恢复后保存（generation 从进程内 0 续接）"
    );
    assert_eq!(
        snap.sessions.len(),
        1,
        "快照携带水合后的会话（非 0 会话半水合）"
    );
    assert_eq!(
        snap.sessions[0].current_leaf_id.as_deref(),
        Some("leaf_keep"),
        "会话树分支从既有快照水合保留"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// restore 失败路径（restore.state=failed）：保存仍被门禁拒绝——退出
/// 钩子不得覆盖主快照（保留最后完好快照供下次恢复）；门禁照常放行
/// run（不阻塞启动，懒计算兜底）。
#[tokio::test]
async fn snapshot_skipped_after_restore_failed_preserves_main_snapshot() {
    // 注入故障快照存储：load_snapshot 恒 Err → run_restore 失败降级；
    // save_snapshot 记录载荷，断言恢复失败后没有任何保存动作
    struct FailingSnapshots(std::sync::Mutex<Option<StateSnapshot>>);
    impl SnapshotStore for FailingSnapshots {
        fn load_snapshot(
            &self,
        ) -> Result<(Option<StateSnapshot>, Option<String>), orchestrator::restore::SnapshotError>
        {
            Err(orchestrator::restore::SnapshotError::new(
                "load_snapshot",
                "注入故障",
            ))
        }
        fn save_snapshot(
            &self,
            snapshot: &StateSnapshot,
        ) -> Result<(), orchestrator::restore::SnapshotError> {
            *self.0.lock().unwrap() = Some(snapshot.clone());
            Ok(())
        }
    }
    let failing = Arc::new(FailingSnapshots(std::sync::Mutex::new(None)));
    let snapshots: Arc<dyn SnapshotStore> = failing.clone();
    let state = Arc::new(CoreRunState::new(
        Arc::new(InMemoryStore::new()),
        snapshots,
        recording_bridge().0,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    let outcome = state.run_restore().await;
    assert!(outcome.is_none(), "restore 失败路径返回 None");
    assert_eq!(
        state.restore_status().state,
        "failed",
        "restore.state=failed 可观测"
    );
    assert!(state.restore_ready(), "失败路径不阻塞启动（降级放行）");
    // restore 失败后保存被拒绝：不覆盖主快照、不推进 generation
    state.save_snapshot_now().await;
    assert!(
        failing.0.lock().unwrap().is_none(),
        "restore 失败后不得保存任何快照（含半水合）"
    );
    assert!(
        state.snapshot_last_error().is_some(),
        "拒绝原因经 snapshot.lastError 可观测"
    );
    assert_eq!(state.snapshot_generation(), 0, "失败保存不推进 generation");
}

// ── T3.5 D5（F2-11 / F2-39）：快照三触发并发互斥 ────────────

/// 直读快照文件并校验（不走 SnapshotStore::load_snapshot 的 .prev
/// 回退，防「主快照损坏被兜底掩盖」误判——验收断言 1 要求主快照
/// 本身可解析且通过 StateSnapshot::valid()）
fn read_snapshot_file_direct(path: &std::path::Path) -> Option<StateSnapshot> {
    let raw = std::fs::read_to_string(path).ok()?;
    let snapshot: StateSnapshot = serde_json::from_str(&raw).ok()?;
    snapshot.valid().then_some(snapshot)
}

/// 快照三触发（终态/周期/退出共用 save_snapshot_now 入口）并发保存互斥：
/// - 断言 1：最终主快照直读经 StateSnapshot::valid() 通过（文件完整可解析）；
/// - 断言 2（R4 修订，AU-02 A5）：join 后第二次代数 > 第一次（单调递增，
///   顺序无关不 flaky）；两次保存代数互异且差恰为 1（读-改-写丢失 →
///   两路同读 G 同写 G+1 → 主/备份同代数必红）；
/// - 断言 3：保存后目录无 .tmp 残留（tmp 已 rename 清空）。
/// 真实并发形态：两个独立 std::thread（各自 current_thread runtime
/// block_on，对齐生产退出钩子「独立 std::thread 调 save_snapshot_blocking」
/// 的形态，R2 §4）经 Barrier 对齐后同时保存——OS 抢占式真并行，缺陷必现。
/// 不选 tokio::spawn：read-G→store 段无内部 await（query 全为即时就绪），
/// 单 worker LIFO 会把两任务串行化执行，缺陷被掩盖（实测 2/2 通过）；
/// 不选固定 sleep 编排（防作弊 B5）。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_concurrent_saves_are_mutexed() {
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("conex_d5_mutex_{}_{seq}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("snapshot.json");
    let snapshots: Arc<dyn SnapshotStore> =
        Arc::new(orchestrator::restore::SnapshotFileStore::new(&path));
    let state = Arc::new(CoreRunState::new(
        Arc::new(InMemoryStore::new()),
        snapshots,
        recording_bridge().0,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    // 注入若干 run：放大「read-G → store-G」窗口（空 store 下整段保存
    // 微秒级完成；500 条 run 使保存段拉长到数百 µs，双线程并行读 G 时
    // 另一方几乎不可能在 store 之后才读——竞态必现）
    for i in 0..500 {
        state
            .store
            .insert_run(
                &format!("r_{i}"),
                "s1",
                RunStatus::Completed,
                Some("stop"),
                0,
            )
            .await
            .unwrap();
    }
    // restore 完成 → 门禁放行 + 首张快照（generation 1，主快照就位；
    // 空库全量重放路径，对齐 snapshot_skipped_before_restore_ready 先例）
    assert!(state.run_restore().await.is_some(), "空库全量重放必须成功");
    assert_eq!(
        state.snapshot_generation(),
        1,
        "恢复后立即保存（generation 1）"
    );
    // R4 修订：第一次测量（join 前）
    let first = state.snapshot_generation();
    for _ in 0..8 {
        // 每轮 Barrier 对齐后双线程真实并发保存（退出钩子同形态）
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let a = Arc::clone(&state);
        let b = Arc::clone(&state);
        let ba = Arc::clone(&barrier);
        let bb = Arc::clone(&barrier);
        let thread_a = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("测试 runtime 可建");
            ba.wait();
            rt.block_on(async move { a.save_snapshot_now().await });
        });
        let thread_b = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("测试 runtime 可建");
            bb.wait();
            rt.block_on(async move { b.save_snapshot_now().await });
        });
        thread_a.join().expect("保存线程 A 正常结束");
        thread_b.join().expect("保存线程 B 正常结束");
        // 断言 3：保存后目录无 .tmp 残留
        let residue: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(residue.is_empty(), "保存后目录不得残留 .tmp：{residue:?}");
        // 断言 2：两次保存代数互异且差恰为 1（顺序无关；
        // 无互斥时两路同读 G 同写 G+1 → 主/备份同代数 → 本断言必红）
        let main_snap = read_snapshot_file_direct(&path)
            .expect("主快照必须存在且通过 checksum 校验（文件完整可解析）");
        let prev_path = PathBuf::from(format!("{}.prev", path.display()));
        let prev_snap =
            read_snapshot_file_direct(&prev_path).expect("上一份快照轮转为备份且完整可解析");
        assert_ne!(
            main_snap.generation, prev_snap.generation,
            "两次并发保存的代数必须互异（generation 读-改-写丢失 → 两路同代数）"
        );
        assert_eq!(
            main_snap.generation.max(prev_snap.generation)
                - main_snap.generation.min(prev_snap.generation),
            1,
            "两次保存代数差恰为 1（顺序无关）"
        );
        // 断言 1：主快照经 StateSnapshot::valid() 通过（直读已校验），
        // 内存代数与文件代数一致（取两者较大者）
        assert_eq!(
            state.snapshot_generation(),
            main_snap.generation.max(prev_snap.generation),
            "内存代数与文件代数一致（较大者）"
        );
        assert!(
            state.snapshot_last_error().is_none(),
            "互斥下并发保存不得产生错误（无轮转 rename 碰撞）"
        );
    }
    // R4 修订：第二次测量（join 后）> 第一次（单调递增，顺序无关）
    let second = state.snapshot_generation();
    assert!(
        second > first,
        "R4：join 后第二次代数（{second}）> 第一次（{first}）"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// ③ run_usage 真实返回：LocalDb 路径——save_run_usage 落库 →
/// run_usage 读回 → RunUsage 全字段映射（runs 表 v5 列，T-39）
#[test]
fn run_usage_returns_persisted_stats_from_local_db() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 0)
        .unwrap();
    let stats = cache_stats(Some(61_000), 12_000);
    db.save_run_usage("r1", stats).unwrap();

    let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));
    let usage = state.run_usage("r1").expect("已落库 usage 必须返回");
    assert_eq!(usage.prompt_tokens, 10_000);
    assert_eq!(usage.completion_tokens, 100);
    assert_eq!(usage.sample_count, 1);
    assert_eq!(usage.cache_read_tokens, Some(9_000));
    assert_eq!(usage.cache_write_tokens, Some(500));
    assert_eq!(usage.cache_miss_tokens, Some(500));
    // hit_ratio 按 C9 重算：read / (miss + read + write)
    assert_eq!(usage.hit_ratio, Some(9_000.0 / 10_000.0));
    assert_eq!(usage.write_ratio, Some(500.0 / 10_000.0));
    assert_eq!(usage.missed_tokens, Some(12_000));
    assert_eq!(usage.warm_until_ms, Some(61_000));
    // 不存在的 run → None（前端回退估算）
    assert!(state.run_usage("missing").is_none());
}

/// ③ 兜底：store 非 LocalDb（InMemoryStore 测试替身）→ run_usage
/// None（local_db 下转失败路径，usage 查询回退前端估算）
#[test]
fn run_usage_falls_back_none_without_local_db() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    assert!(state.local_db().is_none(), "非 LocalDb store 不得下转");
    assert!(state.run_usage("r1").is_none());
}

/// 验收（30 方案 P3）：steering_queue 访问器与引擎队列同一 Arc 实例
/// （消费器与定时器/Cron 共用同一队列，杜绝双实例分叉）。
#[test]
fn core_state_steering_queue_accessor_same_instance() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let via_state = state.steering_queue();
    let via_engine = state.engine.timer_steering_queue();
    assert!(
        Arc::ptr_eq(&via_state, &via_engine),
        "访问器与引擎 timer_steering_queue 必须同一 Arc 实例"
    );
}

/// 验收（30 方案 P3）：task_events 消费器装配可达（CoreRunState::new
/// 内与 pending_queue 同实例构造，无独立队列分叉）。
#[test]
fn core_state_task_events_consumer_shares_queue() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let consumer = state.task_events();
    // 经消费器终态入队 → 访问器侧可见（同一共享队列的字段级断言）
    consumer.on_task_event(&AgentEvent::TaskStarted {
        session_id: String::new(),
        task_id: "t-a".into(),
        command: "cargo build".into(),
        cwd: "/ws".into(),
        owner_run_id: "run-main".into(),
        is_daemon: false,
    });
    consumer.on_task_event(&AgentEvent::TaskCompleted {
        session_id: String::new(),
        task_id: "t-a".into(),
        exit_code: 0,
        duration_ms: 1200,
        line_count: 99,
    });
    let queue = state.steering_queue();
    let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(queue.len(), 1, "消费器条目落入共享队列");
    assert_eq!(queue.peek().unwrap().text, "任务 t-a 已完成，退出码 0");
}

/// 验收（30 方案 P7）：cron_has_enabled 在 CoreRunState::new 内装配——
/// 真实引擎路径下判定器非 None（SchedulerRegistry 非空封装
/// has_active；与 timer_has_active 先例对称，A5-H02 生产缺失消除）
#[test]
fn cron_has_enabled_assembled_in_new() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let check = state
        .cron_has_enabled
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    assert!(
        check.is_some(),
        "CoreRunState::new 必须装配 cron_has_enabled 判定器（真实引擎路径）"
    );
    // scheduler_registry 访问器同步可达（P6 装配面数据源）
    assert!(
        state.scheduler_registry().is_some(),
        "引擎装配后 scheduler_registry 应为 Some"
    );
}

/// 验收（30 方案 P6 装配轮）：WorkflowCommandState 注入共享队列后，
/// 命令层触发条目真实落入 CoreRunState 的 pending_queue——同实例
/// 的行为级证明（main.rs 装配行：WorkflowCommandState::new(db,
/// core_state.steering_queue())；消除 A5-H01a 队列双实例）
#[tokio::test]
async fn main_assembly_shared_queue_single_instance() {
    let db = LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&subagent_test_session_entry("s1"))
        .expect("会话条目");
    let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));
    // main.rs 装配轮同序构造
    let workflow_state =
        crate::workflow_commands::WorkflowCommandState::new(db, state.steering_queue());
    let view = workflow_state
        .backend()
        .create(
            "装配检查".to_string(),
            "检查仓库".to_string(),
            crate::workflow_commands::WorkflowScheduleWire::Manual,
            None,
            None,
            true,
        )
        .await
        .expect("创建应成功");
    workflow_state
        .backend()
        .trigger(&view.id)
        .expect("触发应成功");
    // 条目落入引擎共享队列（命令层注入 sink 与 CoreRunState 同一实例）
    let queue = state.steering_queue();
    let queue = queue.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(queue.len(), 1, "命令层触发必须落入引擎共享队列");
    let entry = queue.peek().expect("队列必有条目");
    assert!(entry.is_steering, "workflow 条目为 steering 受保护位");
    assert!(
        entry.text.contains("检查仓库"),
        "条目含 workflow prompt 触发模板：{}",
        entry.text
    );
    assert_eq!(
        entry.group_id.as_deref(),
        Some(format!("cron-{}", view.id).as_str()),
        "group_id = cron-<id>"
    );
}

/// ② 收口落库：write_back_cache_stats 经 LocalDb 写回 runs 表 v5 列
/// （save_run_usage 幂等 UPDATE），读回整型一致
#[tokio::test]
async fn write_back_cache_stats_persists_run_usage_to_local_db() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 0)
        .unwrap();
    let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));

    let stats = cache_stats(Some(61_000), 12_000);
    write_back_cache_stats(&state, "s1", "r1", stats).await;

    let read_back = db
        .get_run_usage("r1")
        .expect("读回不应失败")
        .expect("收口必须落库");
    assert_eq!(read_back, stats);
    // 收口不 panic 且落库失败路径不中断（本场景无失败，仅验证无害）
    write_back_cache_stats(&state, "s1", "r1", stats).await;
}

/// ② 兜底：store 非 LocalDb（InMemoryStore）→ 落库跳过（无 SQLite
/// 连接），收口流程不 panic、不中断
#[tokio::test]
async fn write_back_cache_stats_skips_save_without_local_db() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    write_back_cache_stats(&state, "s1", "r1", cache_stats(None, 0)).await;
}

/// ④ EngineHandle 会话缓存状态写读面（跨 CoreRunState 可达）：
/// update_cache_session → cache_session 读回——write_back_cache_stats
/// 的 update 分支数据源契约（配置分支依赖 provider 生效配置，
/// 测试环境未就绪 → 装配侧由 engine.rs 测试覆盖）
#[test]
fn engine_cache_session_roundtrip_through_core_state() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let stats = cache_stats(Some(61_000), 0);
    state
        .engine
        .update_cache_session("s1", &stats, "deepseek-v4-flash");
    let session = state.engine.cache_session("s1");
    assert_eq!(session.last_stats, Some(stats));
    assert_eq!(session.last_model.as_deref(), Some("deepseek-v4-flash"));
    // 未写过的会话 → 缺省状态（默认值）
    let untouched = state.engine.cache_session("other");
    assert!(untouched.last_stats.is_none());
    assert!(untouched.last_model.is_none());
}

// ── I2-S5：trash 命令（误删恢复入口）────────────────────────

static TRASH_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 测试用临时目录（独立命名，drop 自动清理）
struct TrashTempDir(PathBuf);

impl TrashTempDir {
    fn new(prefix: &str) -> Self {
        let seq = TRASH_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "conex_trash_cmd_{prefix}_{}_{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &PathBuf {
        &self.0
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let p = self.0.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&p, content).unwrap();
        p
    }
}

impl Drop for TrashTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// trash_list / trash_restore 往返：条目可见、恢复后字节一致、登记清除
#[test]
fn trash_commands_list_restore_roundtrip() {
    let ws = TrashTempDir::new("rt");
    let file = ws.write("a.txt", "hello trash command");
    let trash = TrashTempDir::new("root");

    // 种入条目（删除接口与恢复命令同根）
    let entry = conex_fs::trash::TrashService::new(trash.path())
        .trash_file(&file, true)
        .unwrap();

    let listed = trash_list_at(trash.path()).unwrap();
    assert_eq!(listed.entries.len(), 1);
    assert_eq!(listed.entries[0].id, entry.id);
    assert_eq!(listed.entries[0].original_path, file);
    assert_eq!(listed.entries[0].size, 19);
    assert!(listed.entries[0].checksum.is_some(), "backup=true 写校验和");
    assert!(
        listed.trash_root.contains("root"),
        "trash_root: {}",
        listed.trash_root
    );

    let restored = trash_restore_at(trash.path(), &entry.id).unwrap();
    assert!(restored.ok);
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "hello trash command"
    );
    assert!(
        trash_list_at(trash.path()).unwrap().entries.is_empty(),
        "恢复成功后登记应清除"
    );
}

/// trash_purge：彻底清除后条目消失、恢复报 NotFound
#[test]
fn trash_purge_removes_entry_and_restore_fails() {
    let ws = TrashTempDir::new("purge");
    let file = ws.write("doomed.txt", "gone");
    let trash = TrashTempDir::new("root");
    let service = conex_fs::trash::TrashService::new(trash.path());
    let entry = service.trash_file(&file, false).unwrap();

    let purged = trash_purge_at(trash.path(), &entry.id).unwrap();
    assert!(purged.ok);
    assert_eq!(purged.entry_id, entry.id);
    assert!(trash_list_at(trash.path()).unwrap().entries.is_empty());

    let err = trash_restore_at(trash.path(), &entry.id).unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "err: {err}");
}

/// 非法 entry_id → InvalidInput；不存在的条目 → NotFound（防路径穿越）
#[test]
fn trash_restore_rejects_invalid_and_missing_entry_ids() {
    let trash = TrashTempDir::new("root");

    let err = trash_restore_at(trash.path(), "../../evil").unwrap_err();
    assert!(matches!(err, CoreError::InvalidInput(_)), "err: {err}");
    let err = trash_restore_at(trash.path(), "a/b").unwrap_err();
    assert!(matches!(err, CoreError::InvalidInput(_)), "err: {err}");
    let err = trash_restore_at(trash.path(), "nope").unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "err: {err}");
    let err = trash_purge_at(trash.path(), "../evil").unwrap_err();
    assert!(matches!(err, CoreError::InvalidInput(_)), "err: {err}");
}

/// 未注入回收站根 → 兜底活动工作区 `.crish-trash`（与删除工具一致）
#[test]
fn trash_root_falls_back_to_workspace_dot_crish_trash() {
    let ws = TrashTempDir::new("ws");
    let file = ws.write("notes.txt", "workspace fallback");

    // 兜底根 = <工作区>/.crish-trash（resolve_guard 路径由 workspace 域测试覆盖，
    // 此处验证兜底目录名的登记/列出语义与删除工具一致）
    let root = ws.path().join(DEFAULT_TRASH_DIR_NAME);
    let service = conex_fs::trash::TrashService::new(&root);
    let entry = service.trash_file(&file, true).unwrap();

    let listed = trash_list_at(&root).unwrap();
    assert_eq!(listed.entries.len(), 1);
    assert_eq!(listed.entries[0].id, entry.id);
    assert!(listed.trash_root.ends_with(".crish-trash"));
}

// ── I2-S8：回收站恢复/清除动作审计发射 ──

/// 记录型发射器（核心事件桥测试替身；Emitter trait 公开可注入）
#[derive(Default)]
struct RecordingEmitter(std::sync::Mutex<Vec<String>>);

impl crate::core_event_bridge::Emitter for RecordingEmitter {
    fn emit(&self, _channel: &str, payload: &str) {
        self.0.lock().unwrap().push(payload.to_string());
    }
}

fn recording_bridge() -> (EventBridge, Arc<RecordingEmitter>) {
    let emitter = Arc::new(RecordingEmitter::default());
    let bridge = EventBridge::new(
        "workbench-run-event",
        Arc::clone(&emitter) as Arc<dyn crate::core_event_bridge::Emitter>,
    );
    (bridge, emitter)
}

/// trash_restore / trash_purge 动作带会话上下文时，经事件桥发射
/// security-audit 信封（decision=restored/purged，runId 缺省前端放行）
#[test]
fn emit_trash_audit_sends_security_audit_envelope() {
    let (bridge, emitter) = recording_bridge();

    let report = emit_trash_audit(
        &bridge,
        Some("s1"),
        SecurityAuditOperation::TrashRestore,
        SecurityAuditDecision::Restored,
        "a.txt",
        5,
    );
    assert_eq!(
        report,
        EmitReport {
            emitted: 1,
            buffered: 0,
            dropped: 0
        }
    );

    // 先取回载荷再断言（Mutex 不可重入：guard 存活期间不得再发射）
    let payloads = emitter.0.lock().unwrap().clone();
    assert_eq!(payloads.len(), 1, "恢复动作应发射 1 条审计信封");
    let v: serde_json::Value = serde_json::from_str(&payloads[0]).expect("载荷为合法 JSON");
    assert_eq!(v["type"], "security-audit");
    assert_eq!(v["sessionId"], "s1");
    assert_eq!(v["operation"], "trash-restore");
    assert_eq!(v["decision"], "restored");
    assert_eq!(v["targets"][0], "a.txt");
    assert_eq!(v["impact"]["fileCount"], 1);
    assert_eq!(v["impact"]["totalSizeBytes"], 5);
    // runId/sequence 缺省：用户级引擎命令不属 run 上下文（前端放行不过滤）
    assert!(v.get("runId").is_none(), "runId 应缺省");
    assert!(v.get("sequence").is_none(), "sequence 应缺省");
    assert_eq!(v["schemaVersion"], 1);

    let report_purge = emit_trash_audit(
        &bridge,
        Some("s1"),
        SecurityAuditOperation::TrashPurge,
        SecurityAuditDecision::Purged,
        "b.txt",
        8,
    );
    assert_eq!(report_purge.emitted, 1);
    let payloads2 = emitter.0.lock().unwrap().clone();
    let v2: serde_json::Value = serde_json::from_str(&payloads2[1]).expect("载荷为合法 JSON");
    assert_eq!(v2["operation"], "trash-purge");
    assert_eq!(v2["decision"], "purged");
}

/// 未携带会话上下文：跳过事件发射（wire 零条），仅落审计日志
#[test]
fn emit_trash_audit_without_session_skips_wire_out() {
    let (bridge, emitter) = recording_bridge();

    let report = emit_trash_audit(
        &bridge,
        None,
        SecurityAuditOperation::TrashRestore,
        SecurityAuditDecision::Restored,
        "a.txt",
        5,
    );
    assert_eq!(report, EmitReport::default(), "无会话上下文不发射");
    assert!(emitter.0.lock().unwrap().is_empty(), "事件桥不得收到载荷");
}

/// 审计信封中的事件体可被 AgentEvent 契约反序列化（事件类型注册表一致）
#[test]
fn emit_trash_audit_payload_parses_as_security_audit() {
    let (bridge, emitter) = recording_bridge();
    emit_trash_audit(
        &bridge,
        Some("s1"),
        SecurityAuditOperation::TrashPurge,
        SecurityAuditDecision::Purged,
        "c.txt",
        12,
    );
    let payload = &emitter.0.lock().unwrap()[0];
    let envelope: AgentEventEnvelope = serde_json::from_str(payload).unwrap();
    assert_eq!(envelope.type_name(), "security-audit");
    let AgentEvent::SecurityAudit {
        decision, impact, ..
    } = envelope.event
    else {
        panic!("应为 security-audit 事件");
    };
    assert_eq!(decision, SecurityAuditDecision::Purged);
    assert_eq!(impact.file_count, 1);
    assert_eq!(impact.total_size_bytes, 12);
}

// ── T-AB-19：run 生命周期整合（owner_run_id / 守护进程 / L0-L3）────

use crate::background::BackgroundTaskRegistry;
use std::process::Stdio;
use tokio::process::Child;

/// 测试注册表序号：每个测试独占日志根（并行测试互不污染）
static BG_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// L3 配置项测试串行锁：环境变量为进程级，「默认不联动」与「开启
/// 联动」两组测试共享锁，避免并行运行时互相污染环境变量
static L3_CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// 测试用长运行命令（adopt 后保持 Running；20s 窗口足够测试收尾）
fn long_command() -> &'static str {
    if cfg!(windows) {
        "Start-Sleep -Seconds 20"
    } else {
        "sleep 20"
    }
}

/// 测试用持续输出命令（每 100ms 一行，约 4s；日志增长断言用）
fn output_command() -> &'static str {
    if cfg!(windows) {
        "1..40 | ForEach-Object { Write-Output ('line ' + $_); Start-Sleep -Milliseconds 100 }"
    } else {
        "i=0; while [ $i -lt 40 ]; do echo line $i; i=$((i+1)); sleep 0.1; done"
    }
}

/// 测试注册表（独立日志根；不启动归档循环，30 分钟保留足够）
fn bg_test_registry() -> Arc<BackgroundTaskRegistry> {
    let seq = BG_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "crish-bg-run-lifecycle-{}-{seq}",
        std::process::id()
    ));
    BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(30 * 60))
}

/// 测试命令构造（PowerShell / bash 平台分支；kill_on_drop=false +
/// 双管道，对齐 T-AB-02 后台托管契约）
fn build_test_command(command: &str) -> tokio::process::Command {
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-Command", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", command]);
        c
    };
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    cmd
}

/// 真实 spawn 测试子进程（工具执行链 spawn 语义）
fn spawn_test_child(command: &str) -> Child {
    let mut cmd = build_test_command(command);
    cmd.stdin(Stdio::null());
    cmd.spawn().expect("spawn test child")
}

/// adopt 请求构造（owner_run_id 恒 None——模拟工具执行链；注入由
/// RunAwareBackgroundManager 装饰器完成）
fn adopt_request(child: Child, command: &str, is_daemon: bool) -> BackgroundAdoptRequest {
    BackgroundAdoptRequest {
        child,
        command: command.to_string(),
        cwd: PathBuf::from("."),
        is_daemon,
        resource_monitor: false,
        owner_run_id: None,
    }
}

#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}")])
        .output()
        .expect("tasklist must run");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

#[cfg(not(windows))]
fn pid_is_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 测试用 CoreRunState（注入包装后的真实注册表；独立快照与事件桥）
fn core_state_with_background(
    store: Arc<dyn Store>,
    registry: Arc<BackgroundTaskRegistry>,
) -> Arc<CoreRunState> {
    let (bridge, _emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_core_state_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    Arc::new(CoreRunState::new(
        store,
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        Some(Arc::clone(&registry) as Arc<dyn BackgroundTaskManager>),
    ))
}

/// 便捷构造「状态 + 注册表」对（InMemoryStore 测试替身）
fn state_with_background() -> (Arc<CoreRunState>, Arc<BackgroundTaskRegistry>) {
    let registry = bg_test_registry();
    let state = core_state_with_background(Arc::new(InMemoryStore::new()), Arc::clone(&registry));
    (state, registry)
}

/// 组装活动 run（测试直驱 drive_run_loop 的收口路径；装配面与
/// core_run_task 对齐：EventQueue / 缓冲桥 / 审批门 / 逃逸监视 None）
async fn build_active_run(state: &CoreRunState, session_id: &str, run_id: &str) -> Arc<ActiveRun> {
    let handle = Arc::new(tokio::sync::Mutex::new(
        state
            .run_manager
            .start_run(session_id, run_id)
            .await
            .expect("start_run"),
    ));
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        0,
        None,
    )));
    let bridge = Arc::new(BufferedRunEventBridge::new(
        state.bridge.clone(),
        run_id.to_string(),
    ));
    let broadcast_bridge = Arc::clone(&bridge);
    let broadcast_run_id = run_id.to_string();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    let approval = Arc::new(ApprovalGateImpl::new(
        run_id.to_string(),
        session_id.to_string(),
        None,
        broadcast,
        Arc::clone(&handle),
        state.store.clone(),
        None,
    ));
    Arc::new(ActiveRun {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        handle,
        queue,
        control_bus: Arc::new(Mutex::new(ControlBus::new())),
        abort_signal: AbortSignal::new(),
        approval,
        bridge,
        delta_sink_active: true,
        driver: Mutex::new(None),
        user_touched: AtomicBool::new(false),
        // T-D-13：测试驱动路径的子代理配置缺省 None（普通 run 语义）
        subagent: None,
        // L4（F12）：测试驱动路径未装配审计落库 worker（收口跳过）
        audit_persist: Mutex::new(None),
    })
}

/// EV-08（G-20）：阶梯 1 重派成功 → recovery-retry-attempted 事件带
/// from_run_id/new_run_id 结构化关联（重试无事件 + 无关联缺陷闭合）。
///
/// 直接驱动 [execute_subagent_recovery]（AutoRetry 计划 + 记录型
/// spawner——经 subagent_state_with_providers 装配真实引擎 + LocalDb，
/// 重派新 run 真实 spawn 成功路径；延迟注入 ZERO 跳过真实退避 sleep）。
#[tokio::test]
async fn ladder1_respawn_emits_retry_attempted_event() {
    let main = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("占位。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let sub = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("重派子代理占位。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _main, _sub, emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;

    // 原 run 失败上下文（瞬态网络错误，预算内 → AutoRetry）
    let session_id = "sess-main";
    let cfg = crate::subagent_spawner::SubagentRunConfig {
        subagent_id: "sub-l1".to_string(),
        subagent_run_id: "run-l1-orig".to_string(),
        parent_session_id: session_id.to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1_000,
    };
    let coord = state
        .coordinator_for(session_id)
        .expect("LocalDb 路径协调器可用");
    let ctx = RunFailureContext {
        subagent_id: "sub-l1".to_string(),
        subagent_run_id: "run-l1-orig".to_string(),
        task: "任务".to_string(),
        error_kind: ProviderErrorKind::Network,
        retries: 0,
        retry_elapsed_ms: 0,
        produced_content: false,
        from_leaf_id: None,
        started_at_ms: 1_000,
        inject_bytes: 0,
        window_bytes: 0,
    };
    let plan = RecoveryPlan::AutoRetry {
        delay: Duration::ZERO,
        ctx,
        coord,
    };
    let active = build_active_run(&state, session_id, "run-l1-orig").await;
    state
        .execute_subagent_recovery(session_id, &cfg, plan, &active)
        .await;

    // 事件断言：recovery-retry-attempted 载荷含 from/new run id
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let payloads = emitter.0.lock().unwrap().clone();
        if let Some(hit) = payloads
            .iter()
            .find(|p| p.contains("recovery-retry-attempted"))
        {
            let value: serde_json::Value = serde_json::from_str(hit).expect("载荷 JSON");
            assert_eq!(value["type"], "recovery-retry-attempted");
            assert_eq!(value["sessionId"], session_id);
            assert_eq!(value["fromRunId"], "run-l1-orig", "原 run id");
            let new_run_id = value["newRunId"]
                .as_str()
                .expect("newRunId 非空")
                .to_string();
            assert_ne!(new_run_id, "run-l1-orig", "新 run id 与原 run 不同");
            assert!(value["attempt"].as_u64().is_some(), "attempt 计数存在");
            assert!(value["delayMs"].as_u64().is_some(), "delay 存在");
            assert!(value["budgetRemaining"].as_u64().is_some(), "剩余预算存在");
            // 新 run 行落库（真实 spawn 产物）
            let rows = db.load_session_agents(session_id).expect("读行");
            assert!(
                rows.iter().any(|r| r.subagent_run_id == new_run_id),
                "重派新 run 行存在：{new_run_id}"
            );
            break;
        }
        drop(payloads);
        assert!(
            tokio::time::Instant::now() < deadline,
            "recovery-retry-attempted 未在窗口内发射"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 重派的新 run 收口（真实 spawn 的异步 run；不遗留活动任务）
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
}

/// 测试生产者：返回预置收口结果（驱动 drive_run_loop 一次终态）
struct TestProducer {
    outcome: RunOutcome,
    /// 共享 produce 调用计数（T-CF-11 续 run 断言；续 run 链各轮共享）
    calls: Arc<AtomicU64>,
}

impl TestProducer {
    /// 新建生产者（独立计数）
    fn new(outcome: RunOutcome) -> Self {
        Self::with_calls(outcome, Arc::new(AtomicU64::new(0)))
    }

    /// 新建生产者（共享计数——断言跨轮 produce 总调用次数）
    fn with_calls(outcome: RunOutcome, calls: Arc<AtomicU64>) -> Self {
        Self { outcome, calls }
    }
}

#[async_trait::async_trait]
impl RunProducer for TestProducer {
    async fn produce(&mut self) -> RunOutcome {
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::mem::replace(&mut self.outcome, canned_outcome())
    }
}

/// 预置收口结果（Stop 正常收口；事件流为空，仅 run-terminal）
fn canned_outcome() -> RunOutcome {
    RunOutcome {
        reason: AgentEndReason::Stop,
        error: None,
        // D1 §3.4 兼容：正常 stop 收场 provider_error=None（D7 迁移
        // 缺口收口：session-loop 新增必填字段后本构造点补齐）
        provider_error: None,
        diagnostic: None,
        messages: vec![Arc::new(amsg(
            "u1",
            AgentMessageRole::User,
            vec![text_block("run 终态测试")],
        ))],
        events: Vec::new(),
        turn_index: 0,
        tool_call_count: 0,
        steering_count: 0,
        cache_stats: None,
    }
}

// ── L3（R-CF3）：事件收口 mark_wakeup 生产接线 ──────────────

/// 事件收口接线：drive_run_loop 事件 emit 循环推进 last_wakeup——
/// run 事件到达后 watchdog 失联判定数据源不再恒 None（防误报
/// "无唤醒"；watchdog 侧判定逻辑由 watchdog.rs 单测覆盖）
#[tokio::test]
async fn drive_run_loop_marks_wakeup_on_events() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    assert!(
        state.engine.last_wakeup().last_wakeup_ms().is_none(),
        "接线断言前：从未有事件到达（None）"
    );
    let active = build_active_run(&state, "s1", "run-l3-1").await;
    drive_run_loop(
        Arc::clone(&state),
        Arc::clone(&active),
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;
    assert!(
        state.engine.last_wakeup().last_wakeup_ms().is_some(),
        "run 事件到达后 last_wakeup 应更新（watchdog 不再误报无唤醒）"
    );
}

/// 子代理终态收口接线：on_subagent_run_terminal 推进 last_wakeup——
/// 等待期间的关键事件源（长等待中不误报"无唤醒"）
#[tokio::test]
async fn subagent_terminal_marks_wakeup() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    let cfg = crate::subagent_spawner::SubagentRunConfig {
        subagent_id: "sa-1".to_string(),
        subagent_run_id: "run-sa-1".to_string(),
        parent_session_id: "s1".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1_000,
    };
    state
        .on_subagent_run_terminal(&cfg, RunStatus::Completed)
        .await;
    assert!(
        state.engine.last_wakeup().last_wakeup_ms().is_some(),
        "子代理终态事件到达后 last_wakeup 应更新"
    );
}

/// 轮询至任务终态（窗口内未到则 panic）
async fn wait_task_terminal(registry: &BackgroundTaskRegistry, task_id: &str, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let status = registry.status(task_id).await.expect("status");
        if status.status != TaskState::Running {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "任务 {task_id} 未在窗口内进入终态"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// T-AB-19 验收：工具执行链 adopt 后 `owner_run_id` 等于当前 runId——
/// 装饰器在请求进入注册表前注入「当前 run 上下文」；无上下文恒 None
/// （现状兜底）；显式携带透传不改写；run 终态清除上下文后回到 None。
#[tokio::test]
async fn adopt_records_owner_run() {
    let (state, registry) = state_with_background();

    // run 上下文未设置 → 恒 None（未注入路径兜底）
    let child = spawn_test_child(long_command());
    let r0 = state
        .background
        .adopt(adopt_request(child, "no-run", false))
        .await
        .expect("adopt");
    let listed = registry.list(true).await.expect("list");
    let i0 = listed.iter().find(|i| i.task_id == r0.task_id).unwrap();
    assert_eq!(i0.owner_run_id, None, "无 run 上下文不得注入");

    // 工具执行链语义：run 开始登记上下文 → adopt（owner_run_id 恒
    // None）→ 注入当前 runId
    state.background.set_current_run("run-owner-1");
    let child = spawn_test_child(long_command());
    let r1 = state
        .background
        .adopt(adopt_request(child, "in-run", false))
        .await
        .expect("adopt");
    let listed = registry.list(true).await.expect("list");
    let i1 = listed.iter().find(|i| i.task_id == r1.task_id).unwrap();
    assert_eq!(
        i1.owner_run_id.as_deref(),
        Some("run-owner-1"),
        "adopt 后 owner_run_id 必须等于当前 runId"
    );

    // 显式携带（非 None）→ 透传不改写
    let child = spawn_test_child(long_command());
    let mut req = adopt_request(child, "explicit", false);
    req.owner_run_id = Some("run-other".to_string());
    let r2 = state.background.adopt(req).await.expect("adopt");
    let listed = registry.list(true).await.expect("list");
    let i2 = listed.iter().find(|i| i.task_id == r2.task_id).unwrap();
    assert_eq!(
        i2.owner_run_id.as_deref(),
        Some("run-other"),
        "显式携带不得被覆盖"
    );

    // run 终态（收口路径清除上下文）→ 后续 adopt 回到 None
    state.background.clear_current_run("run-owner-1");
    assert_eq!(state.background.current_run(), None, "run 终态应释放上下文");
    let child = spawn_test_child(long_command());
    let r3 = state
        .background
        .adopt(adopt_request(child, "after-run", false))
        .await
        .expect("adopt");
    let listed = registry.list(true).await.expect("list");
    let i3 = listed.iter().find(|i| i.task_id == r3.task_id).unwrap();
    assert_eq!(i3.owner_run_id, None, "run 终态后 adopt 不得注入旧 runId");

    // 清理
    for r in [r0, r1, r2, r3] {
        let _ = registry.kill(&r.task_id).await;
    }
}

/// T-AB-19 验收：守护进程任务（is_daemon=true）在 run 终态后存活
/// 且日志持续累积（run 终态 → 任务存活 → 日志增长，端到端收口路径）
#[tokio::test]
async fn run_end_daemon_survives() {
    let (state, registry) = state_with_background();
    state.background.set_current_run("run-daemon-1");
    let child = spawn_test_child(output_command());
    let pid = child.id().expect("spawned pid");
    let adopted = state
        .background
        .adopt(adopt_request(child, "run-daemon", true))
        .await
        .expect("adopt");

    // 等首行输出（转发器就位，日志已开始累积）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let status = registry.status(&adopted.task_id).await.expect("status");
        if status.line_count > 0 {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "守护任务迟迟无输出");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // 驱动 run 终态（真实 drive_run_loop 收口路径）
    let active = build_active_run(&state, "s1", "run-daemon-1").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-daemon-1".to_string(), Arc::clone(&active));
    drive_run_loop(
        Arc::clone(&state),
        Arc::clone(&active),
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;

    // run 终态后：任务存活（Running、pid 存活）+ 日志持续累积
    let s1 = registry.status(&adopted.task_id).await.expect("status");
    assert_eq!(
        s1.status,
        TaskState::Running,
        "守护任务在 run 终态后必须存活"
    );
    assert!(pid_is_alive(pid), "守护任务进程必须存活");
    let lines_before = s1.line_count;
    // 日志增长断言条件化（F-009 flaky 根因：固定 sleep(1200) 在负载
    // 下 writer 转发可能延迟 → 改轮询观测状态，8s 上限充足）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let s2 = loop {
        let s = registry.status(&adopted.task_id).await.expect("status");
        if s.line_count > lines_before {
            break s;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run 终态后日志迟迟不累积"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(
        s2.line_count > lines_before,
        "run 终态后日志必须持续累积：{lines_before} -> {}",
        s2.line_count
    );
    // 收口路径释放了「当前 run」上下文（下一 run 可复用注入槽）
    assert_eq!(state.background.current_run(), None);

    // 清理
    let _ = registry.kill(&adopted.task_id).await;
}

/// T-AB-19 验收：普通任务（is_daemon=false）在 run 终态后不被级联杀
/// （pid 存活；registry 生命周期独立于 run——T-AB-12 契约显式锚定）
#[tokio::test]
async fn run_end_normal_task_survives_no_cascade() {
    let (state, registry) = state_with_background();
    state.background.set_current_run("run-normal-1");
    let child = spawn_test_child(long_command());
    let pid = child.id().expect("spawned pid");
    let adopted = state
        .background
        .adopt(adopt_request(child, "run-normal-task", false))
        .await
        .expect("adopt");

    // 驱动 run 终态
    let active = build_active_run(&state, "s1", "run-normal-1").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-normal-1".to_string(), Arc::clone(&active));
    drive_run_loop(
        Arc::clone(&state),
        Arc::clone(&active),
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;

    // run 终态后：普通任务不被级联杀
    assert!(
        pid_is_alive(pid),
        "普通任务不得被 run 终态级联杀（pid 存活）"
    );
    let status = registry.status(&adopted.task_id).await.expect("status");
    assert_eq!(status.status, TaskState::Running, "任务状态不得被改写");
    assert_eq!(state.background.current_run(), None);

    // 清理
    let _ = registry.kill(&adopted.task_id).await;
}

/// T-AB-19 验收：L3 force 取消后任务仍存活（默认不联动——职责单一，
/// 避免误杀，对齐方案 REQ 4.3）
#[tokio::test]
async fn l3_force_cancel_keeps_tasks() {
    // 环境变量为进程级：与开启联动测试共用串行锁（默认断言不受污染）
    let _guard = L3_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::remove_var("CONEX_RUN_CONTROL_L3_TASK_CANCEL");

    let (state, registry) = state_with_background();
    state.background.set_current_run("run-l3-default");
    let child = spawn_test_child(long_command());
    let pid = child.id().expect("spawned pid");
    let adopted = state
        .background
        .adopt(adopt_request(child, "l3-normal", false))
        .await
        .expect("adopt");
    let active = build_active_run(&state, "s1", "run-l3-default").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-l3-default".to_string(), Arc::clone(&active));

    run_control_impl(
        &state,
        "run-l3-default",
        "force_cancel",
        None,
        Some("测试".to_string()),
        None,
    )
    .await
    .expect("force_cancel");

    // 默认不联动：任务存活（未终止、仍在注册表）
    let listed = registry.list(true).await.expect("list");
    let info = listed
        .iter()
        .find(|i| i.task_id == adopted.task_id)
        .expect("任务仍在注册表");
    assert_eq!(info.status, TaskState::Running, "L3 默认不得触碰任务");
    assert!(pid_is_alive(pid), "任务进程必须存活（默认不联动）");

    // 清理
    let _ = registry.kill(&adopted.task_id).await;
}

/// T-AB-19 可选接线（配置项开启）：L3 force 对当前 run 的普通任务
/// （is_daemon=false）发起优雅终止，守护任务不触碰——默认关闭，本
/// 测试显式开启环境变量验证联动语义
#[tokio::test]
async fn l3_force_cancel_kills_normal_tasks_when_enabled() {
    let _guard = L3_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("CONEX_RUN_CONTROL_L3_TASK_CANCEL", "1");

    let (state, registry) = state_with_background();
    state.background.set_current_run("run-l3-on");
    // 普通任务（联动目标：将被优雅终止）
    let child = spawn_test_child(long_command());
    let normal = state
        .background
        .adopt(adopt_request(child, "l3-normal-kill", false))
        .await
        .expect("adopt");
    // 守护任务（联动豁免：不触碰）
    let child = spawn_test_child(long_command());
    let daemon_pid = child.id().expect("spawned pid");
    let daemon = state
        .background
        .adopt(adopt_request(child, "l3-daemon-keep", true))
        .await
        .expect("adopt");
    let active = build_active_run(&state, "s1", "run-l3-on").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-l3-on".to_string(), Arc::clone(&active));

    run_control_impl(
        &state,
        "run-l3-on",
        "force_cancel",
        None,
        Some("测试".to_string()),
        None,
    )
    .await
    .expect("force_cancel");

    // 普通任务进入终态（两阶段 kill），守护任务存活
    wait_task_terminal(&registry, &normal.task_id, Duration::from_secs(30)).await;
    let normal_status = registry.status(&normal.task_id).await.expect("status");
    assert_eq!(
        normal_status.status,
        TaskState::Killed,
        "普通任务应被优雅终止（Killed）：{:?}",
        normal_status.status
    );
    let daemon_status = registry.status(&daemon.task_id).await.expect("status");
    assert_eq!(
        daemon_status.status,
        TaskState::Running,
        "守护任务不得被 L3 联动触碰"
    );
    assert!(pid_is_alive(daemon_pid), "守护任务进程必须存活");

    // 清理
    let _ = registry.kill(&daemon.task_id).await;
}

/// T-AB-19 验收：core_get_status 含任务汇总字段——活跃任务数 /
/// 守护进程数 / 最近终态（数据源 = CoreRunState 汇总访问器；wire
/// 形状 camelCase 由 core_query_commands 单测锚定）
#[tokio::test]
async fn get_status_reports_tasks() {
    let (state, registry) = state_with_background();
    state.background.set_current_run("run-status-1");

    // 守护任务 + 普通任务（活跃）
    let child = spawn_test_child(long_command());
    let daemon = state
        .background
        .adopt(adopt_request(child, "status-daemon", true))
        .await
        .expect("adopt");
    let child = spawn_test_child(long_command());
    let normal = state
        .background
        .adopt(adopt_request(child, "status-normal", false))
        .await
        .expect("adopt");
    // 终态任务（自然退出）
    let child = spawn_test_child("exit 0");
    let finished = state
        .background
        .adopt(adopt_request(child, "status-finished", false))
        .await
        .expect("adopt");
    wait_task_terminal(&registry, &finished.task_id, Duration::from_secs(30)).await;

    let summary = state.background_tasks_summary().await;
    assert_eq!(summary.active_count, 2, "活跃任务数 = 守护 + 普通");
    assert_eq!(summary.daemon_count, 1, "守护进程数 = 活跃守护任务数");
    let last = summary
        .last_finished
        .as_ref()
        .expect("有终态任务必须给出最近终态");
    assert_eq!(&last.task_id, &finished.task_id);
    assert_eq!(last.status, "completed");

    // wire 形状（camelCase，core_get_status 透出面）
    let json = serde_json::to_value(&summary).unwrap();
    assert_eq!(json["activeCount"], 2);
    assert_eq!(json["daemonCount"], 1);
    assert_eq!(json["lastFinished"]["taskId"], finished.task_id);
    assert_eq!(json["lastFinished"]["status"], "completed");

    // 清理
    for r in [daemon, normal] {
        let _ = registry.kill(&r.task_id).await;
    }
}

/// T-AB-19 会话切换契约锚定：任务属会话级（registry 生命周期独立于
/// run 与会话）——会话 A 的 run 结束并切换到会话 B 发起新 run 后，
/// 会话 A 的任务仍存活
#[tokio::test]
async fn session_switch_keeps_tasks() {
    let (state, registry) = state_with_background();

    // 会话 A：run 内 adopt 守护任务
    state.background.set_current_run("run-sess-a");
    let child = spawn_test_child(long_command());
    let pid = child.id().expect("spawned pid");
    let adopted = state
        .background
        .adopt(adopt_request(child, "sess-a-task", true))
        .await
        .expect("adopt");

    // 会话 A run 终态
    let active_a = build_active_run(&state, "sess-a", "run-sess-a").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-sess-a".to_string(), Arc::clone(&active_a));
    drive_run_loop(
        Arc::clone(&state),
        Arc::clone(&active_a),
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;

    // 会话切换：会话 B 发起新 run 并终态（注册表不被任何会话边界清理）
    state.background.set_current_run("run-sess-b");
    let active_b = build_active_run(&state, "sess-b", "run-sess-b").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-sess-b".to_string(), Arc::clone(&active_b));
    drive_run_loop(
        Arc::clone(&state),
        Arc::clone(&active_b),
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;

    // 会话 A 的任务在会话切换后仍存活
    assert!(pid_is_alive(pid), "会话切换后任务必须存活");
    let status = registry.status(&adopted.task_id).await.expect("status");
    assert_eq!(status.status, TaskState::Running);

    // 清理
    let _ = registry.kill(&adopted.task_id).await;
}

// ── T-CF-11：idle 待命续 run（G7 / REQ-C04 验收 1/2）────────────

/// 测试用续 run 拉起器替身：记录注入消息 + 用共享计数 producer 再驱动
/// 一轮（模拟「新 run 的 produce」——续 run 链；队列已转空 → 收口
/// 判定不续，链自然终止）
fn resume_launcher_probe(
    calls: Arc<AtomicU64>,
    injected: Arc<Mutex<Vec<Vec<AgentMessage>>>>,
) -> ResumeLauncher {
    let launcher: ResumeLauncher = Arc::new(move |state, session_id, mode, messages| {
        let calls = Arc::clone(&calls);
        let injected = Arc::clone(&injected);
        let state = Arc::clone(state);
        let session_id = session_id.to_string();
        // mode：续 run 类型（idle-resume 等）——替身不区分类型，忽略
        let _ = mode;
        Box::pin(async move {
            injected
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(messages);
            // 续 run 链：以新 run id 再驱动一轮（队列已清空 → 收口不再续）
            let active = build_active_run(&state, &session_id, "run-resume-1").await;
            state
                .active_runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert("run-resume-1".to_string(), Arc::clone(&active));
            drive_run_loop(
                state,
                active,
                Box::new(TestProducer::with_calls(canned_outcome(), calls)),
            )
            .await;
        })
    });
    launcher
}

/// 记录型拉起器替身（仅计数，不拉起新 run）
fn counting_launcher(counter: Arc<AtomicU64>) -> ResumeLauncher {
    let launcher: ResumeLauncher = Arc::new(move |_state, _session_id, _mode, _messages| {
        let counter = Arc::clone(&counter);
        Box::pin(async move {
            counter.fetch_add(1, Ordering::SeqCst);
        })
    });
    launcher
}

/// 验收：收口时队列有 1 条目（跨 run steering：子代理完成）→ 自动续开
/// 一轮 run——produce 再次调用 + 条目原文进入注入消息
#[tokio::test]
async fn idle_resume_run_when_queue_non_empty() {
    let (state, _registry) = state_with_background();
    // 队列条目（与引擎同实例的 PendingMessageQueue；生成侧已按 §4.8
    // 模板拼入唤醒摘要，注入即条目原文）
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering(
            "e1",
            "子代理 sa-1（分析）已完成：completed",
            1_785_456_000_000,
        ));
    let calls = Arc::new(AtomicU64::new(0));
    let injected: Arc<Mutex<Vec<Vec<AgentMessage>>>> = Arc::new(Mutex::new(Vec::new()));
    state.set_resume_launcher(Some(resume_launcher_probe(
        Arc::clone(&calls),
        Arc::clone(&injected),
    )));

    let active = build_active_run(&state, "s1", "run-1").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-1".to_string(), Arc::clone(&active));
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::with_calls(
            canned_outcome(),
            Arc::clone(&calls),
        )),
    )
    .await;

    // produce 再次调用（首轮 + 续 run 轮）
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "队列非空应收口后自动续开一轮 run"
    );
    // 条目进入注入消息（原文含摘要文本；批量聚合为单条）
    let probe = injected.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(probe.len(), 1, "应恰好拉起一次续 run");
    assert_eq!(probe[0].len(), 1, "批量注入 = 单条聚合消息（不逐条唤醒）");
    assert!(
        probe[0][0].text().contains("子代理 sa-1（分析）已完成"),
        "注入消息应含条目原文：{}",
        probe[0][0].text()
    );
    // 条目已批量转出，队列清空
    assert!(
        state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "条目批量转出后队列应清空"
    );
}

/// 验收：队列空 + 定时器表空 + Cron 表空（未接线）→ 不续 run（produce
/// 次数不增；AI 休眠待用户）
#[tokio::test]
async fn idle_no_resume_when_all_empty() {
    let (state, _registry) = state_with_background();
    let calls = Arc::new(AtomicU64::new(0));
    let launcher_calls = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&launcher_calls))));

    let active = build_active_run(&state, "s1", "run-1").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-1".to_string(), Arc::clone(&active));
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::with_calls(
            canned_outcome(),
            Arc::clone(&calls),
        )),
    )
    .await;

    assert_eq!(calls.load(Ordering::SeqCst), 1, "三源全空不得续 run");
    assert_eq!(
        launcher_calls.load(Ordering::SeqCst),
        0,
        "三源全空时续 run 拉起器不得被调用"
    );
}

/// 验收：连续 3 次续 run 均无 AI 产出 → 停止续 run（防空转风暴；
/// 第 4 次判定返回 None）；有产出后护栏清零恢复。
/// 唤醒源 = 队列条目（真实任务输入轮）——W2（02-定夺）后定时器/Cron
/// 空注入轮不计 streak（待命是正常态），护栏计数仅对真实输入轮生效
#[tokio::test]
async fn idle_resume_stops_after_consecutive_empty() {
    let (state, _registry) = state_with_background();
    let active = build_active_run(&state, "s1", "run-1").await;

    // 连续空转（无 AI 产出 + 真实队列输入）：前 3 次判定命中（续 run）
    for round in 1..=3u32 {
        state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .enqueue(SteeringInputEntry::steering(
                format!("e{round}"),
                "子代理完成",
                1000 + u64::from(round),
            ));
        let verdict = decide_idle_resume(
            &state,
            &active,
            AgentEndReason::Stop,
            false,
            &ResumeSignals::default(),
        )
        .await;
        assert!(
            verdict.is_some(),
            "第 {round} 次无产出续 run 应命中（护栏上限 3）"
        );
    }
    // 第 4 次：连续 3 次无产出 → 停止续 run
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e4", "子代理完成", 1004));
    let stopped = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        false,
        &ResumeSignals::default(),
    )
    .await;
    assert!(stopped.is_none(), "连续 3 次无产出后应停止续 run");

    // 有产出 → 计数清零，重新可续
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e5", "子代理完成", 1005));
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        true,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "有产出后护栏清零，续 run 恢复");
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e6", "子代理完成", 1006));
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        false,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "清零后空转计数从 1 重新开始");
}

/// 验收：用户取消路径不触发续 run（force_cancel → abort_signal +
/// reason=Aborted；队列即使非空也不续）
#[tokio::test]
async fn idle_resume_not_on_user_cancel() {
    let (state, _registry) = state_with_background();
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e1", "子代理完成", 1000));
    let launcher_calls = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&launcher_calls))));

    let active = build_active_run(&state, "s1", "run-1").await;
    // force_cancel 语义（run_control_impl L3 路径）：abort_signal 触发
    active.abort_signal.abort();
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-1".to_string(), Arc::clone(&active));
    // 取消后的收口 outcome：reason=Aborted（producer 按 abort 收场）
    let cancelled = RunOutcome {
        reason: AgentEndReason::Aborted,
        ..canned_outcome()
    };
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(cancelled)),
    )
    .await;

    assert_eq!(
        launcher_calls.load(Ordering::SeqCst),
        0,
        "用户取消不得触发续 run"
    );
}

/// 补充：用户消息到达后的正常收场不触发续 run（本 run 内经 L1
/// soft_inject 收到用户消息 → user_touched 置位；队列非空也不续）
#[tokio::test]
async fn idle_resume_not_after_user_interaction() {
    let (state, _registry) = state_with_background();
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e1", "子代理完成", 1000));
    let launcher_calls = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&launcher_calls))));

    let active = build_active_run(&state, "s1", "run-1").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-1".to_string(), Arc::clone(&active));
    // 用户经 L1 注入消息（soft_inject，source=ui）
    run_control_impl(
        &state,
        "run-1",
        "soft_inject",
        Some("请继续".to_string()),
        None,
        None,
    )
    .await
    .expect("soft_inject 应成功");

    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;

    assert_eq!(
        launcher_calls.load(Ordering::SeqCst),
        0,
        "用户消息到达后的正常收场不得触发续 run"
    );
}

/// 补充：enabled Cron 任务（SchedulerRegistry 判定器注入）→ 收口时
/// 队列空也续 run（保持待命）；无队列条目 → 空注入
#[tokio::test]
async fn idle_resume_when_cron_enabled() {
    let (state, _registry) = state_with_background();
    state.set_cron_has_enabled(Some(Arc::new(|| Box::pin(async { true }))));
    let active = build_active_run(&state, "s1", "run-1").await;

    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        true,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "Cron enabled 应触发续 run");
    assert!(
        verdict.unwrap().inject.is_empty(),
        "队列空时无注入文本（空注入保持待命）"
    );
}

/// 验收（30 方案 P7，E2E-7 后半）：真实 SchedulerRegistry 注册 enabled
/// cron → 收口判定队列空也续 run（保持待命，不再休眠）——判定器经
/// has_active 真实生效（注册表表内条目即活跃，非测试替身注入）
#[tokio::test]
async fn decide_idle_resume_cron_source_resumes() {
    let (state, _registry) = state_with_background();
    let registry = state.scheduler_registry().expect("装配后应为 Some");
    // 注入超长触发延迟：仅占位活跃（表内条目即活跃），测试窗口内不触发
    registry.set_fire_override_ms(3_600_000);
    let cron_id = registry
        .register(crate::sched::CronTaskInput {
            expression: "* * * * *".to_string(),
            prompt: "cron 待命检查".to_string(),
            max_iterations: Some(1),
            is_daemon: false,
        })
        .await
        .expect("cron 注册应成功");
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        true,
        &ResumeSignals::default(),
    )
    .await;
    assert!(
        verdict.is_some(),
        "注册 enabled cron 后队列空也应续 run 保持待命（Cron 源真实生效）"
    );
    assert!(
        verdict.unwrap().inject.is_empty(),
        "队列空时无注入文本（空注入保持待命）"
    );
    // 清理：cancel 移除声明（防跨测试污染）
    registry.cancel(&cron_id).await.ok();
}

/// 验收（30 方案 P7）：判定器 None（SchedulerRegistry 装配降级）→
/// Cron 源 false——与接线前行为一致（三源全空不续 run）
#[tokio::test]
async fn scheduler_none_degrades_cron_off() {
    let (state, _registry) = state_with_background();
    state.set_cron_has_enabled(None);
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        true,
        &ResumeSignals::default(),
    )
    .await;
    assert!(
        verdict.is_none(),
        "Cron 判定器 None → Cron 源 false（与接线前行为一致，三源全空不续 run）"
    );
}

// ======================================================================
// 接续链 2：D6 恢复条目 / 合并上限 / watcher 接线 / user_stopped /
// 空转计数按源 + D7 checkpoint 采集注入（A8/A9 壳层面）
// ======================================================================

/// 测试用 interrupted 记录（对齐 restore.rs:74-89 形状）
fn interrupted_run(run_id: &str, session_id: &str) -> orchestrator::restore::InterruptedRun {
    orchestrator::restore::InterruptedRun {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        previous_status: "running".to_string(),
        status: "failed".to_string(),
        reason: orchestrator::restore::INTERRUPTED_REASON.to_string(),
        error: orchestrator::restore::INTERRUPTED_ERROR.to_string(),
        timestamp: 1_000,
    }
}

/// 测试用恢复结果（interrupted + 会话集）
fn restore_outcome_with(
    interrupted: Vec<orchestrator::restore::InterruptedRun>,
    sessions: Vec<SessionRecord>,
) -> RestoreOutcome {
    RestoreOutcome {
        mode: RestoreMode::FullReplay,
        sessions,
        runs: Vec::new(),
        pending_inputs: Vec::new(),
        interrupted,
        unknown_status_runs: Vec::new(),
        last_sequence: 0,
        snapshot_note: None,
        snapshot_generation: 0,
        // 04 §5：孤儿工具自愈成果（测试构造零自愈）
        healed_orphan_tools: Vec::new(),
    }
}

/// D6-③ 恢复条目：主 run interrupted → 主会话队列恰 1 条，group_id =
/// `restore-<run_id>`，is_steering 受保护，文本含「请继续」（验收 A3
/// 判定面：主 run 自动续跑条目）
#[tokio::test]
async fn restore_enqueues_main_run_entry() {
    let db = LocalDb::open_in_memory().unwrap();
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let outcome =
        restore_outcome_with(vec![interrupted_run("run-main-1", "sess-main")], Vec::new());
    state.enqueue_restore_entries(&outcome).await;
    let mut queue = state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let entries = queue.dequeue_all();
    assert_eq!(entries.len(), 1, "主 run interrupted 应生成恰 1 条恢复条目");
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some("restore-run-main-1"),
        "group_id = restore-<run_id>"
    );
    assert!(
        entries[0].is_steering,
        "恢复条目 steering 受保护（容量挤占保留）"
    );
    assert!(entries[0].text.contains("请继续"), "注入文本含续跑指令");
    assert!(
        entries[0].text.contains("被重启打断"),
        "注入文本含重启打断语义"
    );
    assert!(
        entries[0].id.starts_with("restore-run-main-1-"),
        "条目 id 带时间戳保唯一"
    );
}

/// D6-③ 恢复条目：子代理 interrupted → 父会话收到通知（父归属经
/// session_agents 行解析），sub-sess-* 会话无自动续跑条目（验收 A3
/// 子代理分支：只通知不自动 fork，裁决 #20）
#[tokio::test]
async fn restore_notifies_parent_for_subagent() {
    let db = LocalDb::open_in_memory().unwrap();
    // 父会话行先落（session_agents 外键引用 sessions）
    db.insert_session("sess-main", "sess-main")
        .expect("父会话行");
    // session_agents 行（父归属：主会话 sess-main 派发子代理 sub-run-1-1）
    db.upsert_session_agent(&conex_types::SessionAgent {
        id: "sub-1-1".to_string(),
        subagent_run_id: "sub-run-1-1".to_string(),
        parent_session_id: "sess-main".to_string(),
        parent_run_id: "run-main-1".to_string(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: "analysis".to_string(),
        status: "running".to_string(),
        summary: None,
        messages: Vec::new(),
        started_at: 1_000,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    })
    .expect("session_agents 行落库");
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let outcome = restore_outcome_with(
        vec![interrupted_run("sub-run-1-1", "sub-sess-1-1")],
        vec![SessionRecord {
            session_id: "sess-main".to_string(),
            current_leaf_id: None,
            branches: Vec::new(),
            context_meta: None,
        }],
    );
    state.enqueue_restore_entries(&outcome).await;
    let mut queue = state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let entries = queue.dequeue_all();
    assert_eq!(
        entries.len(),
        1,
        "子代理 interrupted 应生成恰 1 条通知（无自动续跑条目）"
    );
    assert!(
        entries[0].text.contains("子代理 run sub-run-1-1"),
        "通知携带子代理 run id"
    );
    assert!(
        entries[0].text.contains("请决策"),
        "通知含三决策指引（重派 / 接管 / 放弃）"
    );
    assert!(
        !entries[0].text.contains("请继续"),
        "子代理通知不是续跑指令（不自动 fork）"
    );
    assert_eq!(
        entries[0].group_id.as_deref(),
        Some("restore-sub-run-1-1"),
        "子代理通知同样按 restore-<run_id> 分组"
    );
}

/// D6-③ 恢复条目：子代理父归属查不到 → 跳过通知不 panic（run-
/// interrupted 事件已留痕，D6 §8 决策 3）
#[tokio::test]
async fn restore_skips_when_parent_unresolvable() {
    let db = LocalDb::open_in_memory().unwrap();
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let outcome = restore_outcome_with(
        vec![interrupted_run("sub-run-orphan", "sub-sess-9-9")],
        Vec::new(),
    );
    state.enqueue_restore_entries(&outcome).await;
    let queue = state.pending_queue.lock().unwrap();
    assert!(
        queue.is_empty(),
        "父归属查不到 → 跳过通知（仅日志，不 panic、不产生条目）"
    );
}

/// D6-③ 恢复条目：同 run 两次恢复 → replace_or_enqueue 分组去重仅 1 条
#[tokio::test]
async fn restore_entries_dedup_by_group() {
    let db = LocalDb::open_in_memory().unwrap();
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let outcome =
        restore_outcome_with(vec![interrupted_run("run-main-1", "sess-main")], Vec::new());
    state.enqueue_restore_entries(&outcome).await;
    state.enqueue_restore_entries(&outcome).await;
    let queue = state.pending_queue.lock().unwrap();
    assert_eq!(queue.len(), 1, "同 run 分组去重（不重复堆积）");
}

/// D6 §3.4 合并上限：18 条 → 注入文本 = 最新 16 条 + 省略注记（验收 A4）
#[test]
fn drain_merge_caps_at_16() {
    let mut queue = PendingMessageQueue::new();
    for i in 0..18 {
        queue.enqueue(SteeringInputEntry::steering(
            format!("e{i}"),
            format!("条目 {i}"),
            i,
        ));
    }
    let messages = drain_pending_to_inject_messages(&mut queue, "s1");
    assert_eq!(messages.len(), 1, "合并为单条注入消息");
    let text = messages[0].text();
    assert!(text.contains("条目 2"), "最新 16 条保留（省略最旧 2 条）");
    assert!(text.contains("条目 17"), "最新条目保留");
    assert!(!text.starts_with("条目 0"), "最旧条目省略");
    assert!(!text.starts_with("条目 1"), "次旧条目省略");
    assert!(
        !text.contains("\n条目 1\n"),
        "条目 1 不在保留集（条目 10-17 为合法子串，用分隔断言）"
    );
    assert!(text.contains("其余 2 条唤醒通知省略"), "省略注记入文本");
    let metadata = messages[0].metadata.as_ref().expect("steering 元数据");
    assert_eq!(
        metadata
            .get("kind")
            .and_then(|k: &serde_json::Value| k.as_str()),
        Some(
            session_loop::steering::metadata_kind_wire(AgentMessageMetadataKind::Steering).as_str()
        )
    );
}

/// D6 §3.4 合并上限：≤16 条 → 全量拼接，无省略注记（现状语义保持）
#[test]
fn drain_merge_under_cap_unchanged() {
    let mut queue = PendingMessageQueue::new();
    for i in 0..5 {
        queue.enqueue(SteeringInputEntry::steering(
            format!("e{i}"),
            format!("条目 {i}"),
            i,
        ));
    }
    let messages = drain_pending_to_inject_messages(&mut queue, "s1");
    let text = messages[0].text();
    assert!(text.contains("条目 0"), "未超限全量保留（FIFO 序）");
    assert!(text.contains("条目 4"));
    assert!(!text.contains("省略"), "无省略注记");
    assert_eq!(text.matches("条目").count(), 5, "5 条全量拼接");
}

/// D6 §3.2 接线：ensure_wake_watcher 幂等持有 + start 生效（不重复 spawn）
#[tokio::test]
async fn wake_watcher_ensure_idempotent_and_running() {
    let (state, _registry) = state_with_background();
    assert!(state.ensure_wake_watcher("s1"), "首次创建返回 true");
    assert!(
        !state.ensure_wake_watcher("s1"),
        "幂等：重复调用不重复 spawn"
    );
    let map = state.wake_watchers.lock().unwrap();
    assert_eq!(map.len(), 1, "持有表恰 1 项");
    let watcher = map.get("s1").expect("watcher 已持有");
    assert!(watcher.is_running(), "周期任务运行中");
    watcher.stop();
}

/// D6 决策 1：user_stopped 会话级标记同步到 watcher 实例（watcher
/// 判定与 decide_idle_resume 共享同一跨 run 语义）
#[tokio::test]
async fn wake_watcher_user_stopped_propagates() {
    let (state, _registry) = state_with_background();
    state.ensure_wake_watcher("s1");
    state.set_user_stopped("s1");
    assert!(state.is_user_stopped("s1"), "状态级标记已设置");
    let watcher = state
        .wake_watchers
        .lock()
        .unwrap()
        .get("s1")
        .unwrap()
        .clone();
    assert!(watcher.is_user_stopped(), "watcher 实例同步置位");
    state.clear_user_stopped("s1");
    assert!(!state.is_user_stopped("s1"), "清除后状态级标记消失");
    assert!(!watcher.is_user_stopped(), "watcher 实例同步清除");
    watcher.stop();
}

/// D6 决策 1 写入点：用户 L2/L3 停止 → 会话级 user_stopped 置位
#[tokio::test]
async fn run_control_stop_sets_user_stopped() {
    let (state, _registry) = state_with_background();
    state.ensure_wake_watcher("s1");
    let active = build_active_run(&state, "s1", "run-1").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-1".to_string(), Arc::clone(&active));
    // L2 协作停止
    run_control_impl(&state, "run-1", "cooperative_stop", None, None, None)
        .await
        .expect("L2 应成功");
    assert!(state.is_user_stopped("s1"), "L2 停止设置会话级标记");
    // 新 run（模拟用户新 run 清除——run_task_impl 装配面）
    state.clear_user_stopped("s1");
    assert!(!state.is_user_stopped("s1"), "用户新 run 清除标记");
    // L3 强停
    run_control_impl(&state, "run-1", "force_cancel", None, None, None)
        .await
        .expect("L3 应成功");
    assert!(state.is_user_stopped("s1"), "L3 停止设置会话级标记");
    // 测试收尾：watcher 句柄先行取出（guard 语句内释放——if-let
    // 尾语句临时值会越过函数末尾的 state drop，E0597）
    let watcher = state
        .wake_watchers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .cloned();
    if let Some(watcher) = watcher {
        watcher.stop();
    }
}

/// D6 决策 1：user_stopped 后收口判定不续 run（watcher 与
/// decide_idle_resume 共享判停）；用户新 run 清除后恢复
#[tokio::test]
async fn decide_idle_resume_blocked_by_user_stopped() {
    let (state, _registry) = state_with_background();
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e1", "子代理完成", 1000));
    state.set_user_stopped("s1");
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        true,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_none(), "user_stopped 后队列非空也不续 run");
    state.clear_user_stopped("s1");
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        true,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "用户新 run 清除后恢复自动续 run");
}

/// D6-⑤（W2）：仅定时器源空注入轮（无队列条目）无产出 → streak
/// 不增不减（裁决 #21：待命是正常态；验收 A6）
#[tokio::test]
async fn empty_inject_timer_round_not_counted() {
    let (state, _registry) = state_with_background();
    state.set_timer_has_active(Some(Arc::new(|| Box::pin(async { true }))));
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        false,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "定时器源应续 run（保持待命）");
    assert!(verdict.unwrap().inject.is_empty(), "无队列条目 → 空注入");
    let streak = state
        .resume_empty_streak
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .copied()
        .unwrap_or(0);
    assert_eq!(streak, 0, "定时器空注入轮不计 streak（不增不减）");
}

/// D6-⑤（W2）：仅 Cron 源空注入轮无产出 → streak 不增不减
#[tokio::test]
async fn empty_inject_cron_round_not_counted() {
    let (state, _registry) = state_with_background();
    state.set_cron_has_enabled(Some(Arc::new(|| Box::pin(async { true }))));
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        false,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "Cron 源应续 run（保持待命）");
    let streak = state
        .resume_empty_streak
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .copied()
        .unwrap_or(0);
    assert_eq!(streak, 0, "Cron 空注入轮不计 streak");
}

/// D6-⑤（W2）+ 审计 04 补缺（e）：定时器源空注入轮**多轮待命**不误停
/// ——连续超过空转上限（IDLE_RESUME_MAX_EMPTY_ROUNDS=3）的空注入轮
/// streak 保持 0 且判定持续命中（裁决 #21：待命是正常态，不增不减）
#[tokio::test]
async fn timer_standby_multi_empty_rounds_keep_streak_zero() {
    let (state, _registry) = state_with_background();
    state.set_timer_has_active(Some(Arc::new(|| Box::pin(async { true }))));
    let active = build_active_run(&state, "s1", "run-1").await;
    // 6 轮待命（> 上限 3）：每轮仍续 run，streak 不被消耗
    for round in 1..=6u32 {
        let verdict = decide_idle_resume(
            &state,
            &active,
            AgentEndReason::Stop,
            false,
            &ResumeSignals::default(),
        )
        .await;
        assert!(verdict.is_some(), "第 {round} 轮定时器待命应持续续 run");
        let streak = state
            .resume_empty_streak
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get("s1")
            .copied()
            .unwrap_or(0);
        assert_eq!(streak, 0, "第 {round} 轮后 streak 仍为 0（不增不减）");
    }
}

/// D6-⑤（W2）：真实队列条目轮无产出 → 计入 streak（有真实任务输入，
/// 护栏照常计数）
#[tokio::test]
async fn queue_round_no_output_counts_streak() {
    let (state, _registry) = state_with_background();
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e1", "子代理完成", 1000));
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        false,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "队列条目轮应续 run");
    let streak = state
        .resume_empty_streak
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .copied()
        .unwrap_or(0);
    assert_eq!(streak, 1, "队列条目轮无产出计入 streak（现状语义保持）");
}

/// D6-⑤（W2）：有产出轮 → streak 清零（现状语义保持）
#[tokio::test]
async fn productive_round_resets_streak() {
    let (state, _registry) = state_with_background();
    state
        .resume_empty_streak
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), 3);
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering("e1", "子代理完成", 1000));
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        true,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "有产出轮应续 run");
    let streak = state
        .resume_empty_streak
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .copied()
        .unwrap_or(0);
    assert_eq!(streak, 0, "有产出轮清零 streak");
}

/// D6-⑤（W2）：goal 续轮（D5 四源）无产出 → 计入空转 streak（裁决
/// #21 第二分支：goal 轮不享受空注入豁免；stalled 独立计数在 D5
/// goal_state 域）
#[tokio::test]
async fn goal_round_no_output_counts_streak() {
    let db = LocalDb::open_in_memory().unwrap();
    // runs 表外键引用 sessions——活动 run 装配前先落会话行
    db.insert_session("s1", "s1").expect("会话行");
    db.set_session_meta(
        orchestrator::goal_state::GOAL_STATE_KEY,
        &GoalState::new("测试目标", 12, 2).to_json(),
    )
    .expect("goal_state 落键");
    let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let active = build_active_run(&state, "s1", "run-1").await;
    let verdict = decide_idle_resume(
        &state,
        &active,
        AgentEndReason::Stop,
        false,
        &ResumeSignals::default(),
    )
    .await;
    assert!(verdict.is_some(), "goal_pending 应续轮");
    assert_eq!(
        verdict.unwrap().mode,
        "goal-continue",
        "goal 续轮走 goal-continue 模式"
    );
    let streak = state
        .resume_empty_streak
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .copied()
        .unwrap_or(0);
    assert_eq!(
        streak, 1,
        "goal 续轮无产出计入空转 streak（不受空注入豁免）"
    );
}

// ── D5/D1 轮 2 接线：goal_state 写面 / 熔断计数 / 退避注入 ──────

/// 轮询至熔断键 count 达期望值（收口写键在 agent-end 落库之后，
/// spawn_blocking 异步落键——轮询窗口内未达则 panic）
async fn wait_for_fail_streak(db: &LocalDb, expected: u32, window: Duration) -> ProviderFailStreak {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        if let Some(raw) = db
            .get_session_meta(PROVIDER_FAIL_STREAK_KEY)
            .expect("熔断键读取")
        {
            let streak: ProviderFailStreak = serde_json::from_str(&raw).expect("熔断键合法 JSON");
            if streak.count == expected {
                return streak;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "熔断键未在窗口内达 count={expected}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// goal 端到端（生产路径，D5 验收 A1/A5/A6 侧面）：mode=goal 装配 →
/// goal_state 键创建（缺省 12/2）→ 收口 RoundAssessment（current_round
/// +1、stopped_reason=stop）→ goal_pending 四源命中 → goal-continue
/// 续轮拉起。事件三件套（goal-round-started/completed/
/// continuation-decided）同链发射。
#[tokio::test]
async fn goal_mode_run_writes_state_and_continues_round() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("完成第一步，继续推进目标。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, emitter) = run_control_test_state(provider);
    state.run_restore().await;
    // 用户裁决：重试预算/上限可配置——注入快速策略防 30s 窗口被缺省 10 次重试拖穿
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));
    // 记录型拉起器替身（断言 goal-continue 续轮；拦截生产拉起器防
    // 真拉起新 run 形成续 run 链）
    let launched: Arc<std::sync::Mutex<Vec<(String, usize)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let probe = Arc::clone(&launched);
    let launcher: ResumeLauncher = Arc::new(move |_state, _sid, mode, messages| {
        let probe = Arc::clone(&probe);
        let mode = mode.to_string();
        let count = messages.len();
        Box::pin(async move {
            probe.lock().unwrap().push((mode, count));
        })
    });
    state.set_resume_launcher(Some(launcher));
    let mut options = test_options("run-goal-1", "s1", "请完成目标");
    options.mode = Some("goal".to_string());
    options.visible_goal = Some("修复构建问题".to_string());
    // max_rounds / max_stalled_rounds 缺省 None → 引擎缺省 12/2
    run_task_impl(Arc::clone(&state), options)
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    // 轮询至续轮拉起（launcher push 在收口尾部，agent-end 落库后稍晚）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let launched = launched.lock().unwrap();
        if !launched.is_empty() {
            break;
        }
        drop(launched);
        assert!(
            tokio::time::Instant::now() < deadline,
            "goal_pending 续轮未在窗口内拉起"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // goal_state 键创建 + 收口评估（advance 写回 spawn_blocking 异步——竞速容忍轮询）
    wait_goal_round_advanced(&db, "s1", Duration::from_secs(10)).await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("goal_state 键必须已创建");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(goal["goal"], "修复构建问题", "目标文本落键");
    assert_eq!(goal["max_rounds"], 12, "缺省 max_rounds=12（引擎权威）");
    assert_eq!(goal["max_stalled_rounds"], 2, "缺省 max_stalled_rounds=2");
    assert_eq!(goal["current_round"], 1, "Stop 收口轮 current_round+1");
    assert_eq!(goal["stopped_reason"], "stop", "非终态收场 reason=stop");
    // 续轮：goal-continue + 注入消息 1 条（goal 前缀，无队列条目）
    let launched = launched.lock().unwrap();
    assert_eq!(launched.len(), 1, "goal_pending 应触发续轮");
    assert_eq!(launched[0].0, "goal-continue", "续轮 mode=goal-continue");
    assert_eq!(launched[0].1, 1, "注入消息 1 条（goal 前缀）");
    // 事件三件套（envelope 通道，emit 即 flush，emitter 立即可见）
    let payloads = emitter.0.lock().unwrap().clone();
    let types: Vec<String> = payloads
        .iter()
        .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .filter_map(|v| v["type"].as_str().map(String::from))
        .collect();
    assert!(
        types.iter().any(|t| t == "goal-round-started"),
        "goal-round-started 应发射"
    );
    assert!(
        types.iter().any(|t| t == "goal-round-completed"),
        "goal-round-completed 应发射"
    );
    assert!(
        types.iter().any(|t| t == "goal-continuation-decided"),
        "goal-continuation-decided 应发射"
    );
}

/// D5 验收 A4：error 收场轮不评估不递增——current_round/stalled_rounds
/// 保持 0，stopped_reason=error（assess_round reason 门禁 Blocked）；
/// 无 goal_pending 续轮（error 收场由 D2 分支独占，非 retryable 不续）。
#[tokio::test]
async fn goal_run_error_close_does_not_advance_round() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    db.set_session_meta(
        orchestrator::goal_state::GOAL_STATE_KEY,
        &GoalState::new("修复目标", 12, 2).to_json(),
    )
    .expect("goal_state 预置");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    // error 收场（provider_error=None → D2 分支 3a 拒绝续 run）
    let outcome = RunOutcome {
        reason: AgentEndReason::Error,
        error: Some("provider 异常".to_string()),
        provider_error: None,
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block("中断产出")],
        ))],
        ..canned_outcome()
    };
    let active = build_active_run(&state, "s1", "run-goal-err").await;
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(outcome)),
    )
    .await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("键存在");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(goal["current_round"], 0, "error 轮不递增 current_round");
    assert_eq!(goal["stalled_rounds"], 0, "error 轮不计 stalled");
    assert_eq!(goal["stopped_reason"], "error", "reason 门禁落 error");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "error 收场无结构化错误 → 不自动续 run"
    );
}

/// D5 验收 A6：checklist 全勾（L1）→ goal-completed 终态——stopped_
/// reason=goal-completed 落键，status 推断 Completed → goal_pending
/// 恒 false → 无第二次续轮。
#[tokio::test]
async fn goal_run_completed_round_terminates_goal() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    db.set_session_meta(
        orchestrator::goal_state::GOAL_STATE_KEY,
        &GoalState::new("修复目标", 12, 2).to_json(),
    )
    .expect("goal_state 预置");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let outcome = RunOutcome {
        reason: AgentEndReason::Stop,
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block("- [x] 任务一\n- [x] 任务二\n目标已完成")],
        ))],
        ..canned_outcome()
    };
    let active = build_active_run(&state, "s1", "run-goal-done").await;
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(outcome)),
    )
    .await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("键存在");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(
        goal["stopped_reason"], "goal-completed",
        "L1 全勾 → goal-completed 终态"
    );
    assert_eq!(goal["current_round"], 1, "完成轮正常 +1");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "goal-completed 终态 → goal_pending 恒 false，无续轮"
    );
}

/// D5 验收 A9：子代理 run 不参与 goal 评估——收口守卫
/// active.subagent.is_none()，goal_state 键保持原样（不评估不写）。
#[tokio::test]
async fn goal_run_subagent_close_skips_assessment() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    db.set_session_meta(
        orchestrator::goal_state::GOAL_STATE_KEY,
        &GoalState::new("修复目标", 12, 2).to_json(),
    )
    .expect("goal_state 预置");
    let mut active = build_active_run(&state, "s1", "run-sa-1").await;
    let cfg = crate::subagent_spawner::SubagentRunConfig {
        subagent_id: "sa-1".to_string(),
        subagent_run_id: "run-sa-1".to_string(),
        parent_session_id: "s1".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1_000,
    };
    Arc::get_mut(&mut active).expect("唯一引用").subagent = Some(cfg);
    let outcome = RunOutcome {
        reason: AgentEndReason::Stop,
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block("子代理产出")],
        ))],
        ..canned_outcome()
    };
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(outcome)),
    )
    .await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("键存在");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(goal["current_round"], 0, "子代理 run 不评估 goal 轮");
    assert_eq!(
        goal["stopped_reason"],
        serde_json::Value::Null,
        "子代理 run 不写键"
    );
}

// ── D5 goal 集成测试补缺（审计 04 / D5 §5.2 I 系列）：stalled 指纹
//    终态 / 轮数上限终态 / 注入文本内容 / 模式切换（普通 run 保留 +
//    新 /goal 覆盖）────────────────────────────────────────────

/// 构造「同一工具批 + 失败工具结果」的 stop 收场 outcome（stalled
/// 指纹测试用：签名相同且无成功工具结果 → stalled 计入）
fn goal_stalled_outcome() -> RunOutcome {
    RunOutcome {
        reason: AgentEndReason::Stop,
        messages: vec![
            Arc::new(amsg(
                "u1",
                AgentMessageRole::User,
                vec![text_block("继续任务")],
            )),
            Arc::new(amsg(
                "m1",
                AgentMessageRole::Assistant,
                vec![
                    text_block("重试读取同一文件"),
                    tool_call_block("t1", "read_file"),
                ],
            )),
            Arc::new(amsg(
                "m2",
                AgentMessageRole::Tool,
                vec![AgentMessageBlock::ToolResult {
                    tool_call_id: "t1".into(),
                    tool_name: "read_file".into(),
                    output: ToolOutput::text("读取失败".to_string()),
                    is_error: true,
                }],
            )),
        ],
        ..canned_outcome()
    }
}

/// D5 验收 A2 / I3：工具批指纹连续相同且无成功工具结果 → stalled
/// 计数递增（首轮 NoProgress 续轮），达 max_stalled_rounds=2 →
/// goal-stalled 终态（stopped_reason=goal-stalled 落键、status 推断
/// Blocked → goal_pending 恒 false → 无第二次续轮）。预置
/// progress_signature = 本轮工具批指纹，两轮 drive 走生产收口路径。
#[tokio::test]
async fn goal_run_stalled_fingerprint_terminates_goal() {
    // 预置指纹 = 「read_file + path 顶层 key」工具批签名（与两轮
    // outcome 同构——签名相同轨道）
    let signature = orchestrator::goal_state::tool_batch_fingerprint(&[ToolCallStamp {
        tool_name: "read_file".to_string(),
        param_keys: vec!["path".to_string()],
    }])
    .expect("有工具轮必有签名");
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    let mut preset = GoalState::new("修复目标", 12, 2);
    preset.progress_signature = Some(signature.clone());
    db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &preset.to_json())
        .expect("goal_state 预置（带进度签名）");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let outcome = goal_stalled_outcome();
    // 第一轮：签名相同 → stalled_delta=1（NoProgress，未达阈值 2）→
    // goal_pending 命中 → 续轮拉起（count 1）
    drive_run_loop(
        Arc::clone(&state),
        build_active_run(&state, "s1", "run-st-1").await,
        Box::new(TestProducer::new(outcome.clone())),
    )
    .await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("键存在");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(goal["stalled_rounds"], 1, "首轮指纹相同计入 stalled");
    assert_eq!(goal["stopped_reason"], "stop", "未达阈值仍为非终态收场");
    assert_eq!(goal["current_round"], 1, "Stop 轮 current_round+1");
    assert_eq!(
        goal["progress_signature"], signature,
        "签名相同轮沿用指纹（advance 保持）"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 1, "首轮 NoProgress 应续轮");
    // 第二轮：stalled_rounds 1+1 >= 2 → Blocked(goal-stalled)，终态
    // → goal_pending 恒 false → 不再续轮
    drive_run_loop(
        Arc::clone(&state),
        build_active_run(&state, "s1", "run-st-2").await,
        Box::new(TestProducer::new(outcome)),
    )
    .await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("键存在");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(
        goal["stopped_reason"], "goal-stalled",
        "达 max_stalled_rounds → goal-stalled 终态"
    );
    assert_eq!(goal["stalled_rounds"], 2, "连续两轮 stalled 累计为 2");
    assert_eq!(goal["current_round"], 2, "两轮 Stop 收场各 +1");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "goal-stalled 终态 → goal_pending 恒 false，无第二次续轮"
    );
}

/// D5 验收 A3 / I4：max_rounds 耗尽（current_round=11、max=12，
/// 未完成）→ Blocked(goal-max-rounds) 终态——stopped_reason 落键、
/// current_round 推进到 12、goal_pending 恒 false → 无续轮。
#[tokio::test]
async fn goal_run_max_rounds_exhausted_terminates_goal() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    let mut preset = GoalState::new("修复目标", 12, 2);
    preset.current_round = 11;
    db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &preset.to_json())
        .expect("goal_state 预置（末轮）");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let outcome = RunOutcome {
        reason: AgentEndReason::Stop,
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block("还没完成，继续推进。")],
        ))],
        ..canned_outcome()
    };
    drive_run_loop(
        Arc::clone(&state),
        build_active_run(&state, "s1", "run-max-1").await,
        Box::new(TestProducer::new(outcome)),
    )
    .await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("键存在");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(
        goal["stopped_reason"], "goal-max-rounds",
        "轮数耗尽 → goal-max-rounds 终态（restore.rs 保真匹配）"
    );
    assert_eq!(goal["current_round"], 12, "末轮 Stop +1 推进到上限");
    assert_eq!(
        goal["stalled_rounds"], 0,
        "轮数上限判定先于 stalled，不计 stalled"
    );
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "goal-max-rounds 终态 → goal_pending 恒 false，无续轮"
    );
}

/// D5 §3.7 / I2 注入面：goal_pending 续轮拉起 mode=goal-continue，
/// 注入消息文本含 goal 前缀（模板 buildGoalModePrefix 同构）——
/// 「目标：{goal}」「当前第 X/Y 轮（自动续写上限 Y 轮）」，且消息
/// metadata.kind="goal-continue"（引擎自主续轮标识）。
#[tokio::test]
async fn goal_continue_inject_text_contains_goal_prefix_and_round() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("完成第一步，继续推进目标。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    state.run_restore().await;
    // 捕获型拉起器替身（记录 mode + 注入消息，不驱动续 run 链）
    let captured: Arc<std::sync::Mutex<Vec<(String, Vec<AgentMessage>)>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let probe = Arc::clone(&captured);
    let launcher: ResumeLauncher = Arc::new(move |_state, _sid, mode, messages| {
        let probe = Arc::clone(&probe);
        let mode = mode.to_string();
        Box::pin(async move {
            probe.lock().unwrap().push((mode, messages));
        })
    });
    state.set_resume_launcher(Some(launcher));
    let mut options = test_options("run-goal-inj", "s1", "请完成目标");
    options.mode = Some("goal".to_string());
    options.visible_goal = Some("修复构建问题".to_string());
    options.max_rounds = Some(5);
    options.max_stalled_rounds = Some(2);
    run_task_impl(Arc::clone(&state), options)
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    // 轮询至注入捕获（goal_pending 拉起在收口尾部）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let captured = captured.lock().unwrap();
        if !captured.is_empty() {
            break;
        }
        drop(captured);
        assert!(
            tokio::time::Instant::now() < deadline,
            "goal_pending 注入未在窗口内捕获"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let captured = captured.lock().unwrap();
    assert_eq!(captured.len(), 1, "应恰好拉起一次续轮");
    assert_eq!(captured[0].0, "goal-continue", "续轮 mode=goal-continue");
    let messages = &captured[0].1;
    assert_eq!(messages.len(), 1, "纯 goal 前缀注入 = 单条消息");
    let text = messages[0].text();
    assert!(
        text.contains("[目标模式 · 系统指令]"),
        "注入文本应含目标模式系统指令头：{text}"
    );
    assert!(
        text.contains("目标：修复构建问题"),
        "注入含 goal 文本：{text}"
    );
    // 首轮收口后 current_round 0→1，续轮注入 round = current_round+1 =
    // 2（注入读的是收口推进后的 goal_state——续轮本身就是第 2 轮）
    assert!(
        text.contains("当前第 2/5 轮（自动续写上限 5 轮）"),
        "注入含轮次信息（续轮为第 2/5 轮）：{text}"
    );
    let metadata = messages[0]
        .metadata
        .as_ref()
        .expect("goal 续轮消息带 metadata");
    assert_eq!(
        metadata["kind"],
        session_loop::steering::metadata_kind_wire(AgentMessageMetadataKind::GoalContinue),
        "注入消息 metadata.kind=goal-continue（引擎自主续轮标识）"
    );
}

/// D5 验收 A1 / §3.8 模式切换（普通 run 不清 goal_state）：goal_state
/// 是会话级长期意图——普通 run（mode 非 goal）收口不删除键，且收口
/// 评估照常推进（current_round 3→4）、goal_pending 仍可命中续轮。
#[tokio::test]
async fn goal_run_plain_mode_preserves_goal_state() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    let mut preset = GoalState::new("修复目标", 12, 2);
    preset.current_round = 3;
    preset.progress_signature = Some("tools:fnv1a:aaaaaaaaaaaaaaaa".into());
    db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &preset.to_json())
        .expect("goal_state 预置（挂起中）");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    // 普通 run（mode 非 goal，无 goal 装配）——直驱收口路径
    let outcome = RunOutcome {
        reason: AgentEndReason::Stop,
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block("闲聊回复，无目标清单。")],
        ))],
        ..canned_outcome()
    };
    drive_run_loop(
        Arc::clone(&state),
        build_active_run(&state, "s1", "run-plain-1").await,
        Box::new(TestProducer::new(outcome)),
    )
    .await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("普通 run 收口后 goal_state 键必须保留");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    assert_eq!(goal["goal"], "修复目标", "goal 文本保留（未清键）");
    assert_eq!(goal["current_round"], 4, "普通 run 收口照常推进 goal 轮次");
    assert_eq!(goal["stopped_reason"], "stop", "非终态收场");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "普通 run 后 goal_pending 仍命中 → 续轮（goal 是会话级长期意图）"
    );
}

/// D5 §3.8 模式切换（新 /goal 覆盖旧 goal_state）：旧键（current=5、
/// stalled=2、旧 max_rounds=6）被新 /goal 装配覆盖——goal 文本更新、
/// 轮次归零（收口后从第 1 轮重计）、max_rounds/max_stalled_rounds
/// 取新下发值；JSON 形状 snake_case（schemaVersion 驼峰例外，S1）。
#[tokio::test]
async fn goal_mode_new_goal_overwrites_old_state() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    state.run_restore().await;
    let mut old = GoalState::new("旧目标", 6, 4);
    old.current_round = 5;
    old.stalled_rounds = 2;
    old.progress_signature = Some("tools:fnv1a:bbbbbbbbbbbbbbbb".into());
    db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &old.to_json())
        .expect("旧 goal_state 预置");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let mut options = test_options("run-goal-new", "s1", "请完成目标");
    options.mode = Some("goal".to_string());
    options.visible_goal = Some("新目标".to_string());
    options.max_rounds = Some(10);
    options.max_stalled_rounds = Some(3);
    run_task_impl(Arc::clone(&state), options)
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    wait_goal_round_advanced(&db, "s1", Duration::from_secs(10)).await;
    let raw = db
        .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
        .expect("键读取")
        .expect("键存在");
    let goal: serde_json::Value = serde_json::from_str(&raw).expect("合法 JSON");
    // 覆盖语义：新 goal 文本 + 新上限；旧轮次/旧 stalled 归零重计
    assert_eq!(goal["goal"], "新目标", "新 /goal 覆盖旧 goal 文本");
    assert_eq!(goal["max_rounds"], 10, "新 max_rounds 落键");
    assert_eq!(goal["max_stalled_rounds"], 3, "新 max_stalled_rounds 落键");
    assert_eq!(
        goal["current_round"], 1,
        "轮次归零后从第 1 轮重计（旧值 5 消失）"
    );
    assert_eq!(
        goal["stalled_rounds"], 1,
        "新目标首轮纯文本轮 stalled 从 0 重计"
    );
    // JSON 形状断言（§4.1 snake_case；schemaVersion 驼峰经 S1 批准）
    assert_eq!(
        goal["schemaVersion"], 1,
        "schemaVersion 自描述字段（驼峰例外）"
    );
    assert_eq!(goal["stopped_reason"], "stop", "非终态收场");
    assert!(goal["progress_signature"].is_null(), "新装配无历史签名");
    assert!(
        goal.get("maxRounds").is_none(),
        "不得序列化为 camelCase 字段"
    );
    assert!(
        goal.get("currentRound").is_none(),
        "不得序列化为 camelCase 字段"
    );
    // 续轮拉起（launcher 调用）发生在轮次写键之后的异步收口段，二者不是
    // 同一时刻：`wait_goal_round_advanced` 只保证轮次已落键，不保证 launcher
    // 已调用，直接断言会与收口竞速（实证 2026-09-15 读到 0）。改为轮询等待，
    // 断言强度不变（仍要求恰好 1 次）。
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while counter.load(Ordering::SeqCst) < 1 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "新 /goal 覆盖后继续推进（首轮未完成 → 续轮）"
    );
}

/// D1 规则 C2/C3 生产路径：provider 恒瞬态错误（Network）→ run 内 3
/// 次重试耗尽 → fatal 收口（provider_error=Some）→ 收口熔断计数 +1
/// 落键（count=1）。error 收场自动续 run 由 counting 替身拦截。
#[tokio::test]
async fn drive_run_loop_close_records_transient_failure() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("x"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(conex_types::response::ClassifiedStreamError {
            kind: ProviderErrorKind::Network,
            message: "网络中断".to_string(),
            retryable: true,
            retry_after_ms: None,
        }),
    );
    let (state, db, _emitter) = run_control_test_state(provider);
    state.run_restore().await;
    // 用户裁决：重试预算/上限可配置——注入快速策略防 30s 窗口被缺省 10 次重试拖穿
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    run_task_impl(Arc::clone(&state), test_options("run-cb-1", "s1", "任务"))
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    let streak = wait_for_fail_streak(&db, 1, Duration::from_secs(10)).await;
    assert_eq!(streak.count, 1, "瞬态 fatal 收口 → streak=1");
    assert!(streak.first_fail_at_ms > 0, "首次失败时刻填充");
}

/// D1 规则 C3：正常完成收场（Stop、无 provider 错误信号）→ 熔断键清零。
#[tokio::test]
async fn drive_run_loop_close_clears_streak_on_normal_stop() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    db.set_session_meta(
        PROVIDER_FAIL_STREAK_KEY,
        &ProviderFailStreak {
            count: 3,
            first_fail_at_ms: 1_785_456_000_000,
            last_fail_at_ms: 1_785_456_000_000,
            window_ms: 0,
        }
        .to_json(),
    )
    .expect("熔断键预置 count=3");
    let active = build_active_run(&state, "s1", "run-cb-2").await;
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;
    let streak = wait_for_fail_streak(&db, 0, Duration::from_secs(10)).await;
    assert_eq!(streak.count, 0, "正常完成收场 → 熔断清零（C3）");
}

/// D1 S2 补丁关键断言：部分保留断流（Stop 收场 + 最后 assistant 消息
/// metadata.providerErrorKind=network 瞬态类）→ 计入熔断计数（+1），
/// 成功清零不执行。
#[tokio::test]
async fn drive_run_loop_close_counts_partial_stream_failure() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    // 部分保留断流触发 E1 续写判定 → counting 替身拦截拉起
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let mut last = amsg(
        "m2",
        AgentMessageRole::Assistant,
        vec![text_block("半截输出")],
    );
    last.metadata = Some(serde_json::json!({
        "providerErrorKind": "network",
        "providerErrorRetryable": true,
    }));
    let outcome = RunOutcome {
        reason: AgentEndReason::Stop,
        messages: vec![Arc::new(last)],
        ..canned_outcome()
    };
    let active = build_active_run(&state, "s1", "run-cb-3").await;
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(outcome)),
    )
    .await;
    let streak = wait_for_fail_streak(&db, 1, Duration::from_secs(10)).await;
    assert_eq!(streak.count, 1, "部分保留断流（瞬态类）计入熔断（S2）");
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "E1 续写子分支拉起（拦截至替身）"
    );
}

// ══════════════════════════════════════════════════════════════════
// E1 断流续写（审计 04 重要缺口补测）：部分保留断流 → 内容级续写 run
// 端到端（E1 A1/A2/A3 + 任务书 a/b）+ 预算上限（A5/c）+ 非瞬态不续
// （A7/e）+ 失败降级（A4/d，指纹域隔离）
// ══════════════════════════════════════════════════════════════════

/// 按调用序号注入传输层错误的 provider 包装（E1 降级 e2e：续写 run
/// 的每次调用返回瞬态错误 → run 内 3 次重试耗尽 → Error 收场；其余
/// 调用走内层脚本）。最小 mock 扩展，归属 C3 交付物候选——TestProvider
/// 的 with_error 为全量注入（每次调用都失败），无法表达「仅续写 run
/// 故障、首尾 run 正常」的脚本形态。
struct FaultInjectProvider {
    inner: Arc<TestProvider>,
    fault_at: Vec<usize>,
    fault: conex_types::response::ClassifiedStreamError,
    calls: Mutex<usize>,
}

impl FaultInjectProvider {
    fn new(
        inner: Arc<TestProvider>,
        fault_at: Vec<usize>,
        fault: conex_types::response::ClassifiedStreamError,
    ) -> Self {
        Self {
            inner,
            fault_at,
            fault,
            calls: Mutex::new(0),
        }
    }
}

#[async_trait::async_trait]
impl ProviderCall for FaultInjectProvider {
    async fn stream<'a>(
        &self,
        request: &session_loop::provider::ProviderRequest<'a>,
    ) -> Result<
        session_loop::provider::ProviderEventStream,
        conex_types::response::ClassifiedStreamError,
    > {
        let index = {
            let mut count = self.calls.lock().unwrap_or_else(|e| e.into_inner());
            let index = *count;
            *count += 1;
            index
        };
        if self.fault_at.contains(&index) {
            return Err(self.fault.clone());
        }
        self.inner.stream(request).await
    }
}

/// 自定义 provider 注入的测试状态（FaultInjectProvider 包装用；共享
/// run_control_test_state 签名锁定 Arc<TestProvider>，本测试域内联
/// 等价装配——含会话 s1 条目 + 内存库 + 记录型事件桥）
async fn fault_inject_test_state(
    provider: Arc<dyn ProviderCall>,
) -> (Arc<CoreRunState>, LocalDb, Arc<RecordingEmitter>) {
    let db = LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&subagent_test_session_entry("s1"))
        .expect("会话条目");
    let (bridge, emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_run_control_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(CoreRunState::new(
        Arc::new(LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    let config = EngineProviderConfig {
        base_url: "http://test.local/v1".to_string(),
        api_key: "test-key".to_string(),
        model: "deepseek-v4-flash".to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        ..Default::default()
    };
    state.engine.inject_provider_for_test(provider, config);
    (state, db, emitter)
}

/// 记录型续 run 拉起器包装（记录 mode + 注入文本，仍委托生产拉起器
/// 拉起真实续写 run——E1 e2e 断言「mode=content-resume + 模板注入」的
/// 同时保持续 run 链路真实闭合）
fn recording_resume_launcher(
    recorded: Arc<Mutex<Vec<(String, String, Vec<String>)>>>,
) -> ResumeLauncher {
    let prod = production_resume_launcher();
    let launcher: ResumeLauncher = Arc::new(move |state, session_id, mode, messages| {
        let recorded = Arc::clone(&recorded);
        let prod = Arc::clone(&prod);
        let state = Arc::clone(state);
        let session_id = session_id.to_string();
        let mode = mode.to_string();
        let texts: Vec<String> = messages.iter().map(|m| m.text()).collect();
        Box::pin(async move {
            recorded.lock().unwrap_or_else(|e| e.into_inner()).push((
                session_id.clone(),
                mode.clone(),
                texts,
            ));
            prod(&state, &session_id, &mode, messages).await;
        })
    });
    launcher
}

/// E1 §4 A1/A2/A3 + 任务书 a/b：部分保留断流（text + error stop，D7
/// 瞬态标注 network）→ run 1 收场 reason=Stop → decide_idle_resume 续写
/// 分支命中 → 续写 run 拉起（mode="content-resume"、注入文本精确等于
/// 锁定模板「从断点继续,不要重复已输出的内容」）；续写请求对话含 run 1
/// 部分文本（assistant 前缀经 SessionHistoryCache 水合，A2 上下文完整）
/// 且部分文本恰好出现一次（防重复注入，A3/任务书 b）。
#[tokio::test]
async fn content_resume_e2e_partial_stream_resumes_with_template_and_history() {
    let provider = Arc::new(TestProvider::with_scripts(vec![
        // run 1：产出部分文本后断流（error stop 携带瞬态分类标注——
        // 与 streaming handler 流中错误注入形态一致，streaming.rs:124-129）
        vec![
            ProviderStreamEvent::text("这是部分回答,断流点之前的内容"),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("上游网络中断".to_string()),
                error_kind: Some(ProviderErrorKind::Network),
                usage: None,
            },
        ],
        // run 2（续写 run）：正常完成剩余部分
        vec![
            ProviderStreamEvent::text("这是续写完成的剩余内容"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let (state, db, _emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;
    // C4 退避注入：跳过真实跨 run 退避睡眠（测试直接驱动）
    state.set_resume_backoff(Some(Arc::new(|_attempt| Duration::ZERO)));
    let recorded: Arc<Mutex<Vec<(String, String, Vec<String>)>>> = Arc::new(Mutex::new(Vec::new()));
    state.set_resume_launcher(Some(recording_resume_launcher(Arc::clone(&recorded))));

    run_task_impl(
        Arc::clone(&state),
        test_options("run-e1-e2e-1", "s1", "任务"),
    )
    .await
    .expect("run 发起成功");
    // run 1 收场 reason=Stop（部分保留断流的正常收场形态，E1 §2.1 前提）
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(
        terminal, "completed",
        "断流 run 以 Stop 正常收场（E1 续写分支前提）"
    );
    // 续写拉起断言：mode="content-resume" + 注入文本精确等于锁定模板
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let rec = recorded.lock().unwrap_or_else(|e| e.into_inner());
        if !rec.is_empty() {
            assert_eq!(rec.len(), 1, "断流 → 恰好一次续写拉起");
            assert_eq!(rec[0].1, "content-resume", "续写 run mode=content-resume");
            assert_eq!(
                rec[0].2[0], "上一轮生成中断(Network),请从断点继续完成,不要重复已输出的内容",
                "注入文本精确等于锁定模板（E1 §3.2 A1 断言绑定）"
            );
            break;
        }
        drop(rec);
        assert!(
            tokio::time::Instant::now() < deadline,
            "续写拉起未在窗口内发生"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 续写 run 2 请求（序号 1）断言：对话含 run 1 部分文本（assistant
    // 前缀，A2 上下文完整）+ 注入模板；部分文本恰好出现一次（防重复，
    // 任务书 b——已产出文本只在 history 中一次）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let requests = provider.requests();
        if requests.len() >= 2 {
            let messages = &requests[1].messages;
            let joined: String = messages
                .iter()
                .map(|m| m.text())
                .collect::<Vec<_>>()
                .join("\n");
            let partial = "这是部分回答,断流点之前的内容";
            assert!(
                joined.contains(partial),
                "续写请求对话应含 run 1 部分文本（历史水合）"
            );
            assert_eq!(
                joined.matches(partial).count(),
                1,
                "部分文本在续写请求中恰好出现一次（不重复注入已产出内容）"
            );
            assert!(
                joined.contains("上一轮生成中断(Network),请从断点继续完成,不要重复已输出的内容"),
                "续写请求含锁定模板注入"
            );
            assert!(
                messages
                    .iter()
                    .any(|m| m.role == AgentMessageRole::Assistant && m.text().contains(partial)),
                "部分文本以 assistant 前缀形态存在于续写对话"
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "续写 run 2 请求未在窗口内到达"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 首轮 + 续写轮两次 run-terminal 落库（链路闭合——续写 run 正常
    // 完成且最后消息无断流标注，不再二次续写）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
        let terminals = events
            .iter()
            .filter(|e| e.event_type == "run-terminal")
            .count();
        if terminals >= 2 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "应发生首轮 + 续写轮两次 run-terminal：{terminals}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// E1 §4 A5 + 任务书 c：续写预算上限（content_resume_max 缺省 2）——
/// 连续 3 次断流判定：前 2 次续写（预算 0→2），第 3 次不续写（None +
/// recovery-budget-denied 事件留痕，recover_episodes 计数=2）。
#[tokio::test]
async fn content_resume_budget_caps_at_two() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, emitter) = run_control_test_state(provider);
    state.set_resume_backoff(Some(Arc::new(|_attempt| Duration::ZERO)));
    let active = build_active_run(&state, "s1", "run-e1-cap").await;
    let signals = ResumeSignals {
        task_text: "任务".to_string(),
        provider_error: None,
        last_assistant: Some(LastAssistantSignal {
            kind: Some(ProviderErrorKind::Network),
            retryable: Some(true),
            is_plain_text: true,
        }),
    };
    // 前 2 次：预算内续写命中（注入模板精确）
    for round in 1..=2u32 {
        let verdict =
            decide_idle_resume(&state, &active, AgentEndReason::Stop, true, &signals).await;
        let decision = verdict.unwrap_or_else(|| panic!("第 {round} 次断流应在预算内续写"));
        assert_eq!(
            decision.mode, "content-resume",
            "续写 mode 固定 content-resume"
        );
        assert_eq!(
            decision.inject[0].text(),
            "上一轮生成中断(Network),请从断点继续完成,不要重复已输出的内容",
            "注入文本精确等于锁定模板"
        );
    }
    // 第 3 次：预算耗尽 → 不续写
    let denied = decide_idle_resume(&state, &active, AgentEndReason::Stop, true, &signals).await;
    assert!(denied.is_none(), "第 3 次断流预算耗尽不得续写");
    // 预算落键：content-resume 指纹计数 = 2（上限封顶）
    let raw = db
        .get_session_meta(RECOVER_EPISODES_KEY)
        .expect("预算键读取")
        .expect("预算键已写入");
    let counts: serde_json::Value = serde_json::from_str(&raw).expect("预算键合法 JSON");
    let fp = fingerprint_with_source("main", "任务", WAKE_SOURCE_CONTENT_RESUME);
    assert_eq!(
        counts[fp.as_str()].as_u64(),
        Some(2),
        "content-resume 域计数 = 2"
    );
    // 预算耗尽事件留痕（W6 双发射方：主 run 侧 subagentRunId=None）
    let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let values: Vec<serde_json::Value> = payloads
        .iter()
        .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .collect();
    assert!(
        values
            .iter()
            .any(|v| v["type"] == "recovery-budget-denied" && v["subagentRunId"].is_null()),
        "预算耗尽应发射 recovery-budget-denied（subagentRunId=None）"
    );
    // 队列卫生：拒绝轮不残留恢复条目（半截保留交用户）
    assert!(
        state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "预算拒绝不产生队列条目"
    );
}

/// E1 §4 A7 + 任务书 e：非瞬态断流（Auth 类标注）不触发续写——半截
/// 保留交用户（decide_idle_resume 返回 None、无预算消费、无队列条目）。
/// 附带 T2/T3 门禁：瞬态类但 retryable=false 不续写；含工具调用消息
/// 不续写。
#[tokio::test]
async fn content_resume_skips_non_transient_kind() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    state.set_resume_backoff(Some(Arc::new(|_attempt| Duration::ZERO)));
    let active = build_active_run(&state, "s1", "run-e1-auth").await;
    // Auth 类：非瞬态 → 不续写
    let auth_signals = ResumeSignals {
        task_text: "任务".to_string(),
        provider_error: None,
        last_assistant: Some(LastAssistantSignal {
            kind: Some(ProviderErrorKind::Auth),
            retryable: Some(false),
            is_plain_text: true,
        }),
    };
    let verdict =
        decide_idle_resume(&state, &active, AgentEndReason::Stop, true, &auth_signals).await;
    assert!(verdict.is_none(), "Auth 非瞬态断流不得触发续写（E1 §2.3）");
    // 瞬态类但显式标注不可重试（providerErrorRetryable=false）→ 不续写
    let not_retryable = ResumeSignals {
        task_text: "任务".to_string(),
        provider_error: None,
        last_assistant: Some(LastAssistantSignal {
            kind: Some(ProviderErrorKind::Network),
            retryable: Some(false),
            is_plain_text: true,
        }),
    };
    let verdict =
        decide_idle_resume(&state, &active, AgentEndReason::Stop, true, &not_retryable).await;
    assert!(
        verdict.is_none(),
        "瞬态类但 retryable=false 不得续写（E1 §2.2 T2）"
    );
    // 非纯文本消息（含工具调用）→ 不续写（T3：工具调用已提交不续写）
    let tool_signals = ResumeSignals {
        task_text: "任务".to_string(),
        provider_error: None,
        last_assistant: Some(LastAssistantSignal {
            kind: Some(ProviderErrorKind::Network),
            retryable: Some(true),
            is_plain_text: false,
        }),
    };
    let verdict =
        decide_idle_resume(&state, &active, AgentEndReason::Stop, true, &tool_signals).await;
    assert!(verdict.is_none(), "含工具调用的消息不得触发续写（T3）");
    // 预算零消费 + 队列无残留
    assert!(
        db.get_session_meta(RECOVER_EPISODES_KEY)
            .expect("预算键读取")
            .is_none(),
        "非瞬态/不可重试/非纯文本判定不消费续写预算"
    );
    assert!(
        state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "不续写时无队列条目"
    );
}

/// E1 §4 A5/A6 + T5/T7：续写开关关闭 / 熔断触发 / abort / user_touched
/// 四组闸门均不触发续写（保持现状：半截保留交用户）；熔断闸拒绝时
/// 预算不消费（动作未发生不消费）。
#[tokio::test]
async fn content_resume_gates_disabled_circuit_abort_user_touched() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    state.set_resume_backoff(Some(Arc::new(|_attempt| Duration::ZERO)));
    let active = build_active_run(&state, "s1", "run-e1-gate").await;
    let signals = ResumeSignals {
        task_text: "任务".to_string(),
        provider_error: None,
        last_assistant: Some(LastAssistantSignal {
            kind: Some(ProviderErrorKind::Network),
            retryable: Some(true),
            is_plain_text: true,
        }),
    };
    // T7：开关关闭 → 不续写
    db.set_session_meta(CONTENT_RESUME_ENABLED_KEY, "false")
        .expect("开关键写入");
    let verdict = decide_idle_resume(&state, &active, AgentEndReason::Stop, true, &signals).await;
    assert!(verdict.is_none(), "content_resume_enabled=false 不续写");
    db.set_session_meta(CONTENT_RESUME_ENABLED_KEY, "true")
        .expect("开关键复位");
    // T5：熔断触发（count=6 预置 ≥ 阈值 6）→ 不续写且预算不消费
    db.set_session_meta(
        PROVIDER_FAIL_STREAK_KEY,
        &ProviderFailStreak {
            count: 6,
            first_fail_at_ms: 1_785_456_000_000,
            last_fail_at_ms: 1_785_456_000_000,
            window_ms: 0,
        }
        .to_json(),
    )
    .expect("熔断键预置 count=6");
    let verdict = decide_idle_resume(&state, &active, AgentEndReason::Stop, true, &signals).await;
    assert!(verdict.is_none(), "熔断触发不续写（T5）");
    assert!(
        db.get_session_meta(RECOVER_EPISODES_KEY)
            .expect("预算键读取")
            .is_none(),
        "熔断闸拒绝不消费预算（动作未发生不消费）"
    );
    // abort 硬条件：不续写（即使信号齐备，T4）
    let active_abort = build_active_run(&state, "s1", "run-e1-gate-2").await;
    active_abort.abort_signal.abort();
    let verdict =
        decide_idle_resume(&state, &active_abort, AgentEndReason::Stop, true, &signals).await;
    assert!(verdict.is_none(), "abort 硬条件不续写（E1 §2.2 T4）");
    // user_touched 硬条件：不续写（T4）
    let active_touched = build_active_run(&state, "s1", "run-e1-gate-3").await;
    active_touched.user_touched.store(true, Ordering::SeqCst);
    let verdict = decide_idle_resume(
        &state,
        &active_touched,
        AgentEndReason::Stop,
        true,
        &signals,
    )
    .await;
    assert!(verdict.is_none(), "user_touched 硬条件不续写（T4）");
}

/// E1 §4 A4 + 任务书 d：续写 run 自身 error 收场 → 自然降级 D2 error
/// 续 run 通道（mode="recovery-retry"、注入 D2 锁定模板「继续任务」）；
/// content-resume 与 error-retry 指纹域隔离（各自预算计数互不消耗）。
#[tokio::test]
async fn content_resume_degrades_to_error_retry_when_resume_run_fails() {
    let inner = Arc::new(TestProvider::with_scripts(vec![
        // run 1：部分保留断流（触发续写）
        vec![
            ProviderStreamEvent::text("半截回答"),
            ProviderStreamEvent::Stop {
                reason: StopReason::Error,
                error: Some("网络中断".to_string()),
                error_kind: Some(ProviderErrorKind::Network),
                usage: None,
            },
        ],
        // run 3（error 续 run）：恢复完成
        vec![
            ProviderStreamEvent::text("error 续 run 完成"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    // 续写 run 2 的每次调用注入瞬态错误（调用序号 1-4：run 内 3 次
    // 重试（1/2/3）+ 第 4 次耗尽 fatal → Error 收场 retryable=true）
    let fault = conex_types::response::ClassifiedStreamError {
        kind: ProviderErrorKind::Network,
        message: "续写 run 持续断流".to_string(),
        retryable: true,
        retry_after_ms: None,
    };
    let provider: Arc<dyn ProviderCall> = Arc::new(FaultInjectProvider::new(
        Arc::clone(&inner),
        vec![1, 2, 3, 4],
        fault,
    ));
    let (state, db, _emitter) = fault_inject_test_state(provider).await;
    state.run_restore().await;
    // 用户裁决：重试预算/上限可配置——注入快速策略防 30s 窗口被缺省 10 次重试拖穿
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));
    state.set_resume_backoff(Some(Arc::new(|_attempt| Duration::ZERO)));
    let recorded: Arc<Mutex<Vec<(String, String, Vec<String>)>>> = Arc::new(Mutex::new(Vec::new()));
    state.set_resume_launcher(Some(recording_resume_launcher(Arc::clone(&recorded))));

    run_task_impl(
        Arc::clone(&state),
        test_options("run-e1-e2e-2", "s1", "任务"),
    )
    .await
    .expect("run 发起成功");
    // 两次自动拉起：content-resume（run 1 断流）→ recovery-retry（run 2
    // error 收场降级，E1 §3.5 降级链 ② → ③）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let rec = recorded.lock().unwrap_or_else(|e| e.into_inner());
        if rec.len() >= 2 {
            assert_eq!(rec[0].1, "content-resume", "第 1 次拉起 = 续写 run");
            assert_eq!(
                rec[0].2[0], "上一轮生成中断(Network),请从断点继续完成,不要重复已输出的内容",
                "续写注入 = E1 锁定模板"
            );
            assert_eq!(
                rec[1].1, "recovery-retry",
                "续写 run 自身 error 收场 → 降级 error 续 run"
            );
            assert_eq!(
                rec[1].2[0], MAIN_RESUME_INJECT_TEXT,
                "error 续 run 注入 = D2 锁定模板「继续任务」"
            );
            break;
        }
        drop(rec);
        assert!(
            tokio::time::Instant::now() < deadline,
            "续写 → error 续 run 两级拉起未在窗口内发生"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 指纹域隔离：content-resume 与 error-retry 各自计数 1（互不消耗，
    // E1 §3.4 同键互斥 + D2 §3.4 域隔离）
    let raw = db
        .get_session_meta(RECOVER_EPISODES_KEY)
        .expect("预算键读取")
        .expect("预算键已写入");
    let counts: serde_json::Value = serde_json::from_str(&raw).expect("预算键合法 JSON");
    let resume_fp = fingerprint_with_source("main", "任务", WAKE_SOURCE_CONTENT_RESUME);
    let retry_fp = fingerprint_with_source("main", "任务", WAKE_SOURCE_ERROR_RETRY);
    assert_eq!(counts[resume_fp.as_str()].as_u64(), Some(1), "续写域计数 1");
    assert_eq!(
        counts[retry_fp.as_str()].as_u64(),
        Some(1),
        "error-retry 域计数 1（两域隔离互不消耗）"
    );
    // run 3 请求含「继续任务」注入（FaultInjectProvider 短路注入错误
    // 不记录请求快照——成功调用序列 = run 1（0）+ run 3（1））
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let requests = inner.requests();
        if requests.len() >= 2 {
            let joined: String = requests[1]
                .messages
                .iter()
                .map(|m| m.text())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                joined.contains(MAIN_RESUME_INJECT_TEXT),
                "run 3 请求含「继续任务」注入"
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run 3 请求未在窗口内到达"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 三轮 run-terminal 落库（run 1 stop → run 2 error → run 3 stop，
    // 链路闭合）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
        let terminals = events
            .iter()
            .filter(|e| e.event_type == "run-terminal")
            .count();
        if terminals >= 3 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "应发生三轮 run-terminal：{terminals}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// D1 规则 C5：熔断触发边沿（count 4→5 预置 + 本轮瞬态 +1 跨过阈值 6）→
/// 发射 runtime-intervention-required + recovery-escalated
/// detail="circuit-trip"（观测面事件流）。
#[tokio::test]
async fn fail_streak_cross_threshold_emits_circuit_trip() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("x"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(conex_types::response::ClassifiedStreamError {
            kind: ProviderErrorKind::ServerError,
            message: "5xx".to_string(),
            retryable: true,
            retry_after_ms: None,
        }),
    );
    let (state, db, emitter) = run_control_test_state(provider);
    state.run_restore().await;
    // 用户裁决：重试预算/上限可配置——注入快速策略防 30s 窗口被缺省 10 次重试拖穿
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));
    db.set_session_meta(
        PROVIDER_FAIL_STREAK_KEY,
        &ProviderFailStreak {
            count: 5,
            first_fail_at_ms: 1_785_456_000_000,
            last_fail_at_ms: 1_785_456_000_000,
            window_ms: 0,
        }
        .to_json(),
    )
    .expect("熔断键预置 count=5");
    // count=5 未达阈值 → run 内照常重试 → fatal → 收口 +1 → 边沿跨过
    run_task_impl(Arc::clone(&state), test_options("run-cb-4", "s1", "任务"))
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    let streak = wait_for_fail_streak(&db, 6, Duration::from_secs(10)).await;
    assert_eq!(streak.count, 6, "跨过阈值 6");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut values: Vec<serde_json::Value> = Vec::new();
    while tokio::time::Instant::now() < deadline {
        let payloads = emitter.0.lock().unwrap().clone();
        values = payloads
            .iter()
            .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
            .collect();
        if values
            .iter()
            .any(|v| v["type"] == "runtime-intervention-required")
            && values
                .iter()
                .any(|v| v["type"] == "recovery-escalated" && v["detail"] == "circuit-trip")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        values
            .iter()
            .any(|v| v["type"] == "runtime-intervention-required"),
        "熔断触发应发射 runtime-intervention-required"
    );
    assert!(
        values
            .iter()
            .any(|v| { v["type"] == "recovery-escalated" && v["detail"] == "circuit-trip" }),
        "熔断触发应发射 recovery-escalated(detail=circuit-trip)"
    );
}

/// D1 规则 C1 + 装配时序生产端到端：熔断键 count=6 预置 → 装配面注入
/// SessionLoopOptions.provider_fail_streak=Some(6) → transient_retry
/// 入口闸直接 fatal（不烧 run 内配额）——provider 只被调用 1 次；
/// 收口计数 +1 → 键 count=7。
#[tokio::test]
async fn circuit_breaker_gate_fatals_without_retry() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("x"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(conex_types::response::ClassifiedStreamError {
            kind: ProviderErrorKind::Network,
            message: "网络中断".to_string(),
            retryable: true,
            retry_after_ms: None,
        }),
    );
    let (state, db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;
    db.set_session_meta(
        PROVIDER_FAIL_STREAK_KEY,
        &ProviderFailStreak {
            count: 6,
            first_fail_at_ms: 1_785_456_000_000,
            last_fail_at_ms: 1_785_456_000_000,
            window_ms: 0,
        }
        .to_json(),
    )
    .expect("熔断键预置 count=6");
    run_task_impl(Arc::clone(&state), test_options("run-cb-5", "s1", "任务"))
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(
        provider.call_count(),
        1,
        "熔断闸生效：跳过 run 内重试直接 fatal（provider 仅 1 次调用）"
    );
    let streak = wait_for_fail_streak(&db, 7, Duration::from_secs(10)).await;
    assert_eq!(streak.count, 7, "熔断 fatal 收口计数继续 +1");
}

/// D1 对照（无闸）：缺熔断键 → 闸不启用 → 瞬态错误走 3 次 run 内重试
/// （provider 共 4 次调用）后 fatal。
#[tokio::test]
async fn transient_retry_without_gate_retries_three() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("x"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(conex_types::response::ClassifiedStreamError {
            kind: ProviderErrorKind::Network,
            message: "网络中断".to_string(),
            retryable: true,
            retry_after_ms: None,
        }),
    );
    let (state, db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;
    // 用户裁决：重试预算/上限可配置——注入快速策略防 30s 窗口被缺省 10 次重试拖穿
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    run_task_impl(Arc::clone(&state), test_options("run-cb-6", "s1", "任务"))
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(
        provider.call_count(),
        4,
        "无闸：1 次初始 + 3 次 run 内重试后 fatal"
    );
    let streak = wait_for_fail_streak(&db, 1, Duration::from_secs(10)).await;
    assert_eq!(streak.count, 1, "收口熔断计数 +1");
}

/// D1 §3.2.3 装配时序显式跨重启 e2e（审计 04 熔断跨重启 C9 补强）：
/// 失败 run 收口自然写 provider_fail_streak=1 → drop 整个 CoreRunState
/// （模拟引擎重启）→ 全新实例 run_restore 后失败 run 收口读-改-写
/// +1=2（计数跨实例存活累积）→ 预置补足 count=6 → 全新实例装配读键
/// → transient_retry 闸直接 fatal（provider 仅 1 次调用），熔断计数
/// 跨重启天然生效。
#[tokio::test]
async fn circuit_breaker_streak_survives_restart_and_gates_new_run() {
    // provider 脚本：始终瞬态错误（Network 可重试 → 无闸时 3 次重试）
    let failing = || {
        Arc::new(
            TestProvider::new(vec![
                ProviderStreamEvent::text("x"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])
            .with_error(conex_types::response::ClassifiedStreamError {
                kind: ProviderErrorKind::Network,
                message: "网络中断".to_string(),
                retryable: true,
                retry_after_ms: None,
            }),
        )
    };
    // 阶段 1：实例 A 失败 run → 收口自然写 count=1
    let db = {
        let (state, db, _emitter) = run_control_test_state(failing());
        state.run_restore().await;
    // 用户裁决：重试预算/上限可配置——注入快速策略防 30s 窗口被缺省 10 次重试拖穿
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));
        run_task_impl(Arc::clone(&state), test_options("run-cb-r1", "s1", "任务"))
            .await
            .expect("run 发起成功");
        // 同步点 = **本阶段自己的 run-terminal**（按 runId 定位）。
        // 只等键值会被上一阶段的延迟收口骗过（实证 2026-09-15）。
        let terminal =
            wait_run_terminal_for_run(&db, "s1", "run-cb-r1", Duration::from_secs(30)).await;
        assert_eq!(terminal, "failed", "实例 A 以 provider 瞬态错误收场");
        let streak = wait_for_fail_streak(&db, 1, Duration::from_secs(30)).await;
        assert_eq!(streak.count, 1, "实例 A 收口自然写 count=1");
        db
    };
    // 阶段 2：模拟重启（全新 CoreRunState + run_restore，同 db）→
    // 失败 run → 收口读-改-写 count=2（跨实例计数链）
    let db = {
        let (state, db, _emitter) = run_control_test_state_on_db(failing(), db);
        state.run_restore().await;
        run_task_impl(Arc::clone(&state), test_options("run-cb-r2", "s1", "任务"))
            .await
            .expect("run 发起成功");
        // 同步点 = 本阶段自己的 run-terminal（按 runId 定位）。
        // 旧注释「键值计数是本阶段唯一正确同步点」已被实证推翻：键值轮询
        // 无法区分「本阶段收口」与「上一阶段延迟收口」，必须用 runId 事件。
        let terminal =
            wait_run_terminal_for_run(&db, "s1", "run-cb-r2", Duration::from_secs(30)).await;
        assert_eq!(terminal, "failed", "重启后失败 run 收场");
        let streak = wait_for_fail_streak(&db, 2, Duration::from_secs(30)).await;
        assert_eq!(
            streak.count, 2,
            "重启后收口读-改-写 count=2（计数跨重启存活）"
        );
        db
    };
    // 阶段 3：预置补足 count=6（模拟第 3~6 次失败历史）+ 全新实例 →
    // 装配读键 → 闸直接 fatal（provider 仅 1 次调用），收口 +1=7
    let provider = failing();
    let (state, db, _emitter) = run_control_test_state_on_db(provider.clone(), db);
    db.set_session_meta(
        PROVIDER_FAIL_STREAK_KEY,
        &ProviderFailStreak {
            count: 6,
            first_fail_at_ms: 1_785_456_000_000,
            last_fail_at_ms: 1_785_456_000_000,
            window_ms: 0,
        }
        .to_json(),
    )
    .expect("熔断键预置 count=6");
    state.run_restore().await;
    run_task_impl(Arc::clone(&state), test_options("run-cb-r3", "s1", "任务"))
        .await
        .expect("run 发起成功");
    // 同步点 = 本阶段自己的 run-terminal（按 runId 定位）：熔断闸在内核
    // transient_retry 入口触发（首次请求失败之后），故 provider 必已调用
    // 1 次；等本阶段终态落库后 provider 调用链必然结束。旧「键值轮询」同步
    // 点已被实证推翻（上一阶段延迟收口会把 count 推到 7，让断言提前通过）。
    let terminal =
        wait_run_terminal_for_run(&db, "s1", "run-cb-r3", Duration::from_secs(30)).await;
    assert_eq!(terminal, "failed", "熔断闸 fatal 收场");
    let streak = wait_for_fail_streak(&db, 7, Duration::from_secs(30)).await;
    assert_eq!(streak.count, 7, "熔断 fatal 收口计数继续 +1");
    assert_eq!(
        provider.call_count(),
        1,
        "熔断闸生效：跳过 run 内重试直接 fatal（provider 仅 1 次调用）"
    );
}

/// D1 §3.1.4 纯解析：`provider_retry_backoff_ms` 键三形状（数组三值 /
/// 单值 base / 坏值 fail-open）。
#[test]
fn retry_backoff_config_parses_session_meta() {
    let cfg = parse_retry_backoff_config("[750,8000,60000]").expect("数组解析");
    assert_eq!(cfg.base_ms, Some(750));
    assert_eq!(cfg.max_ms, Some(8000));
    assert_eq!(cfg.total_budget_ms, Some(60000));
    let single = parse_retry_backoff_config("1000").expect("单值解析");
    assert_eq!(single.base_ms, Some(1000));
    assert_eq!(single.max_ms, None, "单值只定制 base");
    assert_eq!(single.total_budget_ms, None);
    assert!(
        parse_retry_backoff_config("oops").is_none(),
        "坏值 fail-open"
    );
    assert!(
        parse_retry_backoff_config("{}").is_none(),
        "对象形状 → None"
    );
}

/// D1 §3.1.4 键读取：缺键 → None（现状立即重试向后兼容）；有键 → Some。
#[test]
fn retry_backoff_config_reads_session_meta_key() {
    let db = LocalDb::open_in_memory().unwrap();
    let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));
    assert!(
        state.retry_backoff_config("s1").is_none(),
        "缺键 → None = 现状立即重试"
    );
    db.set_session_meta(PROVIDER_RETRY_BACKOFF_MS_KEY, "[750,8000,60000]")
        .expect("退避键落库");
    let cfg = state.retry_backoff_config("s1").expect("键存在 → Some");
    assert_eq!(cfg.base_ms, Some(750));
    assert_eq!(cfg.max_ms, Some(8000));
    assert_eq!(cfg.total_budget_ms, Some(60000));
}

/// D1 规则 R6 生产端到端：退避键 [750,8000,60000] 注入 → 重试间隔生效
/// ——首次重试等待 ≥750ms（墙钟下界断言，tokio sleep 不提前）→ 3 次
/// 重试后 fatal（provider 共 4 次调用）。
#[tokio::test]
async fn retry_backoff_injection_delays_retry() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("x"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(conex_types::response::ClassifiedStreamError {
            kind: ProviderErrorKind::Network,
            message: "网络中断".to_string(),
            retryable: true,
            retry_after_ms: None,
        }),
    );
    let (state, db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;
    // 用户裁决：重试上限用户可配置——本用例经运行策略限 3 次（会话键只
    // 定退避曲线，上限由策略文件控制），避免缺省 10 次把窗口拖穿。
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: None,
        transient_retry_limit: Some(3),
    }));
    db.set_session_meta(PROVIDER_RETRY_BACKOFF_MS_KEY, "[750,8000,60000]")
        .expect("退避键落库");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let started = tokio::time::Instant::now();
    run_task_impl(Arc::clone(&state), test_options("run-bk-1", "s1", "任务"))
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    assert_eq!(provider.call_count(), 4, "退避注入下仍 3 次重试（预算内）");
    assert!(
        elapsed_ms >= 700,
        "首次重试等待 ≥750ms（实际 {elapsed_ms}ms）——退避注入生产生效"
    );
}

/// 用户裁决（重试预算/上限用户可配置，进配置文件不绑供应商）验收：
/// 运行策略 baseMs=1 + limit=3 → 重试几乎零等待、3 次后 fatal（生产
/// 缺省为 750ms 指数退避 ×10 次/180s 预算；「缺键即立即重试」的旧 R6
/// 语义随缺省预算装配退役，内核侧由 loop_tests 覆盖）。
#[tokio::test]
async fn retry_backoff_run_policy_retries_fast_and_fatales() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("x"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_error(conex_types::response::ClassifiedStreamError {
            kind: ProviderErrorKind::Network,
            message: "网络中断".to_string(),
            retryable: true,
            retry_after_ms: None,
        }),
    );
    let (state, db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(3),
    }));
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let started = tokio::time::Instant::now();
    run_task_impl(Arc::clone(&state), test_options("run-bk-2", "s1", "任务"))
        .await
        .expect("run 发起成功");
    wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    assert_eq!(provider.call_count(), 4, "策略 limit=3：3 次重试后 fatal");
    assert!(
        elapsed_ms < 700,
        "baseMs=1 → 重试近零等待（实际 {elapsed_ms}ms，应 < 退避基数 750ms）"
    );
}

// ── EV-02（D-03 R-15）：checkpoint-created / checkpoint-restored 接线 ──

/// EV-02：run 级 checkpoint 事件通道（记录桥 + EventQueue；EventQueue
/// run_id 构造期绑定，对齐 drive_run_loop 的 active 通道装配面）
fn checkpoint_run_event_channel(
    state: &CoreRunState,
) -> (
    Arc<tokio::sync::Mutex<EventQueue>>,
    Arc<BufferedRunEventBridge>,
    Arc<RecordingEmitter>,
    String,
) {
    let (bridge, emitter) = recording_bridge();
    let bridge = Arc::new(BufferedRunEventBridge::new(bridge, "run-1".to_string()));
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        0,
        Some("run-1".to_string()),
    )));
    (queue, bridge, emitter, "run-1".to_string())
}

/// EV-02 验收①：checkpoint 写叶子成功 → checkpoint-created 发射（载荷
/// record 非空；B1 三要素：正常返回 + 捕获断言 + 计数/序列校验）
#[tokio::test]
async fn checkpoint_created_event_emitted_on_write() {
    let (state, _registry) = state_with_background();
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let outcome = RunOutcome {
            messages: vec![Arc::new(amsg(
                "m1",
                AgentMessageRole::Assistant,
                vec![text_block(
                    "已完成首步。\nCHECKPOINT: {\"target\":\"目标T\",\"summary\":\"摘要S\",\"files\":[\"a.txt\"]}",
                )],
            ))],
            ..canned_outcome()
        };
    let (queue, bridge, emitter, run_id) = checkpoint_run_event_channel(&state);
    collect_checkpoint_on_close(&state, "s1", &outcome, &queue, &bridge, &run_id).await;
    // 捕获断言：恰好 1 条 checkpoint-created，载荷 record 非空
    let payloads = emitter.0.lock().unwrap().clone();
    assert_eq!(
        payloads.len(),
        1,
        "写成功应恰好发射 1 条 checkpoint-created"
    );
    let v: serde_json::Value = serde_json::from_str(&payloads[0]).expect("信封为合法 JSON");
    assert_eq!(v["type"], "checkpoint-created");
    assert_eq!(v["sessionId"], "s1");
    assert_eq!(v["runId"], "run-1");
    assert!(v["checkpoint"].is_object(), "载荷 checkpoint.record 非空");
    assert_eq!(v["checkpoint"]["id"], "leaf-1");
    assert_eq!(v["checkpoint"]["label"], "目标T");
    assert_eq!(v["checkpoint"]["kind"], "workspace-checkpoint");
    assert!(
        v["checkpoint"]["metadata"].is_object(),
        "metadata 承载载荷全文"
    );
    // 计数/序列校验：Persistent 随收口落库，run_id 列绑定 run
    let events = state.store.query_events("s1", 0, None).await.unwrap();
    assert_eq!(events.len(), 1, "checkpoint-created 随收口落库");
    assert_eq!(events[0].event_type, "checkpoint-created");
    assert_eq!(events[0].run_id.as_deref(), Some("run-1"));
    assert_eq!(events[0].sequence, 1, "会话级序列单调分配");
}

/// EV-02 验收②：恢复注入 Present 分支命中 → checkpoint-restored 发射
/// （载荷 restore 非空；会话域事件——落库 run_id 列为 None）
#[tokio::test]
async fn checkpoint_restored_event_emitted_on_present_inject() {
    let (state, _registry) = state_with_background();
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    tree.set_leaf_checkpoint(
        "leaf-1",
        &conex_types::CheckpointPayload {
            target: "目标A".to_string(),
            summary: "摘要B".to_string(),
            timestamp: None,
            completed: vec!["步骤1".to_string()],
            files: vec!["a.txt".to_string()],
            next: vec!["下一步1".to_string()],
        },
    )
    .expect("写入检查点");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    // 注入面行为不变（恢复文本正常返回）
    let section = checkpoint_injection_section(&state, "s1").await;
    assert!(section.contains("目标A"), "注入文本含目标（行为不变）");
    assert!(section.contains("步骤1"), "已完成清单入注入");
    // 捕获断言：落库 1 条 checkpoint-restored（会话域通道）
    let events = state.store.query_events("s1", 0, None).await.unwrap();
    assert_eq!(
        events.len(),
        1,
        "Present 注入应恰好落库 1 条 checkpoint-restored"
    );
    assert_eq!(events[0].event_type, "checkpoint-restored");
    assert!(events[0].run_id.is_none(), "会话域事件 run_id 列为 None");
    assert_eq!(events[0].sequence, 1, "会话级序列单调分配");
    let v: serde_json::Value = serde_json::from_str(&events[0].payload).unwrap();
    assert!(v["restore"].is_object(), "载荷 restore 非空");
    assert_eq!(v["restore"]["checkpointId"], "leaf-1");
    assert_eq!(v["restore"]["restored"][0], "a.txt");
}

/// EV-02 验收③：Corrupt 只 warn 不发 / Absent 不发（B1 三要素：正常
/// 返回 + 捕获断言 + 零事件计数校验；写面与注入面各自验证）
#[tokio::test]
async fn checkpoint_corrupt_absent_emits_no_event() {
    // 写面：坏标记行 → 采集损坏降级，零事件
    let (state, _registry) = state_with_background();
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let outcome = RunOutcome {
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block("CHECKPOINT: {坏 JSON 载荷")],
        ))],
        ..canned_outcome()
    };
    let (queue, bridge, emitter, run_id) = checkpoint_run_event_channel(&state);
    collect_checkpoint_on_close(&state, "s1", &outcome, &queue, &bridge, &run_id).await;
    let payloads = emitter.0.lock().unwrap().clone();
    assert!(payloads.is_empty(), "Corrupt 写面零事件");
    // 注入面：坏载荷叶子 → 降级提示正常返回，零事件
    let record = SessionRecord {
        session_id: "s1".to_string(),
        current_leaf_id: Some("leaf-1".to_string()),
        branches: vec![orchestrator::session::SessionTreeEntry::node(
            "leaf-1",
            None,
            serde_json::json!({ "checkpoint": "not-a-checkpoint-object" }),
        )],
        context_meta: None,
    };
    let tree = SessionTree::from_session_record(record).expect("坏载荷树重建");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let section = checkpoint_injection_section(&state, "s1").await;
    assert!(
        section.contains("检查点损坏已忽略"),
        "注入面正常返回降级提示"
    );
    let events = state.store.query_events("s1", 0, None).await.unwrap();
    assert!(events.is_empty(), "Corrupt 路径零事件落库");
    // Absent：空树（无叶子）→ 注入空串，零事件
    let (state2, _registry2) = state_with_background();
    let empty_tree = SessionTree::new("s1");
    state2
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(empty_tree)));
    assert_eq!(
        checkpoint_injection_section(&state2, "s1").await,
        String::new(),
        "Absent 不注入"
    );
    let events2 = state2.store.query_events("s1", 0, None).await.unwrap();
    assert!(events2.is_empty(), "Absent 路径零事件落库");
}

/// D7 §3.1 采集接线：对话含 CHECKPOINT 标记行 → 收口后叶子 payload
/// 含 checkpoint 键（target/summary 保真，验收 A4 前半）
#[tokio::test]
async fn checkpoint_collected_written_on_close() {
    let (state, _registry) = state_with_background();
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let outcome = RunOutcome {
            messages: vec![Arc::new(amsg(
                "m1",
                AgentMessageRole::Assistant,
                vec![text_block(
                    "已完成首步。\nCHECKPOINT: {\"target\":\"T1\",\"summary\":\"S1\",\"completed\":[\"c1\"],\"next\":[\"n1\"]}",
                )],
            ))],
            ..canned_outcome()
        };
    let (queue, bridge, _emitter, run_id) = checkpoint_run_event_channel(&state);
    collect_checkpoint_on_close(&state, "s1", &outcome, &queue, &bridge, &run_id).await;
    let trees = state.session_trees.lock().unwrap();
    let tree = trees.get("s1").unwrap().lock().unwrap();
    match tree.read_leaf_checkpoint(None) {
        conex_types::LeafCheckpointState::Present(payload) => {
            assert_eq!(payload.target, "T1", "目标保真");
            assert_eq!(payload.summary, "S1", "摘要保真");
            assert_eq!(payload.completed, vec!["c1".to_string()], "已完成保真");
            assert_eq!(payload.next, vec!["n1".to_string()], "下一步保真");
        }
        other => panic!("期望 Present，实际 {other:?}"),
    }
}

/// D7 §3.5 采集侧损坏降级：对话含坏标记行（命中前缀 + 坏 JSON）→
/// 收口不 panic、叶子不写入、不阻断（验收 A2）
#[tokio::test]
async fn checkpoint_collect_corrupt_degrades() {
    let (state, _registry) = state_with_background();
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let outcome = RunOutcome {
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block("CHECKPOINT: {坏 JSON 载荷")],
        ))],
        ..canned_outcome()
    };
    let (queue, bridge, _emitter, run_id) = checkpoint_run_event_channel(&state);
    collect_checkpoint_on_close(&state, "s1", &outcome, &queue, &bridge, &run_id).await;
    let trees = state.session_trees.lock().unwrap();
    let tree = trees.get("s1").unwrap().lock().unwrap();
    assert_eq!(
        tree.read_leaf_checkpoint(None),
        conex_types::LeafCheckpointState::Absent,
        "采集侧损坏 → 不写叶子（降级现状）"
    );
}

/// D7 §3.2 注入：Present 三态分发——有效载荷 → 注入文本含「上次检查点」
/// 与 target/summary/completed/next（验收 A1）
#[tokio::test]
async fn checkpoint_injection_present_contains_summary() {
    let (state, _registry) = state_with_background();
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    tree.set_leaf_checkpoint(
        "leaf-1",
        &conex_types::CheckpointPayload {
            target: "目标A".to_string(),
            summary: "摘要B".to_string(),
            timestamp: None,
            completed: vec!["步骤1".to_string(), "步骤2".to_string()],
            files: Vec::new(),
            next: vec!["下一步1".to_string()],
        },
    )
    .expect("写入检查点");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let section = checkpoint_injection_section(&state, "s1").await;
    assert!(section.contains("[检查点摘要]"), "摘要段标题");
    assert!(section.contains("目标A"), "目标入注入");
    assert!(section.contains("摘要B"), "摘要入注入");
    assert!(section.contains("步骤1"), "已完成入注入");
    assert!(section.contains("下一步1"), "下一步入注入");
}

/// D7 §3.2 注入：Absent（无检查点 / 无叶子）→ 空串（行为与现状一致）
#[tokio::test]
async fn checkpoint_injection_absent_empty() {
    let (state, _registry) = state_with_background();
    let tree = SessionTree::new("s1");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    assert_eq!(
        checkpoint_injection_section(&state, "s1").await,
        String::new(),
        "无检查点 → 不注入"
    );
}

/// D7 §3.2/§3.5 注入：Corrupt（载荷不可解析）→ 降级提示文本，run 照常
/// 拉起（不 panic、不阻断；验收 A2 读侧）
#[tokio::test]
async fn checkpoint_injection_corrupt_hint() {
    let (state, _registry) = state_with_background();
    // 直接构造坏载荷叶子（绕过类型安全的 set_leaf_checkpoint）
    let record = SessionRecord {
        session_id: "s1".to_string(),
        current_leaf_id: Some("leaf-1".to_string()),
        branches: vec![orchestrator::session::SessionTreeEntry::node(
            "leaf-1",
            None,
            serde_json::json!({ "checkpoint": "not-a-checkpoint-object" }),
        )],
        context_meta: None,
    };
    let tree = SessionTree::from_session_record(record).expect("坏载荷树重建");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let section = checkpoint_injection_section(&state, "s1").await;
    assert!(
        section.contains("检查点损坏已忽略"),
        "损坏降级提示入注入（run 照常拉起）"
    );
}

/// D7 §8 决策 4：摘要超长 → 截断 ≤500 字符 + 省略号（注入长度护栏）
#[tokio::test]
async fn checkpoint_injection_summary_truncated() {
    let (state, _registry) = state_with_background();
    let long_summary = "x".repeat(600);
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    tree.set_leaf_checkpoint(
        "leaf-1",
        &conex_types::CheckpointPayload {
            target: "目标A".to_string(),
            summary: long_summary.clone(),
            timestamp: None,
            completed: Vec::new(),
            files: Vec::new(),
            next: Vec::new(),
        },
    )
    .expect("写入检查点");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let section = checkpoint_injection_section(&state, "s1").await;
    assert!(section.contains(&"x".repeat(500)), "摘要保留前 500 字符");
    assert!(!section.contains(&"x".repeat(501)), "超长部分截断");
    assert!(section.contains('…'), "省略号标注截断");
    assert!(section.contains("(无)"), "空清单显示 (无)");
}

/// D7 §8 决策 4：completed/next 各 ≤5 项（清单项上限护栏）
#[tokio::test]
async fn checkpoint_injection_list_items_limited() {
    let (state, _registry) = state_with_background();
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    let completed: Vec<String> = (0..8).map(|i| format!("步骤{i}")).collect();
    tree.set_leaf_checkpoint(
        "leaf-1",
        &conex_types::CheckpointPayload {
            target: "目标A".to_string(),
            summary: "摘要".to_string(),
            timestamp: None,
            completed: completed.clone(),
            files: Vec::new(),
            next: Vec::new(),
        },
    )
    .expect("写入检查点");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    let section = checkpoint_injection_section(&state, "s1").await;
    assert!(section.contains("步骤0"), "前 5 项保留");
    assert!(section.contains("步骤4"));
    assert!(!section.contains("步骤5"), "第 6 项起省略");
    assert!(!section.contains("步骤7"));
}

/// D7 采集写面：子代理会话（sub-sess-*）无树 → 采集自动跳过（R8：
/// 不建占位树）
#[tokio::test]
async fn checkpoint_collect_skips_without_tree() {
    let (state, _registry) = state_with_background();
    let outcome = RunOutcome {
        messages: vec![Arc::new(amsg(
            "m1",
            AgentMessageRole::Assistant,
            vec![text_block(
                "CHECKPOINT: {\"target\":\"T1\",\"summary\":\"S1\"}",
            )],
        ))],
        ..canned_outcome()
    };
    // 无 panic、无写面副作用、零事件
    let (queue, bridge, emitter, run_id) = checkpoint_run_event_channel(&state);
    collect_checkpoint_on_close(&state, "sub-sess-1-1", &outcome, &queue, &bridge, &run_id).await;
    assert!(
        state.session_trees.lock().unwrap().is_empty(),
        "无树会话不建占位树"
    );
    let payloads = emitter.0.lock().unwrap().clone();
    assert!(payloads.is_empty(), "无树跳过 → 零事件");
}

// ======================================================================
// T-D-13：引擎侧 SubagentSpawner 集成测试（生产 spawner 全链路）
// ======================================================================

/// 会话索引条目（测试用主会话）
fn subagent_test_session_entry(id: &str) -> conex_types::SessionIndexEntry {
    conex_types::SessionIndexEntry {
        id: id.to_string(),
        title: format!("会话 {id}"),
        folder: String::new(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-08-05T00:00:00.000Z".to_string(),
        updated_at: 1,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: Some(0),
        engine_last_run_id: None,
        hydrated_from_engine: Some(true),
    }
}

/// 按会话路由的测试 provider（确定性脚本分配）：ProviderRequest.session_id
/// 由 SharedProvider 注入（loop 的会话 id）——主 agent 会话（非 sub-sess-*
/// 前缀）走主脚本序列，子代理会话走子脚本序列。消除共享 TestProvider
/// 调用序号交错导致的脚本分配不确定（T-D-13 端到端测试基建）。
#[derive(Debug)]
struct SessionRoutedProvider {
    main: Arc<TestProvider>,
    sub: Arc<TestProvider>,
}

#[async_trait::async_trait]
impl ProviderCall for SessionRoutedProvider {
    async fn stream<'a>(
        &self,
        request: &session_loop::provider::ProviderRequest<'a>,
    ) -> Result<
        session_loop::provider::ProviderEventStream,
        conex_types::response::ClassifiedStreamError,
    > {
        let target = match request.session_id.as_deref() {
            Some(s) if s.starts_with("sub-sess-") => &self.sub,
            _ => &self.main,
        };
        target.stream(request).await
    }
}

/// 集成装配：LocalDbStore 状态 + spawner 注入面 + 会话路由 TestProvider
/// 引擎就绪。返回 (state, db, main_provider, sub_provider, emitter)。
fn subagent_state_with_providers(
    main: Arc<TestProvider>,
    sub: Arc<TestProvider>,
    model: &str,
) -> (
    Arc<CoreRunState>,
    LocalDb,
    Arc<TestProvider>,
    Arc<TestProvider>,
    Arc<RecordingEmitter>,
) {
    let (bridge, emitter) = recording_bridge();
    let db = LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&subagent_test_session_entry("sess-main"))
        .expect("会话条目");
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_subagent_e2e_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(CoreRunState::new(
        Arc::new(LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    // T-D-13：spawner 注入面装配（launcher / db / 广播 / steering 队列）
    state.finalize_subagent_spawner();
    let routed: Arc<dyn ProviderCall> = Arc::new(SessionRoutedProvider {
        main: Arc::clone(&main),
        sub: Arc::clone(&sub),
    });
    let config = EngineProviderConfig {
        base_url: "http://test.local/v1".to_string(),
        api_key: "test-key".to_string(),
        model: model.to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        ..Default::default()
    };
    state.engine.inject_provider_for_test(routed, config);
    (state, db, main, sub, emitter)
}

/// 主 agent 会话的测试脚本（通用形态：派发调用 + 收口 + 兜底）
fn main_agent_scripts(spawn_call: serde_json::Value) -> Vec<Vec<ProviderStreamEvent>> {
    vec![
        vec![
            ProviderStreamEvent::text("开始派发。"),
            ProviderStreamEvent::tool_call(Some("c1".to_string()), "run_subagent", spawn_call),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        vec![
            ProviderStreamEvent::text("已派发。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 兜底（idle 续 run 等越界调用）：安全收口
        vec![
            ProviderStreamEvent::text("收到通知。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("继续。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]
}

/// 轮询等待全部活动 run 收口（tauri::async_runtime::spawn 的任务在
/// 独立 tokio 任务执行；窗口内未收口则 panic）
async fn wait_all_runs_terminal(state: &CoreRunState, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_empty() {
            return;
        }
        eprintln!(
            "等待收口中：活动 run = {:?}",
            active.keys().collect::<Vec<_>>()
        );
        drop(active);
        assert!(
            tokio::time::Instant::now() < deadline,
            "活动 run 未在窗口内全部收口"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// 轮询等待子代理行进入终态（completed/failed）
async fn wait_agent_rows_terminal(db: &LocalDb, session_id: &str, expect: usize, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        // 写侧落库（spawn_blocking）与查询竞速：表锁按未就绪重试
        let Ok(rows) = db.load_session_agents(session_id) else {
            assert!(tokio::time::Instant::now() < deadline, "子代理行未在窗口内落库");
            tokio::time::sleep(Duration::from_millis(20)).await;
            continue;
        };
        let terminal = rows
            .iter()
            .filter(|r| r.status == "completed" || r.status == "failed")
            .count();
        if terminal >= expect {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "子代理行未在窗口内进入终态（{terminal}/{expect}）"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

fn test_options(run_id: &str, session_id: &str, prompt: &str) -> RunTaskOptions {
    RunTaskOptions {
        run_id: run_id.to_string(),
        session_id: session_id.to_string(),
        prompt: Some(prompt.to_string()),
        mode: Some("task".to_string()),
        cwd: None,
        // 主 agent run 用 full-access：工具批不弹审批（permission_mode
        // None = 全批审批的既有语义；子代理 run 的权限面由 spawner 装配
        // None——full-access 不传导，测试聚焦子代理侧）
        permission_mode: Some("full-access".to_string()),
        client_message_id: None,
        assistant_client_message_id: None,
        system_prompt: None,
        history: None,
        context_window: None,
        parent_run_id: None,
        subagent_config: None,
        // D5 §3.1 goal 模式三字段：测试非 goal run，全部缺省 None
        //（缺省语义 = 引擎侧装配缺省，与生产命令面一致）
        visible_goal: None,
        max_rounds: None,
        max_stalled_rounds: None,
        // I1-β：思考档位缺省 None（引擎默认；档位注入面由 run_launch.rs
        // run_task_impl 装配，测试聚焦其它面不携带档位）
        reasoning_effort: None,
        // I1-α②：测试 run 不携带 context-state（注入面单独验收）
        context_state: None,
        // plans/04 §4.2：测试 run 不携带多模态 content
        content: None,
        has_images: None,
    }
}

/// 主 agent 裁决助手（Mock 裁决器语义）：轮询并批准全部挂起审批
/// （子代理 run 工具调用 → 审批路由主 agent → 测试直接裁决放行；
/// 返回裁决次数）
async fn resolve_all_pending_approvals(state: &CoreRunState, window: Duration) -> usize {
    let deadline = tokio::time::Instant::now() + window;
    let mut resolved = 0usize;
    loop {
        let run_ids: Vec<String> = {
            let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
            active.keys().cloned().collect()
        };
        let mut acted = false;
        for run_id in run_ids {
            let run = {
                let active = state.active_runs.lock().unwrap_or_else(|e| e.into_inner());
                active.get(&run_id).cloned()
            };
            if let Some(run) = run {
                let call_id = {
                    let pending = run
                        .approval
                        .pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    pending.keys().next().cloned()
                };
                if let Some(call_id) = call_id {
                    run.approval
                        .resolve(&call_id, ApprovalDecision::Approved)
                        .await
                        .expect("主 agent 裁决应成功");
                    resolved += 1;
                    acted = true;
                }
            }
        }
        if !acted {
            // 无挂起审批且已无活动 run → 完成；否则继续等待新审批
            let empty = state
                .active_runs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_empty();
            if empty {
                return resolved;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "活动 run 存在但审批未在窗口内触发"
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
}

/// 验收 1：单发/批量端到端——run_subagent 不再 unsupported → 子代理 run
/// 真实启动 → 终态事件回传（父会话落库 + wait 广播）→ 主 Agent 经
/// steering 收到通知；提示词注入断言（角色约束 / 权限申请 / started_at
/// / git 回退段）。
#[tokio::test]
async fn run_subagent_end_to_end_not_unsupported_with_terminal_and_steering() {
    // 主 agent 脚本：第 1 次调用 = 派发两个子代理（批量 tasks）；
    // 第 2 次调用（工具结果回合）= 正常收口；子代理脚本 = 安全收口
    //（text + stop，无工具调用）；会话路由 provider 保证脚本确定性
    let main = Arc::new(TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("我将并行派发两个调研子代理。"),
            ProviderStreamEvent::tool_call(
                Some("c1".to_string()),
                "run_subagent",
                serde_json::json!({
                    "tasks": [
                        { "prompt": "调研模块 A", "taskType": "analysis", "displayLabel": "调研A" },
                        { "prompt": "调研模块 B", "taskType": "analysis", "displayLabel": "调研B" }
                    ]
                }),
            ),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        vec![
            ProviderStreamEvent::text("两个子代理已派发，等待结果。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("收到通知。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("继续。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let sub = Arc::new(TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("调研完成A。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        vec![
            ProviderStreamEvent::text("调研完成B。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let (state, db, main, sub, _emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;

    // 主 agent run（完整 run_task_impl → drive_run_loop）
    run_task_impl(
        Arc::clone(&state),
        test_options("run-main", "sess-main", "并行派发两个调研子代理"),
    )
    .await
    .expect("主 agent run 发起成功");
    // 等待两个子代理行进入终态，且全部活动 run 收口
    wait_agent_rows_terminal(&db, "sess-main", 2, Duration::from_secs(20)).await;
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;

    // 1. 工具不再返回 common.unsupported：两个子代理行落库 + 结果信封
    let rows = db.load_session_agents("sess-main").expect("读行");
    assert_eq!(rows.len(), 2, "批量派发应落库两行");
    assert!(rows.iter().all(|r| r.parent_run_id == "run-main"));
    // 批量条目契约（D3-1 冻结：tasks 条目仅 prompt/role/displayLabel/
    // capabilityMode/timeoutMs/description）不携带 taskType——落库 None，
    // 引擎装配按缺省 analysis（最安全 fail-closed）
    assert!(rows.iter().all(|r| r.task_type.is_none()));
    assert!(rows.iter().all(|r| r.depth == Some(1)));
    assert_eq!(rows[0].display_label.as_deref(), Some("调研A"));
    assert_eq!(rows[1].display_label.as_deref(), Some("调研B"));

    // 2. 子代理 run 真实启动并收口：行进入终态（completed/failed）
    assert!(
        rows.iter()
            .all(|r| r.status == "completed" || r.status == "failed"),
        "子代理行终态：{rows:?}"
    );

    // 3. 终态事件回传：subagent-started + subagent-ended 落库（父会话）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let mut started = 0;
    let mut ended = 0;
    while tokio::time::Instant::now() < deadline {
        let events = db
            .query_events("sess-main", 0, Some(200))
            .expect("事件查询");
        started = events
            .iter()
            .filter(|e| e.event_type == "subagent-started")
            .count();
        ended = events
            .iter()
            .filter(|e| e.event_type == "subagent-ended")
            .count();
        if started >= 2 && ended >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert_eq!(started, 2, "subagent-started 每次 spawn 发射一次");
    assert_eq!(ended, 2, "subagent-ended 每个终态发射一次");

    // 4. 主 Agent 经 steering 收到通知：子代理终态条目入队后，主 agent
    //    的 idle 待命续 run（decide_idle_resume）消费条目并注入——通知
    //    载体 = 队列条目（未被消费时）或续 run 的注入消息（已消费时）
    let entries = {
        let mut queue = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        queue.dequeue_all()
    };
    let queue_notified = entries
        .iter()
        .any(|e| e.is_steering && e.text.contains("子代理"));
    let injected_notified = main
        .requests()
        .iter()
        .any(|r| r.messages.iter().any(|m| m.text().contains("子代理")));
    assert!(
        queue_notified || injected_notified,
        "主 agent 必须经 steering 收到子代理完成通知（队列条目或续 run 注入消息）"
    );

    // 5. 提示词注入断言：子代理 run 的 provider 请求 system_prompt 含
    //    注入段（会话路由 provider：sub 请求全部来自子代理 run——
    //    确定性，不依赖调用序号筛选）
    let sub_prompts: Vec<String> = sub
        .requests()
        .iter()
        .filter_map(|r| r.system_prompt.clone())
        .collect();
    assert_eq!(sub_prompts.len(), 2, "两个子代理 run 各一次带注入的请求");
    for prompt in &sub_prompts {
        // T-D-03：子代理角色约束（主 agent run 不含本段）
        assert!(prompt.contains("## 子代理角色约束"));
        assert!(prompt.contains("所有子 Agent 由主 Agent 分配"));
        // T-D-14：权限申请指引
        assert!(prompt.contains("## 权限申请指引"));
        assert!(prompt.contains("申请由主 agent 审批"));
        // C2：started_at 注入 + git 回退谨慎指引
        assert!(prompt.contains("## 会话注入（started_at）"));
        assert!(prompt.contains("## git 回退谨慎指引"));
    }
    // 主 agent run 不含子代理角色约束段
    let main_prompt = main
        .requests()
        .first()
        .and_then(|r| r.system_prompt.clone())
        .unwrap_or_default();
    assert!(
        !main_prompt.contains("## 子代理角色约束"),
        "主 Agent run 不含角色约束段（T-D-03 关键差异点）"
    );
}

/// 验收 2：嵌套拒绝端到端——守卫兜底（NestingDenied 结构化错误）确定性
/// 验证（T-D-02：子 Agent 无派发能力）。工具面剔除（子代理注册表无
/// run_subagent）为同一 filter 机制（[filter_registry] 谓词），其装配
/// 生效由验收 3（analysis 无写工具 is_error）同构验证 + agent-tools
/// filter 单测覆盖；此处子代理 run 用安全脚本收口。
#[tokio::test]
async fn subagent_run_nesting_denied_both_tool_surface_and_guard() {
    // 会话路由 provider：主 agent 脚本（派发 + 收口 + 兜底）；
    // 子代理脚本 = 安全收口（无嵌套调用）
    let main = Arc::new(TestProvider::with_scripts(main_agent_scripts(
        serde_json::json!({ "prompt": "调研模块 A", "taskType": "analysis" }),
    )));
    let sub = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("调研完成，回报主 agent。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _main, _sub, _emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        test_options("run-main", "sess-main", "派发一个子代理"),
    )
    .await
    .expect("主 agent run 发起成功");
    resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
    wait_agent_rows_terminal(&db, "sess-main", 1, Duration::from_secs(20)).await;

    // 端到端基线：子代理 run 真实启动并收口（恰好一行子代理——嵌套
    // 未发生）
    let rows = db.load_session_agents("sess-main").unwrap();
    assert_eq!(rows.len(), 1, "嵌套派发不得产生额外子代理行");
    assert!(
        rows[0].status == "completed" || rows[0].status == "failed",
        "子代理行终态"
    );

    // 守卫兜底验证：直接经 spawner 以「存活子代理 run」为发起者再 spawn
    // → NestingDenied（T-D-02 结构化错误：所有子 Agent 由主 Agent 分配）。
    // note_depth_for_test 构造存活子代理场景（真实 spawn 的 run 已终态、
    // 记账已释放——测试面直接登记深度，避免 drive_run_loop 收口竞态）
    state
        .subagent_spawner
        .set_current_run("sess-main", "sub-run-live");
    state
        .subagent_spawner
        .note_depth_for_test("sub-run-live", 1, "sess-main");
    let req = agent_tools::tools::subagent::SubagentSpawnRequest {
        agent_id: None,
        prompt: "再派发".to_string(),
        role: None,
        capability_mode: None,
        allowed_tools: None,
        description: None,
        mode: None,
        parent_session_id: "sess-main".to_string(),
        parent_run_id: None,
        parent_tool_call_id: None,
        flow_node_id: None,
        is_composite: false,
        task_type: None,
        allowed_write_paths: None,
        display_label: None,
        model_override: None,
    };
    let err = agent_tools::tools::subagent::SubagentSpawner::spawn(&*state.subagent_spawner, &req)
        .await
        .expect_err("子代理发起 spawn 必须 NestingDenied");
    assert_eq!(err.code(), "subagent.nesting_denied");
    assert!(
        err.message().contains("所有子 Agent 由主 Agent 分配"),
        "结构化错误含编排指引：{}",
        err.message()
    );
    // 零 run：拒绝不产生新行
    assert_eq!(
        db.load_session_agents("sess-main").unwrap().len(),
        1,
        "NestingDenied 零 run"
    );
}

/// 验收 3：默认权限集端到端——analysis 无写工具（工具面裁剪，
/// write_file 调用得到 is_error 工具结果）。会话路由 provider 确定性：
/// 子代理脚本 = write_file 尝试（越界路径不写盘）+ 收口。
#[tokio::test]
async fn default_permission_sets_end_to_end() {
    // 探测文件：analysis 子代理无写工具，写盘不可能发生（probe 仅
    // 兜底断言面，不依赖工作区夹具）
    let probe =
        std::env::temp_dir().join(format!("subagent_analysis_probe_{}.md", std::process::id()));
    let _ = std::fs::remove_file(&probe);
    let main = Arc::new(TestProvider::with_scripts(main_agent_scripts(
        serde_json::json!({ "prompt": "只读调研", "taskType": "analysis" }),
    )));
    // analysis 子代理：确定性尝试 write_file（默认集无写工具 →
    // is_error；审批（ask 语义）由主 agent 裁决放行后执行）
    let sub = Arc::new(TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("尝试写文件。"),
            ProviderStreamEvent::tool_call(
                Some("c2".to_string()),
                "write_file",
                serde_json::json!({ "path": "../escape.md", "content": "x" }),
            ),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        vec![
            ProviderStreamEvent::text("写文件不可用。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let (state, db, _main, sub, _emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;
    run_task_impl(
        Arc::clone(&state),
        test_options("run-main", "sess-main", "派发 analysis 子代理"),
    )
    .await
    .expect("主 agent run 发起成功");
    // analysis 子代理的 write_file 尝试触发审批（ask 语义）→ 主 agent
    // 裁决放行 → 工具执行（unknown tool，is_error）→ 收口
    resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
    wait_agent_rows_terminal(&db, "sess-main", 1, Duration::from_secs(20)).await;

    // analysis 默认集 = 只读白名单：write_file 调用必须 is_error
    // （工具不在注册表，unknown tool 分类）——端到端工具面证据
    // （sub provider 请求全部来自子代理 run，确定性遍历）
    let sub_requests = sub.requests();
    assert!(!sub_requests.is_empty(), "analysis 子代理至少一次请求");
    let mut write_file_error = false;
    for req in &sub_requests {
        for msg in &req.messages {
            for block in &msg.blocks {
                if let AgentMessageBlock::ToolResult {
                    tool_name,
                    is_error,
                    ..
                } = block
                {
                    if tool_name == "write_file" {
                        write_file_error = *is_error;
                    }
                }
            }
        }
    }
    assert!(
        write_file_error,
        "analysis 子代理无写工具（工具结果 is_error）"
    );
    // 兜底：工作区未产生文件（无写工具的天然结果）
    assert!(!probe.exists(), "analysis 无写工具，不得写盘");
}

/// 验收 4：权限申请链路端到端——子代理 run 触发审批 → 请求载荷
/// requester_run_id = 子代理 run id → 主 agent 裁决（ApprovalGateImpl
/// resolve 入口，Mock 裁决器语义 = 测试直接裁决）。
///
/// 确定性设计：第一阶段（主 agent 派发子代理 1）收口后，直接经
/// spawner 发起子代理 run 2（不经 run_subagent 工具）——此时共享
/// TestProvider 无竞争调用，子代理 run 2 的请求确定性回退到兜底脚本
/// （write_file 越界尝试 → 触发审批 → 不写盘）。
#[tokio::test]
async fn subagent_approval_carries_requester_run_id_and_resolves() {
    // 会话路由 provider 确定性：主 agent 脚本（派发 + 收口 + 兜底）；
    // 子代理脚本 = write_file 越界尝试 + 收口（任何子代理 run 拿到都
    // 确定性触发审批且不写盘——path_escape 拒绝）
    let main = Arc::new(TestProvider::with_scripts(main_agent_scripts(
        serde_json::json!({ "prompt": "实现功能", "taskType": "implementation" }),
    )));
    let sub = Arc::new(TestProvider::with_scripts(vec![
        vec![
            ProviderStreamEvent::text("开始实现。"),
            ProviderStreamEvent::tool_call(
                Some("c2".to_string()),
                "write_file",
                serde_json::json!({ "path": "../escape.md", "content": "x" }),
            ),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        vec![
            ProviderStreamEvent::text("写文件被拒，调整方案。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 兜底（子代理 run 2 等越界调用）：write_file 尝试
        vec![
            ProviderStreamEvent::text("继续实现。"),
            ProviderStreamEvent::tool_call(
                Some("c3".to_string()),
                "write_file",
                serde_json::json!({ "path": "../escape.md", "content": "x" }),
            ),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        vec![
            ProviderStreamEvent::text("已处理。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let (state, db, _main, _sub, emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;
    // 第一阶段：主 agent 派发子代理 1（implementation）并收口全部 run
    run_task_impl(
        Arc::clone(&state),
        test_options("run-main", "sess-main", "派发 implementation 子代理"),
    )
    .await
    .expect("主 agent run 发起成功");
    resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
    wait_agent_rows_terminal(&db, "sess-main", 1, Duration::from_secs(20)).await;

    // 第二阶段：直接经 spawner 发起子代理 run 2（implementation）——
    // 确定性触发审批（requester_run_id = 子代理 run 2）
    let second = agent_tools::tools::subagent::SubagentSpawnRequest {
        agent_id: None,
        prompt: "实现功能 B".to_string(),
        role: None,
        capability_mode: None,
        allowed_tools: None,
        description: None,
        mode: None,
        parent_session_id: "sess-main".to_string(),
        parent_run_id: Some("run-main".to_string()),
        parent_tool_call_id: None,
        flow_node_id: None,
        is_composite: false,
        task_type: Some(agent_tools::tools::subagent::TaskType::Implementation),
        allowed_write_paths: None,
        display_label: None,
        model_override: None,
    };
    let spawned =
        agent_tools::tools::subagent::SubagentSpawner::spawn(&*state.subagent_spawner, &second)
            .await
            .expect("spawn 子代理 run 2 应成功");

    // 等待子代理 run 2 触发审批（approval-requested 广播含
    // requester_run_id = 子代理 run 2 id；Mock 裁决器 = 测试直接经
    // ApprovalGateImpl.resolve（主 agent 裁决面入口，I-02 校验）批准）
    let sub_run_id = spawned.subagent_run_id.clone();
    let (approved, requester_checked) = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            // 审批广播捕获：emitter 记录 JSON 信封，扫描全部载荷找
            // requester_run_id = 本 run 的 approval-requested（先发后等
            // 契约：广播在等待前发出——命中即裁决，不等待广播消费时序）
            let payloads = emitter.0.lock().unwrap().clone();
            let matched: Option<(String, serde_json::Value)> = payloads
                .iter()
                .filter(|p| p.contains("approval-requested"))
                .filter_map(|p| {
                    let value: serde_json::Value = serde_json::from_str(p).ok()?;
                    // 扁平载荷：{request: {requesterRunId, ...}, runId, type}
                    let requester = value
                        .get("request")?
                        .get("requesterRunId")?
                        .as_str()?
                        .to_string();
                    (requester == sub_run_id).then_some((requester, value))
                })
                .next();
            if let Some((requester, value)) = matched {
                // 载荷断言：requester_run_id = 子代理 run id
                let got = requester == sub_run_id;
                // 主 agent 裁决（Mock 裁决器：批准）
                let active = state
                    .active_runs
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&sub_run_id)
                    .cloned();
                if let Some(run) = active {
                    let call_id = {
                        let pending = run
                            .approval
                            .pending
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        pending.keys().next().cloned()
                    };
                    if let Some(call_id) = call_id {
                        run.approval
                            .resolve(&call_id, ApprovalDecision::Approved)
                            .await
                            .expect("主 agent 裁决应成功");
                        break (true, got);
                    }
                }
                let _ = value;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "子代理审批未在窗口内触发（approval-requested 广播缺失或 requester 不匹配）"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    };
    assert!(approved, "子代理审批必须被主 agent 裁决");
    assert!(
        requester_checked,
        "审批请求载荷必须携带 requester_run_id = 子代理 run id"
    );
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
    wait_agent_rows_terminal(&db, "sess-main", 2, Duration::from_secs(20)).await;
}

// ── R1-10 T-08：远程 run 权限模式（full-access 降级 ask + 危险工具
// 仍 NeedsApproval；D5 §9.1 / §9.2 矩阵）────────────────────────

/// 危险工具脚本（主 agent 单发 write_file 尝试 + 收口 + 兜底；
/// 越界路径不写盘——审批触发与写盘成败解耦）
fn dangerous_write_scripts() -> Vec<Vec<ProviderStreamEvent>> {
    vec![
        vec![
            ProviderStreamEvent::text("写文件。"),
            ProviderStreamEvent::tool_call(
                Some("c1".to_string()),
                "write_file",
                serde_json::json!({ "path": "../escape-r110.md", "content": "x" }),
            ),
            ProviderStreamEvent::stop(StopReason::ToolCall),
        ],
        vec![
            ProviderStreamEvent::text("写文件结果已收到。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 兜底（越界调用）：安全收口
        vec![
            ProviderStreamEvent::text("兜底。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]
}

/// ask 模式的 run 选项（远程降级后的生效模式；对齐 test_options 其余
/// 字段——主 agent run，无子代理配置）
fn ask_mode_options(run_id: &str, session_id: &str, prompt: &str) -> RunTaskOptions {
    let mut options = test_options(run_id, session_id, prompt);
    options.permission_mode = Some("ask".to_string());
    options
}

/// 轮询等待指定工具的 approval-requested 广播（R1-10 T-08 断言锚；
/// 返回触发次数——≥1；窗口内未触发则 panic——审批门缺失即红）
async fn wait_approval_requested(
    emitter: &Arc<RecordingEmitter>,
    tool_name: &str,
    window: Duration,
) -> usize {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let payloads = emitter.0.lock().unwrap().clone();
        let hits = payloads
            .iter()
            .filter(|p| p.contains("approval-requested"))
            .filter_map(|p| {
                let value: serde_json::Value = serde_json::from_str(p).ok()?;
                let name = value.get("request")?.get("toolName")?.as_str()?;
                (name == tool_name).then_some(())
            })
            .count();
        if hits > 0 {
            return hits;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "approval-requested（{tool_name}）未在窗口内触发——危险工具未走审批门即红"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// T-08 基线：ask 模式（远程降级后的生效模式）run 内危险工具仍
/// NeedsApproval——approval-requested 触发 → 裁决放行 → 工具执行 →
/// run 收口（复用 I-02 审批链测试基建）
#[tokio::test]
async fn t08_ask_mode_dangerous_tool_needs_approval() {
    let main = Arc::new(TestProvider::with_scripts(dangerous_write_scripts()));
    let sub = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("无子代理。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, _db, _main, _sub, emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        ask_mode_options("run-ask", "sess-main", "写文件（ask 模式）"),
    )
    .await
    .expect("ask 模式 run 发起成功");

    // 危险工具（write_file）必须弹审批（NeedsApproval）；未触发即红
    let hits = wait_approval_requested(&emitter, "write_file", Duration::from_secs(15)).await;
    assert!(hits >= 1, "write_file 必须至少触发一次审批");
    // 用户裁决（I-02 resolve 入口）→ 工具执行 → 收口
    resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
}

/// T-08 核心：远程 run 装配——REST 面（CoreStateBackend::run_task）
/// 申报 full-access → 装配面降级 ask（apply_remote_mode）→ run 内
/// 危险工具仍 NeedsApproval。降级失效（approval_enabled=false）则
/// 审批不触发——本测试在等待窗口内直接红
#[tokio::test]
async fn t08_remote_run_full_access_downgraded_dangerous_tool_gated() {
    let main = Arc::new(TestProvider::with_scripts(dangerous_write_scripts()));
    let sub = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("无子代理。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, _db, _main, _sub, emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;

    // 远程装配点：CoreStateBackend（REST 写面直调体）——wire 载荷
    // permissionMode=full-access（移动端申报）→ 装配面降级 ask +
    // remote-mode-downgrade 审计标记
    use crate::server::backend::ApiBackend;
    let backend = crate::core_backend::CoreStateBackend::new(Arc::clone(&state));
    backend
        .run_task(conex_types::device::RunTaskParams {
            session_id: Some("sess-main".to_string()),
            prompt: "远程 run（申报 full-access）".to_string(),
            prompt_ref: None,
            mode: Some("task".to_string()),
            cwd: None,
            permission_mode: Some(conex_types::device::PermissionMode::FullAccess),
            history: None,
            client_message_id: None,
        })
        .await
        .expect("远程 run 发起成功");

    // 降级失效即红：full-access 直通 → approval_enabled=false → 危险
    // 工具不弹审批 → 本断言超时失败
    let hits = wait_approval_requested(&emitter, "write_file", Duration::from_secs(15)).await;
    assert!(
        hits >= 1,
        "降级后 ask 模式：write_file 必须仍 NeedsApproval"
    );
    // 裁决 → 执行 → 收口（与本地 ask run 同一审批链，无远程例外分支）
    resolve_all_pending_approvals(&state, Duration::from_secs(20)).await;
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
}
/// 验收 5：kill_all 引擎侧实现（T-D-09/T-D-13 ForceCancelSink 接线）——
/// 按 subagent_run_id 定位活动 run 的 ControlBus 投递 L3 强停 + 行归一
/// failed（产出保留）。
#[tokio::test]
async fn kill_all_delivers_force_cancel_and_normalizes_rows() {
    let (state, db) = {
        let (s, d, _m, _s, _e) = subagent_state_with_providers(
            Arc::new(TestProvider::new(vec![
                ProviderStreamEvent::text("占位。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])),
            Arc::new(TestProvider::new(vec![
                ProviderStreamEvent::text("占位。"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ])),
            "deepseek-v4-flash",
        );
        (s, d)
    };
    state.run_restore().await;
    // 准备：子代理行（running）+ 活动 run（ActiveRun 挂 active_runs）
    let sub_run_id = "sub-run-kill";
    let sub_session = "sub-sess-kill";
    db.upsert_session_entry(&subagent_test_session_entry("sess-main"))
        .unwrap();
    // 子代理会话条目（run 表外键约束：start_run 需要会话行）
    db.upsert_session_entry(&subagent_test_session_entry(sub_session))
        .unwrap();
    // 子代理行落库（模拟 spawner 产物；running 状态）
    {
        let mut rows = db.load_session_agents("sess-main").unwrap();
        rows.push(conex_types::SessionAgent {
            id: "sub-kill".to_string(),
            subagent_run_id: sub_run_id.to_string(),
            parent_session_id: "sess-main".to_string(),
            parent_run_id: "run-main".to_string(),
            parent_tool_call_id: None,
            description: String::new(),
            mode: "research".to_string(),
            status: "running".to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: 1,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
            sub_session_id: None,
        });
        db.save_session_agents("sess-main", &rows).unwrap();
    }
    // 活动 run（子代理 run 的 ActiveRun 挂注册表——L3 投递目标）
    let active = build_active_run(&state, sub_session, sub_run_id).await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(sub_run_id.to_string(), Arc::clone(&active));

    // 生命周期服务（ForceCancelSink = CoreRunState 实现）
    let service = state
        .lifecycle_service()
        .expect("LocalDb 路径必须可装配生命周期服务");
    let outcome = service
        .kill_all("sess-main", "test-kill")
        .expect("kill_all 应成功");
    assert_eq!(outcome.terminated.len(), 1, "L3 强停投递成功");
    assert_eq!(outcome.terminated[0].subagent_run_id, sub_run_id);
    assert!(
        outcome.non_terminal.is_empty(),
        "活动 run 可达 → 无未终态汇总"
    );

    // 行归一 failed（产出保留：summary/messages 不动）
    let rows = db.load_session_agents("sess-main").unwrap();
    let row = rows
        .iter()
        .find(|r| r.subagent_run_id == sub_run_id)
        .unwrap();
    assert_eq!(row.status, "failed");
    assert!(row.ended_at.is_some(), "ended_at 补齐");

    // L3 强停意图已投递到目标 run 的 ControlBus（reason 携带标识）
    let intents = active
        .control_bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain();
    assert_eq!(intents.len(), 1, "恰好一条 L3 强停意图");
    assert_eq!(
        intents[0].reason.as_deref(),
        Some("subagent_force_cancel:sub-run-kill"),
        "reason 携带可观测标识（control.rs:296 语义）"
    );

    // 不可达 run（无活动实例）→ 未终态汇总（不 panic）
    let mut ghost_rows = db.load_session_agents("sess-main").unwrap();
    ghost_rows.push(conex_types::SessionAgent {
        id: "sub-ghost".to_string(),
        subagent_run_id: "sub-run-ghost".to_string(),
        parent_session_id: "sess-main".to_string(),
        parent_run_id: "run-main".to_string(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: "research".to_string(),
        status: "running".to_string(),
        summary: None,
        messages: Vec::new(),
        started_at: 1,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    });
    db.save_session_agents("sess-main", &ghost_rows).unwrap();
    let again = service
        .kill_all("sess-main", "test-kill-2")
        .expect("kill_all 应成功");
    // sub-run-kill 已 failed（不在 running 过滤面）→ 本轮仅 ghost 目标
    assert_eq!(again.terminated.len(), 0, "已终态行不在过滤面");
    assert_eq!(again.non_terminal.len(), 1, "ghost run 未投递汇总");
    assert!(again.non_terminal[0].reason.contains("未投递"));
    // ghost 行同样归一 failed
    let rows = db.load_session_agents("sess-main").unwrap();
    assert!(rows
        .iter()
        .filter(|r| r.subagent_run_id == "sub-run-ghost")
        .all(|r| r.status == "failed"));
}

// ── 30-P1 / 30-P5：run 控制面端到端 + 逃逸判定器时序 ─────────

/// 测试临时工作区（RAII 清理）。conex_test_utils 为 dev-dependency
/// 且本卡禁改 Cargo.toml——自备最小等价物（真实目录 + 真实文件，
/// 逃逸监视真实 watcher 的监视根）
struct TestWorkspace {
    path: PathBuf,
}

impl TestWorkspace {
    fn new(tag: &str) -> Self {
        let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "conex_escape_e2e_{tag}_{}_{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("临时目录创建");
        Self { path }
    }

    fn path_str(&self) -> String {
        self.path.display().to_string()
    }

    fn write_file(&self, rel: &str, content: &str) {
        std::fs::write(self.path.join(rel), content).expect("测试写文件");
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 测试状态（真实 CoreRunState + LocalDb + 注入 TestProvider 引擎；
/// run_task_impl → drive_run_loop 完整装配真实 loop；会话 s1 条目
/// 已建——start_run 外键前置）
fn run_control_test_state(
    provider: Arc<TestProvider>,
) -> (Arc<CoreRunState>, LocalDb, Arc<RecordingEmitter>) {
    // 产品默认模型（catalog 窗口 1M；DEEPCHECK-06 预算测试需小窗口模型
    // 时走 run_control_test_state_with_model）
    run_control_test_state_with_model(provider, "deepseek-v4-flash")
}

/// 已建——start_run 外键前置；显式生效模型（预算测试按 catalog 窗口
/// 选模型：qwen2-5-omni-7b → 32000，用于触发预检压缩的确定性小窗口）
fn run_control_test_state_with_model(
    provider: Arc<TestProvider>,
    model: &str,
) -> (Arc<CoreRunState>, LocalDb, Arc<RecordingEmitter>) {
    let db = LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&subagent_test_session_entry("s1"))
        .expect("会话条目");
    run_control_test_state_on_db_with_model(provider, db, model)
}

/// 在既有 db 上重建测试状态（显式跨重启 e2e 用：模拟引擎重启时
/// 复用同一 LocalDb——session_meta 键库跨实例残留，熔断计数 /
/// 定时器声明等持久化面的重启恢复测试入口；会话条目由调用方 db
/// 携带，不重复 upsert）
fn run_control_test_state_on_db(
    provider: Arc<TestProvider>,
    db: LocalDb,
) -> (Arc<CoreRunState>, LocalDb, Arc<RecordingEmitter>) {
    run_control_test_state_on_db_with_model(provider, db, "deepseek-v4-flash")
}

/// on_db 变体的显式模型版（state 构造面与
/// [Self::run_control_test_state_with_model] 共享；db 由调用方持有
/// ——跨重启链路上传给下一实例）
fn run_control_test_state_on_db_with_model(
    provider: Arc<TestProvider>,
    db: LocalDb,
    model: &str,
) -> (Arc<CoreRunState>, LocalDb, Arc<RecordingEmitter>) {
    let (bridge, emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_run_control_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(CoreRunState::new(
        Arc::new(LocalDbStore::new(db.clone())),
        snapshots,
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ));
    // 用户裁决（重试预算/上限可配置）下的测试基线：baseMs=1 让错误重试
    // 近零等待（缺省 750ms 指数退避 ×10 次 ≈ 59s，超出 30s 断言窗口）；
    // limit 保持 10 与生产一致，断言重试次数的用例经 set_run_policy 或
    // 会话键单独覆盖（后写覆盖，见 retry_backoff_injection_delays_retry）。
    state.set_run_policy(Some(crate::config::run_policy::RunPolicy {
        retry_backoff: Some(crate::config::run_policy::RetryBackoffPolicy {
            base_ms: Some(1),
            max_ms: Some(8),
            total_budget_ms: Some(60_000),
        }),
        transient_retry_limit: Some(10),
    }));
    let routed: Arc<dyn ProviderCall> = provider;
    let config = EngineProviderConfig {
        base_url: "http://test.local/v1".to_string(),
        api_key: "test-key".to_string(),
        model: model.to_string(),
        endpoint: Endpoint::ChatCompletions,
        stream: true,
        extra: BTreeMap::new(),
        // live 夹具键（qwen2-5-omni-7b 预算兜底；plans/04 §2.4 窗口只读 live）
        provider_id: Some("qwen".to_string()),
        ..Default::default()
    };
    state.engine.inject_provider_for_test(routed, config);
    (state, db, emitter)
}

/// 测试选项（带 cwd；cwd = 逃逸监视根 / 共享注册表根）
fn test_options_with_cwd(
    run_id: &str,
    session_id: &str,
    prompt: &str,
    cwd: &str,
) -> RunTaskOptions {
    RunTaskOptions {
        cwd: Some(cwd.to_string()),
        ..test_options(run_id, session_id, prompt)
    }
}

/// 轮询活动 run 句柄的终态 end_reason（真实 loop 收口后 drive_outcome
/// finalize 写入；窗口内未终态则 panic）
async fn wait_run_end_reason(active: &Arc<ActiveRun>, window: Duration) -> String {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let run = active.handle.lock().await;
        if let Some(reason) = &run.end_reason {
            return reason.clone();
        }
        drop(run);
        assert!(tokio::time::Instant::now() < deadline, "run 未在窗口内终态");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// 轮询会话事件库中的 agent-end 事件（真实 loop 收口落库；返回
/// reason——RunOutcome.reason 的持久化镜像，kebab-case）
async fn wait_run_terminal(db: &LocalDb, session_id: &str, window: Duration) -> String {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        // 收口落库经 spawn_blocking 异步写 events 表——测试轮询可能撞上
        // 写侧表锁（query_events_collect: database table is locked）；
        // 锁竞速按「未就绪」重试，写侧完成后本查询自然成功。
        let events = match db.query_events(session_id, 0, Some(500)) {
            Ok(events) => events,
            Err(_) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "run-terminal 事件未在窗口内落库"
                );
                tokio::time::sleep(Duration::from_millis(30)).await;
                continue;
            }
        };
        for event in &events {
            // G-29 事件权威：run-terminal 是唯一终态事件（03 §5.2-2，
            // 旧 agent-end/run-completed/run-failed 已删），断言只认权威形态。
            if event.event_type != "run-terminal" {
                continue;
            }
            let payload: serde_json::Value =
                serde_json::from_str(&event.payload).expect("run-terminal 载荷为合法 JSON");
            if let Some(terminal) = payload["terminal"].as_str() {
                return terminal.to_string();
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "run-terminal 事件未在窗口内落库"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// 按 **runId** 定位终态事件（跨阶段复用同一 db 的唯一正确同步点）。
///
/// `wait_run_terminal` 只按 sessionId 取**第一个** run-terminal——当同一
/// 会话上先后跑多个 run（如熔断计数跨重启用例的阶段 1/2/3）时，它会命中
/// 上一阶段遗留的旧事件，导致「本阶段 run 尚未收口」被误判为已收口
/// （实证 2026-09-15：阶段 3 的 provider 调用数读到 0，而 streak 已被
/// 上一阶段的延迟收口推到 7）。定位到具体 runId 才能把同步点钉在本阶段。
async fn wait_run_terminal_for_run(
    db: &LocalDb,
    session_id: &str,
    run_id: &str,
    window: Duration,
) -> String {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let events = match db.query_events(session_id, 0, Some(500)) {
            Ok(events) => events,
            Err(_) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "{run_id} 的 run-terminal 未在窗口内落库（事件表读锁竞速）"
                );
                tokio::time::sleep(Duration::from_millis(30)).await;
                continue;
            }
        };
        for event in &events {
            if event.event_type != "run-terminal" {
                continue;
            }
            let payload: serde_json::Value =
                serde_json::from_str(&event.payload).expect("run-terminal 载荷为合法 JSON");
            if payload["runId"].as_str() != Some(run_id) {
                continue;
            }
            if let Some(terminal) = payload["terminal"].as_str() {
                return terminal.to_string();
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{run_id} 的 run-terminal 未在窗口内落库"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}


// ── 诊断（临时）3：goal 覆盖流程键演化 dump ──
#[tokio::test]
async fn diag_goal_overwrite_dump() {
    let provider = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("x"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _emitter) = run_control_test_state(provider);
    state.run_restore().await;
    let mut old = GoalState::new("旧目标", 6, 4);
    old.current_round = 5;
    old.stalled_rounds = 2;
    old.progress_signature = Some("tools:fnv1a:bbbbbbbbbbbbbbbb".into());
    db.set_session_meta(orchestrator::goal_state::GOAL_STATE_KEY, &old.to_json())
        .expect("旧 goal_state 预置");
    let counter = Arc::new(AtomicU64::new(0));
    state.set_resume_launcher(Some(counting_launcher(Arc::clone(&counter))));
    let mut options = test_options("run-goal-diag", "s1", "请完成目标");
    options.mode = Some("goal".to_string());
    options.visible_goal = Some("新目标".to_string());
    options.max_rounds = Some(10);
    options.max_stalled_rounds = Some(3);
    run_task_impl(Arc::clone(&state), options)
        .await
        .expect("run 发起成功");
    for i in 0..50 {
        let raw = db
            .get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY)
            .ok()
            .flatten();
        match raw {
            Some(raw) => {
                let goal: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
                println!(
                    "[{i}] goal={} round={} stalled={} max={}",
                    goal["goal"], goal["current_round"], goal["stalled_rounds"], goal["max_rounds"]
                );
                if goal["current_round"].as_u64().unwrap_or(0) >= 1 {
                    return;
                }
            }
            None => println!("[{i}] 键不存在"),
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    panic!("goal advance 未写回（dump 结束）");
}

/// 轮询 goal_state 键直至收口评估写回完成。收口 advance 经 spawn_blocking
/// 异步写回（晚于 run-terminal 可见，竞速容忍）；窗口内 current_round 未
/// 推进到 >=1 则 panic（写回丢失 = 真失败）。
async fn wait_goal_round_advanced(db: &LocalDb, session_id: &str, window: Duration) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        if let Ok(Some(raw)) = db.get_session_meta(orchestrator::goal_state::GOAL_STATE_KEY) {
            if let Ok(goal) = serde_json::from_str::<serde_json::Value>(&raw) {
                if goal["current_round"].as_u64().unwrap_or(0) >= 1 {
                    return;
                }
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "goal_state 收口评估写回未在窗口内完成"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}


/// 事件桥载荷 → security-audit 操作列表（判定器审计断言用）
fn audit_operations(emitter: &RecordingEmitter) -> Vec<String> {
    emitter
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter_map(|p| {
            let value: serde_json::Value = serde_json::from_str(p).ok()?;
            if value["type"] == "security-audit" {
                Some(value["operation"].as_str().unwrap_or_default().to_string())
            } else {
                None
            }
        })
        .collect()
}

/// 轮询至事件桥出现指定 operation 的 security-audit（窗口内未到则
/// panic——不静默降级）
async fn wait_for_audit_operation(
    emitter: &Arc<RecordingEmitter>,
    operation: &str,
    window: Duration,
) {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        if audit_operations(emitter).iter().any(|op| op == operation) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "未在窗口内收到 {operation} 审计"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// 30-P1 验收（E2E-1）：L3 force_cancel 真实终止运行中的 run——
/// TestProvider 栅栏挂起流（pause 3s），L3 经 run_control_impl →
/// abort_signal + 控制总线 → 下一安全点（stream 结束）ABORT →
/// agent-end reason == aborted（真实 loop 消费，不再只置位）
#[tokio::test]
async fn l3_force_cancel_aborts_running_run() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("第一轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_pause(0, 3_000),
    );
    let (state, db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        test_options("run-l3-e2e", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("run-l3-e2e")
        .cloned()
        .expect("run 已注册");
    // L3 强停（用户取消路径：abort_signal + 总线 force_cancel 双写）
    run_control_impl(
        &state,
        "run-l3-e2e",
        "force_cancel",
        None,
        Some("用户取消".to_string()),
        None,
    )
    .await
    .expect("force_cancel 应成功");
    // 真实 loop 在下一安全点收场：agent-end reason == aborted
    let end_reason = wait_run_end_reason(&active, Duration::from_secs(30)).await;
    assert_eq!(end_reason, "aborted", "L3 强停后 run 必须以 aborted 终态");
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(
        terminal, "cancelled",
        "L3 强停后 loop 的 run-terminal 终态必须为 cancelled（权威映射 aborted→cancelled）"
    );
}

/// 30-P1 验收（E2E-1）：L2 cooperative_stop 真实到达运行中的 run——
/// 协作停止不等 abort：安全点 D1 驱动到 done，agent-end reason ==
/// stopped（独立 reason，非 aborted 非 stop）
#[tokio::test]
async fn l2_cooperative_stop_reaches_stopped() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("第一轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_pause(0, 3_000),
    );
    let (state, db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        test_options("run-l2-e2e", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("run-l2-e2e")
        .cloned()
        .expect("run 已注册");
    // L2 协作停止（入控制总线，不触发 abort_signal）
    run_control_impl(
        &state,
        "run-l2-e2e",
        "cooperative_stop",
        None,
        Some("用户停止".to_string()),
        None,
    )
    .await
    .expect("cooperative_stop 应成功");
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(
        terminal, "completed",
        "L2 协作停止后 loop 必须以 completed 终态收场（G-29 权威：Stopped 不置 cancel_requested，独立 reason 文案并入 stop，取消语义仅由 cancel_requested→cancelled 表达）"
    );
    // 协作停止不是取消：run-terminal 终态为 completed 而非 cancelled
    // （L2 不置 cancel_requested，终态本体由 drive_outcome 权威映射）
    let _ = active;
    let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
    let terminal = events
        .iter()
        .filter(|e| e.event_type == "run-terminal")
        .last()
        .expect("run-terminal 必须落库");
    let payload: serde_json::Value =
        serde_json::from_str(&terminal.payload).expect("run-terminal 载荷为合法 JSON");
    assert_eq!(
        payload["terminal"], "completed",
        "L2 协作停止归 completed 而非 cancelled：{payload}"
    );
}

/// 30-P1 验收（E2E-1）：L1 soft_inject 真实到达运行中的 run——
/// followUp 注入 → turn-complete 空闲 promote → 下一轮请求对话包含
/// 注入消息（conversation 增长，真实 loop 消费，不再只置位）
#[tokio::test]
async fn l1_soft_inject_reaches_session() {
    let provider = Arc::new(
        TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::text("第一轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            vec![
                ProviderStreamEvent::text("收到注入"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ])
        .with_pause(0, 3_000),
    );
    let (state, _db, _emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        test_options("run-l1-e2e", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    // 栅栏窗口内注入（流仍挂起，注入不打断流）
    tokio::time::sleep(Duration::from_millis(300)).await;
    run_control_impl(
        &state,
        "run-l1-e2e",
        "follow_up",
        Some("注入消息A".to_string()),
        Some("l1-test".to_string()),
        None,
    )
    .await
    .expect("follow_up 应成功");
    // 注入消息真实进入会话：下一轮 provider 请求的对话包含注入文本
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let injected = provider
            .request_message_arcs(1)
            .iter()
            .any(|m| m.text().contains("注入消息A"));
        if injected {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "注入消息未在窗口内进入会话对话"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 收口复核：run 正常收场（注入不打断流）
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("run-l1-e2e")
        .cloned()
        .expect("run 已注册");
    let end_reason = wait_run_end_reason(&active, Duration::from_secs(30)).await;
    assert_eq!(end_reason, "stop", "L1 注入不改变收场（正常 stop）");
}

/// 30-P1 验收（E2E-1）：kill_all 引擎侧实现（ForceCancelSink :1751
/// 路径）→ 目标 run 真实终止——L3 强停经同一控制总线投递，运行中
/// run 在下一安全点以 aborted 收场
#[tokio::test]
async fn kill_all_aborts_target_run() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("第一轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_pause(0, 3_000),
    );
    let (state, db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        test_options("run-kill-e2e", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("run-kill-e2e")
        .cloned()
        .expect("run 已注册");
    // kill_all 的引擎侧实现：ForceCancelSink（:1751 路径，bus L3 投递）
    use orchestrator::lifecycle::ForceCancelSink as _;
    assert!(
        state.request_force_cancel("run-kill-e2e", "test-kill-all"),
        "kill_all 投递必须命中活动 run"
    );
    let terminal = wait_run_terminal(&db, "s1", Duration::from_secs(90)).await;
    assert_eq!(
        terminal, "cancelled",
        "kill_all 后目标 run 必须以 cancelled 终态收场（权威映射 aborted→cancelled）"
    );
    let _ = active;
}

/// 30-P1 改动点 4：spawn(drive_run_loop) 的 JoinHandle 已登记——
/// 构造后句柄存在（不 await）；run 收口后 is_finished() 轮询成立
#[tokio::test]
async fn active_run_driver_joinhandle_saved() {
    let provider = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("收口"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_pause(0, 1_000),
    );
    let (state, _db, _emitter) = run_control_test_state(provider.clone());
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        test_options("run-drv-e2e", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("run-drv-e2e")
        .cloned()
        .expect("run 已注册");
    // 句柄已登记（spawn 后同步写入；ActiveRun 构造先例断言）
    assert!(
        active
            .driver
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some(),
        "spawn 后 driver JoinHandle 必须已登记"
    );
    // 收口后 is_finished() 轮询成立（不 await 句柄本身——防挂起语义）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !active.driver_finished() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "驱动任务未在窗口内收口"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// 主动探查架构验收（零被动注入回归）：并发写入工作区文件期间，
/// 系统绝不产生被动 escape_watch 注入或 undeclared-write 审计，会话保持纯净。
#[tokio::test]
async fn zero_passive_injection_during_run_e2e() {
    let ws = TestWorkspace::new("zero_inj_e2e");
    let provider = Arc::new(
        TestProvider::with_scripts(vec![vec![
            ProviderStreamEvent::text("第一轮回复完毕"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ]])
        .with_pause(0, 2_000),
    );
    let (state, _db, emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;

    run_task_impl(
        Arc::clone(&state),
        test_options_with_cwd("run-zero-inj", "s1", "发起 run", &ws.path_str()),
    )
    .await
    .expect("run 发起成功");

    // 模拟后台应用写入大量日志与数据库文件
    tokio::time::sleep(Duration::from_millis(100)).await;
    for i in 0..15 {
        ws.write_file(&format!("runtime_log_{i}.log"), "some tracing log");
        ws.write_file(&format!("sessions_db_{i}.db-wal"), "wal content");
    }

    // 等待 run 正常结束
    let active = state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("run-zero-inj")
        .cloned();
    if let Some(active) = active {
        let _ = wait_run_end_reason(&active, Duration::from_secs(10)).await;
    }

    // 验证：事件流中绝无 undeclared-write 被动审计事件
    let ops = audit_operations(&emitter);
    assert!(
        !ops.iter().any(|op| op == "undeclared-write"),
        "主动探查架构下不得产生 undeclared-write 审计：{ops:?}"
    );

    // 验证：provider 只接收到 1 次初始调用，没有发生被动注入导致的第二轮唤醒
    assert_eq!(
        provider.requests().len(),
        1,
        "必须无任何自发唤醒，只执行用户发起的单轮调用"
    );
}

/// 运行工作区根解析 helper 与 with_options 解析链同源断言
#[test]
fn workspace_root_resolution_matches_with_options() {
    let explicit = resolve_run_workspace_root(Some("C:\\work\\proj"));
    assert_eq!(explicit, PathBuf::from("C:\\work\\proj"));
    let none = resolve_run_workspace_root(None);
    let current = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    assert_eq!(none, current);
}

// ── 批 3 装配轮端到端（30 方案 §十：E2E-5/6/7）──────────────────────

/// 30-P3/P2 验收（E2E-5）：任务完成 → 主 agent 唤醒注入 + security-audit
/// 留痕——生产装配序（先 set_task_event_consumer 后 set_event_bridge）
/// 接线真实注册表：adopt 真实子进程（RunAware 装饰器注入 owner）→
/// 完成 → 引擎共享队列出现「任务 <id> 已完成，退出码 0」条目 +
/// command-exec 审计两记录（started / completed）
#[tokio::test]
async fn task_completion_wakes_main_agent_e2e() {
    let registry = bg_test_registry();
    let (bridge, emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_e2e5_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(CoreRunState::new(
        Arc::new(InMemoryStore::new()),
        snapshots,
        bridge.clone(),
        Arc::new(StatusDiagnostics::new()),
        Some(Arc::clone(&registry) as Arc<dyn BackgroundTaskManager>),
    ));
    // 生产装配序（30 §8.1：consumer 先于 bridge——EventBridgeSink
    // 构造时读取消费器快照）
    registry.set_task_event_consumer(state.task_events());
    registry.set_event_bridge(bridge, String::new());
    // owner 注入：经 RunAwareBackgroundManager 装饰器（adopt 时当前
    // run id 写入 owner_run_id——任务归属主 agent 唤醒的前提）
    state.background.set_current_run("run-e2e5");

    // adopt 真实子进程（立即退出码 0 → completed 终态；resource_monitor
    // = true——finish_task 仅对受监视任务发射 task-completed（background.rs
    // 终态通知条件），与生产「长任务资源监视」路径一致）
    let child = spawn_test_child("exit 0");
    let r = state
        .background
        .adopt(BackgroundAdoptRequest {
            child,
            command: "e2e5-cmd".to_string(),
            cwd: PathBuf::from("."),
            is_daemon: false,
            resource_monitor: true,
            owner_run_id: None,
        })
        .await
        .expect("adopt 应成功");
    let task_id = r.task_id.clone();

    // 完成 → 共享队列出现唤醒条目（轮询窗口内必达）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let queue = state.steering_queue();
        let mut queue = queue.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = queue.peek() {
            assert!(
                entry
                    .text
                    .contains(&format!("任务 {task_id} 已完成，退出码 0")),
                "唤醒条目应为完成摘要模板：{}",
                entry.text
            );
            assert_eq!(
                entry.group_id.as_deref(),
                Some(orchestrator::task_events::TASK_WAKE_GROUP_ID),
                "任务唤醒条目 group_id = task-wake"
            );
            queue.clear();
            break;
        }
        drop(queue);
        assert!(
            tokio::time::Instant::now() < deadline,
            "任务完成唤醒条目未在窗口内落入共享队列"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // security-audit command-exec 记录（started + completed 两记录直发）
    wait_for_audit_operation(&emitter, "command-exec", Duration::from_secs(30)).await;
    let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let audits: Vec<&String> = payloads
        .iter()
        .filter(|p| {
            let value: serde_json::Value = serde_json::from_str(p).ok().unwrap_or_default();
            value["type"] == "security-audit" && value["operation"] == "command-exec"
        })
        .collect();
    assert!(
        audits.len() >= 2,
        "started + completed 应各直发一条 command-exec 审计：{}",
        audits.len()
    );
    // 审计载荷携带任务 id（targets 可检索）
    assert!(
        audits.iter().any(|p| p.contains(&format!("\"{task_id}\""))),
        "审计 targets 应承载任务 id"
    );
}

/// 30-P4 验收（E2E-6）：timer/cron 到期事件经 drain 转发到事件桥——
/// 真实引擎装配（经 CoreRunState）→ 定时器到期缓冲 TimerFired / cron
/// 触发缓冲 CronFired → forward helper（main.rs drain 任务同一转发
/// 路径）→ workbench-run-event 信封（R-22 伪 runId 注入 timer-<id>/
/// cron-<id>、sequence 不注入，字段级断言）——A10 N-05 缓冲事件不再终老
#[tokio::test]
async fn timer_and_cron_events_drain_forwarded_e2e() {
    let (bridge, emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_e2e6_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let state = Arc::new(CoreRunState::new(
        Arc::new(InMemoryStore::new()),
        snapshots,
        bridge.clone(),
        Arc::new(StatusDiagnostics::new()),
        None,
    ));

    // 定时器面：注册 1 秒定时器（register 第一参为秒）→ 到期 → 生产
    // 缓冲出现 TimerFired → 转发 helper → 事件桥信封（字段级断言）
    let channel: Arc<dyn agent_tools::tools::set_timer::TimerChannel> =
        state.engine.timer_registry();
    let handle = channel
        .register(
            1,
            "e2e6 定时器".to_string(),
            conex_types::timer::TimerCondition::Never,
        )
        .await
        .expect("timer_channel 已接线，register 不应 unsupported");
    tokio::time::sleep(Duration::from_millis(1300)).await;
    let forwarded = crate::engine::forward_drained_timer_events(&state.timer_event_sink(), &bridge);
    assert_eq!(forwarded, 1, "到期 timer-fired 应经转发路径发射");
    let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let first: serde_json::Value = serde_json::from_str(&payloads[0]).expect("载荷应为合法 JSON");
    assert_eq!(first["type"], "timer-fired");
    assert_eq!(
        first["runId"],
        format!("timer-{}", handle.timer_id),
        "R-22 伪 runId：timer-加timerId（生产 handle 端到端验证）"
    );
    assert!(
        first.get("sequence").is_none(),
        "timer 事件不得注入 sequence"
    );
    assert_eq!(first["sessionId"], "");
    assert_eq!(first["prompt"], "e2e6 定时器");
    assert_eq!(first["timerId"], handle.timer_id);
    channel.cancel(&handle.timer_id).await.ok();

    // cron 面：短触发延迟（测试钩子）→ 触发 → 生产缓冲 CronFired →
    // 转发 helper → 事件桥信封（cron-fired 字段级断言）
    let registry = state.scheduler_registry().expect("装配后应为 Some");
    registry.set_fire_override_ms(40);
    let cron_id = registry
        .register(crate::sched::CronTaskInput {
            expression: "* * * * *".to_string(),
            prompt: "e2e6 cron".to_string(),
            max_iterations: Some(1),
            is_daemon: false,
        })
        .await
        .expect("cron 注册应成功");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let forwarded =
        crate::engine::forward_drained_scheduler_events(&state.scheduler_event_sink(), &bridge);
    assert_eq!(forwarded, 1, "cron-fired 应经转发路径发射");
    let payloads = emitter.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let second: serde_json::Value = serde_json::from_str(&payloads[1]).expect("载荷应为合法 JSON");
    assert_eq!(second["type"], "cron-fired");
    assert_eq!(
        second["runId"],
        format!("cron-{cron_id}"),
        "R-22 伪 runId：cron-加cronId（生产 id 端到端验证）"
    );
    assert!(
        second.get("sequence").is_none(),
        "cron 事件不得注入 sequence"
    );
    assert_eq!(second["cronId"], cron_id);
    assert_eq!(second["prompt"], "e2e6 cron");
    // 缓冲已取走（Vec::take 语义，不重复转发）
    assert!(
        state.scheduler_event_sink().drain().is_empty(),
        "转发后生产缓冲应为空"
    );
}

/// 30-P6/P7 验收（E2E-7）：create-workflow（cron 表达式）→ 注册表真实
/// 调度触发 → steering 条目入共享队列 → run 收口续 run 唤醒——下一轮
/// provider 对话包含 workflow prompt 注入（真实 loop + 真实队列 +
/// 真实注册表 + 真实判定器，全链路端到端）
#[tokio::test]
async fn workflow_cron_fire_wakes_resume_run_e2e() {
    let provider = Arc::new(
        TestProvider::with_scripts(vec![
            vec![
                ProviderStreamEvent::text("第一轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            vec![
                ProviderStreamEvent::text("收到 workflow 唤醒"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ])
        // 500ms 栅栏：确保首个 cron 触发（override 40ms）在 run 1 收口
        // 前入队——首轮收口即命中队列唤醒（注入文本落到首续 run 轮）
        .with_pause(0, 500),
    );
    let (state, db, _emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;

    // P6 装配（main.rs 装配轮同序）：共享队列 + 注册表委托注入
    let workflow_state =
        crate::workflow_commands::WorkflowCommandState::new(db.clone(), state.steering_queue());
    let registry = state.scheduler_registry().expect("装配后应为 Some");
    workflow_state.set_registry(Arc::clone(&registry));
    // 短触发延迟：create 后 ~40ms cron 触发 → 条目入共享队列
    registry.set_fire_override_ms(40);
    let view = workflow_state
        .backend()
        .create(
            "每日检查".to_string(),
            "执行检查并报告".to_string(),
            crate::workflow_commands::WorkflowScheduleWire::Cron {
                expression: "* * * * *".to_string(),
            },
            None,
            None,
            true,
        )
        .await
        .expect("workflow 创建应成功");

    // run 发起（500ms 栅栏内 cron 已触发入队——条目带 workflow prompt；
    // run 收口后 decide_idle_resume 队列源命中唤醒）
    run_task_impl(
        Arc::clone(&state),
        test_options("run-wf-e2e", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    // 收口续 run：续 run 轮 provider 请求的对话包含 workflow prompt
    // 注入（§4.8 模板：`<prompt>（cron <id> 第 N 次触发）`）。栅栏保证
    // 首 fire 先于首轮收口，注入文本落首续 run 轮（请求序号 1）；
    // 仍扫描窗口序号 0..6 兜底毫秒级竞态（首轮先于触发收口时空注入
    // 待命、文本落后续 run 轮）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut injected = false;
    loop {
        for idx in 0..6 {
            if provider
                .request_message_arcs(idx)
                .iter()
                .any(|m| m.text().contains("执行检查并报告") && m.text().contains(&view.id))
            {
                injected = true;
                break;
            }
        }
        if injected {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "workflow cron 唤醒未在窗口内到达续 run 对话"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 取消 cron：终止 40ms 反复触发（create 委托 register 为
    // max_iterations=None——每次触发替换 steering 条目并重建 sleep，
    // 属真实调度语义；取消后表内条目移除，has_active 归 false，
    // 防续 run 链无限延伸）
    registry.cancel(&view.id).await.ok();
    // 唤醒条目已批量转出（续 run 消费后队列清空——轮询窗口内；
    // 取消前最后一次触发可能刚入队，需等待当前续 run 链转出）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let empty = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if empty {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "workflow 唤醒条目应被续 run 批量转出"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 收口复核：轮询至两次 run-terminal（首轮 + 续 run 轮）落库——
    // 注入到达对话的时刻先于续 run 收口，终态落库需等待
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let events = db.query_events("s1", 0, Some(500)).expect("事件查询");
        let terminals = events
            .iter()
            .filter(|e| e.event_type == "run-terminal")
            .count();
        if terminals >= 2 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "应发生首轮 + 续 run 两次 run-terminal：{terminals}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ── D6 无人值守唤醒 e2e（审计 04 补缺：AI 休眠 → watcher 拉起链路）──

/// 验收 A1（审计 04 §3 补测建议 3）：AI 休眠（收口三源全空）后定时器
/// 注册到期 → steering 条目入队 → 真实 watcher 首轮延迟后 tick →
/// 队列非空且无活动 run → 拉起 idle-resume run → 注入文本含定时器
/// 到期提示（真实定时器注册表 + 真实共享队列 + 真实 watcher 周期任务
/// + 真实 run 链全链路端到端）
#[tokio::test]
async fn watcher_wakes_sleeping_ai_after_timer_expiry_e2e() {
    let provider = Arc::new(TestProvider::with_scripts(vec![
        // 脚本 0：首轮 run（正常收口三源全空 → AI 休眠）
        vec![
            ProviderStreamEvent::text("第一轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 脚本 1：watcher 拉起的 idle-resume run（空注入——队列条目
        // 由新 run 收口时 decide_idle_resume drain，D6 §8 决策 2 路径①）
        vec![
            ProviderStreamEvent::text("watcher 拉起轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 脚本 2：收口判定 drain 注入定时器到期文本的续 run 轮
        vec![
            ProviderStreamEvent::text("注入轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let (state, _db, _emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;
    // 首轮 run：收口三源全空 → AI 休眠（无续 run）
    run_task_impl(
        Arc::clone(&state),
        test_options("run-sleep-1", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    // 等待首轮收口（AI 休眠：无活动 run 且仅一次 provider 调用）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let active_empty = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if active_empty && provider.call_count() == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "首轮应快速收口进入 AI 休眠（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    assert_eq!(provider.call_count(), 1, "收口三源全空不续 run（AI 休眠）");
    // 注册 1s 定时器（AI 休眠后到期的唤醒事件源；到期经真实注册表
    // fire_timer → steering 条目入共享队列）
    let channel: Arc<dyn agent_tools::tools::set_timer::TimerChannel> =
        state.engine.timer_registry();
    let handle = channel
        .register(
            1,
            "提醒喝水".to_string(),
            conex_types::timer::TimerCondition::Never,
        )
        .await
        .expect("定时器注册应成功");
    // 等待定时器到期 → steering 条目入共享队列（group_id = timer-<id>）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let entry = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .peek()
            .cloned();
        if let Some(entry) = entry {
            assert_eq!(
                entry.group_id.as_deref(),
                Some(crate::timers::steering_group_id(&handle.timer_id).as_str()),
                "到期条目 group_id 应为 timer-<id>"
            );
            assert!(
                entry.text.contains("已到期"),
                "到期条目文本应含到期提示：{}",
                entry.text
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "定时器到期条目未在窗口内入队"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 真实 watcher（首轮 run 装配时已 spawn，首轮延迟 5s）到期后 tick：
    // 队列非空且无活动 run → 拉起 idle-resume run → 收口判定 drain
    // 注入 → 续 run 轮 provider 对话包含「提醒喝水（定时器 <id> 已到期）」
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut injected = false;
    loop {
        for idx in 0..8 {
            if provider
                .request_message_arcs(idx)
                .iter()
                .any(|m| m.text().contains("提醒喝水") && m.text().contains("已到期"))
            {
                injected = true;
                break;
            }
        }
        if injected {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "定时器到期唤醒未在窗口内到达续 run 对话（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 链条收束：注入轮收口后队列清空 → AI 休眠（无第 4 次调用）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let active_empty = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        let queue_empty = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if active_empty && queue_empty && provider.call_count() >= 3 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "唤醒链应收束（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        provider.call_count(),
        3,
        "唤醒链共 3 轮（首轮 + watcher 拉起轮 + 注入轮），不得继续拉起"
    );
    // 收尾：停掉后台 watcher 周期任务（防 runtime 销毁前的残留 tick）
    let watcher = state
        .wake_watchers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .cloned();
    if let Some(watcher) = watcher {
        watcher.stop();
    }
}

/// 验收 A5（审计 04 补缺 b）：watcher 拉起与收口判定并发双拉 →
/// 串行守卫拒绝后发者（幂等）——真实 run 活动期间 watcher tick 经
/// has_active_run 短路、并发 spawn 经 run_task_impl 串行守卫拒绝，
/// 仅一个 run 成立（真实 run 链 + 真实 watcher 实例）
#[tokio::test]
async fn watcher_concurrent_double_launch_only_one_run_e2e() {
    let provider = Arc::new(
        TestProvider::with_scripts(vec![
            // 脚本 0：首轮 run 保持活动 3s（栅栏窗口内并发双拉）
            vec![
                ProviderStreamEvent::text("首轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            // 脚本 1：收口判定续 run（注入定时器条目文本）
            vec![
                ProviderStreamEvent::text("续轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ])
        .with_pause(0, 3_000),
    );
    let (state, _db, _emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;
    run_task_impl(
        Arc::clone(&state),
        test_options("run-double-1", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    // 等待首轮 run 活动（active_runs 恰 1 且 provider 已调用）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let active_len = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len();
        if active_len == 1 && provider.call_count() == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "首轮 run 应进入活动态（active={active_len}）"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    // 唤醒源条目入队（定时器到期语义）
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering(
            "timer-e2e",
            "提醒喝水（定时器 t-e2e 已到期）",
            1_000_000,
        ));
    // 并发双拉：watcher tick（真实实例，has_active_run 短路）+ 收口
    // 判定同款 spawn_idle_resume_run（run_task_impl 串行守卫拒绝后发者）
    let watcher = state
        .wake_watchers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .cloned()
        .expect("首轮 run 装配已 spawn watcher");
    watcher.stop();
    tokio::join!(
        watcher.tick(),
        idle_resume::spawn_idle_resume_run(
            Arc::clone(&state),
            "s1".to_string(),
            "idle-resume",
            Vec::new(),
        ),
    );
    // 双拉均被拒：活动 run 仍恰 1 个，无第二个 run 成立（幂等）
    assert_eq!(provider.call_count(), 1, "并发双拉不得创建第二个 run");
    assert_eq!(
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len(),
        1,
        "活动 run 仍恰 1 个"
    );
    // 首轮收口（栅栏 3s 后）→ 收口判定 drain 条目 → 恰一次续 run
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let active_empty = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        let queue_empty = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if active_empty && queue_empty && provider.call_count() == 2 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "收口判定应恰一次续 run（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 续 run 注入轮对话含定时器条目原文（条目被恰一次消费）
    let injected = provider
        .request_message_arcs(1)
        .iter()
        .any(|m| m.text().contains("提醒喝水") && m.text().contains("已到期"));
    assert!(injected, "续 run 注入应含定时器到期提示");
}

/// 审计 04 补缺（c）：最小拉 run 间隔接线面——真实 watcher 实例在
/// 距上次拉起 < min_launch_interval（10s）内的重复 tick 不拉起
/// （抖动护栏；「间隔到达后放行」由 wake_watcher.rs 单测
/// watcher_min_launch_interval 以注入时钟覆盖）
#[tokio::test]
async fn watcher_min_launch_interval_blocks_retick_e2e() {
    let provider = Arc::new(TestProvider::with_scripts(vec![
        // 脚本 0：首轮 run
        vec![
            ProviderStreamEvent::text("第一轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
        // 脚本 1：watcher 拉起轮（空注入）+ 后续轮（脚本数组超出取最后）
        vec![
            ProviderStreamEvent::text("拉起轮"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ],
    ]));
    let (state, _db, _emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;
    run_task_impl(
        Arc::clone(&state),
        test_options("run-min-int-1", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    // 等待首轮收口（AI 休眠）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let active_empty = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if active_empty && provider.call_count() == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "首轮应快速收口（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let watcher = state
        .wake_watchers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .cloned()
        .expect("watcher 已装配");
    watcher.stop();
    // 唤醒源条目入队 → 手动 tick 拉起（记录上次拉起时刻）
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering(
            "timer-min",
            "提醒喝水（定时器 t-min 已到期）",
            1_000_000,
        ));
    watcher.tick().await;
    // 拉起轮收口 → 收口判定 drain → 注入轮（条目消费）→ AI 休眠
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let active_empty = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        let queue_empty = state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if active_empty && queue_empty && provider.call_count() >= 2 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "拉起轮应收口（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let settled_calls = provider.call_count();
    // 新条目入队 + 立即 tick：距上次拉起 < 10s → 不拉起（间隔护栏）
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering(
            "timer-min-2",
            "第二个到期提醒",
            1_000_001,
        ));
    watcher.tick().await;
    assert_eq!(
        provider.call_count(),
        settled_calls,
        "最小间隔内重复 tick 不得拉起"
    );
    assert!(
        !state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "未拉起的条目应保留在队列"
    );
}

/// 审计 04 补缺（d）：user_stopped 端到端——真实 L3 用户停止 →
/// 定时器到期条目入队 → watcher tick 不拉起（护栏 2「用户显式停止
/// 永不自动续」跨 run 语义）；用户新 run 清除标记 → watcher 恢复拉起
#[tokio::test]
async fn watcher_user_stopped_blocks_then_user_run_resumes_e2e() {
    let provider = Arc::new(
        TestProvider::with_scripts(vec![
            // 脚本 0：首轮 run 保持活动 3s（L3 停止窗口）
            vec![
                ProviderStreamEvent::text("首轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            // 脚本 1：用户新 run（清除停止标记）
            vec![
                ProviderStreamEvent::text("用户新 run"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
            // 脚本 2：注入轮（脚本数组超出取最后）
            vec![
                ProviderStreamEvent::text("注入轮"),
                ProviderStreamEvent::stop(StopReason::Stop),
            ],
        ])
        .with_pause(0, 3_000),
    );
    let (state, _db, _emitter) = run_control_test_state(Arc::clone(&provider));
    state.run_restore().await;
    run_task_impl(
        Arc::clone(&state),
        test_options("run-stop-1", "s1", "发起 run"),
    )
    .await
    .expect("run 发起成功");
    // 等待首轮活动 → L3 用户强停（run_control_impl → 会话级 user_stopped）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let active_len = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len();
        if active_len == 1 && provider.call_count() == 1 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "首轮 run 应进入活动态（active={active_len}）"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    run_control_impl(&state, "run-stop-1", "force_cancel", None, None, None)
        .await
        .expect("L3 强停应成功");
    // 等待首轮收口（用户停止 → 收口不续 run）+ user_stopped 置位
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let active_empty = state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty();
        if active_empty && state.is_user_stopped("s1") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "用户停止后应收口并置位会话级标记（active_empty={active_empty}）"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let watcher = state
        .wake_watchers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("s1")
        .cloned()
        .expect("watcher 已装配");
    watcher.stop();
    // 定时器到期条目入队 → watcher tick → user_stopped 不拉起
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering(
            "timer-stop",
            "提醒喝水（定时器 t-stop 已到期）",
            1_000_000,
        ));
    watcher.tick().await;
    assert_eq!(provider.call_count(), 1, "用户停止后 watcher 不得拉起 run");
    assert!(
        !state
            .pending_queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "未拉起的到期条目应保留在队列"
    );
    // 用户新 run（mode=task → 装配清除 user_stopped）→ 收口判定
    // drain 到期条目 → 注入轮对话含到期提示
    run_task_impl(
        Arc::clone(&state),
        test_options("run-resume-1", "s1", "用户新消息"),
    )
    .await
    .expect("用户新 run 发起成功");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if provider.call_count() >= 3 && !state.is_user_stopped("s1") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "用户新 run 应清除标记并消费到期条目（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 到期条目已消费（经新 run 收口判定注入轮）
    let injected = (0..4).any(|idx| {
        provider
            .request_message_arcs(idx)
            .iter()
            .any(|m| m.text().contains("提醒喝水") && m.text().contains("已到期"))
    });
    assert!(injected, "到期条目应被新 run 收口判定注入");
    // 恢复后 watcher 可拉起：新条目入队 + tick → 拉起（清除标记生效）
    state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .enqueue(SteeringInputEntry::steering(
            "timer-resume",
            "恢复后的到期提醒",
            1_000_002,
        ));
    let before = provider.call_count();
    watcher.tick().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        if provider.call_count() > before {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "清除标记后 watcher 应恢复拉起（call_count={}）",
            provider.call_count()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ── 15-T-6（裁决 D9）：审计路由注册/收口注销（run 生命周期面）──

/// run 启动注册 → drive_run_loop 收口强制注销（注册表无残留断言：
/// 审计路由随 run 生命周期不泄漏；与 escape_watch 句柄同生命周期
/// 收口对齐）。注册走与 run_task_impl 同构的 BridgeAuditSink 装配，
/// 收口走真实 drive_run_loop 终态路径。
#[tokio::test]
async fn audit_sink_route_registered_at_run_start_unregistered_on_close() {
    let (state, _registry) = state_with_background();
    let session_id = "audit-sink-s1";
    let run_id = "audit-sink-r1";
    let active = build_active_run(&state, session_id, run_id).await;
    // 模拟 run_task_impl 装配：run 启动注册（BridgeAuditSink 包装
    // 同一 run 级桥——与生产装配同构；持久化通道为测试占位）
    let (_audit_tx, _audit_rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    let bridge_audit = Arc::new(BridgeAuditSink::new(
        Arc::clone(&active.bridge),
        run_id.to_string(),
        _audit_tx,
    ));
    state
        .engine
        .audit_sink()
        .register(session_id, bridge_audit as AuditSink);
    assert_eq!(
        state.engine.audit_sink().route_count(),
        1,
        "run 启动后会话路由应已注册"
    );
    // 驱动 run 终态（真实 drive_run_loop 收口路径）
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.to_string(), Arc::clone(&active));
    drive_run_loop(
        Arc::clone(&state),
        active,
        Box::new(TestProducer::new(canned_outcome())),
    )
    .await;
    // 收口注销：注册表无残留
    assert_eq!(
        state.engine.audit_sink().route_count(),
        0,
        "run 收口后审计路由必须注销（防 session 泄漏）"
    );
}

/// 会话串行守卫下重复 run：前一 run 注册被后一 run 覆盖，收口后
/// 注册表整体清空（多 run 并发路由注册者覆盖语义 + 收口注销）
#[tokio::test]
async fn audit_sink_route_cleared_after_consecutive_runs() {
    let (state, _registry) = state_with_background();
    // 第一 run 注册
    let run_1 = build_active_run(&state, "audit-sink-s2", "audit-sink-r2a").await;
    let (_tx_1, _rx_1) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    state.engine.audit_sink().register(
        "audit-sink-s2",
        Arc::new(BridgeAuditSink::new(
            Arc::clone(&run_1.bridge),
            "audit-sink-r2a".to_string(),
            _tx_1,
        )) as AuditSink,
    );
    // 第二 run 覆盖注册（后注册者覆盖语义）
    let run_2 = build_active_run(&state, "audit-sink-s2", "audit-sink-r2b").await;
    let (_tx_2, _rx_2) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    state.engine.audit_sink().register(
        "audit-sink-s2",
        Arc::new(BridgeAuditSink::new(
            Arc::clone(&run_2.bridge),
            "audit-sink-r2b".to_string(),
            _tx_2,
        )) as AuditSink,
    );
    assert_eq!(state.engine.audit_sink().route_count(), 1);
    // 收口两个 run（各走一次真实 drive_run_loop 终态路径）
    for (run_id, active) in [("audit-sink-r2a", run_1), ("audit-sink-r2b", run_2)] {
        state
            .active_runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(run_id.to_string(), Arc::clone(&active));
        drive_run_loop(
            Arc::clone(&state),
            active,
            Box::new(TestProducer::new(canned_outcome())),
        )
        .await;
    }
    // 收口注销幂等 + 注册表无残留
    assert_eq!(
        state.engine.audit_sink().route_count(),
        0,
        "连续 run 收口后注册表必须清空"
    );
}

// ── L4（F12）：security-audit 落库接线（append_event 持久化）──

/// 测试用 security-audit 事件（delete 操作；形状对齐
/// agent-tools audit.rs security_audit_event 构造器）
fn audit_delete_event(session_id: &str, decision: SecurityAuditDecision) -> AgentEvent {
    agent_tools::audit::security_audit_event(
        session_id,
        SecurityAuditOperation::Delete,
        vec!["a.txt".to_string()],
        ImpactAssessment {
            file_count: 1,
            total_size_bytes: 0,
            directory_count: 0,
            cross_directory: false,
            flagged: false,
        },
        decision,
        None,
    )
}

/// 桥接审计 sink 双轨发射：emit → 实时广播（缓冲桥）+ 持久化通道
/// （worker 按发射序落库）——广播保实时、落库保审计底账并存
#[test]
fn bridge_audit_sink_broadcasts_and_queues_persistence() {
    let (bridge, emitter) = recording_bridge();
    let buffered = Arc::new(BufferedRunEventBridge::new(bridge, "run-audit"));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<AgentEvent>();
    let sink = BridgeAuditSink::new(Arc::clone(&buffered), "run-audit".to_string(), tx);
    sink.emit(&audit_delete_event("s1", SecurityAuditDecision::Blocked));

    // 实时轨：缓冲桥收到并冲刷（记录发射器一条 security-audit 信封）
    let payloads = emitter.0.lock().unwrap().clone();
    assert_eq!(payloads.len(), 1, "实时广播一条");
    let v: serde_json::Value = serde_json::from_str(&payloads[0]).expect("载荷为合法 JSON");
    assert_eq!(v["type"], "security-audit");
    assert_eq!(v["decision"], "blocked");

    // 持久化轨：同一事件已入通道（worker 按序 reserve + append_event）
    let received = rx.try_recv().expect("审计事件应进入持久化通道");
    assert!(
        matches!(received, AgentEvent::SecurityAudit { .. }),
        "持久化通道应收到 security-audit 事件"
    );
}

/// L4（F12）端到端：审计事件落库——run 内经路由 sink 发射
/// security-audit → run 收口后 events 表可读回（sequence 分配 +
/// 载荷保真；实时广播与落库底账双轨并存）
#[tokio::test]
async fn security_audit_persists_into_events_table() {
    // provider 脚本暂停 2s：保证 run 活动窗口内发射审计事件
    // （路由注册在 spawn 前同步完成，窗口内发射必达桥）
    let main = Arc::new(
        TestProvider::new(vec![
            ProviderStreamEvent::text("正在执行任务。"),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
        .with_pause(0, 2_000),
    );
    let sub = Arc::new(TestProvider::new(vec![
        ProviderStreamEvent::text("调研完成。"),
        ProviderStreamEvent::stop(StopReason::Stop),
    ]));
    let (state, db, _main, _sub, emitter) =
        subagent_state_with_providers(main, sub, "deepseek-v4-flash");
    state.run_restore().await;

    // 完整 run_task_impl → drive_run_loop（run 启动注册审计路由）
    run_task_impl(
        Arc::clone(&state),
        test_options("run-audit-1", "sess-main", "执行一次安全审计任务"),
    )
    .await
    .expect("run 发起成功");

    // run 活动窗口内：经路由型审计 sink 发射工具级 security-audit
    //（模拟 shell/delete 审计；run 级 BridgeAuditSink 承接 → 实时
    // 广播 + 持久化通道）
    state.engine.audit_sink().emit(&audit_delete_event(
        "sess-main",
        SecurityAuditDecision::Denied,
    ));

    // 等待 run 收口（收口处 await 审计落库 worker 排空；此处轮询
    // 兜底驱动任务与测试主线的微小竞态窗口）
    wait_all_runs_terminal(&state, Duration::from_secs(30)).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let (audit_sequence, audit_payload) = loop {
        let events = db
            .query_events("sess-main", 0, Some(200))
            .expect("事件查询");
        if let Some(found) = events
            .iter()
            .find(|e| e.event_type == "security-audit")
            .map(|e| (e.sequence, e.payload.clone()))
        {
            break found;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "审计事件未在窗口内落库"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    };

    // 1. 审计底账：events 表可读回（append_event 持久化 + sequence 分配）
    assert!(
        audit_sequence >= 1,
        "审计事件应有分配的 sequence：{audit_sequence}"
    );
    let payload: serde_json::Value =
        serde_json::from_str(&audit_payload).expect("落库载荷为合法 JSON");
    assert_eq!(payload["decision"], "denied", "落库载荷决策保真");

    // 2. 实时轨并存：同一审计事件也经缓冲桥广播（前端审计面板可见）
    let broadcast = emitter.0.lock().unwrap().clone();
    assert!(
        broadcast.iter().any(|p| {
            serde_json::from_str::<serde_json::Value>(p)
                .map(|v| v["type"] == "security-audit")
                .unwrap_or(false)
        }),
        "实时广播应与落库并存（广播保实时、落库保底账）"
    );
}

// ── 审计 01 W1：任务连续性三通道生产装配（kill_subagent /
//    send_message 工具面）───────────────────────────────────────

/// 测试助手：构造并登记活动 run（子代理配置可注入——审计 01 W1
/// 通道测试用；装配面与 build_active_run 对齐，active_runs 登记由
/// 本函数完成。ActiveRun 字段不可经 Arc 修改，故整构造复制）。
async fn insert_continuity_run(
    state: &CoreRunState,
    session_id: &str,
    run_id: &str,
    subagent: Option<crate::subagent_spawner::SubagentRunConfig>,
) -> Arc<ActiveRun> {
    let handle = Arc::new(tokio::sync::Mutex::new(
        state
            .run_manager
            .start_run(session_id, run_id)
            .await
            .expect("start_run"),
    ));
    let queue = Arc::new(tokio::sync::Mutex::new(EventQueue::new(
        state.store.clone(),
        0,
        None,
    )));
    let bridge = Arc::new(BufferedRunEventBridge::new(
        state.bridge.clone(),
        run_id.to_string(),
    ));
    let broadcast_bridge = Arc::clone(&bridge);
    let broadcast_run_id = run_id.to_string();
    let broadcast = Box::new(move |event: AgentEvent| {
        let envelope = AgentEventEnvelope::new(event, Some(broadcast_run_id.clone()), None);
        broadcast_bridge.emit(&envelope);
        broadcast_bridge.flush();
    });
    let approval = Arc::new(ApprovalGateImpl::new(
        run_id.to_string(),
        session_id.to_string(),
        None,
        broadcast,
        Arc::clone(&handle),
        state.store.clone(),
        None,
    ));
    let active = Arc::new(ActiveRun {
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        handle,
        queue,
        control_bus: Arc::new(Mutex::new(ControlBus::new())),
        abort_signal: AbortSignal::new(),
        approval,
        bridge,
        delta_sink_active: true,
        driver: Mutex::new(None),
        user_touched: AtomicBool::new(false),
        subagent,
        audit_persist: Mutex::new(None),
    });
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.to_string(), Arc::clone(&active));
    active
}

/// 测试用会话级 ToolContext（session_id 覆盖——通道按会话定位主 run
/// 环，须与活动 run 会话一致；对齐生产装配的按会话 ToolContext）
fn continuity_tool_context(session_id: &str) -> agent_tools::context::ToolContext {
    agent_tools::context::ToolContext {
        session_id: session_id.to_string(),
        ..agent_tools::context::create_mock_tool_context()
    }
}

/// E2E：finalize_continuity_channels 装配后 send_message(target=self)
/// 在无活动 run 时走 PendingMessageQueue 兜底——条目 group_id=
/// main-agent-msg、steering 标记、文本保真；工具信封 delivered/messageId。
#[tokio::test]
async fn continuity_finalize_wires_send_message_self_queue_fallback() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    state.finalize_continuity_channels();
    let tool = state
        .engine
        .tool_registry()
        .get(agent_tools::tools::send_message::SEND_MESSAGE_TOOL_NAME)
        .expect("send_message 已注册");
    let ctx = continuity_tool_context("sess-main");
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "target": "self",
                "message": "记住：下一轮继续调研 X",
            }),
        )
        .await
        .expect("通道已装配，target=self 不应失败");
    assert_eq!(out["target"], "self");
    assert_eq!(out["delivered"], true);
    assert_eq!(out["ring"], "follow_up", "缺省 follow_up（不打断当前 run）");
    let message_id = out["messageId"].as_str().expect("messageId 应为字符串");
    assert!(
        message_id.starts_with("main-agent-msg-"),
        "消息 id 前缀：{message_id}"
    );
    // 兜底队列：无活动 run → PendingMessageQueue 条目（下一 run 消费）
    let queue = state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    assert_eq!(queue.len(), 1, "无活动 run 时应入队兜底");
    let entry = queue.peek().expect("队首条目");
    assert_eq!(entry.group_id.as_deref(), Some("main-agent-msg"));
    assert!(entry.is_steering, "兜底条目为 steering（容量挤占保护）");
    assert_eq!(entry.text, "记住：下一轮继续调研 X");
    assert_eq!(entry.id, message_id, "条目 id 沿用工具返回的 messageId");
}

/// E2E：send_message(target=subagent) 送达目标子代理 run 的 L1 steer
/// 环——恰 1 条意图、kind=Steer、reason=subagent_inject:<id>、文本
/// 保真、无 L2/L3；生产 ControlBusResolver 接线后 wait_channel.inject
/// 同通道可用；目标不可达 → 结构化 subagent.not_found。
#[tokio::test]
async fn continuity_finalize_wires_send_message_subagent_steer() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    state.finalize_continuity_channels();
    let subagent_run = insert_continuity_run(
        &state,
        "sess-main",
        "sub-run-1-0",
        Some(crate::subagent_spawner::SubagentRunConfig {
            subagent_id: "sub-1-0".to_string(),
            subagent_run_id: "sub-run-1-0".to_string(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 0,
        }),
    )
    .await;
    let tool = state
        .engine
        .tool_registry()
        .get(agent_tools::tools::send_message::SEND_MESSAGE_TOOL_NAME)
        .expect("send_message 已注册");
    let ctx = continuity_tool_context("sess-main");
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "target": "subagent",
                "subagentId": "sub-1-0",
                "message": "优先低风险改动",
            }),
        )
        .await
        .expect("目标子代理可达，注入不应失败");
    assert_eq!(out["target"], "subagent");
    assert_eq!(out["delivered"], true);
    assert_eq!(
        out["ring"], "steer",
        "target=subagent 恒 steer（L1 注入语义）"
    );
    // 目标 run 总线：恰 1 条 L1 steer 意图（无 L2/L3）
    let intents = subagent_run
        .control_bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain();
    assert_eq!(intents.len(), 1, "应恰好一条控制意图");
    assert_eq!(intents[0].kind, session_loop::control::ControlKind::Steer);
    assert_eq!(
        intents[0].reason.as_deref(),
        Some("subagent_inject:sub-1-0"),
        "reason 携带可观测标识"
    );
    let text = intents[0]
        .message
        .as_ref()
        .expect("注入意图必须携带消息")
        .blocks
        .iter()
        .find_map(|b| match b {
            conex_types::message::AgentMessageBlock::Text { text } => Some(text.as_str()),
            _ => None,
        });
    assert_eq!(text, Some("优先低风险改动"));
    // 生产 ControlBusResolver 接线：wait_channel 的 inject 同通道可用
    // （取代 NoopControlBusResolver——装配前 inject 恒 InjectFailed）
    state
        .engine
        .wait_channel()
        .inject("sub-1-0", "wait 期间调整")
        .await
        .expect("生产解析器应能定位目标 run（Noop 已被板卡取代）");
    let intents2 = subagent_run
        .control_bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain();
    assert_eq!(intents2.len(), 1);
    assert_eq!(intents2[0].kind, session_loop::control::ControlKind::Steer);
    // 目标不可达 → 结构化 subagent.not_found（不静默、不 panic）
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({
                "target": "subagent",
                "subagentId": "ghost-sub",
                "message": "不应送达",
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), conex_types::error::codes::SUBAGENT_NOT_FOUND);
}

/// E2E：send_message(target=self) 在活动主 run 存活时经主 run 自己
/// ControlBus 入环——followUp（缺省）/ steer（urgency=steer）两环；
/// 消息 metadata.source="main-agent"、reason=send_message_tool；
/// **不标记 user_touched**（收口不因此抑制 idle 续 run）。
#[tokio::test]
async fn continuity_finalize_wires_send_message_self_follow_up_ring() {
    let state = core_state_with_store(Arc::new(InMemoryStore::new()));
    state.finalize_continuity_channels();
    let main_run = insert_continuity_run(&state, "sess-main", "run-main", None).await;
    let tool = state
        .engine
        .tool_registry()
        .get(agent_tools::tools::send_message::SEND_MESSAGE_TOOL_NAME)
        .expect("send_message 已注册");
    let ctx = continuity_tool_context("sess-main");
    // 缺省 urgency → followUp 环（仅 idle promote 消费，不打断当前 run）
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "target": "self",
                "message": "记住：继续调研 Y",
            }),
        )
        .await
        .expect("活动主 run 存活，消息应入 followUp 环");
    assert_eq!(out["ring"], "follow_up");
    // urgency=steer → steer 环（下一安全点注入，当前 run 继续）
    tool.execute(
        &ctx,
        serde_json::json!({
            "target": "self",
            "message": "先修 X 再继续",
            "urgency": "steer",
        }),
    )
    .await
    .expect("urgency=steer 应入 steer 环");
    // 主 run 总线：两条意图（followUp + steer），消息元数据保真
    let intents = main_run
        .control_bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain();
    assert_eq!(intents.len(), 2);
    assert_eq!(
        intents[0].kind,
        session_loop::control::ControlKind::FollowUp
    );
    assert_eq!(intents[1].kind, session_loop::control::ControlKind::Steer);
    assert_eq!(intents[0].reason.as_deref(), Some("send_message_tool"));
    assert_eq!(intents[1].reason.as_deref(), Some("send_message_tool"));
    for intent in &intents {
        let msg = intent.message.as_ref().expect("消息意图必须携带消息");
        assert_eq!(msg.role, conex_types::message::AgentMessageRole::User);
        let metadata = msg.metadata.as_ref().expect("消息应带来源标记");
        assert_eq!(
            metadata.get("source").and_then(|s| s.as_str()),
            Some("main-agent"),
            "来源标记 metadata.source=main-agent（与用户消息区分）"
        );
    }
    let text = intents[0]
        .message
        .as_ref()
        .expect("消息")
        .blocks
        .iter()
        .find_map(|b| match b {
            conex_types::message::AgentMessageBlock::Text { text } => Some(text.as_str()),
            _ => None,
        });
    assert_eq!(text, Some("记住：继续调研 Y"));
    // 不标记 user_touched：主 agent 自发消息不算「用户交互」（收口
    // 不因此抑制 idle 续 run——core_run_commands.rs:2517-2519 语义）
    assert!(
        !main_run.user_touched.load(Ordering::SeqCst),
        "send_message 路径恒不标记 user_touched"
    );
    // 队列零新增（run 存活时走环注入，不落兜底队列）
    let queue = state
        .pending_queue
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    assert!(queue.is_empty(), "run 存活时消息入环，不写兜底队列");
}

/// E2E：kill_subagent 工具经生产通道三态——缺行 → 结构化
/// subagent.not_found；running 行 + 活动 run → killed + L3 强停意图 +
/// 行归一 failed；已终态行 → alreadyTerminal 幂等（无投递、不覆写）。
#[tokio::test]
async fn continuity_kill_channel_lifecycle_paths() {
    let db = LocalDb::open_in_memory().expect("内存库");
    // 会话条目前置（session_agents 外键约束；对齐子代理 e2e 装配）
    db.upsert_session_entry(&subagent_test_session_entry("sess-main"))
        .expect("会话条目");
    let state = core_state_with_store(Arc::new(LocalDbStore::new(db.clone())));
    state.finalize_continuity_channels();
    let tool = state
        .engine
        .tool_registry()
        .get(agent_tools::tools::kill_subagent::SUBAGENT_KILL_TOOL_NAME)
        .expect("kill_subagent 已注册");
    let ctx = continuity_tool_context("sess-main");
    // ① 缺行 → subagent.not_found（结构化错误码）
    let err = tool
        .execute(&ctx, serde_json::json!({ "subagentId": "ghost" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), conex_types::error::codes::SUBAGENT_NOT_FOUND);
    // ② running 行 + 活动 run → killed：L3 强停意图 + 行归一 failed
    let row = conex_types::SessionAgent {
        id: "sub-1-0".to_string(),
        subagent_run_id: "sub-run-1-0".to_string(),
        parent_session_id: "sess-main".to_string(),
        parent_run_id: "run-main".to_string(),
        parent_tool_call_id: None,
        description: String::new(),
        mode: "research".to_string(),
        status: "running".to_string(),
        summary: None,
        messages: Vec::new(),
        started_at: 1_000,
        ended_at: None,
        depth: Some(1),
        subagent_path_json: None,
        task_type: None,
        display_label: None,
        allowed_write_paths_json: None,
        sub_session_id: None,
    };
    db.upsert_session_agent(&row).expect("行落库");
    let subagent_run = insert_continuity_run(
        &state,
        "sess-main",
        "sub-run-1-0",
        Some(crate::subagent_spawner::SubagentRunConfig {
            subagent_id: "sub-1-0".to_string(),
            subagent_run_id: "sub-run-1-0".to_string(),
            parent_session_id: "sess-main".to_string(),
            task_type: None,
            allowed_write_paths: None,
            output_dir: None,
            started_at_ms: 1_000,
        }),
    )
    .await;
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "subagentId": "sub-1-0", "reason": "目标不可恢复" }),
        )
        .await
        .expect("running 行 + 活动 run 应 killed");
    assert_eq!(out["subagentId"], "sub-1-0");
    assert_eq!(out["subagentRunId"], "sub-run-1-0");
    assert_eq!(out["outcome"], "killed");
    assert_eq!(
        out["forceCancelDelivered"], true,
        "活动 run 存在，L3 应实际投递"
    );
    let intents = subagent_run
        .control_bus
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .drain();
    assert_eq!(intents.len(), 1, "应恰好一条 L3 强停意图");
    assert_eq!(
        intents[0].kind,
        session_loop::control::ControlKind::ForceCancel
    );
    assert_eq!(
        intents[0].reason.as_deref(),
        Some("subagent_force_cancel:sub-run-1-0"),
        "reason 携带可观测标识"
    );
    let rows = db.load_session_agents("sess-main").expect("读行");
    let row = rows.iter().find(|a| a.id == "sub-1-0").expect("行存在");
    assert_eq!(row.status, "failed", "行归一 failed");
    assert!(row.ended_at.is_some(), "ended_at 补齐");
    // ③ 已终态行再 kill → alreadyTerminal 幂等（不投递、不覆写）
    let out2 = tool
        .execute(&ctx, serde_json::json!({ "subagentId": "sub-1-0" }))
        .await
        .expect("已终态 kill 应幂等成功");
    assert_eq!(out2["outcome"], "alreadyTerminal");
    assert_eq!(out2["forceCancelDelivered"], false);
    let rows2 = db.load_session_agents("sess-main").expect("读行");
    let row2 = rows2.iter().find(|a| a.id == "sub-1-0").expect("行存在");
    assert_eq!(row2.status, "failed");
    assert_eq!(
        row2.ended_at, row.ended_at,
        "幂等路径不覆写 ended_at（保留终态审计事实）"
    );
}

// ── E2 F4（07 §3 卡 C）：core_compact_now 手动压缩命令 ──────────────

/// F4/F5 测试辅助：构造超预算对话（N 条大消息；ASCII 约 4 字符/token，
/// 8000 字符 ≈ 2000 token/条；15 条 ≈ 30k token ≈ 窗口 64000 的 47%）
fn big_llm_conversation(n: usize) -> Vec<Arc<AgentMessage>> {
    let mut messages = vec![Arc::new(amsg(
        "system-1",
        AgentMessageRole::System,
        vec![text_block("系统提示词段")],
    ))];
    for i in 0..n {
        let role = if i % 2 == 0 {
            AgentMessageRole::User
        } else {
            AgentMessageRole::Assistant
        };
        messages.push(Arc::new(amsg(
            &format!("m{i}"),
            role,
            vec![text_block(&"x".repeat(8000))],
        )));
    }
    messages
}

/// F4：手动压缩往返——缓存对话替换 + Manual 事件 + 块表落库 + 返回载荷
#[tokio::test]
async fn compact_now_manual_roundtrip_replaces_cache_emits_events_and_writes_block() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db.clone()));
    let state = core_state_with_store(store);
    inject_fake_summarizer(&state);
    // 预置超预算对话（缓存路径：引擎权威增量；30 条 ≈ 60k token）
    let messages = big_llm_conversation(30);
    let history: Vec<HistoryMessage> = messages
        .iter()
        .map(|m| to_history_message(m.as_ref()))
        .collect();
    state.session_history.store("s1", history);

    // 显式目标预算 40000（≥ 下限 16384+20000，且 < 60k 对话 → 必压缩；
    // 测试引擎的生效窗口不参与计算，断言确定性）
    let result = compact_now_impl(&state, "s1", Some(40_000))
        .await
        .expect("手动压缩成功");
    assert!(
        result.tokens_before > result.tokens_after,
        "压缩后 token 下降"
    );
    assert!(result.dropped > 0, "有消息被压缩");
    assert_eq!(
        result.summary_state, "committed",
        "LLM 摘要成功 → committed"
    );

    // 缓存被压缩后序列替换（下次 run 装配即用压缩后对话）
    let cached = state.session_history.get("s1").expect("缓存被替换");
    assert!(
        cached.iter().any(|m| m.id.starts_with("compacted-summary")),
        "缓存含压缩摘要消息"
    );
    assert!(cached.len() < 31, "压缩后消息条数下降");

    // Manual 事件落库（Start + End；envelope 载荷含 result.trigger=manual）
    let events = db.query_events("s1", 0, None).unwrap();
    let types: Vec<&str> = events.iter().map(|e| e.event_type.as_str()).collect();
    assert!(
        types.contains(&"context-compression-start"),
        "Start 事件落库"
    );
    assert!(types.contains(&"context-compression-end"), "End 事件落库");
    let end_payload: serde_json::Value = serde_json::from_str(
        &events
            .iter()
            .find(|e| e.event_type == "context-compression-end")
            .unwrap()
            .payload,
    )
    .unwrap();
    assert_eq!(end_payload["result"]["trigger"], "manual", "trigger=Manual");

    // 块表落库（details 携带块语义键；state=committed）
    let block = db
        .get_block("s1", "compacted-summary-1-1")
        .unwrap()
        .unwrap();
    assert_eq!(block.block_id, "compacted-summary-1-1");
    assert_eq!(block.state, conex_db::BlockState::Committed);
    assert!(block.summary_is_llm, "committed ⇒ LLM 摘要");
}

/// F4：busy 拒绝——活动 run 存在时压缩命令返回结构化错误（不打断活动流）
#[tokio::test]
async fn compact_now_rejects_busy_session() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    inject_fake_summarizer(&state);
    let active = build_active_run(&state, "s1", "run-1").await;
    state
        .active_runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("run-1".to_string(), active);
    let error = compact_now_impl(&state, "s1", None).await.unwrap_err();
    assert!(
        error.to_string().contains("正在运行"),
        "busy 拒绝文案：{error}"
    );
}

/// F4：目标 token 校验——低于 reserve + keep_recent 下限 → InvalidInput
#[tokio::test]
async fn compact_now_validates_target_tokens() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    inject_fake_summarizer(&state);
    let error = compact_now_impl(&state, "s1", Some(1000))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("低于下限"), "下限护栏：{error}");
}

/// F4：无 Summarizer → 结构化错误「LLM 摘要不可用，未压缩」（F1 L1）
#[tokio::test]
async fn compact_now_rejects_without_summarizer() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    state.set_summarizer_factory(None);
    let messages = big_llm_conversation(30);
    let history: Vec<HistoryMessage> = messages
        .iter()
        .map(|m| to_history_message(m.as_ref()))
        .collect();
    state.session_history.store("s1", history);
    let error = compact_now_impl(&state, "s1", None).await.unwrap_err();
    assert!(
        error.to_string().contains("LLM 摘要不可用"),
        "无 Summarizer 错误：{error}"
    );
}

/// F4：无切割点（对话过短）→ 结构化错误（不破坏对话）
#[tokio::test]
async fn compact_now_rejects_noop_short_conversation() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    inject_fake_summarizer(&state);
    let messages = vec![
        Arc::new(amsg(
            "system-1",
            AgentMessageRole::System,
            vec![text_block("系统")],
        )),
        Arc::new(amsg("m0", AgentMessageRole::User, vec![text_block("你好")])),
    ];
    let history: Vec<HistoryMessage> = messages
        .iter()
        .map(|m| to_history_message(m.as_ref()))
        .collect();
    state.session_history.store("s1", history);
    let error = compact_now_impl(&state, "s1", None).await.unwrap_err();
    assert!(
        error.to_string().contains("无合法切割点"),
        "noop 错误：{error}"
    );
}

// ── E2 F5（07 §4 卡 D）：分阶段总结壳层接线 ────────────────────────

/// F5：里程碑触发——阈值达标即产出 stage-1 总结（存储 + checkpoint
/// 落载荷）；重复触发抑制（已触发集合跨 run 持久，同比例重评不新增）。
/// 阈值经 session_meta `compact_stage_ratios` 收敛到 [0.001, 0.999]：
/// 测试引擎生效窗口不定（目录兜底 64k~500k），30k token 对话比例
/// ∈ [0.06, 0.47] 恒 ≥ 0.001 且 < 0.999——首轮触发 stage-1、二轮抑制
/// （07 §4.4 测试 4「compact_stage_ratios 可配」语义）。
#[tokio::test]
async fn stage_milestone_triggers_once_and_suppresses_repeat() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta("compact_stage_ratios", "[0.001, 0.999]")
        .unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    inject_fake_summarizer(&state);
    // 会话树（checkpoint 落载荷面）
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    // 15 条 ≈ 30k token（任意窗口下比例 ∈ [0.06, 0.47] → 命中 stage-1）
    let messages = big_llm_conversation(15);
    let active = build_active_run(&state, "s1", "run-s1").await;

    evaluate_stage_milestones(&state, &active, "s1", &messages).await;
    assert_eq!(
        stage_triggered_indices(&state, "s1"),
        vec![0],
        "stage-1 已触发"
    );
    let summaries = stored_stage_summaries(&state, "s1");
    assert_eq!(summaries.len(), 1, "产出 1 条阶段总结");
    assert_eq!(summaries[0].0, "stage-1", "tier = stage-1");
    assert!(summaries[0].1.contains("阶段"), "md 渲染含 tier 标注头");
    // checkpoint 落载荷（target ← goal / next ← nextSteps）
    {
        let trees = state.session_trees.lock().unwrap();
        let tree = trees.get("s1").unwrap().lock().unwrap();
        match tree.read_leaf_checkpoint(None) {
            conex_types::LeafCheckpointState::Present(payload) => {
                assert_eq!(payload.target, "测试目标", "target ← goal");
                assert_eq!(
                    payload.next,
                    vec!["下一步一".to_string()],
                    "next ← nextSteps"
                );
            }
            other => panic!("期望 Present，实际 {other:?}"),
        }
    }
    // 重复触发抑制：同比例再评估 → 不新增总结、不重复标记
    evaluate_stage_milestones(&state, &active, "s1", &messages).await;
    assert_eq!(
        stored_stage_summaries(&state, "s1").len(),
        1,
        "重复评估不新增（每阶梯只触发一次）"
    );
    assert_eq!(stage_triggered_indices(&state, "s1"), vec![0], "标记幂等");
}

/// EV-07 测试辅助：带记录型事件桥的 CoreRunState（LocalDb 内存库 +
/// 独立诊断 + 快照存储；调用方继续配置 ratios / summarizer / tree /
/// goal_state 键）
fn core_state_with_emitter(db: LocalDb) -> (Arc<CoreRunState>, Arc<RecordingEmitter>) {
    let (bridge, emitter) = recording_bridge();
    let seq = CORE_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let snapshots: Arc<dyn SnapshotStore> = Arc::new(
        orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
            "conex_core_state_{}_{seq}_snapshot.json",
            std::process::id()
        ))),
    );
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    (
        Arc::new(CoreRunState::new(
            store,
            snapshots,
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        )),
        emitter,
    )
}

/// EV-07：阶段里程碑达标全链路（注入 Summarizer stub）→
/// stage-summary-milestone 四态依次发射（reached → summarizing →
/// produced → persisted），载荷 tier=stage-N / milestoneIndex=0
#[tokio::test]
async fn stage_milestone_emits_milestone_events() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta("compact_stage_ratios", "[0.001, 0.999]")
        .unwrap();
    let (state, emitter) = core_state_with_emitter(db);
    inject_fake_summarizer(&state);
    // 会话树（checkpoint 落载荷面）
    let mut tree = SessionTree::new("s1");
    tree.append("leaf-1", serde_json::json!({}))
        .expect("追加叶子");
    state
        .session_trees
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert("s1".to_string(), Arc::new(Mutex::new(tree)));
    // 15 条 ≈ 30k token（任意窗口下比例 ∈ [0.06, 0.47] → 命中 stage-1）
    let messages = big_llm_conversation(15);
    let active = build_active_run(&state, "s1", "run-s1").await;
    evaluate_stage_milestones(&state, &active, "s1", &messages).await;
    // 事件载荷（envelope 手工合并扁平 JSON：type 与变体字段同层）
    let payloads = emitter.0.lock().unwrap().clone();
    let milestones: Vec<(String, String, u32)> = payloads
        .iter()
        .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .filter(|v| v["type"].as_str() == Some("stage-summary-milestone"))
        .filter_map(|v| {
            let milestone_type = v["milestoneType"].as_str()?.to_string();
            let tier = v["tier"].as_str()?.to_string();
            let index = v["milestoneIndex"].as_u64()? as u32;
            Some((milestone_type, tier, index))
        })
        .collect();
    let types: Vec<&str> = milestones.iter().map(|m| m.0.as_str()).collect();
    assert_eq!(
        types,
        vec!["reached", "summarizing", "produced", "persisted"],
        "四态依次发射（达标 → Summarizer 调用 → 产出 → 落库）"
    );
    assert_eq!(milestones[0].1, "stage-1", "tier = stage-N");
    assert_eq!(milestones[0].2, 0, "里程碑索引 0（stage-1 首阶梯）");
    // 既有语义不回归：触发标记 + 阶段总结落库照常
    assert_eq!(
        stage_triggered_indices(&state, "s1"),
        vec![0],
        "stage-1 已触发"
    );
    assert_eq!(stored_stage_summaries(&state, "s1").len(), 1, "产出 1 条");
}

/// EV-07：Summarizer 缺失 → 仅 reached（无 summarizing/produced/
/// persisted——「达标但不可产出」事件面可辨）
#[tokio::test]
async fn stage_milestone_without_summarizer_emits_only_reached() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta("compact_stage_ratios", "[0.001, 0.999]")
        .unwrap();
    let (state, emitter) = core_state_with_emitter(db);
    state.set_summarizer_factory(None);
    // 不注入 Summarizer（F1 L1：无 Summarizer → 不产出、不标记）
    let messages = big_llm_conversation(15);
    let active = build_active_run(&state, "s1", "run-s1").await;
    evaluate_stage_milestones(&state, &active, "s1", &messages).await;
    let payloads = emitter.0.lock().unwrap().clone();
    let types: Vec<String> = payloads
        .iter()
        .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .filter(|v| v["type"].as_str() == Some("stage-summary-milestone"))
        .filter_map(|v| v["milestoneType"].as_str().map(String::from))
        .collect();
    assert_eq!(
        types,
        vec!["reached".to_string()],
        "Summarizer 缺失止于 reached"
    );
    assert!(stage_triggered_indices(&state, "s1").is_empty(), "不标记");
}

/// EV-07：goal 收口决策补发——L1 checklist 全勾（Completed）→
/// goal-continuation-decided action=complete、reason=goal-completed、
/// detail 携带 round（与 goal-round-completed.round 同源）
#[tokio::test]
async fn goal_continuation_decided_completed_action_is_complete() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta(
        orchestrator::goal_state::GOAL_STATE_KEY,
        &GoalState::new("修复目标", 12, 2).to_json(),
    )
    .expect("goal_state 预置");
    let (state, emitter) = core_state_with_emitter(db);
    let active = build_active_run(&state, "s1", "run-1").await;
    let signals = GoalRoundSignals {
        assistant_text: "- [x] 完成的任务\n- [x] 收尾任务".to_string(),
        tool_calls: Vec::new(),
        tool_success_count: 0,
        tool_call_count: 0,
        message_count: 2,
    };
    state
        .assess_goal_round(&active, AgentEndReason::Stop, &signals, None)
        .await;
    let payloads = emitter.0.lock().unwrap().clone();
    let decided = payloads
        .iter()
        .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .find(|v| v["type"].as_str() == Some("goal-continuation-decided"))
        .expect("goal-continuation-decided 应发射");
    assert_eq!(
        decided["action"], "complete",
        "Completed 决策 action=complete（不再恒 continue）"
    );
    assert_eq!(decided["reason"], "goal-completed", "reason=goal-completed");
    assert_eq!(decided["detail"], "round=1", "detail 携带 round（首轮）");
}

/// EV-07：goal 收口决策补发——MaxTurns 收场（reason 门禁 Blocked）→
/// action=blocked、reason=max-turns
#[tokio::test]
async fn goal_continuation_decided_blocked_action_is_blocked() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta(
        orchestrator::goal_state::GOAL_STATE_KEY,
        &GoalState::new("修复目标", 12, 2).to_json(),
    )
    .expect("goal_state 预置");
    let (state, emitter) = core_state_with_emitter(db);
    let active = build_active_run(&state, "s1", "run-1").await;
    let signals = GoalRoundSignals {
        assistant_text: String::new(),
        tool_calls: Vec::new(),
        tool_success_count: 0,
        tool_call_count: 0,
        message_count: 1,
    };
    state
        .assess_goal_round(&active, AgentEndReason::MaxTurns, &signals, None)
        .await;
    let payloads = emitter.0.lock().unwrap().clone();
    let decided = payloads
        .iter()
        .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .find(|v| v["type"].as_str() == Some("goal-continuation-decided"))
        .expect("goal-continuation-decided 应发射");
    assert_eq!(
        decided["action"], "blocked",
        "Blocked 决策 action=blocked（不再恒 continue）"
    );
    assert_eq!(
        decided["reason"], "max-turns",
        "reason=max-turns（区分阻断源）"
    );
    assert_eq!(decided["detail"], "round=1", "detail 携带 round");
}

/// EV-07：goal 收口决策补发——无 checklist/DONE 且无工具轮（stalled
/// 递增未达阈值 → NoProgress）→ action=stop、reason=stop
#[tokio::test]
async fn goal_continuation_decided_no_progress_action_is_stop() {
    let db = LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.set_session_meta(
        orchestrator::goal_state::GOAL_STATE_KEY,
        &GoalState::new("修复目标", 12, 2).to_json(),
    )
    .expect("goal_state 预置");
    let (state, emitter) = core_state_with_emitter(db);
    let active = build_active_run(&state, "s1", "run-1").await;
    let signals = GoalRoundSignals {
        assistant_text: "这轮没有实质进展".to_string(),
        tool_calls: Vec::new(),
        tool_success_count: 0,
        tool_call_count: 0,
        message_count: 1,
    };
    state
        .assess_goal_round(&active, AgentEndReason::Stop, &signals, None)
        .await;
    let payloads = emitter.0.lock().unwrap().clone();
    let decided = payloads
        .iter()
        .filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok())
        .find(|v| v["type"].as_str() == Some("goal-continuation-decided"))
        .expect("goal-continuation-decided 应发射");
    assert_eq!(
        decided["action"], "stop",
        "NoProgress 决策 action=stop（不再恒 continue）"
    );
    assert_eq!(decided["reason"], "stop", "reason=stop（stalled 累计中）");
    assert_eq!(decided["detail"], "round=1", "detail 携带 round");
}

/// F5：系统提示词段注入——build_system_prompt 输出后拼接「阶段总结」段；
/// 无总结 → 原样返回（行为与接线前一致）
#[test]
fn stage_summary_injected_into_system_prompt() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db.clone()));
    let state = core_state_with_store(store);
    // 无总结 → 原样（build_system_prompt trim 规范化后输出）
    let base = assemble_system_prompt_with_stages(&state, "s1", Some("  基础提示词  ".to_string()));
    assert_eq!(base.as_deref(), Some("基础提示词"), "无总结原样返回");
    // 预置一条阶段总结 → 拼接「阶段总结：N 条」段 + md 渲染（tier 标注）
    db.set_session_meta(
        "s1:compact_stage_summaries",
        r###"[{"tier":"stage-1","markdown":"## 阶段性总结（stage-1）\n- 进展一"}]"###,
    )
    .unwrap();
    let injected = assemble_system_prompt_with_stages(&state, "s1", Some("基础".to_string()))
        .expect("注入非空");
    assert!(injected.contains("阶段总结：1 条"), "段头");
    assert!(injected.contains("阶段性总结（stage-1）"), "md 渲染内容");
    assert!(injected.starts_with("基础"), "基础段在前（拼接语义）");
}

// ── SR-01 散落 cfg(test) 块随行搬移（测试专用逻辑，外置重建）─────────
// 原分布于 core_run_commands.rs 实现段 11 处（1198/1208/1703/2233/2243/
// 2253/2264/5758/8135/8142/8149 一带）；主文件已全部清零，此处按原
// 语义重建——inherent impl 扩展块（类型私有字段对 tests 子模块可见）、
// idle_resume 测试面 use（函数为 pub(crate)）、跨模块测试面静态/辅助
// （CONFIG_TEST_LOCK / isolate_config_store 由主文件 re-export 保持
// `crate::core_run_commands::*` 路径不 break）。

use super::idle_resume::{
    checkpoint_injection_section, collect_checkpoint_on_close, decide_idle_resume,
    drain_pending_to_inject_messages, evaluate_stage_milestones, stage_triggered_indices,
    stored_stage_summaries,
};

/// 测试面：config 静态 store 隔离锁（PS-04 T4.3 命令级测试用）。
///
/// `config_profile_apply` / `config_update` 会写 `API_CONFIG_STORE` / 密钥槽
/// 静态存储；命令级测试必须①并行串行化（set_var/take/init 非并发安全）、
/// ②重置静态到独立临时目录（禁止触碰真实用户配置——引擎测试的只读初始化
/// 可能已把静态绑定到 `CRISH_WORKBENCH_CONFIG_DIR` 之外的真实路径）。
pub(crate) static CONFIG_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ── 统一配置单轨测试夹具（替代已删除的 with_store_mut / config_profile_apply /
// config_secret_set / config_get；凭据经 env ref 注入，配置变更经
// ModelsStore::apply 落盘 + install_models_store_for_test 安装）────────────

/// 单轨测试凭据环境变量名（key 经 set_var/remove_var 注入，与旧 apply 的
/// key 切换语义一致；CONFIG_TEST_LOCK 已序列化这些测试，env 互不串扰）。
pub(crate) const TEST_ENV_KEY: &str = "CONEX_TEST_WIZARD_KEY";
const TEST_PROFILE_A_KEY: &str = "CONEX_TEST_PROFILE_A_KEY";
const TEST_PROFILE_B_KEY: &str = "CONEX_TEST_PROFILE_B_KEY";

/// 写统一树 YAML 到 dir/models.yaml，读入提交，安装为生效 store。
fn install_yaml_store(
    dir: &std::path::Path,
    yaml: &str,
) -> std::sync::Arc<agent_provider::model_store::ModelsStore> {
    let config_path = dir.join("models.yaml");
    std::fs::write(&config_path, yaml).expect("write models.yaml");
    let store = std::sync::Arc::new(agent_provider::model_store::ModelsStore::new(
        config_path,
        dir.join("secrets"),
        None,
    ));
    store.read().expect("load unified models tree");
    crate::config::install_models_store_for_test(std::sync::Arc::clone(&store));
    store
}

/// 在已提交统一树上以新修订重应用 YAML（CAS：expected = 当前提交修订）。
fn apply_unified_yaml(store: &agent_provider::model_store::ModelsStore, yaml: &str) {
    let revision = store
        .committed()
        .expect("unified tree 必须已提交")
        .revision
        .clone();
    store
        .save_yaml(yaml, &revision)
        .expect("apply unified tree");
}

/// 单 provider(p1) 统一树 YAML：active=(p1, active_model)，含 model-a/model-b
/// 候选，apiKeyRef=env:<env_key>（凭据由调用方经 set_var 注入）。
fn unified_tree_yaml(base_url: &str, active_model: &str, env_key: &str) -> String {
    format!(
        "version: 2\n\
         activeModel:\n  providerId: p1\n  modelId: {active_model}\n\
         providers:\n  p1:\n    displayName: P1\n    baseUrl: {base_url}\n    protocol: openai/chat\n    apiKeyRef: env:{env_key}\n    models:\n      - id: model-a\n        enabled: true\n      - id: model-b\n        enabled: true\n"
    )
}

/// 安装单 provider 初始树（provider=p1，base_url，active=model-a，key 经
/// `TEST_ENV_KEY` 注入为 "sk-a"）。返回已安装 store。
pub(crate) fn install_tree_models_store(
    dir: &std::path::Path,
    base_url: &str,
) -> std::sync::Arc<agent_provider::model_store::ModelsStore> {
    std::env::set_var(TEST_ENV_KEY, "sk-a");
    install_yaml_store(dir, &unified_tree_yaml(base_url, "model-a", TEST_ENV_KEY))
}

/// 单 provider 树上切换 base_url/model（provider=p1 不变；key 由调用方经
/// set_var 切换）。等价于旧 `config_profile_apply(profile, key, base, model)`。
pub(crate) fn apply_single_provider(
    store: &agent_provider::model_store::ModelsStore,
    base_url: &str,
    model: &str,
) {
    apply_unified_yaml(store, &unified_tree_yaml(base_url, model, TEST_ENV_KEY));
}

/// 多 provider 统一树（profile-a / profile-b，各自 env 凭据），active 指定。
/// 仅本文件 profile 切换 / 快照测试使用。
fn profile_tree_yaml(active_id: &str, active_model: &str) -> String {
    format!(
        "version: 2\n\
         activeModel:\n  providerId: {active_id}\n  modelId: {active_model}\n\
         providers:\n  profile-a:\n    displayName: profile-a\n    baseUrl: https://a.example/v1\n    protocol: openai/chat\n    apiKeyRef: env:{TEST_PROFILE_A_KEY}\n    models:\n      - id: model-a\n        enabled: true\n      - id: model-b\n        enabled: true\n  profile-b:\n    displayName: profile-b\n    baseUrl: https://b.example/v1\n    protocol: openai/chat\n    apiKeyRef: env:{TEST_PROFILE_B_KEY}\n    models:\n      - id: model-a\n        enabled: true\n      - id: model-b\n        enabled: true\n"
    )
}

/// 把静态 config store 重置并隔离到 `dir`（T4.3 命令级测试用；调用方必须
/// 持 [CONFIG_TEST_LOCK]）。静态 store 重置为独立临时目录的空统一树，
/// 测试随后经 install_yaml_store / install_tree_models_store 写入真实配置——
/// 写入永不落到真实用户配置。
pub(crate) fn isolate_config_store(dir: &std::path::Path) {
    std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", dir);
    crate::config::reset_config_stores_for_test();
    let store = std::sync::Arc::new(agent_provider::model_store::ModelsStore::new(
        dir.join("models.yaml"),
        dir.join("secrets"),
        None,
    ));
    store.read().expect("isolate config store read");
    crate::config::install_models_store_for_test(store);
}

impl super::SessionHistoryCache {
    /// 缓存中的会话数（测试/诊断专用，生产路径暂不消费）
    pub(crate) fn session_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .len()
    }

    /// 指定会话缓存的消息条数（测试/诊断专用，生产路径暂不消费）
    pub(crate) fn message_count(&self, session_id: &str) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .get(session_id)
            .map(|messages| messages.len())
            .unwrap_or(0)
    }
}

/// 当前 run 上下文（测试与诊断用）
impl super::RunAwareBackgroundManager {
    pub(crate) fn current_run(&self) -> Option<String> {
        self.current_run_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

/// SR-01 散落 cfg(test) 注入面重建（T-CF-11 / D2 §3.4 C4 锁死测试驱动面）：
/// 原定义于 CoreRunState impl 内，搬移后以 inherent impl 扩展块重建——
/// 同一类型多处 inherent impl 合法（每方法单定义），方法可见性（pub(crate)）
/// 与语义零改动；scripted_mock_server.rs / 测试经方法调用解析不受影响。
impl super::CoreRunState {
    /// T-CF-11：注入 Cron enabled 判定器（30 方案 P7 后为测试替换槽——
    /// 生产在 [Self::new] 内直接装配 engine.scheduler_registry() 的
    /// has_active 封装；测试经本方法注入替身/清空断言判定分支）
    pub(crate) fn set_cron_has_enabled(&self, check: Option<super::WakeSourceCheck>) {
        *self
            .cron_has_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = check;
    }

    /// T-CF-11：注入定时器活跃判定器（测试可替换；None = 收口时不因
    /// 定时器续 run）
    pub(crate) fn set_timer_has_active(&self, check: Option<super::WakeSourceCheck>) {
        *self
            .timer_has_active
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = check;
    }

    /// T-CF-11：注入 idle 续 run 拉起器（测试替身断言判定与注入载荷；
    /// None = 恢复生产路径 [production_resume_launcher] 的缺省行为）
    pub(crate) fn set_resume_launcher(&self, launcher: Option<super::ResumeLauncher>) {
        *self
            .resume_launcher
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = launcher;
    }

    /// D2 §3.4（C4 锁死）：注入跨 run 续 run 退避延迟函数（测试直接驱动，
    /// 不依赖 tokio pause；注入存在时退避睡眠跳过——测试驱动模式；
    /// None = 生产镜像 recovery.rs 常量）
    pub(crate) fn set_resume_backoff(&self, backoff: Option<super::BackoffDelayFn>) {
        *self
            .resume_backoff
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = backoff;
    }
}

// ── DM-07：read_run_events_impl / read_session_events_impl（by_run + limit 下推）──

/// 测试用扁平 typed 信封 payload（wire 形状对齐 AgentEventEnvelope 手工
/// serde：{type, sessionId, runId, sequence, schemaVersion, timestamp}；
/// runId 顶层键同时满足 run-terminal 变体对 run_id 字段的依赖）
fn dm07_envelope(event_type: &str, run_id: Option<&str>, sequence: u64) -> String {
    serde_json::json!({
        "type": event_type,
        "sessionId": "s1",
        "runId": run_id,
        "sequence": sequence,
        "schemaVersion": 1,
        "timestamp": "2026-08-14T00:00:00Z",
    })
    .to_string()
}

/// DM-07 记录型 store 包装：断言 query_events / query_events_by_run 收到
/// 的 limit 下推参数（其余方法原样委托内层，行为零改动）
struct RecordingStore {
    inner: Arc<dyn Store>,
    session_limits: Arc<Mutex<Vec<Option<u64>>>>,
    run_limits: Arc<Mutex<Vec<Option<u64>>>>,
}

#[async_trait::async_trait]
impl Store for RecordingStore {
    async fn insert_run(
        &self,
        run_id: &str,
        session_id: &str,
        status: conex_db::RunStatus,
        end_reason: Option<&str>,
        cursor: i64,
    ) -> orchestrator::persist::StoreResult<()> {
        self.inner
            .insert_run(run_id, session_id, status, end_reason, cursor)
            .await
    }

    async fn update_run_status(
        &self,
        run_id: &str,
        status: conex_db::RunStatus,
        end_reason: Option<&str>,
        cursor: Option<i64>,
    ) -> orchestrator::persist::StoreResult<()> {
        self.inner
            .update_run_status(run_id, status, end_reason, cursor)
            .await
    }

    async fn reserve_sequence(&self, session_id: &str) -> orchestrator::persist::StoreResult<u64> {
        self.inner.reserve_sequence(session_id).await
    }

    async fn seed_sequence(
        &self,
        session_id: &str,
        next_sequence: u64,
    ) -> orchestrator::persist::StoreResult<()> {
        self.inner.seed_sequence(session_id, next_sequence).await
    }

    async fn append_event(
        &self,
        session_id: &str,
        sequence: u64,
        event_type: &str,
        payload: &str,
        run_id: Option<&str>,
    ) -> orchestrator::persist::StoreResult<()> {
        self.inner
            .append_event(session_id, sequence, event_type, payload, run_id)
            .await
    }

    async fn query_events(
        &self,
        session_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> orchestrator::persist::StoreResult<Vec<orchestrator::persist::PersistedEvent>> {
        self.session_limits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(limit);
        self.inner
            .query_events(session_id, after_sequence, limit)
            .await
    }

    async fn query_events_by_run(
        &self,
        session_id: &str,
        run_id: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> orchestrator::persist::StoreResult<Vec<orchestrator::persist::PersistedEvent>> {
        self.run_limits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(limit);
        self.inner
            .query_events_by_run(session_id, run_id, after_sequence, limit)
            .await
    }

    // 1C-1 下推面（Store trait 新增方法）：本桩仅关注 query_events /
    // query_events_by_run 的 limit 记录，其余一律原样委托内层。
    async fn max_sequence(&self, session_id: &str) -> orchestrator::persist::StoreResult<u64> {
        self.inner.max_sequence(session_id).await
    }

    async fn query_events_by_type(
        &self,
        session_id: &str,
        run_id: &str,
        event_type: &str,
        after_sequence: u64,
        limit: Option<u64>,
    ) -> orchestrator::persist::StoreResult<Vec<orchestrator::persist::PersistedEvent>> {
        self.inner
            .query_events_by_type(session_id, run_id, event_type, after_sequence, limit)
            .await
    }

    async fn query_runs(&self) -> orchestrator::persist::StoreResult<Vec<conex_db::StoredRun>> {
        self.inner.query_runs().await
    }

    async fn save_pending_input(
        &self,
        id: &str,
        session_id: &str,
        run_id: Option<&str>,
        payload: &str,
    ) -> orchestrator::persist::StoreResult<()> {
        self.inner
            .save_pending_input(id, session_id, run_id, payload)
            .await
    }

    async fn load_pending_inputs(
        &self,
        session_id: &str,
    ) -> orchestrator::persist::StoreResult<Vec<conex_db::PendingInput>> {
        self.inner.load_pending_inputs(session_id).await
    }

    async fn delete_pending_input(&self, id: &str) -> orchestrator::persist::StoreResult<bool> {
        self.inner.delete_pending_input(id).await
    }

    fn as_local_db(&self) -> Option<conex_db::LocalDb> {
        self.inner.as_local_db()
    }
}

/// DM-07 验收 ①：run 查询返回全链含终态后 tail——agent-start…run-terminal +
/// 终态后同 runId 尾事件（audit-flush 收尾区，R-06）；goal-* 轮次域不命中。
#[tokio::test]
async fn read_run_events_full_chain_with_tail() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    // run r1 全链：agent-start → message-delta → run-terminal → 终态后 tail
    // （审计排空 audit-flush 同 runId 归属）；goal-* 轮次域落库 run_id=NULL
    db.append_event(
        "s1",
        1,
        "agent-start",
        &dm07_envelope("agent-start", Some("r1"), 1),
        Some("r1"),
    )
    .unwrap();
    db.append_event(
        "s1",
        2,
        "goal-round-started",
        &dm07_envelope("goal-round-started", None, 2),
        None,
    )
    .unwrap();
    db.append_event(
        "s1",
        3,
        "message-delta",
        &dm07_envelope("message-delta", Some("r1"), 3),
        Some("r1"),
    )
    .unwrap();
    db.append_event(
        "s1",
        4,
        "run-terminal",
        &dm07_envelope("run-terminal", Some("r1"), 4),
        Some("r1"),
    )
    .unwrap();
    db.append_event(
        "s1",
        5,
        "audit-flush",
        &dm07_envelope("audit-flush", Some("r1"), 5),
        Some("r1"),
    )
    .unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let page = super::read_run_events_impl(&state, "r1", Some("s1"), None, None)
        .await
        .unwrap();
    let types: Vec<&str> = page
        .events
        .iter()
        .map(|value| value["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        vec![
            "agent-start",
            "message-delta",
            "run-terminal",
            "audit-flush"
        ],
        "run 查询返回全链含终态后 tail，goal-* 不命中"
    );
    assert!(!page.has_more, "无更多事件");
    assert_eq!(page.next_after_sequence, 5, "游标 = 页末全局 sequence");
    assert_eq!(
        page.events[0]["runId"], "r1",
        "wire runId 与 SQL 过滤口径一致"
    );
}

/// DM-07 验收 ②：交错 run 只返本 run（SQL 按 run_id 列过滤互不串扰）。
#[tokio::test]
async fn read_run_events_interleaved_runs_only_own() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    // 交错落库：r1/r2 事件全局 sequence 交织
    db.append_event(
        "s1",
        1,
        "agent-start",
        &dm07_envelope("agent-start", Some("r1"), 1),
        Some("r1"),
    )
    .unwrap();
    db.append_event(
        "s1",
        2,
        "agent-start",
        &dm07_envelope("agent-start", Some("r2"), 2),
        Some("r2"),
    )
    .unwrap();
    db.append_event(
        "s1",
        3,
        "message-delta",
        &dm07_envelope("message-delta", Some("r1"), 3),
        Some("r1"),
    )
    .unwrap();
    db.append_event(
        "s1",
        4,
        "message-delta",
        &dm07_envelope("message-delta", Some("r2"), 4),
        Some("r2"),
    )
    .unwrap();
    db.append_event(
        "s1",
        5,
        "run-terminal",
        &dm07_envelope("run-terminal", Some("r1"), 5),
        Some("r1"),
    )
    .unwrap();
    db.append_event(
        "s1",
        6,
        "run-terminal",
        &dm07_envelope("run-terminal", Some("r2"), 6),
        Some("r2"),
    )
    .unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let seqs = |page: crate::core_query_commands::EventPage| {
        page.events
            .iter()
            .map(|value| value["sequence"].as_u64().unwrap())
            .collect::<Vec<u64>>()
    };
    let r1 = super::read_run_events_impl(&state, "r1", Some("s1"), None, None)
        .await
        .unwrap();
    assert_eq!(seqs(r1), vec![1, 3, 5], "交错 run 只返本 run 事件");
    let r2 = super::read_run_events_impl(&state, "r2", Some("s1"), None, None)
        .await
        .unwrap();
    assert_eq!(seqs(r2), vec![2, 4, 6]);
}

/// DM-07 验收 ③：续页游标 = 页末全局 sequence（SQL 过滤后页内末事件即
/// 本 run 事件流位置），跨页无缝不跳事件。
#[tokio::test]
async fn read_run_events_pagination_global_sequence() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    // r1 六事件与 r2 六事件全局交织（sequence 1..=12）
    for i in 1_u64..=6 {
        db.append_event(
            "s1",
            (i * 2 - 1) as i64,
            "message-delta",
            &dm07_envelope("message-delta", Some("r1"), i * 2 - 1),
            Some("r1"),
        )
        .unwrap();
        db.append_event(
            "s1",
            (i * 2) as i64,
            "message-delta",
            &dm07_envelope("message-delta", Some("r2"), i * 2),
            Some("r2"),
        )
        .unwrap();
    }
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let seqs = |page: crate::core_query_commands::EventPage| {
        page.events
            .iter()
            .map(|value| value["sequence"].as_u64().unwrap())
            .collect::<Vec<u64>>()
    };
    // 每页 2 条（page_size=2，limit=3 下推）
    let p1 = super::read_run_events_impl(&state, "r1", Some("s1"), None, Some(2))
        .await
        .unwrap();
    assert_eq!(seqs(p1.clone()), vec![1, 3]);
    assert!(p1.has_more);
    assert_eq!(p1.next_after_sequence, 3, "游标 = 页末全局 sequence");
    let p2 = super::read_run_events_impl(
        &state,
        "r1",
        Some("s1"),
        Some(p1.next_after_sequence),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(
        seqs(p2.clone()),
        vec![5, 7],
        "续页从页末全局 sequence 之后无缝续接"
    );
    assert!(p2.has_more);
    assert_eq!(p2.next_after_sequence, 7);
    let p3 = super::read_run_events_impl(
        &state,
        "r1",
        Some("s1"),
        Some(p2.next_after_sequence),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(seqs(p3.clone()), vec![9, 11], "末页取尽");
    assert!(!p3.has_more);
}

/// DM-07 验收 ④：limit 下推后 has_more 正确（n+1 语义）——每页 SQL 只取
/// page_size + 1 行，页末一行仅用于 has_more 判定不返回。
#[tokio::test]
async fn read_run_events_limit_pushdown_has_more() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    for i in 1_u64..=5 {
        db.append_event(
            "s1",
            i as i64,
            "message-delta",
            &dm07_envelope("message-delta", Some("r1"), i),
            Some("r1"),
        )
        .unwrap();
    }
    let session_limits = Arc::new(Mutex::new(Vec::new()));
    let run_limits = Arc::new(Mutex::new(Vec::new()));
    let recording = RecordingStore {
        inner: Arc::new(orchestrator::persist::LocalDbStore::new(db)),
        session_limits: Arc::clone(&session_limits),
        run_limits: Arc::clone(&run_limits),
    };
    let state = core_state_with_store(Arc::new(recording));
    let p1 = super::read_run_events_impl(&state, "r1", Some("s1"), None, Some(2))
        .await
        .unwrap();
    assert_eq!(
        *run_limits.lock().unwrap(),
        vec![Some(3)],
        "limit 下推 = page_size + 1"
    );
    assert_eq!(p1.events.len(), 2, "页只含 page_size 条");
    assert!(p1.has_more);
    let p2 = super::read_run_events_impl(
        &state,
        "r1",
        Some("s1"),
        Some(p1.next_after_sequence),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(p2.events.len(), 2);
    assert!(p2.has_more);
    let p3 = super::read_run_events_impl(
        &state,
        "r1",
        Some("s1"),
        Some(p2.next_after_sequence),
        Some(2),
    )
    .await
    .unwrap();
    assert_eq!(p3.events.len(), 1, "末页取尽");
    assert!(!p3.has_more);
    assert_eq!(
        *run_limits.lock().unwrap(),
        vec![Some(3), Some(3), Some(3)],
        "每页均只取 page_size + 1 行"
    );
}

/// DM-07 验收 ⑤：goal-* 三事件轮次域不命中 run 查询；按会话查询仍返回。
#[tokio::test]
async fn read_run_events_excludes_goal_round() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.append_event(
        "s1",
        1,
        "agent-start",
        &dm07_envelope("agent-start", Some("r1"), 1),
        Some("r1"),
    )
    .unwrap();
    for (i, goal_type) in [
        "goal-round-started",
        "goal-round-completed",
        "goal-continuation-decided",
    ]
    .iter()
    .enumerate()
    {
        let sequence = (i + 2) as u64;
        db.append_event(
            "s1",
            sequence as i64,
            goal_type,
            &dm07_envelope(goal_type, None, sequence),
            None,
        )
        .unwrap();
    }
    db.append_event(
        "s1",
        5,
        "run-terminal",
        &dm07_envelope("run-terminal", Some("r1"), 5),
        Some("r1"),
    )
    .unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let page = super::read_run_events_impl(&state, "r1", Some("s1"), None, None)
        .await
        .unwrap();
    let types: Vec<&str> = page
        .events
        .iter()
        .map(|value| value["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        vec!["agent-start", "run-terminal"],
        "goal-* 轮次域不命中 run 查询"
    );
    let session_page = super::read_session_events_impl(&state, "s1", None, None)
        .await
        .unwrap();
    assert_eq!(
        session_page.events.len(),
        5,
        "goal-* 按会话查询返回（会话域）"
    );
}

/// DM-07：sessionId 缺省时从 runs 表反查；未知 run → NotFound（run.not_found 语义）。
#[tokio::test]
async fn read_run_events_session_lookup_via_run_record() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    db.insert_run("r1", "s1", conex_db::RunStatus::Running, None, 0)
        .unwrap();
    db.append_event(
        "s1",
        1,
        "agent-start",
        &dm07_envelope("agent-start", Some("r1"), 1),
        Some("r1"),
    )
    .unwrap();
    let store: Arc<dyn Store> = Arc::new(orchestrator::persist::LocalDbStore::new(db));
    let state = core_state_with_store(store);
    let page = super::read_run_events_impl(&state, "r1", None, None, None)
        .await
        .unwrap();
    assert_eq!(page.events.len(), 1, "sessionId 缺省从 run 记录反查成功");
    let err = super::read_run_events_impl(&state, "nope", None, None, None)
        .await
        .unwrap_err();
    assert!(matches!(err, CoreError::NotFound(_)), "未知 run → NotFound");
}

/// DM-07 验收 ⑥：会话读 limit 下推——read_session_events_impl 每页只取
/// page_size + 1 行（store 层记录断言 query_events 收到 limit 参数）。
#[tokio::test]
async fn core_read_session_events_limit_pushdown() {
    let db = conex_db::LocalDb::open_in_memory().unwrap();
    db.insert_session("s1", "s1").unwrap();
    for i in 1_u64..=5 {
        db.append_event(
            "s1",
            i as i64,
            "agent-start",
            &dm07_envelope("agent-start", Some("r1"), i),
            Some("r1"),
        )
        .unwrap();
    }
    let session_limits = Arc::new(Mutex::new(Vec::new()));
    let run_limits = Arc::new(Mutex::new(Vec::new()));
    let recording = RecordingStore {
        inner: Arc::new(orchestrator::persist::LocalDbStore::new(db)),
        session_limits: Arc::clone(&session_limits),
        run_limits: Arc::clone(&run_limits),
    };
    let state = core_state_with_store(Arc::new(recording));
    let page = super::read_session_events_impl(&state, "s1", None, Some(2))
        .await
        .unwrap();
    assert_eq!(
        *session_limits.lock().unwrap(),
        vec![Some(3)],
        "会话读 limit 下推 = page_size + 1"
    );
    assert_eq!(page.events.len(), 2, "页只含 page_size 条");
    assert!(page.has_more);
    assert_eq!(page.next_after_sequence, 2, "游标 = 页末全局 sequence");
}
