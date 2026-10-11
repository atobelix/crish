//! 守卫链端到端集成测试（维度 1 收敛后：3 阶段守卫链）。
//!
//! ## 覆盖面
//! - S1a/b 零注册（未注入 / 显式未开启）；
//! - S2 开启态恰 12 注册 + 清单与 `ALL_TOOL_NAMES` 逐项一致；
//! - S3 守卫① 会话未注入 / 未开启 → `tool.computer.not_ready`/`not_enabled`；
//! - S4a/b/c 守卫② 互斥（浏览器活跃拒绝 + 零注入；release 回 Idle 返回
//!   先前态；Idle→Desktop 后执行成功）；
//! - S5 守卫③ abort_token → `tool.computer.cancelled`；
//! - S9 执行中停止（批次间自查 → cancelled）；
//! - S10a 守卫⑥ ActionTargetGate 拒绝 → `tool.computer.elevated_window`；
//! - S11a-c 真实 WindowTargetGate（mock probe 提权 / 白名单 / 空白名单放行）；
//! - RealComputerSession 包装断言（trait fit + 感知版本推进 mock 面）。

use agent_tools::context::ToolContext;
use agent_tools::definition::ToolError;
use agent_tools::registry::ToolRegistry;
use conex_computer::activation::ActivationGate;
use conex_computer::perception::{PerceptionError, PerceptionNode, PerceptionSnapshot, Rect};
use conex_computer::screen::CapturedFrame;
use conex_computer::security::SessionEnablement;
use conex_computer::window_gate::{ElevationProbe, WhitelistEntry, WindowTargetGate};
use conex_computer::{Action, ActionResult, SessionError};
use conex_computer_tools::session::ComputerOps;
use conex_computer_tools::{codes, register_computer_tools, ComputerToolsConfig, ALL_TOOL_NAMES};
use conex_shared::gate::{ActionTarget, ActionTargetGate, TargetDenial, TargetDenialKind};
use serde_json::{json, Value};
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// ===== 测试替身 =====

/// Mock 会话替身：记录 dispatch 次数 + 感知版本号推进 + 可配置错误注入。
#[derive(Default)]
struct MockComputerOps {
    dispatch_count: AtomicUsize,
    version: AtomicU64,
    inject_denial: Mutex<Option<TargetDenial>>,
    /// 可选：dispatch 内部触发 abort（模拟执行中停止）
    abort_on_dispatch: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl MockComputerOps {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

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

    fn abort_on_dispatch(&self, abort_fn: impl Fn() + Send + Sync + 'static) {
        *self.abort_on_dispatch.lock().expect("mock 锁损坏") = Some(Arc::new(abort_fn));
    }
}

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
        if let Some(abort_fn) = self.abort_on_dispatch.lock().expect("mock 锁损坏").clone() {
            abort_fn();
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

/// Mock 提权探测
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

// ===== 配置与执行辅助 =====

/// 完整守卫装配（开启态 + 守卫组件齐备；桌面态激活）。
fn full_config(
    session: Option<Arc<dyn ComputerOps>>,
) -> (
    ComputerToolsConfig,
    Arc<ActivationGate>,
    Arc<SessionEnablement>,
) {
    let activation = Arc::new(ActivationGate::new());
    activation.request_desktop().expect("桌面激活应成功");
    let enablement = Arc::new(SessionEnablement::new());
    enablement.enable().expect("开启态可建立");
    (
        ComputerToolsConfig {
            session,
            enablement: Some(enablement.clone()),
            activation: Some(activation.clone()),
        },
        activation,
        enablement,
    )
}

fn mock_ctx() -> ToolContext {
    agent_tools::context::create_mock_tool_context()
}

async fn exec_tool(
    config: &ComputerToolsConfig,
    tool_name: &str,
    args: Value,
    ctx: &ToolContext,
) -> Result<Value, ToolError> {
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, config.clone()).expect("注册应成功");
    let tool = registry.get(tool_name).expect("工具应注册");
    tool.execute(ctx, args).await
}

// ===== S1: 零注册 =====

/// S1a：未注入 enablement → 零注册
#[test]
fn s1a_no_enablement_zero_registration() {
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, ComputerToolsConfig::default()).expect("注册应成功");
    assert_eq!(registry.len(), 0);
}

/// S1b：显式未开启 → 零注册
#[test]
fn s1b_disabled_enablement_zero_registration() {
    let enablement = Arc::new(SessionEnablement::new());
    let mut registry = ToolRegistry::new();
    register_computer_tools(
        &mut registry,
        ComputerToolsConfig {
            enablement: Some(enablement),
            ..Default::default()
        },
    )
    .expect("注册应成功");
    assert_eq!(registry.len(), 0);
}

// ===== S2: 开启态注册 =====

/// S2：开启态恰 12 注册 + 清单一致
#[test]
fn s2_enabled_mounts_all_12_tools() {
    let (config, _, _) = full_config(None);
    let mut registry = ToolRegistry::new();
    register_computer_tools(&mut registry, config).expect("注册应成功");
    assert_eq!(registry.len(), 12, "工具族应恰好 12 个");
    let mut names: Vec<String> = registry
        .list_definitions()
        .iter()
        .map(|d| d.name.clone())
        .collect();
    names.sort();
    let mut expected: Vec<String> = ALL_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(names, expected);
}

// ===== S3: 守卫① 未注入 / 未开启 =====

/// S3：未注入会话 → not_ready
#[tokio::test]
async fn s3_no_session_returns_not_ready() {
    let (config, _, _) = full_config(None);
    let ctx = mock_ctx();
    let err = exec_tool(&config, "computer_click", json!({}), &ctx)
        .await
        .expect_err("未注入会话应返回 not_ready");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_NOT_READY);
}

// ===== S4: 守卫② 互斥 =====

/// S4a：浏览器活跃 → exclusive + 零注入
#[tokio::test]
async fn s4a_browser_active_rejects_exclusive() {
    let session = MockComputerOps::new();
    let (mut config, activation, _) = full_config(Some(session.clone()));
    // 切换为浏览器活跃：先释放桌面态，再激活浏览器
    activation.release();
    activation.request_browser().expect("浏览器激活应成功");
    config.activation = Some(activation);

    let ctx = mock_ctx();
    let err = exec_tool(&config, "computer_click", json!({}), &ctx)
        .await
        .expect_err("浏览器活跃时必须拒绝");
    assert_eq!(err.code(), codes::TOOL_SESSION_EXCLUSIVE);
    assert_eq!(session.dispatch_calls(), 0, "互斥拒绝必须零注入");
}

/// S4b：release 回 Idle 后再 Desktop → 执行成功
#[tokio::test]
async fn s4b_release_then_desktop_succeeds() {
    let session = MockComputerOps::new();
    let (mut config, activation, _) = full_config(Some(session.clone()));
    // 先释放桌面态，再激活浏览器，再 release 回 Idle，最后桌面态
    activation.release();
    activation.request_browser().expect("浏览器激活");
    activation.release();
    activation.request_desktop().expect("桌面激活应成功");
    config.activation = Some(activation);

    let ctx = mock_ctx();
    let result = exec_tool(&config, "computer_click", json!({}), &ctx)
        .await
        .expect("桌面活跃应执行成功");
    assert_eq!(result["ok"], true);
    assert_eq!(session.dispatch_calls(), 1);
}

/// S4c：Idle→Desktop 后执行成功
#[tokio::test]
async fn s4c_idle_to_desktop_succeeds() {
    let session = MockComputerOps::new();
    let (config, _, _) = full_config(Some(session.clone()));
    let ctx = mock_ctx();
    let result = exec_tool(&config, "computer_click", json!({}), &ctx)
        .await
        .expect("应执行成功");
    assert_eq!(result["ok"], true);
}

// ===== S5: 守卫③ 停止自查 =====

/// S5：abort_token 置位 → cancelled + 零注入
#[tokio::test]
async fn s5_abort_token_returns_cancelled() {
    let session = MockComputerOps::new();
    let (config, _, _) = full_config(Some(session.clone()));
    let ctx = mock_ctx();
    ctx.abort_token.abort();
    let err = exec_tool(&config, "computer_click", json!({}), &ctx)
        .await
        .expect_err("abort_token 必须拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED);
    assert_eq!(session.dispatch_calls(), 0);
}

// ===== S9: 执行中停止（批次间自查） =====

/// S9：dispatch 返回后 abort_token 已置位 → cancelled
#[tokio::test]
async fn s9_stop_during_execution_returns_cancelled() {
    let session = MockComputerOps::new();
    let (config, _, _) = full_config(Some(session.clone()));
    let ctx = agent_tools::context::create_mock_tool_context();
    let abort_token = ctx.abort_token.clone();
    session.abort_on_dispatch(move || abort_token.abort());

    let err = exec_tool(&config, "computer_click", json!({}), &ctx)
        .await
        .expect_err("执行中停止必须返回 cancelled");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED);
    assert_eq!(session.dispatch_calls(), 1, "动作已派发（在途批次完成）");
}

// ===== S10: 守卫⑥ 门禁拒绝 =====

/// S10a：Gate 拒绝 → elevated_window
#[tokio::test]
async fn s10a_gate_denial_maps_to_elevated_window() {
    let session = MockComputerOps::with_gate_err();
    let (config, _, _) = full_config(Some(session.clone()));
    let ctx = mock_ctx();
    let err = exec_tool(&config, "computer_click", json!({}), &ctx)
        .await
        .expect_err("提权窗口必须拒绝");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_ELEVATED_WINDOW);
}

// ===== S11: 真实 WindowTargetGate =====

/// S11a：mock probe 提权进程 → 拒绝
#[test]
fn s11a_elevated_process_rejected() {
    let gate = WindowTargetGate::with_probe(
        Vec::new(),
        Arc::new(MockProbe::elevated(vec!["elevated.exe".into()])),
    );
    let target = ActionTarget::Window {
        title: "Elevated App".into(),
        process: Some("elevated.exe".into()),
    };
    let result = gate.check(&target);
    assert!(result.is_err(), "提权进程必须拒绝");
    let denial = result.unwrap_err();
    assert_eq!(denial.kind, TargetDenialKind::Elevated);
}

/// S11b：白名单匹配 → 放行
#[test]
fn s11b_whitelist_allows() {
    let gate = WindowTargetGate::new(vec![WhitelistEntry::new("Notepad", None)]);
    let target = ActionTarget::Window {
        title: "Notepad".into(),
        process: Some("notepad.exe".into()),
    };
    assert!(gate.check(&target).is_ok(), "白名单进程应放行");
}

/// S11c：空白名单 + 非提权 → 放行
#[test]
fn s11c_empty_whitelist_non_elevated_allows() {
    let gate = WindowTargetGate::new(Vec::new());
    let target = ActionTarget::Window {
        title: "App".into(),
        process: Some("normal.exe".into()),
    };
    assert!(gate.check(&target).is_ok(), "空白名单 + 非提权应放行");
}

// ===== RealComputerSession 包装断言 =====

/// RealComputerSession 可装箱为 `Arc<dyn ComputerOps>`
#[test]
fn real_computer_session_fits_computer_ops_trait() {
    fn assert_computer_ops<T: ComputerOps>() {}
    assert_computer_ops::<conex_computer_tools::session::RealComputerSession>();
}

/// wait 在 abort_token 触发时立即返回 cancelled（维度 1 收敛：select! 修复）。
#[tokio::test]
async fn wait_aborted_returns_cancelled_immediately() {
    let session = MockComputerOps::new();
    let (config, _, _) = full_config(Some(session.clone()));
    let ctx = agent_tools::context::create_mock_tool_context();
    ctx.abort_token.abort();
    let start = std::time::Instant::now();
    let err = exec_tool(&config, "computer_wait", json!({ "duration": 50 }), &ctx)
        .await
        .expect_err("abort 后 wait 应立即返回 cancelled");
    assert_eq!(err.code(), codes::TOOL_COMPUTER_CANCELLED);
    assert!(
        start.elapsed().as_secs() < 1,
        "abort 应立即返回（实际 {:?}）",
        start.elapsed()
    );
}
