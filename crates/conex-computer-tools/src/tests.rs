//! 测试资产（骨架 8 测试保留并演进 + 实施轮新增：守卫链顺序 / 审批传输 /
//! 急停接线 / 参数校验 / 返回形状 / 码表，06 文档 §7 验收 8-12）。
//!
//! 守卫组件（ActivationGate / SessionEnablement / ApprovalGate / EmergencyStop）
//! 均为 conex-computer 纯逻辑实现，测试直接用真实现 + 状态断言（审批未发起 =
//! pending/last_verdict 均为 None）；仅会话注入面用 [`MockComputerOps`] 替身
//! （零注入断言 = dispatch 调用计数）。

use super::*;
use agent_tools::context::{create_mock_tool_context, AskChannel, AskDecision, ToolContext};
use async_trait::async_trait;
use base64::Engine;
use conex_computer::activation::ActivationGate;
use conex_computer::action::{ActionError, ClickCount, MouseButton};
use conex_computer::coord::Point;
use conex_computer::perception::{PerceptionNode, PerceptionSnapshot, Rect};
use conex_computer::screen::CapturedFrame;
use conex_computer::security::{
    Approval, ApprovalGate, ApprovalRequest, EmergencyStop, EnableSource, SessionEnablement,
    StopSource,
};
use conex_computer::{Action, ActionResult, SessionError};
use conex_shared::gate::{TargetDenial, TargetDenialKind};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

// ===== 测试替身 =====

/// 会话 mock 替身（零注入断言 = dispatch 调用计数；结果可配置）。
struct MockComputerOps {
    dispatch_result: Mutex<Result<ActionResult, SessionError>>,
    screenshot_result: Mutex<Result<CapturedFrame, SessionError>>,
    snapshot_result: Mutex<Result<PerceptionSnapshot, conex_computer::perception::PerceptionError>>,
    dispatch_calls: Mutex<Vec<Action>>,
    screenshot_calls: AtomicU64,
    snapshot_calls: AtomicU64,
    version: AtomicU64,
    display_count: AtomicU64,
    /// 可选：dispatch 时触发急停（执行中急停测试注入）
    stop_on_dispatch: Mutex<Option<Arc<EmergencyStop>>>,
}

/// 2x2 PNG 样例帧（screenshot 返回形状测试用）
fn sample_frame() -> CapturedFrame {
    let mut img = image::RgbaImage::new(2, 2);
    for pixel in img.pixels_mut() {
        *pixel = image::Rgba([10, 20, 30, 255]);
    }
    let mut buf = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(img)
        .write_to(&mut buf, image::ImageFormat::Png)
        .expect("样例帧编码成功");
    CapturedFrame {
        seq: 1,
        width: 2,
        height: 2,
        data: buf.into_inner(),
    }
}

/// UIA 样例快照（snapshot 返回形状测试用）
fn sample_snapshot() -> PerceptionSnapshot {
    let root = PerceptionNode::new(
        "window",
        "测试窗口",
        "",
        Rect::new(0, 0, 800, 600),
        vec![PerceptionNode::new(
            "button",
            "确定",
            "",
            Rect::new(700, 50, 780, 90),
            vec![],
        )],
    );
    PerceptionSnapshot {
        root,
        node_count: 2,
        truncated: false,
    }
}

impl MockComputerOps {
    fn new() -> Self {
        Self::default()
    }

    fn dispatch_count(&self) -> usize {
        self.dispatch_calls.lock().expect("mock 锁损坏").len()
    }

    fn received_actions(&self) -> Vec<Action> {
        self.dispatch_calls
            .lock()
            .expect("mock 锁损坏")
            .clone()
    }

    fn fail_dispatch(&self, err: SessionError) {
        *self.dispatch_result.lock().expect("mock 锁损坏") = Err(err);
    }

    /// 注入「dispatch 期间触发急停」（批次间自查测试面）
    fn stop_on_dispatch(&self, stop: Arc<EmergencyStop>) {
        *self.stop_on_dispatch.lock().expect("mock 锁损坏") = Some(stop);
    }
}

impl Default for MockComputerOps {
    fn default() -> Self {
        Self {
            dispatch_result: Mutex::new(Ok(ActionResult::Done)),
            screenshot_result: Mutex::new(Ok(sample_frame())),
            snapshot_result: Mutex::new(Ok(sample_snapshot())),
            dispatch_calls: Mutex::new(Vec::new()),
            screenshot_calls: AtomicU64::new(0),
            snapshot_calls: AtomicU64::new(0),
            version: AtomicU64::new(7),
            display_count: AtomicU64::new(1),
            stop_on_dispatch: Mutex::new(None),
        }
    }
}

#[async_trait]
impl session::ComputerOps for MockComputerOps {
    fn readiness(&self) -> Result<(), String> {
        Ok(())
    }

    async fn dispatch(&self, action: &Action) -> Result<ActionResult, SessionError> {
        self.dispatch_calls
            .lock()
            .expect("mock 锁损坏")
            .push(action.clone());
        if let Some(stop) = &*self.stop_on_dispatch.lock().expect("mock 锁损坏") {
            stop.global_stop();
        }
        // 单次消费语义（SessionError 非 Clone；测试均为单次调用）
        let mut guard = self.dispatch_result.lock().expect("mock 锁损坏");
        std::mem::replace(
            &mut *guard,
            Err(SessionError::Inject("mock 结果已消费".into())),
        )
    }

    async fn screenshot(&self) -> Result<CapturedFrame, SessionError> {
        self.screenshot_calls.fetch_add(1, Ordering::SeqCst);
        let mut guard = self.screenshot_result.lock().expect("mock 锁损坏");
        std::mem::replace(
            &mut *guard,
            Err(SessionError::Capture("mock 结果已消费".into())),
        )
    }

    async fn snapshot(
        &self,
    ) -> Result<PerceptionSnapshot, conex_computer::perception::PerceptionError> {
        self.snapshot_calls.fetch_add(1, Ordering::SeqCst);
        let mut guard = self.snapshot_result.lock().expect("mock 锁损坏");
        std::mem::replace(
            &mut *guard,
            Err(conex_computer::perception::PerceptionError::NoActiveWindow),
        )
    }

    fn perception_version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }

    fn display_count(&self) -> u64 {
        self.display_count.load(Ordering::SeqCst)
    }
}

/// 审批通道记录替身（ctx.ask 调用断言：载荷 + 裁决可配；可注入 ask 等待期
/// 急停触发钩子——审批等待期取消测试面）
#[derive(Debug, Clone)]
struct RecordingAsk {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    decision: AskDecision,
    on_ask: Option<Arc<EmergencyStop>>,
}

impl RecordingAsk {
    fn new(decision: AskDecision) -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            decision,
            on_ask: None,
        }
    }

    /// 注入钩子：ask 等待期间触发急停（模拟等待中用户急停）
    fn with_stop_trigger(mut self, stop: Arc<EmergencyStop>) -> Self {
        self.on_ask = Some(stop);
        self
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().expect("ask 锁损坏").clone()
    }
}

#[async_trait]
impl AskChannel for RecordingAsk {
    async fn ask(
        &self,
        tool_name: &str,
        args: &serde_json::Value,
    ) -> Result<AskDecision, agent_tools::definition::ToolError> {
        self.calls
            .lock()
            .expect("ask 锁损坏")
            .push((tool_name.to_string(), args.clone()));
        if let Some(stop) = &self.on_ask {
            stop.global_stop();
        }
        Ok(self.decision.clone())
    }
}

// ===== 配置与执行辅助 =====

/// 开启态配置（挂载判据：用户显式开启）
fn enabled_config() -> ComputerToolsConfig {
    let enablement = Arc::new(SessionEnablement::new());
    enablement.enable(EnableSource::User).expect("用户开启应成功");
    ComputerToolsConfig {
        enablement: Some(enablement),
        ..Default::default()
    }
}

/// 全接线配置（五守卫组件齐备；approval 未绑定急停旗——急停竞态由守卫链
/// settle 前自查兜底）
fn wired_config() -> (
    ComputerToolsConfig,
    Arc<MockComputerOps>,
    Arc<ApprovalGate>,
    Arc<EmergencyStop>,
) {
    let session = Arc::new(MockComputerOps::new());
    let enablement = Arc::new(SessionEnablement::new());
    enablement.enable(EnableSource::User).expect("用户开启应成功");
    let activation = Arc::new(ActivationGate::new());
    activation
        .request_desktop()
        .expect("桌面会话激活应成功");
    let approval = Arc::new(ApprovalGate::new());
    let stop = Arc::new(EmergencyStop::new());
    let config = ComputerToolsConfig {
        session: Some(session.clone()),
        enablement: Some(enablement),
        activation: Some(activation),
        approval: Some(approval.clone()),
        stop: Some(stop.clone()),
    };
    (config, session, approval, stop)
}

/// 注册辅助：按配置注册并返回注册表
fn registry_with(config: ComputerToolsConfig) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, config).expect("注册应成功");
    registry
}

/// 执行辅助：新注册表 + 指定上下文执行工具
async fn exec(
    tool_name: &str,
    config: &ComputerToolsConfig,
    args: Value,
    tctx: &ToolContext,
) -> Result<Value, agent_tools::definition::ToolError> {
    let registry = registry_with(config.clone());
    let tool = registry.get(tool_name).expect("工具应注册");
    tool.execute(tctx, args).await
}

/// 默认审批放行上下文（ask 接线：Allowed）
fn allowed_ctx() -> (ToolContext, RecordingAsk) {
    let ask = RecordingAsk::new(AskDecision::Allowed);
    let mut ctx = create_mock_tool_context();
    ctx.ask = Some(Arc::new(ask.clone()));
    (ctx, ask)
}

// ===== 注册 / 挂载（骨架保留 8 测试，06 §7 验收 1-5、7） =====

/// 注册数精确断言 + 名称清单一致（验收 1：开启态挂载全部 13 个）。
#[test]
fn registration_enabled_mounts_all_13_tools() {
    let registry = registry_with(enabled_config());
    assert_eq!(registry.len(), 13, "工具族应恰好注册 13 个");
    let mut names: Vec<String> = registry
        .list()
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    names.sort();
    let mut expected: Vec<String> = ALL_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(names, expected, "注册清单必须与 ALL_TOOL_NAMES 逐项一致");
}

/// 安全默认：未注入开启判据 → 零注册（模型侧 tool schema 不含）。
#[test]
fn registration_default_config_mounts_zero() {
    let registry = registry_with(ComputerToolsConfig::default());
    assert_eq!(registry.len(), 0, "未开启/未注入必须零注册（安全默认）");
}

/// 挂载判据：显式未开启（新会话默认关闭态）→ 零注册。
#[test]
fn registration_disabled_enablement_mounts_zero() {
    let enablement = Arc::new(SessionEnablement::new());
    assert!(!enablement.tool_mount_allowed(), "新会话默认关闭");
    let registry = registry_with(ComputerToolsConfig {
        enablement: Some(enablement),
        ..Default::default()
    });
    assert_eq!(registry.len(), 0, "未开启必须零注册（04 §4.1 第 3 点）");
}

/// 重复注册幂等跳过（06 §3.2）：第二次注册不报冲突、注册数不变。
#[test]
fn registration_twice_is_idempotent() {
    let mut registry = registry_with(enabled_config());
    register_computer_tools(&mut registry, enabled_config()).expect("重复注册应幂等跳过");
    assert_eq!(registry.len(), 13);
}

/// 全工具 dangerous=true（04 §4.2 全动作审批：13 个全量）。
#[test]
fn all_tools_dangerous_true() {
    let registry = registry_with(enabled_config());
    for name in ALL_TOOL_NAMES {
        let tool = registry.get(name).expect("工具应注册");
        assert!(
            tool.definition().dangerous,
            "{name} 必须标记 dangerous=true"
        );
    }
}

/// 名称唯一性 + 全部工具名以 computer_ 前缀开头（命名空间隔离纪律，18 §2.1）。
#[test]
fn all_names_unique_and_computer_prefixed() {
    let registry = registry_with(enabled_config());
    let names: Vec<String> = registry
        .list()
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    let unique: HashSet<&String> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "名称必须唯一");
    for name in &names {
        assert!(name.starts_with("computer_"), "命名空间隔离：{name}");
    }
}

/// 守卫① 未注入契约（骨架 `unwired_error_contract_all_tools` 演进：实施轮
/// 接线后未注入会话统一返回 `tool.computer.not_ready`，06 §7 验收 6 语义）。
#[tokio::test]
async fn not_ready_contract_all_tools() {
    let registry = registry_with(enabled_config());
    let ctx = create_mock_tool_context();
    for name in ALL_TOOL_NAMES {
        let tool = registry.get(name).expect("工具应注册");
        let err = tool
            .execute(&ctx, json!({}))
            .await
            .expect_err("未注入会话应返回 not_ready");
        assert_eq!(
            err.code(),
            codes::TOOL_COMPUTER_NOT_READY,
            "{name} 应返回 tool.computer.not_ready"
        );
    }
}

/// 命名空间共存（18 §2.1 / 06 §3.4）：computer_* 与 browser_* 同注册表
/// 无键冲突、模型同时可见（24 + 13 = 37，不回退）。
#[test]
fn coexists_with_browser_tools_in_same_registry() {
    let mut registry = ToolRegistry::new();
    conex_browser_tools::register_browser_tools(
        &mut registry,
        conex_browser_tools::BrowserToolsConfig::default(),
    )
    .expect("浏览器工具注册成功");
    register_computer_tools(&mut registry, enabled_config()).expect("电脑操作工具注册成功");
    assert_eq!(registry.len(), 37, "两族共存（24 browser + 13 computer）");
    let defs = registry.list_definitions();
    assert!(
        defs.iter().any(|d| d.name == "browser_navigate"),
        "browser_* 工具可见"
    );
    assert!(
        defs.iter().any(|d| d.name == "computer_click"),
        "computer_* 工具可见"
    );
    assert!(
        defs.iter().all(|d| d.name.starts_with("browser_") || d.name.starts_with("computer_")),
        "两族名称无歧义"
    );
}

// ===== 码表（06 §7 验收 8） =====

/// 9 码常量唯一 + 与 06 §5 表逐项拼写一致。
#[test]
fn codes_constants_unique_and_spelled() {
    let entries = [
        codes::TOOL_COMPUTER_INVALID_PARAMS,
        codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS,
        codes::TOOL_COMPUTER_ELEVATED_WINDOW,
        codes::TOOL_COMPUTER_NOT_ENABLED,
        codes::TOOL_COMPUTER_NOT_READY,
        codes::TOOL_COMPUTER_CANCELLED,
        codes::TOOL_COMPUTER_CAPABILITY_UNAVAILABLE,
        codes::TOOL_COMPUTER_UNWIRED,
        codes::TOOL_SESSION_EXCLUSIVE,
    ];
    let unique: HashSet<&str> = entries.iter().copied().collect();
    assert_eq!(unique.len(), entries.len(), "码值必须唯一");
    assert_eq!(entries[0], "tool.computer.invalid_params");
    assert_eq!(entries[1], "tool.computer.coords_out_of_bounds");
    assert_eq!(entries[2], "tool.computer.elevated_window");
    assert_eq!(entries[3], "tool.computer.not_enabled");
    assert_eq!(entries[4], "tool.computer.not_ready");
    assert_eq!(entries[5], "tool.computer.cancelled");
    assert_eq!(entries[6], "tool.computer.capability_unavailable");
    assert_eq!(entries[7], "tool.computer.unwired");
    assert_eq!(entries[8], "tool.session.exclusive");
}

// ===== 守卫链顺序（06 §7 验收 9：互斥/开启复查/急停在审批前） =====

/// 守卫②：互斥检查在审批之前——非 Desktop 态 → exclusive，审批未发起、
/// 零注入。
#[tokio::test]
async fn guard_exclusive_checked_before_approval() {
    let (mut config, session, approval, _stop) = wired_config();
    // 互斥守卫探针：浏览器会话活跃（电脑操作互斥拒绝）
    let activation = Arc::new(ActivationGate::new());
    activation.request_browser().expect("浏览器激活应成功");
    config.activation = Some(activation);

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("互斥必须拒绝");
    assert_eq!(err.code(), codes::TOOL_SESSION_EXCLUSIVE);
    // 审批未发起（pending/last_verdict 均空）+ 零注入
    assert!(approval.pending().is_none(), "审批不得发起（守卫②在审批前）");
    assert!(approval.last_verdict().is_none(), "审批不得有裁决");
    assert_eq!(session.dispatch_count(), 0, "互斥拒绝必须零注入");
}

/// 守卫③：开启态复查在审批之前——未开启 → not_enabled，审批未发起、零注入。
/// 挂载是注册时刻快照：先以开启态注册，运行期挂起后守卫③兜底拒绝。
#[tokio::test]
async fn guard_not_enabled_checked_before_approval() {
    let (config, session, approval, _stop) = wired_config();
    let registry = registry_with(config.clone());
    // 运行期挂起（急停后回 Idle 同路径）：显式关闭开启态
    config
        .enablement
        .as_ref()
        .expect("enablement 已注入")
        .disable("测试挂起");

    let (ctx, _ask) = allowed_ctx();
    let tool = registry.get("computer_click").expect("工具应在注册期挂载");
    let err = tool
        .execute(&ctx, json!({}))
        .await
        .expect_err("未开启必须拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_NOT_ENABLED);
    assert!(approval.pending().is_none(), "审批不得发起（守卫③在审批前）");
    assert!(approval.last_verdict().is_none(), "审批不得有裁决");
    assert_eq!(session.dispatch_count(), 0, "开启复查拒绝必须零副作用");
}

/// 守卫④：急停自查在审批之前——急停旗置位 → cancelled，审批未发起、零注入。
#[tokio::test]
async fn guard_stop_checked_before_approval() {
    let (config, session, approval, stop) = wired_config();
    stop.global_stop();

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("急停必须拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED);
    assert!(approval.pending().is_none(), "审批不得发起（守卫④在审批前）");
    assert_eq!(session.dispatch_count(), 0, "急停拒绝必须零注入");
}

/// 守卫④：中止令牌（abort_token）同样拦截（急停吊销链同一判据）。
#[tokio::test]
async fn guard_abort_token_checked_before_approval() {
    let (config, session, approval, _stop) = wired_config();
    let ctx = create_mock_tool_context();
    ctx.abort_token.abort();
    let err = exec("computer_move", &config, json!({ "coordinate": [1, 2] }), &ctx)
        .await
        .expect_err("中止令牌必须拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED);
    assert!(approval.pending().is_none());
    assert_eq!(session.dispatch_count(), 0);
}

// ===== 审批（守卫⑤：Denied 零注入 / 未注入收口 / ctx.ask 传输） =====

/// 审批拒绝（守卫⑤ 逐次审批语义）→ approval.rejected 零注入（04 §5 项 6 同源）。
/// 拒绝路径：并发在途审批（一次一票，并发请求直接拒绝，防队列堆积）。
#[tokio::test]
async fn approval_denied_zero_injection() {
    let (config, session, approval, _stop) = wired_config();
    // 先手工发起一笔不结算的审批（在途占位）→ 并发请求被拒
    let _pending = approval.require_approval(ApprovalRequest::new("computer_x", "占位"));
    assert!(approval.pending().is_some(), "在途占位审批应存在");

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("并发审批必须拒绝");
    assert_eq!(
        err.code(),
        conex_types::error::codes::APPROVAL_REJECTED,
        "审批拒绝统一 approval.rejected"
    );
    assert_eq!(session.dispatch_count(), 0, "拒绝必须零注入");
}

/// 06 遗留⑤：approval 未注入（None）按 Denied 收口——不静默放行、零注入。
#[tokio::test]
async fn approval_absent_denied_closed() {
    let (mut config, session, _approval, _stop) = wired_config();
    config.approval = None;

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("审批未注入必须拒绝");
    assert_eq!(
        err.code(),
        conex_types::error::codes::APPROVAL_REJECTED,
        "审批未注入按 Denied 收口（安全默认，不静默放行）"
    );
    assert_eq!(session.dispatch_count(), 0, "拒绝必须零注入");
}

/// 审批传输（06 遗留⑤）：Pending → ctx.ask 送用户 → Allowed 收口执行。
/// 断言 ask 调用（工具名 + 载荷字段）+ 执行透传 + 裁决登记。
#[tokio::test]
async fn approval_pending_transports_via_ctx_ask_allowed() {
    let (config, session, approval, _stop) = wired_config();
    let (ctx, ask) = allowed_ctx();

    let result = exec(
        "computer_click",
        &config,
        json!({ "button": "left", "count": "single", "coordinate": [100, 200] }),
        &ctx,
    )
    .await
    .expect("审批放行应执行成功");
    assert_eq!(result["ok"], true);

    // ctx.ask 调用断言：工具名 + 载荷（action/paramsSummary）
    let calls = ask.calls();
    assert_eq!(calls.len(), 1, "恰好一次审批传输");
    let (tool_name, payload) = &calls[0];
    assert_eq!(tool_name, "computer_click");
    assert_eq!(payload["action"], "computer_click");
    assert_eq!(payload["paramsSummary"], "button=left count=single coordinate=[100,200]");

    // 裁决登记：Granted
    let (_, _, verdict) = approval.last_verdict().expect("应有裁决记录");
    assert_eq!(verdict, Approval::Granted);
    assert!(approval.pending().is_none(), "在途审批已结算");

    // 执行透传：Action::Click 参数完整
    let received = session.received_actions();
    assert_eq!(received.len(), 1);
    assert_eq!(
        received[0],
        Action::Click {
            button: MouseButton::Left,
            count: ClickCount::Single,
            coordinate: Some(Point::new(100, 200)),
            modifiers: vec![],
        }
    );
}

/// 审批传输：AskDecision::Denied → approval.rejected + 零注入 + 裁决登记。
#[tokio::test]
async fn approval_pending_transport_denied_zero_injection() {
    let (config, session, approval, _stop) = wired_config();
    let ask = RecordingAsk::new(AskDecision::Denied {
        reason: "用户拒绝".into(),
    });
    let mut ctx = create_mock_tool_context();
    ctx.ask = Some(Arc::new(ask));

    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("用户拒绝必须失败");
    assert_eq!(
        err.code(),
        conex_types::error::codes::APPROVAL_REJECTED,
        "拒绝统一 approval.rejected"
    );
    assert!(err.to_string().contains("用户拒绝"), "原因透传：{err}");
    assert_eq!(session.dispatch_count(), 0, "拒绝必须零注入");
    let (_, _, verdict) = approval.last_verdict().expect("应有裁决记录");
    assert_eq!(
        verdict,
        Approval::Denied {
            reason: "用户拒绝".into()
        }
    );
}

/// 审批等待期取消：ask 等待期间急停/中止令牌置位 → 以 Denied 收口（cancelled，
/// 零注入，security.rs:305-314 注释登记）。
#[tokio::test]
async fn approval_wait_cancelled_by_stop_returns_cancelled() {
    let (config, session, approval, stop) = wired_config();
    // 钩子：ask 等待期间（审批已发起后）触发急停——守卫④ 在审批前放行，
    // settle 前自查发现急停 → 以 Denied 收口
    let ask = RecordingAsk::new(AskDecision::Allowed).with_stop_trigger(stop.clone());
    let mut ctx = create_mock_tool_context();
    ctx.ask = Some(Arc::new(ask));

    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("急停生效必须取消");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED);
    assert_eq!(session.dispatch_count(), 0, "取消必须零注入");
    // 在途审批已按 Denied 收口
    let (_, _, verdict) = approval.last_verdict().expect("应有裁决记录");
    assert!(
        matches!(verdict, Approval::Denied { .. }),
        "等待期取消必须以 Denied 收口"
    );
}

/// 06 遗留⑤：approval 注入但 ctx.ask 未接线 → 按 Denied 收口 + 在途清理
/// （settle 后 pending 为空，不残留审批状态）。
#[tokio::test]
async fn approval_ask_channel_absent_settles_denied() {
    let (config, session, approval, _stop) = wired_config();
    let ctx = create_mock_tool_context(); // ask = None

    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("无传输面必须拒绝");
    assert_eq!(
        err.code(),
        conex_types::error::codes::APPROVAL_REJECTED,
        "ctx.ask 未接线按拒绝收口"
    );
    assert!(approval.pending().is_none(), "在途审批必须已清理");
    assert_eq!(session.dispatch_count(), 0);
}

// ===== 急停接线（06 §7 验收 10） =====

/// computer_estop 触发全局急停链：Global 源急停旗 + 中止令牌吊销 +
/// 会话开启态关闭（恢复需用户重新显式开启，04 §4.4）。
#[tokio::test]
async fn estop_triggers_global_stop_and_abort() {
    let (config, _session, _approval, stop) = wired_config();
    let (ctx, ask) = allowed_ctx();

    let result = exec("computer_estop", &config, json!({ "reason": "模型发现危险" }), &ctx)
        .await
        .expect("estop 应执行成功");
    assert_eq!(result["ok"], true);
    assert_eq!(result["stopped"], true);

    assert!(stop.stopped(), "急停旗必须置位");
    let records = stop.records();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].source, StopSource::Global, "AI 主动急停并入全局链");
    assert!(ctx.abort_token.is_aborted(), "中止令牌必须吊销（同一吊销链）");
    assert!(
        !config
            .enablement
            .as_ref()
            .expect("enablement 已注入")
            .enabled(),
        "会话开启态必须关闭（恢复需用户重新显式开启）"
    );
    // 审批照常走（estop 也经守卫⑤）
    assert_eq!(ask.calls().len(), 1);
}

/// estop 自身不被急停打断：急停旗已置位时 estop 仍可执行（跳过守卫④，
/// 已完成即返回）。
#[tokio::test]
async fn estop_not_interrupted_by_existing_stop() {
    let (config, _session, _approval, stop) = wired_config();
    stop.global_stop(); // 已有急停

    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_estop", &config, json!({}), &ctx)
        .await
        .expect("estop 不被急停打断（自身即急停）");
    assert_eq!(result["stopped"], true);
}

/// 注入批次间自查：dispatch 返回后急停旗已置位 → tool.computer.cancelled
/// （06 §4.2 守卫⑥ 末段）。
#[tokio::test]
async fn stop_during_execution_returns_cancelled() {
    let (config, session, _approval, stop) = wired_config();
    session.stop_on_dispatch(stop.clone());

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("执行中急停必须返回 cancelled");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED);
    assert_eq!(session.dispatch_count(), 1, "动作已派发（在途批次完成）");
    assert!(stop.stopped());
}

// ===== 参数校验与错误映射（守卫⑥） =====

/// 参数校验：未知参数 / 非法 button → invalid_params（工具层解析面）。
#[tokio::test]
async fn click_rejects_bad_params() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_click", &config, json!({ "button": "side" }), &ctx)
        .await
        .expect_err("非法 button 应拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_INVALID_PARAMS);

    let err = exec("computer_click", &config, json!({ "foo": 1 }), &ctx)
        .await
        .expect_err("未知参数应拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_INVALID_PARAMS);
}

/// 参数校验：type 空文本 / key 空数组 / scroll 非法方向 → invalid_params。
#[tokio::test]
async fn type_key_scroll_reject_bad_params() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();

    let err = exec("computer_type", &config, json!({ "text": "" }), &ctx)
        .await
        .expect_err("空文本应拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_INVALID_PARAMS);

    let err = exec("computer_key", &config, json!({ "keys": [] }), &ctx)
        .await
        .expect_err("空组合键应拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_INVALID_PARAMS);

    let err = exec(
        "computer_scroll",
        &config,
        json!({ "direction": "sideways", "amount": 3 }),
        &ctx,
    )
    .await
    .expect_err("非法方向应拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_INVALID_PARAMS);
}

/// 坐标越界映射：会话内 `Action::validate`（coords_out_of_bounds）→ 工具层
/// 透传同码（06 §5）。
#[tokio::test]
async fn coords_out_of_bounds_mapped_from_session() {
    let (config, session, _approval, _stop) = wired_config();
    session.fail_dispatch(SessionError::Action(ActionError::CoordsOutOfBounds));

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_move", &config, json!({ "coordinate": [99999, 0] }), &ctx)
        .await
        .expect_err("越界必须拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS);
}

/// 门禁拒绝映射（06 遗留⑥）：SessionError::Gate（提权/白名单）→
/// tool.computer.elevated_window（06 §4.2 守卫⑥ 统一码）。
#[tokio::test]
async fn gate_denial_maps_to_elevated_window() {
    let (config, session, _approval, _stop) = wired_config();
    session.fail_dispatch(SessionError::Gate(TargetDenial {
        kind: TargetDenialKind::Elevated,
        target: "系统设置 (SystemSettings.exe)".into(),
        reason: "目标窗口为提权进程，拒绝注入".into(),
    }));

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect_err("提权窗口必须拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_ELEVATED_WINDOW);
}

/// 感知失败映射：snapshot 无活动窗口 → tool.execution_failed（消息带语义）。
#[tokio::test]
async fn snapshot_failure_maps_to_execution_failed() {
    let (config, session, _approval, _stop) = wired_config();
    *session
        .snapshot_result
        .lock()
        .expect("mock 锁损坏") = Err(conex_computer::perception::PerceptionError::NoActiveWindow);

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_snapshot", &config, json!({}), &ctx)
        .await
        .expect_err("感知失败应报错");
    assert_eq!(
        err.code(),
        conex_types::error::codes::TOOL_EXECUTION_FAILED
    );
    assert!(err.to_string().contains("无活动窗口"), "消息携带语义：{err}");
}

/// 截屏失败映射：SessionError::Capture → tool.execution_failed。
#[tokio::test]
async fn screenshot_failure_maps_to_execution_failed() {
    let (config, session, _approval, _stop) = wired_config();
    *session
        .screenshot_result
        .lock()
        .expect("mock 锁损坏") = Err(SessionError::Capture("截屏设备失败".into()));

    let (ctx, _ask) = allowed_ctx();
    let err = exec("computer_screenshot", &config, json!({}), &ctx)
        .await
        .expect_err("截屏失败应报错");
    assert_eq!(
        err.code(),
        conex_types::error::codes::TOOL_EXECUTION_FAILED
    );
}

// ===== 返回形状（06 §2.2 实施轮契约） =====

/// click 成功 → {"ok": true, "perceptionVersion": N}。
#[tokio::test]
async fn click_ok_returns_perception_version() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_click", &config, json!({}), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result, json!({ "ok": true, "perceptionVersion": 7 }));
}

/// type 成功 → typedChars（字符数，Unicode 按 char 计）+ perceptionVersion。
#[tokio::test]
async fn type_ok_returns_typed_chars() {
    let (config, session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_type", &config, json!({ "text": "你好 world" }), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result["typedChars"], 8, "中文按字符计");
    assert_eq!(result["perceptionVersion"], 7);
    // 参数透传：Action::Type 原文
    assert_eq!(
        session.received_actions(),
        vec![Action::Type {
            text: "你好 world".to_string()
        }]
    );
}

/// hold_key 成功 → durationSecs 原值回显。
#[tokio::test]
async fn hold_key_ok_returns_duration_secs() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_hold_key", &config, json!({ "key": "a", "duration": 2.5 }), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result["ok"], true);
    assert_eq!(result["durationSecs"], 2.5);
}

/// move 成功 → ok + 坐标透传（_sync 语义由会话承担）。
#[tokio::test]
async fn move_ok_passes_coordinate() {
    let (config, session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_move", &config, json!({ "coordinate": [683, 384] }), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result["ok"], true);
    assert_eq!(
        session.received_actions(),
        vec![Action::MouseMove {
            coordinate: Point::new(683, 384)
        }]
    );
}

/// cursor_position 成功 → API 空间坐标 + displayNumber + perceptionVersion。
#[tokio::test]
async fn cursor_position_ok_returns_api_coords() {
    let (config, session, _approval, _stop) = wired_config();
    *session
        .dispatch_result
        .lock()
        .expect("mock 锁损坏") = Ok(ActionResult::CursorPosition(Point::new(683, 384)));
    session.display_count.store(2, Ordering::SeqCst);

    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_cursor_position", &config, json!({}), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result["x"], 683);
    assert_eq!(result["y"], 384);
    assert_eq!(result["displayNumber"], 2);
    assert_eq!(result["perceptionVersion"], 7);
}

/// screenshot 成功 → image{mediaType,data(base64)} + 显示环境字段。
#[tokio::test]
async fn screenshot_ok_returns_base64_payload() {
    let (config, session, _approval, _stop) = wired_config();
    session.display_count.store(2, Ordering::SeqCst);

    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_screenshot", &config, json!({ "format": "png" }), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result["image"]["mediaType"], "image/png");
    let data = result["image"]["data"]
        .as_str()
        .expect("data 必须为 base64 字符串");
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data)
        .expect("base64 可解码");
    let img = image::load_from_memory(&decoded).expect("解码图像可读取");
    assert_eq!((img.width(), img.height()), (2, 2));
    assert_eq!(result["displayWidthPx"], 2);
    assert_eq!(result["displayHeightPx"], 2);
    assert_eq!(result["displayNumber"], 2);
    assert_eq!(result["perceptionVersion"], 7);
}

/// snapshot 成功 → tree / nodeCount / truncated / perceptionVersion。
#[tokio::test]
async fn snapshot_ok_returns_tree() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_snapshot", &config, json!({}), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result["nodeCount"], 2);
    assert_eq!(result["truncated"], false);
    assert_eq!(result["tree"]["role"], "window");
    assert_eq!(result["tree"]["name"], "测试窗口");
    assert_eq!(result["tree"]["children"][0]["name"], "确定");
    assert_eq!(result["perceptionVersion"], 7);
}

/// wait 成功 → elapsedSecs（实测）+ screenshot=null。
#[tokio::test]
async fn wait_ok_returns_elapsed_secs() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_wait", &config, json!({ "duration": 0.01 }), &ctx)
        .await
        .expect("应成功");
    assert!(
        result["elapsedSecs"].as_f64().expect("elapsedSecs 数字") >= 0.01,
        "实测等待时长应 ≥ 请求时长"
    );
    assert!(result["screenshot"].is_null(), "缺省不返回截屏");
}

/// wait + screenshot=true → 顺带返回截屏载荷（image 结构完整）。
#[tokio::test]
async fn wait_with_screenshot_returns_frame() {
    let (config, session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec(
        "computer_wait",
        &config,
        json!({ "duration": 0.01, "screenshot": true }),
        &ctx,
    )
    .await
    .expect("应成功");
    let shot = result["screenshot"].clone();
    assert_eq!(shot["image"]["mediaType"], "image/png");
    assert_eq!(shot["displayWidthPx"], 2);
    assert_eq!(session.dispatch_count(), 0, "wait 不注入任何输入");
}

/// snapshot 树预算参数：max_depth 二次截断后 nodeCount 联动。
#[tokio::test]
async fn snapshot_budget_applied() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let result = exec("computer_snapshot", &config, json!({ "max_depth": 1 }), &ctx)
        .await
        .expect("应成功");
    assert_eq!(result["nodeCount"], 1, "max_depth=1 仅保留根");
    assert_eq!(result["truncated"], true, "截断必须标记");
}

/// screenshot region 裁剪：越界 → coords_out_of_bounds（zoom 语义，06 §2.1）。
#[tokio::test]
async fn screenshot_region_out_of_bounds_rejected() {
    let (config, _session, _approval, _stop) = wired_config();
    let (ctx, _ask) = allowed_ctx();
    let err = exec(
        "computer_screenshot",
        &config,
        json!({ "region": [0, 0, 99, 2] }),
        &ctx,
    )
    .await
    .expect_err("region 越界应拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS);
}
