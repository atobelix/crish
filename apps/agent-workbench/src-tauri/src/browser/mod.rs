//! 浏览器会话槽与惰性会话操作层（27 接线方案 S3/S4/S5 引擎侧装配面）
//!
//! ## 定位
//! 27 方案 D-A/D-B 的落点：**进程级惰性单例**——一个 [BrowserSlot] 持有
//! `BrowserManager`（进程管理器）+ 会话槽（`tokio::sync::Mutex<Option<RealSession>>`）
//! + estop 周期（[CancellationToken] + 急停旗，M-2 abort 桥），全应用共享；
//!   否决会话级（每会话一实例）的理由见 27 §2.1（单实例双控制面 + 引擎级
//!   共享注册表 + 全局右侧面板）。
//!
//! - 生命周期（27 §2.1）：**惰性启动**——首次 browser_* 工具调用（经
//!   [LazySessionOps] 的 ensure_ready 入口）或面板命令（browser_start）时
//!   `manager.start(LaunchConfig)` → 端点就绪 → `BrowserSession::connect`
//!   （policy = [AllowAllPolicy]，estop 信号源注入）；**停止** = 面板命令
//!   browser_stop（Graceful）；应用退出由 BrowserManager Drop 兜底杀树
//!   （browser/mod.rs Drop impl，退出钩子不重复接线）。
//! - 崩溃/重启（R-9）：manager 状态 Crashed/Launching/Stopping → 恢复期
//!   gating（`tool.browser.not_ready`）；重启完成后 Running + **端点漂移**
//!   （随机端口变化）→ 会话槽重建（旧 Transport 端口已死，必须重连）。
//! - estop 周期（M-2，27 §2.5）：[BrowserSlot::reset_estop] 每 run 启动时
//!   换新令牌 + 复位急停旗（新 run 不继承上一 run 的取消态，防毒化会话）；
//!   run 级强停（L3/用户取消）经 [spawn_browser_estop_watcher] 触发
//!   [BrowserSlot::cancel_estop]（发送层在途命令逐 id 取消 + 新命令拒绝）。
//! - 事件面：状态迁移经 `browser://state-changed`（`{ state, url? }`）Tauri
//!   发射（对齐 27 方案 S6 契约与 conex-browser events.rs 的同前缀约定）；
//!   [BrowserSlot::attach_emitter] 挂接，转发任务惰性单飞。
//!
//! ## 配置口径（27 §2.1/§2.2）
//! - `launch`：Auto 回退链 + Ephemeral profile + `allow_cft_download: false`；
//!   **模式偏离登记**：方案要求 `mode: Headed`（MVP M4 可见形态），但
//!   conex-browser `EngineMode` 枚举仅有 HeadlessNew/HeadedOffscreen
//!   （args.rs:16-24），无可见窗口变体——保持默认 HeadlessNew，M4 可见
//!   形态待 args.rs 支持后切换（遗留登记 27 §6）。
//! - `gate`：MVP 门禁（MvpDomainGate 空白名单 = 默认全允许限公共互联网，
//!   17 §4.1）；经 [BrowserSlot::gate] 注入工具注册配置，动作执行器与
//!   工具层导航检查点共用同一实例（单一真源）。
//! - `sensitive`/`budgets`：工具注册配置缺省（默认拒绝面全关 + 活动预算）。
//!
//! ## 会话归属（遗留登记 27 §6）
//! 27 §2.1 槽形含 `owner` 字段（多会话迁移 P1）；MVP 无消费方，未建字段，
//! owner 切换策略登记 P1（避免死代码占位）。
//!
//! ## MCP attach 消费接线（34 §5.2 E-1/E-2/E-4，R-12）
//! 外部浏览器类 MCP（chrome-devtools-mcp 族）经 `--browserUrl` 附加受管
//! 实例 CDP 端点的 **browser 域消费面**（实现细节见 `mcp_attach` 模块头）：
//! - **E-1 端点暴露守卫**：本槽装配 [BrowserSlot::with_mcp_attach_allowed]
//!   （默认 false = R-12 零暴露）；[BrowserSlot::mcp_attach_endpoint] 守卫——
//!   开关关闭时结构化拒绝 `tool.browser.capability_disabled`（任何进程状态下
//!   端点信息不对外），开启且受管实例就绪时返回注入形态
//!   `http://127.0.0.1:<port>`（McpServerConfig args `--browserUrl`）；
//! - **E-2 spawn 分派**：Windows 下外部 MCP 必须经 `cmd /c npx` 分派
//!   （34 §4.2 实测：直接 `spawn("npx")` → NotFound），配置面分派见
//!   `mcp_attach::mcp_attach_server_config`（桥自身不改动）；
//! - **E-4 工具注册**：既有桥 `register_plugin_server` 零改动承接
//!   browserUrl 型 server（参数注入面已确认，验证方法见 `mcp_attach` 模块头）。
//! - **接线完成（E-1 装配 + 消费 seam，engine.rs）**：会话装配读取
//!   `BrowserToolsConfig.mcp_attach_allowed`（默认 false = 零暴露）→
//!   [BrowserSlot::with_mcp_attach_allowed] 注入（engine.rs 装配
//!   [BrowserSlot::new] 处）；MCP spawn 前的配置注入面为
//!   `Engine::browser_attach_mcp_server_config`——经 [BrowserSlot::mcp_attach_endpoint]
//!   守卫取端点 → `mcp_attach::mcp_attach_server_config` 构建配置；
//!   插件 mcpServers 装配点（用户声明 server 的注册处，core_run_commands
//!   并行域）为 TODO 登记，落地后调该 seam 并经
//!   `Engine::register_plugin_mcp_server` 注册。
//!
//! ## storage_state 命令发送面（J1b，维度 16 §5 CDP 实读/注入接线）
//! [BrowserSlot::storage_ops] 返回 [StorageStateOps]（`Storage.getCookies`
//! 实读 / `Storage.setCookies` 注入的 CDP 发送面抽象）：会话连接成功时
//! 装配 [SessionBackedStorage]（经统一发送层 `send_browser`，browser 级
//! 命令）；停止/断开/重连换回 [UnwiredStorageOps]（命令返回 not_ready
//! 结构化错误，不触发惰性启动——storage_state 是辅助通道，须先显式
//! `browser_start`）；测试经 [BrowserSlot::inject_storage_ops] 注入 mock。
//!
//! ## G-9 优雅停止 Browser.close 发送面（N6 接线，遗留登记清零）
//! [BrowserSlot::connect] 建连成功后调 `BrowserManager::register_session`
//! ——管理器持 `Arc<BrowserSession>` 保活会话作优雅停止的发送面
//! （stop_inner 丢弃会话槽后、`manager.stop(Graceful)` 前仍存活，
//! Browser.close 得以先发）。清除由管理器停止收尾自动完成（M3
//! `clear_session_state` 自动清空语义），重连/重启路径经 connect 重新
//! 登记覆盖旧发送面——**`drop_raw_session` 不触碰发送面**（顺序契约：
//! 它在 manager.stop 之前执行，若清空将使 G-9 失效，见
//! [Self::drop_raw_session] 注记）。

pub(crate) mod frame_stream;
#[cfg(windows)]
pub mod inspector_bridge;
pub(crate) mod mcp_attach;
#[cfg(not(windows))]
#[path = "native_commands_fallback.rs"]
pub mod native_commands;
#[cfg(windows)]
pub mod native_commands;
#[cfg(not(windows))]
#[path = "native_manager_fallback.rs"]
pub mod native_manager;
#[cfg(windows)]
pub mod native_manager;
pub mod native_tokens;
pub mod native_types;
pub(crate) mod panel_input;
pub mod security;
pub(crate) mod session_ops;
mod slot_accessors;
mod slot_events;

pub(crate) use session_ops::{LazySessionOps, StorageStateOps, TauriStateEmitter};
use session_ops::{SessionBackedStorage, UnwiredStorageOps};

#[allow(unused_imports)]
pub use native_manager::NativeWebviewManager;
#[allow(unused_imports)]
pub use native_tokens::{ControllerTokenKind, CoreTokenKind, EventTokenRegistry, TokenEntry};
#[allow(unused_imports)]
pub use native_types::{
    BrowserActionKind, BrowserStorageMode, CreateWebviewArgs, DownloadProgressPayload,
    NavigationStatePayload, WebviewBounds,
};
#[allow(unused_imports)]
pub use security::{
    is_trusted_certificate_target, resolve_browser_udf_path, validate_navigation_url,
    SecurityDenial,
};

use agent_tools::definition::ToolError;
use async_trait::async_trait;
use conex_browser::action::gate::{DomainGate, GateDenial};
use conex_browser::action::{
    ActionRequest, ActionSuccess, ElementMeta, WaitCondition, WaitOptions,
};
use conex_browser::browser::profile::data_root;
use conex_browser::browser::state::BrowserState;
use conex_browser::cdp::domains::{
    Cookie as CdpCookie, SetCookieParam, StorageGetCookiesResult, StorageSetCookiesParams,
};
use conex_browser::cdp::sender::CancellationToken;
use conex_browser::cdp::transport::ExpectedBrowser;
use conex_browser::import::storage_state::{LocalStorageChannel, SessionLocalStorageChannel};
use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::{
    BrowserManager, BrowserSession, CrashReason, LaunchConfig, ProcessEvent, SessionRef, StopReason,
};
use conex_browser_tools::codes::TOOL_BROWSER_NOT_READY;
use conex_browser_tools::gate::MvpDomainGate;
use conex_browser_tools::policy::AllowAllPolicy;
use conex_browser_tools::session::{
    ConsoleEntry, NetworkEntry, RealSession, SessionOps, SnapshotView,
};
use conex_run::core_event_bridge::Emitter;
use frame_stream::{FrameStreamController, FrameStreamState};
use mcp_attach::McpAttachEndpoint;
use panel_input::{BrowserInputEvent, PanelInputRouter};
use serde::Serialize;
use session_loop::AbortSignal;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::broadcast;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::MutexGuard as AsyncMutexGuard;

/// 停止硬超时（评审 F4）：stop 总超时后强制杀树兜底（可配，默认 15s）。
const DEFAULT_STOP_HARD_TIMEOUT: Duration = Duration::from_secs(15);

/// 启动失败冷却期（评审 F9）：启动失败后冷却期内直接 not_ready，防每次工具
/// 调用重走完整启动链（可配，默认 5s）。
const DEFAULT_START_FAIL_COOLDOWN: Duration = Duration::from_secs(5);

/// 面板状态载荷（browser_status 返回 + `browser://state-changed` 事件负载；
/// 27 方案 S6 契约定死：`{ state, url? }`；评审 F7 扩展 `reason?`——崩溃
/// 事件携带原因，前端兼容解析）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct StatusPayload {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 启动命令返回载荷（契约定死：`{ state: "running"|"starting"|"error", reason? }`）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct StartPayload {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 面板状态串（契约口径：idle/launching/running/stopping/stopped/crashed/error）。
fn panel_state_str(state: &BrowserState, ever_started: bool, degraded: bool) -> &'static str {
    if degraded {
        return "error";
    }
    match state {
        BrowserState::Stopped => {
            if ever_started {
                "stopped"
            } else {
                "idle"
            }
        }
        BrowserState::Launching { .. } => "launching",
        BrowserState::Running => "running",
        BrowserState::Stopping { .. } => "stopping",
        BrowserState::Crashed { .. } => "crashed",
    }
}

/// fail-closed 降级门禁（MvpDomainGate 构造失败的防御分支：拒绝一切导航/动作）。
struct DenyAllGate;

impl DomainGate for DenyAllGate {
    fn check(&self, url: &str) -> Result<(), GateDenial> {
        Err(GateDenial {
            url: url.to_string(),
            reason: "门禁构造失败（fail-closed 拒绝）".to_string(),
        })
    }
}

/// 浏览器会话槽（进程级单例：manager + 会话槽 + estop 周期 + 事件发射）。
///
/// 并发纪律：会话槽为 `tokio::sync::Mutex`（跨 await 持锁安全）——并发
/// ensure/start 串行化（双启动防线：锁内重查 + `BrowserManager.start` 幂等，
/// 27 §5 风险预案）；同步方法仅 `try_lock`（竞态窗口返回 not_ready，不阻塞）。
/// 锁纪律（B8）：std Mutex 持锁区间仅同步操作，绝不跨 await。
pub(crate) struct BrowserSlot {
    /// 进程管理器（None = 数据根解析失败降级：全部操作 not_ready）。
    manager: Option<Arc<BrowserManager>>,
    /// 会话槽（惰性：首次 ensure/start 时 connect；崩溃重启端点漂移 → 重建）。
    session: AsyncMutex<Option<Arc<RealSession>>>,
    /// 当前 estop 令牌（每启动/run 周期换新；M-2 abort 桥落点）。
    estop: Mutex<CancellationToken>,
    /// 急停旗（与 estop 同周期：run 级 abort 置位，下周期启动复位）。
    estop_flag: Arc<AtomicBool>,
    /// 发送层策略（connect 时注入；持有与槽同步的令牌/急停旗）。
    policy: Arc<AllowAllPolicy>,
    /// 域名门禁（MVP 实现；工具注册与动作执行器共用同一实例）。
    gate: Arc<dyn DomainGate>,
    /// 启动配置（27 §2.1：Auto + Ephemeral + HeadlessNew，见模块头偏离登记）。
    launch: LaunchConfig,
    /// 是否曾启动过（browser_status 区分 idle 与 stopped）。
    ever_started: AtomicBool,
    /// 事件发射器（attach_emitter 注入；None = 未接线，事件不发射）。
    /// 经 core_event_bridge::Emitter 抽象（Tauri 通道 / 测试替身）。
    emitter: Mutex<Option<Arc<dyn Emitter>>>,
    /// 事件转发任务已启动标记（惰性单飞）。
    forwarder_started: AtomicBool,
    /// 当前连接的端点（崩溃重启端点漂移检测 → 会话重建判定）。
    connected_endpoint: Mutex<Option<String>>,
    /// 停止硬超时（评审 F4：超时后强制杀树兜底；可配注入）。
    stop_hard_timeout: Duration,
    /// 启动失败冷却期（评审 F9：失败后冷却期内直接 not_ready；可配注入）。
    start_fail_cooldown: Duration,
    /// 上次启动失败时间戳（冷却期 gating 判定）。
    last_start_failure: Mutex<Option<Instant>>,
    /// 帧流控制器（P1-B1：Tauri Channel 帧下行 + 帧状态事件；无订阅者不启帧流）。
    frames: Arc<FrameStreamController>,
    /// 面板输入路由（P1-B1：browser_input 高频节流 + P1-A InputPipeline 对接）。
    input: Arc<PanelInputRouter>,
    /// 底层会话（帧订阅/输入注入版本推进的原始句柄；connect 时登记）。
    raw_session: Mutex<Option<Arc<BrowserSession>>>,
    /// attach 型外部浏览器类 MCP 会话级开关（R-12，34 §5.2 E-1 消费面；
    /// 默认 false = 端点信息零暴露；引擎侧会话装配读
    /// `BrowserToolsConfig.mcp_attach_allowed` 后经
    /// [BrowserSlot::with_mcp_attach_allowed] 注入，接线点见模块头登记）。
    mcp_attach_allowed: bool,
    /// storage_state 命令的 CDP 发送面（J1b，维度 16 §5）：会话连接成功时
    /// 装配 [SessionBackedStorage]，停止/断开/重连换回 [UnwiredStorageOps]
    /// （命令返回 not_ready，不触发惰性启动）；测试经
    /// [BrowserSlot::inject_storage_ops] 注入 mock。
    storage_ops: Mutex<Arc<dyn StorageStateOps>>,
    /// localStorage 注入通道（J1b 扩展面，维度 16 §5.3 注入执行）：生产
    /// 恒 None——访问器按需经底层会话惰性构造
    /// [SessionLocalStorageChannel]；测试经
    /// [BrowserSlot::inject_local_storage_channel] 注入 mock。
    local_storage_channel: Mutex<Option<Arc<dyn LocalStorageChannel>>>,
}

impl BrowserSlot {
    /// 进程级惰性单例构造：平台数据根解析失败 → 降级槽（装配不失败，仅降级）。
    pub(crate) fn new() -> Self {
        let manager: Option<Arc<BrowserManager>> = match data_root() {
            Ok(root) => Some(Arc::new(BrowserManager::new(root))),
            Err(error) => {
                tracing::warn!(
                    target: "browser",
                    error = %error,
                    "浏览器数据根解析失败（browser_* 工具与面板命令按 not_ready 降级）"
                );
                None
            }
        };
        Self::from_parts(manager, LaunchConfig::default())
    }

    /// 显式 manager 与启动配置构造（测试注入/降级槽；None = 降级）。
    fn from_parts(manager: Option<Arc<BrowserManager>>, launch: LaunchConfig) -> Self {
        let estop_flag = Arc::new(AtomicBool::new(false));
        let estop = CancellationToken::new();
        let policy = Arc::new(AllowAllPolicy::new(Arc::clone(&estop_flag), estop.clone()));
        let gate: Arc<dyn DomainGate> = match MvpDomainGate::new(&[], &[]) {
            Ok(g) => Arc::new(g),
            Err(error) => {
                // 空列表构造不可失败（防御分支）；fail-closed：拒绝全部导航
                tracing::warn!(
                    target: "browser",
                    error = %error,
                    "MVP 门禁构造失败（降级为全拒绝）"
                );
                Arc::new(DenyAllGate)
            }
        };
        BrowserSlot {
            manager,
            session: AsyncMutex::new(None),
            estop: Mutex::new(estop),
            estop_flag,
            policy,
            gate,
            launch,
            ever_started: AtomicBool::new(false),
            emitter: Mutex::new(None),
            forwarder_started: AtomicBool::new(false),
            connected_endpoint: Mutex::new(None),
            stop_hard_timeout: DEFAULT_STOP_HARD_TIMEOUT,
            start_fail_cooldown: DEFAULT_START_FAIL_COOLDOWN,
            last_start_failure: Mutex::new(None),
            frames: Arc::new(FrameStreamController::new()),
            input: Arc::new(PanelInputRouter::new()),
            raw_session: Mutex::new(None),
            // R-12 安全默认：attach 开关默认关闭（未显式授权不向外部 MCP
            // 暴露受管端点，34 §5.1）
            mcp_attach_allowed: false,
            // J1b：会话连接前恒为未连接面（storage 命令 not_ready）
            storage_ops: Mutex::new(Arc::new(UnwiredStorageOps)),
            // J1b 扩展面：localStorage 通道生产惰性构造（None = 按需建）
            local_storage_channel: Mutex::new(None),
        }
    }

    /// 注入停止硬超时（测试用短窗；生产保持默认 15s）。
    #[cfg(test)]
    fn with_stop_hard_timeout(mut self, timeout: Duration) -> Self {
        self.stop_hard_timeout = timeout;
        self
    }

    /// 注入启动失败冷却期（测试用短窗/消除；生产保持默认 5s）。
    #[cfg(test)]
    fn with_start_fail_cooldown(mut self, cooldown: Duration) -> Self {
        self.start_fail_cooldown = cooldown;
        self
    }

    /// 记录一次启动失败（冷却期 gating 起点；评审 F9）。
    fn record_start_failure(&self) {
        *self
            .last_start_failure
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }

    /// 冷却期剩余（启动失败后冷却期内 → Some(remaining)；否则 None）。
    fn start_cooldown_remaining(&self) -> Option<Duration> {
        let last = *self
            .last_start_failure
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let elapsed = last?.elapsed();
        if elapsed < self.start_fail_cooldown {
            Some(self.start_fail_cooldown - elapsed)
        } else {
            None
        }
    }

    /// 域名门禁（工具注册配置注入：动作执行器与导航检查点共用同一实例）。
    pub(crate) fn gate(&self) -> Arc<dyn DomainGate> {
        Arc::clone(&self.gate)
    }

    /// 换新 estop 周期（每 run 启动 / 每次新启动调用）：令牌换新 + 急停旗
    /// 复位——新周期不继承上一周期的取消态（M-2 桥防跨 run 毒化）。
    pub(crate) fn reset_estop(&self) {
        let token = CancellationToken::new();
        *self.estop.lock().unwrap_or_else(|p| p.into_inner()) = token.clone();
        self.policy.reset(token);
    }

    /// 触发 estop（run 级强停 / 用户接管）：取消在途 CDP 命令（逐 id）+
    /// 急停旗置位（新命令拒绝）；急停旗随下一启动周期复位。
    pub(crate) fn cancel_estop(&self) {
        let token = self.estop.lock().unwrap_or_else(|p| p.into_inner()).clone();
        token.cancel();
        self.estop_flag.store(true, Ordering::SeqCst);
        tracing::debug!(target: "browser", "浏览器 estop 触发（在途 CDP 命令取消 + 新命令拒绝）");
    }

    /// 面板启动命令入口（27 方案 S6）：非惰性启动——立即拉起并连接。
    /// 返回状态串（"running"/"starting"）；失败 Err（调用方映射为 error 载荷）。
    /// 启动失败后冷却期内（评审 F9）直接 Err，不重走完整启动链。
    pub(crate) async fn start(&self) -> Result<&'static str, String> {
        let Some(manager) = self.manager.clone() else {
            return Err("浏览器未注入（数据根解析失败降级，browser_* 工具不可用）".to_string());
        };
        match manager.status().state {
            BrowserState::Running => {
                self.ensure_ready().await?;
                Ok("running")
            }
            BrowserState::Stopped => {
                if let Some(remaining) = self.start_cooldown_remaining() {
                    return Err(format!(
                        "浏览器上次启动失败，冷却中（{:.1} 秒后可重试）",
                        remaining.as_secs_f32()
                    ));
                }
                let mut guard = self.session.lock().await;
                if guard.is_some() && self.endpoint_matches(&manager) {
                    return Ok("running");
                }
                if let Err(e) = self.start_and_connect_locked(&manager, &mut guard).await {
                    self.record_start_failure();
                    return Err(e);
                }
                Ok("running")
            }
            // 启动/停止在途：返回 starting（状态迁移经事件流推送面板）
            BrowserState::Launching { .. } | BrowserState::Stopping { .. } => Ok("starting"),
            BrowserState::Crashed { .. } => {
                Err("浏览器崩溃恢复中（退避重启），请稍后重试".to_string())
            }
        }
    }

    /// 面板停止命令入口（27 方案 S6）：丢弃会话 + 停止进程。
    ///
    /// - `force=false`（正常停止）：Graceful——等待会话锁（并发启动/重连持锁
    ///   至多首启超时），等优雅收口（wait_or_kill 超时内部转杀树）；
    /// - `force=true`（急停，评审 F3）：**不等会话锁**（try_lock 尽力丢弃会话，
    ///   launching 中不被会话锁阻塞至首启超时），直接走强制杀树路径。
    ///
    /// 总硬超时（评审 F4）：`stop_hard_timeout`（默认 15s，可配）内未收敛 →
    /// 再次强制杀树兜底；仍超时返回错误（进程由退出钩子/管理器 Drop 兜底杀树）。
    pub(crate) async fn stop(&self, force: bool) -> Result<(), String> {
        let Some(manager) = self.manager.clone() else {
            return Err("浏览器未注入（数据根解析失败降级）".to_string());
        };
        let hard = self.stop_hard_timeout;
        match tokio::time::timeout(hard, self.stop_inner(&manager, force)).await {
            Ok(result) => result,
            Err(_) => {
                tracing::warn!(
                    target: "browser",
                    timeout_ms = hard.as_millis() as u64,
                    "停止超时（{:.0}s），转入强制杀树兜底",
                    hard.as_secs_f64()
                );
                // 超时兜底：尽力丢弃会话 + 强制杀（kill_tree 路径）
                if let Ok(mut guard) = self.session.try_lock() {
                    *guard = None;
                }
                match tokio::time::timeout(hard, manager.stop(StopReason::Force)).await {
                    Ok(result) => result
                        .map(|_| ())
                        .map_err(|e| format!("浏览器停止失败：{e}")),
                    Err(_) => Err(format!(
                        "浏览器停止超时（{:.0}s 内未能收敛，进程由退出钩子兜底杀树）",
                        hard.as_secs_f64()
                    )),
                }
            }
        }
    }

    /// 停止主路径（被 [Self::stop] 硬超时包裹）。
    async fn stop_inner(&self, manager: &Arc<BrowserManager>, force: bool) -> Result<(), String> {
        if force {
            // 急停：不等会话锁（launching 中连接/启动持锁至多首启超时 ~40s），
            // try_lock 尽力丢弃会话后立即走强制杀树路径
            if let Ok(mut guard) = self.session.try_lock() {
                *guard = None;
            }
        } else {
            let mut guard = self.session.lock().await;
            // 丢弃会话（Transport 断开）；进程收口由 manager.stop 承担
            *guard = None;
        }
        // 停止帧流（无订阅者语义：停流 = 不再下行；帧泵随会话断开自然收尾）
        self.frames.unsubscribe().await;
        self.drop_raw_session();
        let reason = if force {
            StopReason::Force
        } else {
            StopReason::Graceful
        };
        manager
            .stop(reason)
            .await
            .map(|_| ())
            .map_err(|e| format!("浏览器停止失败：{e}"))
    }

    /// 面板状态查询（契约定死：idle/launching/running/stopping/stopped/crashed/error + url?）。
    pub(crate) fn status(&self) -> StatusPayload {
        let degraded = self.manager.is_none();
        let ever = self.ever_started.load(Ordering::SeqCst);
        let state = match &self.manager {
            None => "error",
            Some(manager) => panel_state_str(&manager.status().state, ever, degraded),
        };
        StatusPayload {
            state,
            url: self.current_url(),
            reason: None,
        }
    }

    /// 会话就绪保证（27 方案 D-B）：惰性启动/重连后返回已就绪会话。
    ///
    /// 状态机：Running + 会话匹配 → 直接可用；Running + 端点漂移 → 重建；
    /// Stopped → 惰性启动 + 连接；Launching/Crashed/Stopping → Err（R-9）。
    /// 并发双启动防线：锁内重查 + `BrowserManager.start` 幂等（27 §5）。
    pub(crate) async fn ensure_ready(&self) -> Result<Arc<RealSession>, String> {
        let Some(manager) = self.manager.clone() else {
            return Err("浏览器未注入（数据根解析失败降级，browser_* 工具不可用）".to_string());
        };
        let status = manager.status();
        match status.state {
            BrowserState::Running => {
                // 快速路径（不持锁）：会话已连接且端点未漂移 → 直接可用
                if self.has_session_matching(&manager) {
                    if let Some(rs) = self.session_sync() {
                        return Ok(rs);
                    }
                }
                // 慢路径：持锁串行化并发 ensure + 漂移重连
                let mut guard = self.session.lock().await;
                if guard.is_some() && self.endpoint_matches(&manager) {
                    let Some(rs) = guard.as_ref() else {
                        return Err("浏览器会话不可用（异常状态）".to_string());
                    };
                    return Ok(Arc::clone(rs));
                }
                self.reconnect_locked(&manager, &mut guard).await?;
                let Some(rs) = guard.as_ref() else {
                    return Err("浏览器会话不可用（异常状态）".to_string());
                };
                Ok(Arc::clone(rs))
            }
            BrowserState::Stopped => {
                if let Some(remaining) = self.start_cooldown_remaining() {
                    return Err(format!(
                        "浏览器上次启动失败，冷却中（{:.1} 秒后可重试）",
                        remaining.as_secs_f32()
                    ));
                }
                let mut guard = self.session.lock().await;
                if guard.is_some() && self.endpoint_matches(&manager) {
                    let Some(rs) = guard.as_ref() else {
                        return Err("浏览器会话不可用（异常状态）".to_string());
                    };
                    return Ok(Arc::clone(rs));
                }
                if let Err(e) = self.start_and_connect_locked(&manager, &mut guard).await {
                    self.record_start_failure();
                    return Err(e);
                }
                let Some(rs) = guard.as_ref() else {
                    return Err("浏览器会话不可用（异常状态）".to_string());
                };
                Ok(Arc::clone(rs))
            }
            other => Err(format!(
                "浏览器恢复中（进程状态：{other:?}，R-9 恢复期 gating）"
            )),
        }
    }

    /// 挂接事件发射器与状态转发任务见 [`slot_events`]。

    /// 会话存在且端点匹配（快速路径判定）。
    fn has_session_matching(&self, manager: &BrowserManager) -> bool {
        let present = self
            .session
            .try_lock()
            .map(|g| g.is_some())
            .unwrap_or(false);
        present && self.endpoint_matches(manager)
    }

    /// 端点匹配：当前连接的端点 == 管理器当前端点（崩溃重启后随机端口
    /// 变化 → 判定漂移，触发会话重建）。
    fn endpoint_matches(&self, manager: &BrowserManager) -> bool {
        let Some(current) = manager.endpoint() else {
            return false;
        };
        let stored = self
            .connected_endpoint
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        stored.as_deref() == Some(&current.url())
    }

    /// 会话重建（端点漂移/会话缺失路径）。
    async fn reconnect_locked(
        &self,
        manager: &Arc<BrowserManager>,
        guard: &mut AsyncMutexGuard<'_, Option<Arc<RealSession>>>,
    ) -> Result<(), String> {
        **guard = None;
        self.drop_raw_session();
        **guard = Some(self.connect(manager).await?);
        Ok(())
    }

    /// 惰性/面板启动 + 连接（持锁路径，双启动防线）。
    async fn start_and_connect_locked(
        &self,
        manager: &Arc<BrowserManager>,
        guard: &mut AsyncMutexGuard<'_, Option<Arc<RealSession>>>,
    ) -> Result<(), String> {
        // 新启动周期：换新 estop 令牌 + 复位急停旗（不继承上一周期取消态）
        self.reset_estop();
        **guard = None;
        self.drop_raw_session();
        manager
            .start(self.launch.clone())
            .await
            .map_err(|e| format!("浏览器启动失败：{e}"))?;
        self.ever_started.store(true, Ordering::SeqCst);
        match manager.status().state {
            BrowserState::Running => {
                **guard = Some(self.connect(manager).await?);
                Ok(())
            }
            other => Err(format!("浏览器未进入运行态（当前：{other:?}）")),
        }
    }

    /// 连接会话（端点私有通道 → BrowserSession::connect，policy = AllowAllPolicy；
    /// 记录端点供漂移检测；连接失败带可行动指引）。
    async fn connect(&self, manager: &Arc<BrowserManager>) -> Result<Arc<RealSession>, String> {
        let endpoint = manager
            .endpoint()
            .ok_or_else(|| "浏览器端点不可用（恢复期，请稍后重试）".to_string())?;
        // 先克隆再显式 trait 对象化（Arc::clone 泛型推断不跨赋值反向强转，
        // 与 engine.rs timer_event_sink 同款写法）
        let policy_arc = Arc::clone(&self.policy);
        let policy: Arc<dyn conex_browser::cdp::sender::CommandPolicyHooks> = policy_arc;
        let session = Arc::new(
            BrowserManager::connect_session(endpoint.clone(), ExpectedBrowser::default(), policy)
                .await
                .map_err(|e| format!("浏览器会话连接失败：{e}（可稍后重试）"))?,
        );
        *self
            .connected_endpoint
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(endpoint.url());
        *self.raw_session.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::clone(&session));
        // N6（G-9 遗留接线落地）：会话建立 → register_session——管理器持
        // Arc<BrowserSession> 作为优雅停止的 Browser.close 发送面（G-9）。
        // 顺序契约（关键）：stop_inner 先丢弃会话槽、再 manager.stop
        // (Graceful)——close_sender 持有的 Arc 使 CDP 传输在停止期间存活，
        // Browser.close 得以先发；发送面清除由 M3 自动清空承担（停止收尾
        // finish_stop → clear_session_state），重连/重启路径经本方法重新
        // 登记覆盖旧发送面。**drop_raw_session 不得主动清空**（它在
        // manager.stop 之前执行，清空将使 G-9 失效，见其注记）。
        manager.register_session(Arc::clone(&session));
        // J1b：storage_state 命令发送面随会话装配（Storage 域 browser 级命令）
        *self.storage_ops.lock().unwrap_or_else(|p| p.into_inner()) =
            Arc::new(SessionBackedStorage::new(Arc::clone(&session)));
        // P1-B1：装配输入注入管线（P1-A InputPipeline；随连接生命周期——
        // 版本推进 R-1/U-1 与活动钩子由管线内部承担）
        let pipeline = conex_browser::input::InputPipeline::new(Arc::clone(&session));
        let frames = Arc::clone(&self.frames);
        pipeline.attach_activity(Arc::new(move || {
            // 12 §2.5：注入成功 → 交互升帧信号（无活跃帧流会话时 no-op）；
            // 维度 15 用户输入上报为 P1-B2 接线点（TODO）
            frames.on_user_input();
        }));
        self.input.set_pipeline(pipeline);
        Ok(Arc::new(RealSession::new(
            session,
            Some(Arc::clone(manager)),
            Arc::clone(&self.gate),
            BudgetConfig::active(),
        )))
    }
}

// 顶层适配面：会话操作与状态事件见 [`session_ops`]，访问器见
// [`slot_accessors`]，发射链路见 [`slot_events`]。

/// 27 方案 S5（M-2 abort 桥）：run 级强停 → 浏览器发送层取消。
///
/// 装配序（core_run_commands run 装配块，见 S5 接线段）：每 run 先
/// [BrowserSlot::reset_estop]（新 run 不继承上一 run 取消态），再挂本
/// watcher——abort 触发 → [BrowserSlot::cancel_estop]（在途命令逐 id 取消
/// + 新命令拒绝；急停旗随下一启动周期复位）。
pub(crate) fn spawn_browser_estop_watcher(slot: Arc<BrowserSlot>, signal: AbortSignal) {
    // 同步入口函数（无 async 签名）：调用方上下文不保证有 tokio runtime，
    // 统一走 tauri::async_runtime::spawn（全局 runtime，同步/异步上下文
    // 均安全；与 tokio::spawn 语义一致——任务 detach 运行，句柄不持有）。
    tauri::async_runtime::spawn(async move {
        signal.wait_aborted().await;
        slot.cancel_estop();
    });
}

#[cfg(test)]
mod tests;
