//! 守卫链端到端集成测试（49 报告 §1 迁移，R1-2 建议 3 入库护栏）。
//!
//! ## 迁移依据
//! 49 报告（`.agent-outputs/2026-08-08-browser-selection/49-电脑操作端到端联调.md`）
//! §1 守卫链 29 断言原在 temp rig（`cu-e2e/smoke/src/bin/guard_chain.rs`），
//! 无入库护栏。本文件将其迁移为 conex-computer-tools `tests/` 集成测试：
//! mock 会话面**常驻**（全平台可跑，CI 守护）；真实桌面面见
//! `tests/real_desktop.rs`（`#[ignore]` 标注，依赖交互式桌面会话）。
//!
//! ## 覆盖面（对齐 49 报告断言编号）
//! - S1a/b 零注册（未注入 / 显式未开启）；
//! - S2 开启态恰 13 注册 + 清单与 `ALL_TOOL_NAMES` 逐项一致；
//! - S3 守卫① 会话未注入 → `tool.computer.not_ready`；
//! - S4a/b/c 守卫② 互斥（浏览器活跃拒绝 + 零注入；release 回 Idle 返回
//!   先前态；Idle→Desktop 后执行成功）；
//! - S5 守卫③ 运行期禁用 → `tool.computer.not_enabled` + 零副作用；
//! - S6 守卫④ 急停旗 → `tool.computer.cancelled`（审批前拦截）；
//! - S7a-e 守卫⑤ 审批流（Granted 执行 / Denied 零注入 / 审批门未注入拒绝 /
//!   ctx.ask 未接线拒绝 + 在途清理 / 并发逐次审批）；
//! - S8a-e 急停链（estop 工具 → 全局急停 + abort_token 吊销 + 开启态关闭 +
//!   后续 not_enabled）；
//! - S9 执行中急停（批次间自查 → cancelled）；
//! - S10a 守卫⑥ ActionTargetGate 拒绝 → `tool.computer.elevated_window`；
//! - S11a-c 真实 WindowTargetGate（mock probe 提权 / 白名单 / 空白名单放行）；
//! - S12a-e 4 命令契约组件层对照（enable/disable/estop/status 状态语义）；
//! - RealComputerSession 包装断言（trait fit + 感知版本推进 mock 面）。

use agent_tools::context::{AskChannel, AskDecision, ToolContext};
use agent_tools::definition::ToolError;
use agent_tools::registry::ToolRegistry;
use conex_computer::activation::{ActivationGate, SessionMode};
use conex_computer::perception::{PerceptionError, PerceptionNode, PerceptionSnapshot, Rect};
use conex_computer::screen::CapturedFrame;
use conex_computer::security::{
    Approval, ApprovalGate, ApprovalRequest, EmergencyStop, EnableSource, SessionEnablement,
    StopSource,
};
use conex_computer::window_gate::{ElevationProbe, WhitelistEntry, WindowTargetGate};
use conex_computer::{Action, ActionResult, SessionError};
use conex_computer_tools::session::ComputerOps;
use conex_computer_tools::{codes, register_computer_tools, ComputerToolsConfig, ALL_TOOL_NAMES};
use conex_shared::gate::{ActionTarget, ActionTargetGate, TargetDenial, TargetDenialKind};
use serde_json::{json, Value};
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// ===== 测试替身（mock 会话 / 审批通道，常驻面） =====

/// Mock 会话替身：记录 dispatch 次数 + 感知版本号推进 + 可配置错误注入。
///
/// 零注入断言 = `dispatch_count()` 不变；感知版本推进（18 §5 项 7）在
/// dispatch/screenshot/snapshot 成功后 `+1`（与 `RealComputerSession`
/// 实装语义一致，49 报告 T7 同源）。
#[derive(Default)]
struct MockComputerOps {
    /// dispatch 调用次数（零注入断言的唯一判据）
    dispatch_count: AtomicUsize,
    /// 感知版本号（成功后推进）
    version: AtomicU64,
    /// 可选：dispatch 时注入 Gate 拒绝（模拟提权/白名单拒绝）
    inject_denial: Mutex<Option<TargetDenial>>,
    /// 可选：dispatch 内部触发急停（模拟执行中急停）
    stop_on_dispatch: Mutex<Option<Arc<EmergencyStop>>>,
}

impl MockComputerOps {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 注入「dispatch 时返回 Gate 拒绝」（守卫⑥ 映射测试面）
    fn with_gate_err() -> Arc<Self> {
        let s = Self::default();
        *s.inject_denial.lock().expect("mock 锁损坏") = Some(TargetDenial {
            kind: TargetDenialKind::Elevated,
            target: "系统设置 (SystemSettings.exe)".into(),
            reason: "提权窗口拒绝注入 (tool.computer.elevated_window)".into(),
        });
        Arc::new(s)
    }

    fn dispatch_calls(&self) -> usize {
        self.dispatch_count.load(Ordering::SeqCst)
    }

    fn version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }
}

/// 2x2 PNG 样例帧（screenshot 返回面；工具层会解码后处理）
fn sample_frame() -> CapturedFrame {
    let mut img = image::RgbaImage::new(2, 2);
    for pixel in img.pixels_mut() {
        *pixel = image::Rgba([10, 20, 30, 255]);
    }
    let mut buf = Cursor::new(Vec::new());
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

/// UIA 样例快照（snapshot 返回面）
fn sample_snapshot() -> PerceptionSnapshot {
    let root = PerceptionNode::new(
        "window",
        "Untitled - Notepad",
        "",
        Rect::new(0, 0, 800, 600),
        vec![PerceptionNode::new(
            "edit",
            "Text editor",
            "hello",
            Rect::new(0, 0, 800, 600),
            vec![],
        )],
    );
    PerceptionSnapshot {
        root,
        node_count: 2,
        truncated: false,
    }
}

#[async_trait::async_trait]
impl ComputerOps for MockComputerOps {
    fn readiness(&self) -> Result<(), String> {
        Ok(())
    }

    async fn dispatch(&self, _action: &Action) -> Result<ActionResult, SessionError> {
        if let Some(stop) = self.stop_on_dispatch.lock().expect("mock 锁损坏").clone() {
            stop.global_stop();
        }
        if let Some(denial) = self.inject_denial.lock().expect("mock 锁损坏").clone() {
            return Err(SessionError::Gate(denial));
        }
        self.dispatch_count.fetch_add(1, Ordering::SeqCst);
        self.version.fetch_add(1, Ordering::SeqCst);
        Ok(ActionResult::Done)
    }

    async fn screenshot(&self) -> Result<CapturedFrame, SessionError> {
        self.version.fetch_add(1, Ordering::SeqCst);
        Ok(sample_frame())
    }

    async fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError> {
        self.version.fetch_add(1, Ordering::SeqCst);
        Ok(sample_snapshot())
    }

    fn perception_version(&self) -> u64 {
        self.version()
    }
}

/// Mock 审批通道：裁决可配（Allowed / Denied）+ 调用计数。
#[derive(Debug, Clone)]
struct MockAsk {
    decision: AskDecision,
    calls: Arc<AtomicUsize>,
}

impl MockAsk {
    fn allowed() -> Self {
        Self {
            decision: AskDecision::Allowed,
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn denied(reason: &str) -> Self {
        Self {
            decision: AskDecision::Denied {
                reason: reason.to_string(),
            },
            calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl AskChannel for MockAsk {
    async fn ask(
        &self,
        _tool_name: &str,
        _args: &Value,
    ) -> Result<AskDecision, ToolError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.decision.clone())
    }
}

/// Mock 提权探测（S11a：判定指定进程名提权）
struct MockProbe {
    elevated: Vec<String>,
}

impl MockProbe {
    fn elevated(elevated: Vec<String>) -> Self {
        Self { elevated }
    }
}

impl ElevationProbe for MockProbe {
    fn is_elevated(&self, process: &str) -> bool {
        self.elevated.iter().any(|e| e == process)
    }
}

// ===== 配置与执行辅助（对齐 49 rig：真实守卫组件 + mock 会话） =====

/// 完整守卫装配（开启态 + 五守卫组件齐备；approval 绑定急停旗）。
fn full_config(
    session: Option<Arc<dyn ComputerOps>>,
) -> (
    ComputerToolsConfig,
    Arc<ActivationGate>,
    Arc<SessionEnablement>,
    Arc<ApprovalGate>,
    Arc<EmergencyStop>,
) {
    let activation = Arc::new(ActivationGate::new());
    let enablement = Arc::new(SessionEnablement::new());
    enablement
        .enable(EnableSource::User)
        .expect("开启态可建立");
    let stop = Arc::new(EmergencyStop::new());
    let approval = Arc::new(ApprovalGate::with_stop(stop.clone()));
    (
        ComputerToolsConfig {
            session,
            enablement: Some(enablement.clone()),
            activation: Some(activation.clone()),
            approval: Some(approval.clone()),
            stop: Some(stop.clone()),
        },
        activation,
        enablement,
        approval,
        stop,
    )
}

/// 带审批通道的会话上下文
fn ctx_with_ask(ask: Option<Arc<dyn AskChannel>>) -> ToolContext {
    let mut ctx = agent_tools::context::create_mock_tool_context();
    ctx.ask = ask;
    ctx
}

/// 执行辅助：新注册表 + 指定上下文执行工具（真实工具面路径）
async fn run_tool(
    registry: &ToolRegistry,
    name: &str,
    args: Value,
    ctx: &ToolContext,
) -> Result<Value, ToolError> {
    let tool = registry
        .get(name)
        .unwrap_or_else(|| panic!("工具 {name} 未注册"));
    tool.execute(ctx, args).await
}

/// 注册 + 激活桌面态 + 返回（registry, mock, approval, stop）
async fn desktop_rig(
    session: Arc<dyn ComputerOps>,
) -> (ToolRegistry, Arc<dyn ComputerOps>, Arc<ApprovalGate>, Arc<EmergencyStop>) {
    let (cfg, activation, _, approval, stop) = full_config(Some(session.clone()));
    activation.request_desktop().expect("可进桌面态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    (registry, session, approval, stop)
}

// ===== S1/S2 挂载判据 =====

/// S1a：未注入 enablement → 注册函数零注册返回 Ok（安全默认）。
#[test]
fn s1a_zero_registration_without_enablement() {
    let mut registry = ToolRegistry::new();
    let r = register_computer_tools(&mut registry, ComputerToolsConfig::default());
    assert!(r.is_ok(), "零注册必须返回 Ok：{r:?}");
    assert_eq!(registry.len(), 0, "未注入开启判据必须零注册");
}

/// S1b：显式未开启（新会话默认关闭态）→ 零注册。
#[test]
fn s1b_zero_registration_when_explicitly_disabled() {
    let enablement = Arc::new(SessionEnablement::new());
    assert!(!enablement.tool_mount_allowed(), "新会话默认关闭");
    let mut registry = ToolRegistry::new();
    let r = register_computer_tools(
        &mut registry,
        ComputerToolsConfig {
            enablement: Some(enablement),
            ..Default::default()
        },
    );
    assert!(r.is_ok());
    assert_eq!(registry.len(), 0, "显式未开启必须零注册");
}

/// S2：开启态 → 恰 13 注册，清单与 ALL_TOOL_NAMES 逐项一致（清单防漂移）。
#[test]
fn s2_enabled_mounts_exactly_13_matching_manifest() {
    let (cfg, _, _, _, _) = full_config(None);
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    let names: Vec<String> = registry.list().iter().map(|t| t.name().to_string()).collect();
    assert_eq!(names.len(), 13, "工具族应恰好 13 个：{names:?}");
    assert_eq!(
        names,
        ALL_TOOL_NAMES.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        "注册清单必须与 ALL_TOOL_NAMES 逐项一致"
    );
    // 全部 dangerous=true（04 §4.2 全动作审批）
    assert!(
        registry
            .list()
            .iter()
            .all(|t| t.definition().dangerous),
        "13 个工具必须全 dangerous=true"
    );
}

// ===== S3/S4 守卫①-②（会话注入 / 互斥） =====

/// S3：守卫① 会话未注入 → `tool.computer.not_ready`（对齐 R-9 gating）。
#[tokio::test]
async fn s3_session_not_injected_returns_not_ready() {
    let (cfg, activation, _, _, _) = full_config(None);
    activation.request_desktop().expect("可进桌面态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("未注入会话应拒绝");
    assert_eq!(
        err.code(),
        codes::TOOL_COMPUTER_NOT_READY,
        "会话未注入应返回 tool.computer.not_ready：{err}"
    );
}

/// S4a：守卫② 浏览器活跃 → `tool.session.exclusive` + 零注入（dispatch 计数不变）。
#[tokio::test]
async fn s4a_browser_active_blocks_exclusive_zero_injection() {
    let mock = MockComputerOps::new();
    let (cfg, activation, _, _, _) = full_config(Some(mock.clone()));
    activation.request_browser().expect("可进浏览器态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let calls_before = mock.dispatch_calls();
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("浏览器活跃时应拒绝");
    assert_eq!(err.code(), codes::TOOL_SESSION_EXCLUSIVE, "互斥码：{err}");
    assert_eq!(
        mock.dispatch_calls(),
        calls_before,
        "互斥拒绝必须零注入"
    );
}

/// S4b：release 回 Idle 返回先前态（BrowserActive）。
#[tokio::test]
async fn s4b_release_returns_previous_mode() {
    let activation = Arc::new(ActivationGate::new());
    activation.request_browser().expect("可进浏览器态");
    let prev = activation.release();
    assert_eq!(prev, SessionMode::BrowserActive, "release 应返回先前态");
    assert_eq!(activation.current(), SessionMode::Idle);
}

/// S4c：Idle → DesktopActive → 工具执行成功（互斥释放后链路正确，
/// `{ok:true, perceptionVersion:1}`——mock 感知版本随 dispatch 推进）。
#[tokio::test]
async fn s4c_desktop_active_executes_successfully() {
    let mock = MockComputerOps::new();
    let (registry, _, _, _) = desktop_rig(mock.clone()).await;
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let result = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect("桌面活跃应执行成功");
    assert_eq!(result["ok"], true);
    assert_eq!(
        result["perceptionVersion"], 1,
        "感知版本应随 dispatch 推进（0 → 1）"
    );
}

// ===== S5/S6 守卫③-④（开启复查 / 急停自查） =====

/// S5：守卫③ 运行期禁用 → `tool.computer.not_enabled` + 零注入
/// （挂载是注册时刻快照，运行期挂起由本守卫兜底）。
#[tokio::test]
async fn s5_runtime_disable_returns_not_enabled() {
    let mock = MockComputerOps::new();
    let (cfg, activation, enablement, _, _) = full_config(Some(mock.clone()));
    activation.request_desktop().expect("可进桌面态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    enablement.disable("运行期禁用验证");
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let calls_before = mock.dispatch_calls();
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("禁用后应拒绝");
    assert_eq!(
        err.code(),
        codes::TOOL_COMPUTER_NOT_ENABLED,
        "运行期禁用应返回 not_enabled：{err}"
    );
    assert_eq!(mock.dispatch_calls(), calls_before, "拒绝必须零副作用");
}

/// S6：守卫④ 急停旗置位 → `tool.computer.cancelled`（审批前拦截）。
#[tokio::test]
async fn s6_estop_flag_returns_cancelled() {
    let mock = MockComputerOps::new();
    let (cfg, activation, _, approval, stop) = full_config(Some(mock.clone()));
    activation.request_desktop().expect("可进桌面态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    stop.global_stop();
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("急停中应拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED, "急停码：{err}");
    assert!(approval.pending().is_none(), "急停自查必须在审批之前");
    assert_eq!(mock.dispatch_calls(), 0, "急停拒绝必须零注入");
}

// ===== S7 守卫⑤ 审批流（Ask 逐次审批） =====

/// S7a：Pending → ctx.ask Allowed → Granted → 执行（dispatch=1）。
#[tokio::test]
async fn s7a_approval_allowed_executes() {
    let mock = MockComputerOps::new();
    let (registry, _, approval, _) = desktop_rig(mock.clone()).await;
    let ask = MockAsk::allowed();
    let ctx = ctx_with_ask(Some(Arc::new(ask.clone())));
    let result = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect("审批放行应执行成功");
    assert_eq!(result["ok"], true);
    assert_eq!(mock.dispatch_calls(), 1, "放行后应恰好注入一次");
    assert_eq!(ask.call_count(), 1, "审批传输应恰好一次");
    let (_, _, verdict) = approval.last_verdict().expect("应有裁决记录");
    assert_eq!(verdict, Approval::Granted);
    assert!(approval.pending().is_none(), "在途审批已结算");
}

/// S7b：Pending → ctx.ask Denied → `approval.rejected` + 零注入。
#[tokio::test]
async fn s7b_approval_denied_zero_injection() {
    let mock = MockComputerOps::new();
    let (registry, _, approval, _) = desktop_rig(mock.clone()).await;
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::denied("用户拒绝"))));
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("用户拒绝应失败");
    assert_eq!(
        err.code(),
        conex_types::error::codes::APPROVAL_REJECTED,
        "拒绝统一 approval.rejected：{err}"
    );
    assert!(err.to_string().contains("用户拒绝"), "原因透传：{err}");
    assert_eq!(mock.dispatch_calls(), 0, "拒绝必须零注入");
    let (_, _, verdict) = approval.last_verdict().expect("应有裁决记录");
    assert_eq!(
        verdict,
        Approval::Denied {
            reason: "用户拒绝".into()
        }
    );
}

/// S7c：审批门未注入（None）→ `approval.rejected`（安全默认，不静默放行）。
#[tokio::test]
async fn s7c_approval_gate_absent_rejects() {
    let mock = MockComputerOps::new();
    let (cfg, activation, _, _, _stop) = full_config(Some(mock.clone()));
    activation.request_desktop().expect("可进桌面态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(
        &mut registry,
        ComputerToolsConfig {
            session: cfg.session,
            enablement: cfg.enablement,
            activation: cfg.activation,
            approval: None,
            stop: cfg.stop,
        },
    )
    .expect("注册应成功");
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("审批门未注入应拒绝");
    assert_eq!(
        err.code(),
        conex_types::error::codes::APPROVAL_REJECTED,
        "审批门未注入按拒绝收口"
    );
    assert!(err.to_string().contains("审批门未注入"), "文案：{err}");
    assert_eq!(mock.dispatch_calls(), 0, "拒绝必须零注入");
}

/// S7d：ctx.ask 未接线（None）→ `approval.rejected` + 在途审批已清理。
#[tokio::test]
async fn s7d_ask_channel_absent_settles_denied() {
    let mock = MockComputerOps::new();
    let (registry, _, approval, _) = desktop_rig(mock.clone()).await;
    let ctx = ctx_with_ask(None);
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("无传输面应拒绝");
    assert_eq!(
        err.code(),
        conex_types::error::codes::APPROVAL_REJECTED,
        "ctx.ask 未接线按拒绝收口"
    );
    assert!(approval.pending().is_none(), "在途审批必须已清理");
    assert_eq!(mock.dispatch_calls(), 0);
}

/// S7e：并发审批 → 第二次 Denied（Ask 逐次审批语义，防队列堆积）。
#[tokio::test]
async fn s7e_concurrent_approval_second_denied() {
    let (_, _, _, approval, _) = full_config(Some(MockComputerOps::new()));
    let r1 = approval.require_approval(ApprovalRequest::new("computer_click", "count=single"));
    let r2 = approval.require_approval(ApprovalRequest::new("computer_type", "text=abc"));
    assert!(matches!(r1, Approval::Pending { .. }), "首次应 Pending：{r1:?}");
    assert!(
        matches!(r2, Approval::Denied { .. }),
        "并发请求必须 Denied（逐次审批）：{r2:?}"
    );
    if let Approval::Pending { id } = r1 {
        let _ = approval.settle(id, Approval::Granted);
    }
}

// ===== S8 急停链（estop 工具 + 执行中急停） =====

/// S8a-d：computer_estop → `{ok:true, stopped:true}` + 全局急停旗（来源
/// Global）+ abort_token 吊销（同一吊销链）+ 会话开启态关闭（恢复需重新
/// 显式开启）。
#[tokio::test]
async fn s8_estop_tool_triggers_global_chain() {
    let mock = MockComputerOps::new();
    let (cfg, activation, enablement, _, stop) = full_config(Some(mock.clone()));
    activation.request_desktop().expect("可进桌面态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let result = run_tool(
        &registry,
        "computer_estop",
        json!({ "reason": "AI 主动急停验证" }),
        &ctx,
    )
    .await
    .expect("estop 应执行成功");
    assert_eq!(result["ok"], true);
    assert_eq!(result["stopped"], true);
    assert!(stop.stopped(), "急停旗必须置位");
    assert!(
        stop.records()
            .last()
            .is_some_and(|r| r.source == StopSource::Global),
        "AI 主动急停并入全局链：{:?}",
        stop.records()
    );
    assert!(ctx.abort_token.is_aborted(), "abort_token 必须吊销");
    assert!(!enablement.enabled(), "会话开启态必须关闭");
}

/// S8e：急停后动作 → `tool.computer.not_enabled`（守卫③ 兜底；
/// estop 已关闭开启态，复查在急停自查之前拦截）。
#[tokio::test]
async fn s8e_estop_after_action_returns_not_enabled() {
    let mock = MockComputerOps::new();
    let (cfg, activation, _, _, stop) = full_config(Some(mock.clone()));
    activation.request_desktop().expect("可进桌面态");
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let _ = run_tool(
        &registry,
        "computer_estop",
        json!({}),
        &ctx,
    )
    .await;
    assert!(stop.stopped());
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("急停后应拒绝");
    assert_eq!(
        err.code(),
        codes::TOOL_COMPUTER_NOT_ENABLED,
        "急停后动作应 not_enabled（守卫③ 兜底）：{err}"
    );
}

/// S9：执行中急停（批次间自查）——dispatch 内部触发急停 →
/// `tool.computer.cancelled`（动作已派发，在途批次完成）。
#[tokio::test]
async fn s9_in_flight_estop_returns_cancelled() {
    let mock = MockComputerOps::new();
    let (cfg, activation, _, _, stop) = full_config(Some(mock.clone()));
    activation.request_desktop().expect("可进桌面态");
    *mock.stop_on_dispatch.lock().expect("mock 锁损坏") = Some(stop.clone());
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, cfg).expect("注册应成功");
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("执行中急停应拒绝");
    assert_eq!(
        err.code(),
        codes::TOOL_COMPUTER_CANCELLED,
        "执行中急停应 cancelled：{err}"
    );
    assert_eq!(mock.dispatch_calls(), 1, "动作已派发（在途批次完成）");
    assert!(stop.stopped());
}

// ===== S10/S11 守卫⑥ ActionTargetGate =====

/// S10a：会话返回 Gate 拒绝（提权）→ 工具映射 `tool.computer.elevated_window`
/// （载荷透传）。
#[tokio::test]
async fn s10a_gate_denial_maps_to_elevated_window() {
    let mock = MockComputerOps::with_gate_err();
    let (registry, _, _, _) = desktop_rig(mock.clone()).await;
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));
    let err = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect_err("提权拒绝应透出");
    assert_eq!(
        err.code(),
        codes::TOOL_COMPUTER_ELEVATED_WINDOW,
        "Gate 拒绝应映射 elevated_window：{err}"
    );
    assert!(err.to_string().contains("系统设置"), "载荷透传：{err}");
    assert_eq!(mock.dispatch_calls(), 0, "拒绝必须零注入");
}

/// S11a：真实 WindowTargetGate + mock probe：提权进程窗口 → Elevated 拒绝
/// （reason 含错误码语义）。
#[test]
fn s11a_window_gate_elevated_probe_rejects() {
    let gate = WindowTargetGate::with_probe(
        vec![WhitelistEntry::new("系统设置", None)],
        Arc::new(MockProbe::elevated(vec!["SystemSettings.exe".into()])),
    );
    let denial = gate
        .check(&ActionTarget::Window {
            title: "系统设置".into(),
            process: Some("SystemSettings.exe".into()),
        })
        .expect_err("提权应拒绝");
    assert_eq!(denial.kind, TargetDenialKind::Elevated, "{denial:?}");
    assert!(
        denial.reason.contains("tool.computer.elevated_window"),
        "reason 应含错误码语义：{}",
        denial.reason
    );
}

/// S11b：白名单外窗口 → Whitelist 拒绝。
#[test]
fn s11b_window_gate_whitelist_denies_outside() {
    let gate = WindowTargetGate::new(vec![WhitelistEntry::new("记事本", None)]);
    let denial = gate
        .check(&ActionTarget::Window {
            title: "计算器".into(),
            process: Some("calc.exe".into()),
        })
        .expect_err("白名单外应拒绝");
    assert_eq!(denial.kind, TargetDenialKind::Whitelist, "{denial:?}");
}

/// S11c：空白名单默认放行。
#[test]
fn s11c_window_gate_empty_whitelist_allows() {
    let gate = WindowTargetGate::new(vec![]);
    assert!(
        gate.check(&ActionTarget::Window {
            title: "任意窗口".into(),
            process: None,
        })
        .is_ok(),
        "空白名单默认放行"
    );
}

// ===== S12 4 命令契约（组件层对照前端 computerSessionApi.ts 载荷形状） =====

/// S12a-e：enable/disable/estop/status 组件状态语义与前端契约形状一一对应：
/// `{ enabled: bool }` / `{ stopped: true }` / mode 三态（idle/browser/desktop）
/// + persisted_value。
#[test]
fn s12_command_contract_component_semantics() {
    // enable → { enabled: true }
    let e = SessionEnablement::new();
    e.enable(EnableSource::User).expect("可开启");
    assert!(e.enabled() && e.persisted_value(), "enable → enabled=true");

    // disable → { enabled: false } + reason 登记
    e.disable("面板停用");
    assert!(!e.enabled() && !e.persisted_value());
    assert!(e.disabled_reason().is_some(), "禁用原因必须登记");

    // estop → { stopped: true } + 来源记录（Panel 示例源）
    let stop = EmergencyStop::new();
    stop.panel_stop();
    assert!(stop.stopped());
    assert!(
        stop.records()
            .last()
            .is_some_and(|r| r.source == StopSource::Panel)
    );

    // status → mode 三态映射（idle/browser/desktop）
    let gate = ActivationGate::new();
    assert_eq!(gate.current(), SessionMode::Idle);
    gate.request_browser().expect("可进浏览器态");
    assert_eq!(gate.current(), SessionMode::BrowserActive);
    gate.release();
    gate.request_desktop().expect("可进桌面态");
    assert_eq!(gate.current(), SessionMode::DesktopActive);
}

// ===== RealComputerSession 包装断言（mock 面 + trait fit） =====

/// RealComputerSession 可装箱为 `Arc<dyn ComputerOps>`（工具面注入契约；
/// 编译期断言全平台生效，非 Windows 为降级实装）。
#[test]
fn real_session_wrapper_fits_computer_ops() {
    fn assert_computer_ops<T: ComputerOps>() {}
    assert_computer_ops::<conex_computer_tools::session::RealComputerSession>();
}

/// 感知版本推进 mock 面：连续动作后版本单调递增（与 RealComputerSession
/// 实装语义一致——dispatch/screenshot/snapshot 成功后 +1，18 §5 项 7）。
#[tokio::test]
async fn perception_version_advances_monotonically() {
    let mock = MockComputerOps::new();
    let (registry, _, _, _) = desktop_rig(mock.clone()).await;
    let ctx = ctx_with_ask(Some(Arc::new(MockAsk::allowed())));

    let r1 = run_tool(&registry, "computer_click", json!({}), &ctx)
        .await
        .expect("click 应成功");
    let v1 = r1["perceptionVersion"].as_u64().expect("版本字段");

    let r2 = run_tool(&registry, "computer_type", json!({ "text": "hi" }), &ctx)
        .await
        .expect("type 应成功");
    let v2 = r2["perceptionVersion"].as_u64().expect("版本字段");
    assert!(v2 > v1, "版本必须单调递增：{v1} → {v2}");

    let r3 = run_tool(&registry, "computer_snapshot", json!({}), &ctx)
        .await
        .expect("snapshot 应成功");
    let v3 = r3["perceptionVersion"].as_u64().expect("版本字段");
    assert!(v3 > v2, "版本必须单调递增：{v2} → {v3}");
}
