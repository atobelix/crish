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
pub(crate) mod mcp_attach;
pub(crate) mod panel_input;

use crate::core_event_bridge::Emitter;
use agent_tools::definition::ToolError;
use async_trait::async_trait;
use conex_browser::action::gate::{DomainGate, GateDenial};
use conex_browser::action::{ActionRequest, ActionSuccess, ElementMeta, WaitCondition, WaitOptions};
use conex_browser::browser::profile::data_root;
use conex_browser::browser::state::BrowserState;
use conex_browser::cdp::domains::{
    Cookie as CdpCookie, SetCookieParam, StorageGetCookiesResult, StorageSetCookiesParams,
};
use conex_browser::cdp::sender::CancellationToken;
use conex_browser::cdp::transport::ExpectedBrowser;
use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::import::storage_state::{LocalStorageChannel, SessionLocalStorageChannel};
use conex_browser::{
    BrowserManager, BrowserSession, CrashReason, LaunchConfig, ProcessEvent, SessionRef, StopReason,
};
use conex_browser_tools::codes::TOOL_BROWSER_NOT_READY;
use conex_browser_tools::gate::MvpDomainGate;
use conex_browser_tools::policy::AllowAllPolicy;
use conex_browser_tools::session::{ConsoleEntry, NetworkEntry, RealSession, SessionOps, SnapshotView};
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
        let policy = Arc::new(AllowAllPolicy::new(
            Arc::clone(&estop_flag),
            estop.clone(),
        ));
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
        let token = self
            .estop
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
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
    async fn stop_inner(
        &self,
        manager: &Arc<BrowserManager>,
        force: bool,
    ) -> Result<(), String> {
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
        let reason = if force { StopReason::Force } else { StopReason::Graceful };
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
            other => Err(format!("浏览器恢复中（进程状态：{other:?}，R-9 恢复期 gating）")),
        }
    }

    /// 挂接事件发射器并启动状态转发任务（惰性单飞：manager 事件 →
    /// `browser://state-changed`；main.rs setup 与命令面均可调用，幂等）。
    ///
    /// 转发语义（评审 F5/F7）：
    /// - `StateChanged` → 发射状态迁移（payload 携带当前 url）；
    /// - `NavStackChanged` → 重发当前状态（URL 随导航推送，防面板 URL 陈旧）；
    /// - `CrashRestarting` → 发射 `{ state: "crashed", reason }`（崩溃带原因）；
    /// - 订阅掉队（`Lagged`）**不终止转发**——重订阅续传 + 以当前状态快照补发
    ///   （旧实现 `Err(_) => break` 导致永久停发）；通道关闭才退出。
    ///
    /// 帧流状态事件（`browser://frame-state-changed`）随同一发射器接线
    /// （P1-B1：帧状态 starting/active/stopped，独立事件不与面板状态机混流）。
    pub(crate) fn attach_emitter(self: &Arc<Self>, emitter: Arc<dyn Emitter>) {
        *self.emitter.lock().unwrap_or_else(|p| p.into_inner()) = Some(emitter.clone());
        self.frames.attach_emitter(emitter);
        if self.forwarder_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(manager) = self.manager.clone() else {
            return;
        };
        let mut rx = manager.subscribe();
        let slot = Arc::clone(self);
        // 同步上下文守卫（G-13 L3 P0）：本函数在 main.rs setup（无 tokio
        // runtime 的同步回调）与命令面（browser_status 为同步命令）均可达——
        // 直接 tokio::spawn 会 panic（"no reactor running"）。改用
        // tauri::async_runtime::spawn：Tauri 全局 runtime（惰性初始化，
        // setup 中可用），任务在应用 runtime 线程池运行，语义不变。
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ProcessEvent::StateChanged { state, .. }) => {
                        slot.emit_state_changed(&state);
                    }
                    Ok(ProcessEvent::NavStackChanged { .. }) => {
                        // F7：导航变更 → 重发当前状态（URL 随导航推送）
                        slot.emit_state_changed(&manager.status().state);
                    }
                    Ok(ProcessEvent::CrashRestarting { reason, .. }) => {
                        // F7：崩溃事件补原因（前端兼容解析 reason 字段）
                        slot.emit_crash(&reason);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // F5：掉队 ≠ 通道关闭——重订阅续传；掉队期间状态以
                        // 当前快照补发一次，面板不陈旧
                        tracing::warn!(target: "browser", "状态事件转发掉队（Lagged），重订阅续传");
                        rx = manager.subscribe();
                        slot.emit_state_changed(&manager.status().state);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    // ---------- 内部 ----------

    /// 会话同步取用（try_lock：并发启动/重连窗口返回 None，不阻塞）。
    fn session_sync(&self) -> Option<Arc<RealSession>> {
        self.session
            .try_lock()
            .ok()
            .and_then(|g| g.as_ref().cloned())
    }

    /// 帧流控制器（P1-B1 命令面访问器）。
    pub(crate) fn frames(&self) -> Arc<FrameStreamController> {
        Arc::clone(&self.frames)
    }

    /// 面板输入路由（P1-B1 命令面访问器）。
    pub(crate) fn input(&self) -> Arc<PanelInputRouter> {
        Arc::clone(&self.input)
    }

    /// storage_state 命令发送面（J1b 访问器）：会话连接中 = 会话委托
    /// （Storage 域 browser 级实读/注入）；未连接/停止/恢复期 = 未连接面
    /// （命令映射 not_ready 结构化错误）。
    pub(crate) fn storage_ops(&self) -> Arc<dyn StorageStateOps> {
        Arc::clone(&self.storage_ops.lock().unwrap_or_else(|p| p.into_inner()))
    }

    /// 注入 storage 发送面（J1b 测试替身注入点；生产路径不调用——连接
    /// 生命周期自动装配/换回，见 [Self::connect] 与 [Self::drop_raw_session]）。
    #[cfg(test)]
    pub(crate) fn inject_storage_ops(&self, ops: Arc<dyn StorageStateOps>) {
        *self.storage_ops.lock().unwrap_or_else(|p| p.into_inner()) = ops;
    }

    /// localStorage 注入通道（J1b 扩展面访问器，维度 16 §5.3 注入执行）：
    /// 测试注入优先；生产按需经底层会话构造 [SessionLocalStorageChannel]
    /// （绑定活动标签会话——`Page.addScriptToEvaluateOnNewDocument` 注册
    /// origin 守卫脚本 + `DOMStorage.setDOMStorageItem` 直写）。未连接 /
    /// 无活动标签 → Err（命令映射 not_ready，storage 命令不触发惰性启动）。
    pub(crate) fn local_storage_channel(&self) -> Result<Arc<dyn LocalStorageChannel>, String> {
        if let Some(injected) = self
            .local_storage_channel
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
            .cloned()
        {
            return Ok(injected);
        }
        let session = self.raw_session_sync().ok_or_else(|| {
            "浏览器未连接（请先 browser_start 后再导入登录态）".to_string()
        })?;
        let channel = SessionLocalStorageChannel::for_active(session)
            .map_err(|e| format!("localStorage 注入通道不可用：{e}"))?;
        Ok(Arc::new(channel))
    }

    /// 注入 localStorage 通道（J1b 测试替身注入点；生产路径不调用——访问器
    /// 按需惰性构造，见 [Self::local_storage_channel]）。
    #[cfg(test)]
    pub(crate) fn inject_local_storage_channel(&self, channel: Arc<dyn LocalStorageChannel>) {
        *self
            .local_storage_channel
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(channel);
    }

    /// 底层会话同步取用（帧订阅/输入管线装配的原始句柄）。
    fn raw_session_sync(&self) -> Option<Arc<BrowserSession>> {
        self.raw_session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// 注入 attach 会话级开关（E-1 消费面：`BrowserToolsConfig.mcp_attach_allowed`
    /// 由引擎侧会话装配读取后经本方法装配，34 §5.2 E-1；已接线——engine.rs
    /// 装配 [BrowserSlot::new] 处，值源默认 false，面板开关写入面 TODO）。
    pub(crate) fn with_mcp_attach_allowed(mut self, allowed: bool) -> Self {
        self.mcp_attach_allowed = allowed;
        self
    }

    /// 端点暴露守卫（E-1 消费面，R-12）：受管实例启动后取 attach 端点注入
    /// 形态（`http://127.0.0.1:<port>`，34 §5.2 E-1），供引擎侧 MCP server
    /// 启动配置注入（`McpServerConfig.args` 的 `--browserUrl`）。
    ///
    /// 语义（详见 [mcp_attach::attach_exposure_decision]）：
    /// - 开关关闭（默认）→ `tool.browser.capability_disabled`（端点信息
    ///   零暴露，任何进程状态下都不返回）；
    /// - 开关开启但浏览器未就绪（未启动/恢复期/降级槽）→
    ///   `tool.browser.not_ready`；
    /// - 开关开启且就绪 → [McpAttachEndpoint]（browserUrl + ws 串）。
    ///
    /// 引擎侧接线（已接线 E-1，engine.rs）：`register_plugin_mcp_server`
    /// spawn 前的配置注入面为 `Engine::browser_attach_mcp_server_config`
    /// ——先经本守卫取端点，再 `mcp_attach::mcp_attach_server_config`
    /// 构建配置注入 `--browserUrl`（E-4 桥零改动；插件 mcpServers 装配
    /// 点为并行域 TODO 登记，见 engine.rs 该 seam 注释）。
    pub(crate) fn mcp_attach_endpoint(&self) -> Result<McpAttachEndpoint, ToolError> {
        let endpoint = self.manager.as_ref().and_then(|m| m.endpoint());
        mcp_attach::attach_exposure_decision(self.mcp_attach_allowed, endpoint.as_ref())
    }

    /// 输入事件转发入口（browser_input 命令消费；no-wait 语义——仅路由/合并，
    /// 派发由 P1-A 管线后台进行，invoke 立即返回）。版本推进（R-1/U-1 注入
    /// 即时 +1）与活动钩子（交互期升帧）由管线/帧流会话内部承担。
    pub(crate) fn forward_input(&self, evt: &BrowserInputEvent) {
        self.input.route(evt);
        // 12 §2.5：交互信号 → 升 Interactive 档（无活跃帧流会话时 no-op）
        self.frames.on_user_input();
    }

    /// 启动帧流（browser_start_frames 命令消费）：
    /// 浏览器就绪 → 帧流控制器订阅（懒创建 P1-A ScreencastSession + start）。
    pub(crate) async fn start_frames(
        &self,
        channel: tauri::ipc::Channel<tauri::ipc::Response>,
    ) -> Result<FrameStreamState, String> {
        self.ensure_ready().await?;
        let Some(session) = self.raw_session_sync() else {
            return Err("浏览器会话不可用（重连中）".to_string());
        };
        let ctrl = Arc::clone(&self.frames);
        ctrl.subscribe(session, channel).await;
        Ok(ctrl.state())
    }

    /// 停止帧流（browser_stop_frames 命令消费；幂等）——停止帧泵，会话保留。
    pub(crate) async fn stop_frames(&self) -> FrameStreamState {
        self.frames.unsubscribe().await;
        self.frames.state()
    }

    /// 会话存在且端点匹配（快速路径判定）。
    fn has_session_matching(&self, manager: &BrowserManager) -> bool {
        let present = self.session.try_lock().map(|g| g.is_some()).unwrap_or(false);
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
        *self.connected_endpoint.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(endpoint.url());
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

    /// 丢弃底层会话句柄（停止/重连/重建前调用）：释放帧流会话（shutdown，
    /// 转发任务随 sink 关闭退出）+ 清除输入管线（旧管线 Drop 终止消费任务）。
    ///
    /// **不触碰 G-9 关闭发送面**（N6 顺序契约）：stop_inner 在本方法之后
    /// 才调 `manager.stop(Graceful)`——发送面须存活至 Browser.close 发出；
    /// 清除由管理器停止收尾自动完成（M3 `clear_session_state` 自动清空），
    /// 重连/重启路径由 [Self::connect] 重新登记覆盖旧发送面。
    fn drop_raw_session(&self) {
        *self.raw_session.lock().unwrap_or_else(|p| p.into_inner()) = None;
        // J1b：会话失效 → storage 发送面换回未连接（陈旧会话不得滞留）
        *self.storage_ops.lock().unwrap_or_else(|p| p.into_inner()) =
            Arc::new(UnwiredStorageOps);
        self.frames.release_session();
        self.input.clear_pipeline();
    }

    /// 当前活动标签 URL（nav_stack 只读面；无标签/未启动 → None）。
    fn current_url(&self) -> Option<String> {
        let manager = self.manager.as_ref()?;
        let nav = manager.nav_stack();
        nav.tabs.get(nav.active).map(|t| t.url.to_string())
    }

    /// 状态迁移发射（`browser://state-changed`，payload `{ state, url? }`）。
    fn emit_state_changed(&self, state: &BrowserState) {
        let Some(emitter) = self
            .emitter
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            return;
        };
        let payload = StatusPayload {
            state: panel_state_str(
                state,
                self.ever_started.load(Ordering::SeqCst),
                self.manager.is_none(),
            ),
            url: self.current_url(),
            reason: None,
        };
        let json = match serde_json::to_string(&payload) {
            Ok(json) => json,
            Err(error) => {
                tracing::error!(target: "browser", error = %error, "状态载荷序列化失败（跳过发射）");
                return;
            }
        };
        emitter.emit("browser://state-changed", &json);
    }

    /// 崩溃事件发射（`browser://state-changed`，payload `{ state: "crashed",
    /// reason }`；评审 F7：面板崩溃态带原因，前端兼容解析）。
    fn emit_crash(&self, reason: &CrashReason) {
        let Some(emitter) = self
            .emitter
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            return;
        };
        let payload = StatusPayload {
            state: "crashed",
            url: self.current_url(),
            reason: Some(format!("{reason:?}")),
        };
        let json = match serde_json::to_string(&payload) {
            Ok(json) => json,
            Err(error) => {
                tracing::error!(target: "browser", error = %error, "崩溃载荷序列化失败（跳过发射）");
                return;
            }
        };
        emitter.emit("browser://state-changed", &json);
    }
}

/// 运行时泛型 Tauri 发射器（命令面构造：生产 Wry 与测试 MockRuntime 均可用；
/// 对齐 core_event_bridge::TauriEmitter 的发射语义——失败仅记录）。
pub(crate) struct TauriStateEmitter<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriStateEmitter<R> {
    pub(crate) fn new(app: tauri::AppHandle<R>) -> Self {
        TauriStateEmitter { app }
    }
}

impl<R: tauri::Runtime> Emitter for TauriStateEmitter<R> {
    fn emit(&self, channel: &str, payload: &str) {
        use tauri::Emitter as _;
        if let Err(error) = self.app.emit(channel, payload) {
            tracing::warn!(
                target: "browser",
                channel,
                error = %error,
                "事件通道发射失败（尽力而为）"
            );
        }
    }
}

/// 惰性会话操作层（27 方案 D-B）：实现 [SessionOps] 并解析到 [BrowserSlot]
/// 的会话槽——每个方法入口先 `ensure_ready`（惰性启动/重连），再委托
/// [RealSession]（快照缓存/动作执行器/console/network 缓冲单点复用，
/// 不在引擎侧重复实现；可见性扩展见 conex-browser-tools session.rs）。
pub(crate) struct LazySessionOps {
    slot: Arc<BrowserSlot>,
}

// ---------------------------------------------------------------------------
// storage_state CDP 发送面（J1b，维度 16 §5：Storage.getCookies 实读 /
// Storage.setCookies 注入）
// ---------------------------------------------------------------------------

/// storage_state 命令的 CDP 发送面（J1b 抽象；测试注入 mock，生产经
/// [SessionBackedStorage] 委托底层会话）。命令面见
/// [crate::browser_commands]（browser_export_storage_state /
/// browser_import_storage_state）。
#[async_trait]
pub(crate) trait StorageStateOps: Send + Sync {
    /// 实读默认浏览器上下文全量 cookie（browser 级 `Storage.getCookies`，
    /// 维度 16 §5.2 导出取数面）。Err = 会话不可用（命令映射
    /// `tool.browser.not_ready`）。
    async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String>;
    /// 批量注入 cookie（browser 级 `Storage.setCookies`，维度 16 §5.3
    /// 注入面；`to_cdp_params` 类型化参数已做会话 cookie 归一化/幂等去重）。
    async fn set_cookies(&self, cookies: Vec<SetCookieParam>) -> Result<(), String>;
}

/// 未连接实现（会话槽为空 / 降级槽）：storage 命令返回 not_ready 语义错误。
/// **不触发惰性启动**——storage_state 是辅助通道（维度 16 §0.1），用户须
/// 先经面板 `browser_start` 显式启动后才可导出/导入登录态。
struct UnwiredStorageOps;

#[async_trait]
impl StorageStateOps for UnwiredStorageOps {
    async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String> {
        Err("浏览器未连接（请先 browser_start 后再导出/导入登录态）".to_string())
    }
    async fn set_cookies(&self, _cookies: Vec<SetCookieParam>) -> Result<(), String> {
        Err("浏览器未连接（请先 browser_start 后再导出/导入登录态）".to_string())
    }
}

/// 会话委托实现（[BrowserSlot::connect] 成功时装配）：经统一发送层
/// `send_browser`（browser 级命令，无 session 依赖）调 Storage 域——
/// 不需要活动标签，与维度 16 §4.1 回读校验的 CDP 实读同口径。
struct SessionBackedStorage {
    session: Arc<BrowserSession>,
}

impl SessionBackedStorage {
    fn new(session: Arc<BrowserSession>) -> Self {
        SessionBackedStorage { session }
    }
}

#[async_trait]
impl StorageStateOps for SessionBackedStorage {
    async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String> {
        let result: StorageGetCookiesResult = self
            .session
            .send_browser("Storage.getCookies", serde_json::json!({}))
            .await
            .map_err(|e| format!("Storage.getCookies 实读失败：{e}"))?;
        Ok(result.cookies)
    }
    async fn set_cookies(&self, cookies: Vec<SetCookieParam>) -> Result<(), String> {
        let params = StorageSetCookiesParams {
            cookies,
            browser_context_id: None,
        };
        self.session
            .send_browser::<serde_json::Value>("Storage.setCookies", params)
            .await
            .map_err(|e| format!("Storage.setCookies 注入失败：{e}"))?;
        Ok(())
    }
}

impl LazySessionOps {
    pub(crate) fn new(slot: Arc<BrowserSlot>) -> Self {
        LazySessionOps { slot }
    }

    /// 取已就绪会话（调用方必须先 ensure_ready；try_lock 失败 = 并发启动中）。
    fn session(&self) -> Result<Arc<RealSession>, ToolError> {
        self.slot.session_sync().ok_or_else(|| {
            ToolError::new(
                TOOL_BROWSER_NOT_READY,
                "浏览器会话初始化中（并发启动/重连），请重试",
            )
        })
    }
}

#[async_trait]
impl SessionOps for LazySessionOps {
    /// 惰性会话入口：未启动则启动、端点漂移则重连（27 方案 D-B/M-2 桥会话面）。
    async fn ensure_ready(&self) -> Result<(), String> {
        self.slot.ensure_ready().await.map(|_| ())
    }

    /// 同步就绪检查（R-9 gating）：会话已连接 → 委托 RealSession（进程状态
    /// + 活动标签）；未连接 → 按 manager 状态区分「未启动」与「恢复中」。
    fn readiness(&self) -> Result<(), String> {
        match self.slot.session_sync() {
            Some(rs) => rs.readiness(),
            None => match &self.slot.manager {
                None => Err("浏览器未注入（数据根解析失败降级）".to_string()),
                Some(manager) => match manager.status().state {
                    BrowserState::Stopped => {
                        Err("浏览器未启动（首次工具调用将自动启动）".to_string())
                    }
                    other => Err(format!(
                        "浏览器恢复中（进程状态：{other:?}，R-9 恢复期 gating）"
                    )),
                },
            },
        }
    }

    fn current_tab(&self) -> Result<SessionRef, ToolError> {
        self.session()?.current_tab()
    }

    async fn send_page(
        &self,
        session: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        self.ensure_ready().await.map_err(not_ready_err)?;
        self.session()?.send_page(session, method, params).await
    }

    async fn send_browser(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        self.ensure_ready().await.map_err(not_ready_err)?;
        self.session()?.send_browser(method, params).await
    }

    fn snapshot_version(&self, tab_id: &str) -> u64 {
        self.slot
            .session_sync()
            .map(|rs| rs.snapshot_version(tab_id))
            .unwrap_or(0)
    }

    async fn capture_snapshot(
        &self,
        tab_id: &str,
        session: &str,
        budgets: BudgetConfig,
    ) -> Result<SnapshotView, ToolError> {
        self.ensure_ready().await.map_err(not_ready_err)?;
        self.session()?
            .capture_snapshot(tab_id, session, budgets)
            .await
    }

    fn element_meta(
        &self,
        tab_id: &str,
        version: u64,
        index: u32,
    ) -> Result<Option<ElementMeta>, ToolError> {
        self.session()?.element_meta(tab_id, version, index)
    }

    async fn execute_action(&self, req: ActionRequest) -> Result<ActionSuccess, conex_browser::action::ActionError> {
        self.ensure_ready()
            .await
            .map_err(|e| conex_browser::action::ActionError::new(
                conex_browser::action::ActionErrorKind::ConnectionLost,
                e,
            ))?;
        self.session()
            .map_err(|e| conex_browser::action::ActionError::new(
                conex_browser::action::ActionErrorKind::ConnectionLost,
                e.to_string(),
            ))?
            .execute_action(req)
            .await
    }

    async fn wait_for(
        &self,
        cond: WaitCondition,
        opts: WaitOptions,
    ) -> Result<ActionSuccess, conex_browser::action::ActionError> {
        self.ensure_ready()
            .await
            .map_err(|e| conex_browser::action::ActionError::new(
                conex_browser::action::ActionErrorKind::ConnectionLost,
                e,
            ))?;
        self.session()
            .map_err(|e| conex_browser::action::ActionError::new(
                conex_browser::action::ActionErrorKind::ConnectionLost,
                e.to_string(),
            ))?
            .wait_for(cond, opts)
            .await
    }

    async fn console_entries(&self, since_seq: u64) -> Vec<ConsoleEntry> {
        match self.ensure_ready().await {
            Ok(()) => match self.session() {
                Ok(rs) => rs.console_entries(since_seq).await,
                Err(_) => Vec::new(),
            },
            Err(_) => Vec::new(),
        }
    }

    async fn network_entries(&self, since_seq: u64) -> Vec<NetworkEntry> {
        match self.ensure_ready().await {
            Ok(()) => match self.session() {
                Ok(rs) => rs.network_entries(since_seq).await,
                Err(_) => Vec::new(),
            },
            Err(_) => Vec::new(),
        }
    }
}

/// String 就绪原因 → `tool.browser.not_ready`（exec 管线 ② 步消费面）。
fn not_ready_err(reason: String) -> ToolError {
    ToolError::new(TOOL_BROWSER_NOT_READY, reason)
}

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
mod tests {
    use super::*;
    use conex_browser::{CrashReason, NavStack};
    use serde_json::json;

    /// 测试发射器（转发任务断言：记录 channel:payload）。
    struct TestEmitter(Arc<Mutex<Vec<String>>>);

    impl Emitter for TestEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("{channel}:{payload}"));
        }
    }

    /// 面板状态映射全表（契约口径：idle/launching/running/stopping/stopped/
    /// crashed/error；降级槽恒 error）。
    #[test]
    fn panel_state_mapping_table() {
        assert_eq!(panel_state_str(&BrowserState::Stopped, false, false), "idle");
        assert_eq!(panel_state_str(&BrowserState::Stopped, true, false), "stopped");
        assert_eq!(
            panel_state_str(&BrowserState::Launching { attempt: 1 }, false, false),
            "launching"
        );
        assert_eq!(panel_state_str(&BrowserState::Running, false, false), "running");
        assert_eq!(
            panel_state_str(&BrowserState::Stopping { graceful: true }, false, false),
            "stopping"
        );
        assert_eq!(
            panel_state_str(
                &BrowserState::Crashed {
                    reason: CrashReason::Unknown,
                    restarts: 1
                },
                false,
                false
            ),
            "crashed"
        );
        // 降级槽：任何进程状态均 error
        assert_eq!(panel_state_str(&BrowserState::Running, false, true), "error");
        assert_eq!(panel_state_str(&BrowserState::Stopped, false, true), "error");
    }

    /// 降级槽（manager=None）：status/start/ensure_ready/readiness 全部
    /// not_ready 语义（装配降级不 panic，27 §5 风险预案红线）。
    #[tokio::test]
    async fn degraded_slot_is_not_ready() {
        let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
        let status = slot.status();
        assert_eq!(status.state, "error");
        assert!(slot.status().url.is_none());

        let err = slot.start().await.unwrap_err();
        assert!(err.contains("未注入"), "降级文案：{err}");
        match slot.ensure_ready().await {
            Ok(_) => panic!("降级槽 ensure_ready 必须失败"),
            Err(err) => assert!(err.contains("未注入"), "降级文案：{err}"),
        }
        let err = slot.stop(false).await.unwrap_err();
        assert!(err.contains("未注入"), "降级文案：{err}");
        let err = slot.stop(true).await.unwrap_err();
        assert!(err.contains("未注入"), "降级文案：{err}");

        let ops = LazySessionOps::new(slot);
        assert!(ops.ensure_ready().await.is_err());
        let err = ops.readiness().unwrap_err();
        assert!(err.contains("未注入"), "降级文案：{err}");
        let err = ops.current_tab().unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
        let err = ops
            .send_page("S1", "Page.navigate", json!({ "url": "https://e.com" }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
    }

    /// estop 周期（M-2 桥状态机）：初始干净 → cancel（令牌取消 + 急停旗
    /// 置位）→ reset（令牌换新 + 急停旗复位，新周期不继承取消态）。
    #[tokio::test]
    async fn estop_epoch_reset_cancel_cycle() {
        let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
        // 初始周期
        assert!(!slot.policy.abort_token().is_cancelled());
        assert!(!slot.estop_flag.load(Ordering::SeqCst));
        // run 级 abort → cancel
        slot.cancel_estop();
        assert!(slot.policy.abort_token().is_cancelled());
        assert!(slot.estop_flag.load(Ordering::SeqCst));
        // 下一 run/启动周期 → reset
        slot.reset_estop();
        assert!(!slot.policy.abort_token().is_cancelled());
        assert!(!slot.estop_flag.load(Ordering::SeqCst));
    }

    /// 载荷契约形状（27 方案 S6 + 评审 F7）：url/reason 缺省时不落键
    /// （skip_serializing_if），携带时按 `{ state, url? }` / `{ state, reason? }`
    /// 序列化。
    #[test]
    fn payload_contract_shapes() {
        let idle = StatusPayload {
            state: "idle",
            url: None,
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(&idle).unwrap(),
            json!({ "state": "idle" })
        );
        let running = StatusPayload {
            state: "running",
            url: Some("https://e.com/".to_string()),
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(&running).unwrap(),
            json!({ "state": "running", "url": "https://e.com/" })
        );
        let crashed = StatusPayload {
            state: "crashed",
            url: None,
            reason: Some("ProcessExit(1)".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&crashed).unwrap(),
            json!({ "state": "crashed", "reason": "ProcessExit(1)" })
        );
        let start_ok = StartPayload {
            state: "running",
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(&start_ok).unwrap(),
            json!({ "state": "running" })
        );
        let start_err = StartPayload {
            state: "error",
            reason: Some("原因".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&start_err).unwrap(),
            json!({ "state": "error", "reason": "原因" })
        );
    }

    /// 评审 F3：急停（force=true）不等待会话锁——预占锁（模拟 launching 中
    /// start_and_connect_locked 持锁挂起）后 force stop 仍立即收敛（manager
    /// 未启动路径幂等）；正常停止（force=false）会被锁阻塞至硬超时兜底。
    #[tokio::test]
    async fn force_stop_skips_session_lock() {
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-force-stop-test"),
        ));
        let slot = Arc::new(BrowserSlot::from_parts(
            Some(manager),
            LaunchConfig::default(),
        ));
        // 预占会话锁（并发启动/重连持锁窗口）
        let _guard = slot.session.lock().await;
        // 急停：不等锁，直接收敛（未启动 manager 停止幂等）
        slot.stop(true).await.expect("force stop 不得被会话锁阻塞");
    }

    /// 评审 F4：stop 硬超时——优雅停止被会话锁阻塞超时后，走强制杀树兜底
    /// （未启动 manager 强制停止幂等收敛，不永久挂死）。
    #[tokio::test]
    async fn stop_hard_timeout_falls_back_to_force() {
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-stop-timeout-test"),
        ));
        let slot = Arc::new(
            BrowserSlot::from_parts(Some(manager), LaunchConfig::default())
                .with_stop_hard_timeout(Duration::from_millis(50)),
        );
        // 预占会话锁：优雅停止在 lock().await 阻塞 → 50ms 硬超时 → 强制兜底
        let _guard = slot.session.lock().await;
        let started = Instant::now();
        slot.stop(false).await.expect("超时兜底应收敛");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "硬超时兜底不得长期挂起：{:?}",
            started.elapsed()
        );
    }

    /// 评审 F9：启动失败冷却期——record_start_failure 后冷却期内 start /
    /// ensure_ready 直接返回冷却错误（不触发真实启动链）；冷却期过后恢复。
    #[tokio::test]
    async fn start_failure_cooldown_gates() {
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-cooldown-test"),
        ));
        let slot = Arc::new(BrowserSlot::from_parts(
            Some(manager),
            LaunchConfig::default(),
        ));
        assert_eq!(slot.start_cooldown_remaining(), None, "初始无冷却");
        slot.record_start_failure();
        let err = slot.start().await.unwrap_err();
        assert!(err.contains("冷却"), "start 冷却 gating：{err}");
        match slot.ensure_ready().await {
            Ok(_) => panic!("冷却期内 ensure_ready 必须失败"),
            Err(err) => assert!(err.contains("冷却"), "ensure_ready 冷却 gating：{err}"),
        }
        // 冷却期过后恢复：注入 0 冷却 = 冷却门禁关闭（记录失败后亦不 gating，
        // 未启动语义可重新走启动链；不触发真实启动）
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-cooldown-expired-test"),
        ));
        let slot = Arc::new(
            BrowserSlot::from_parts(Some(manager), LaunchConfig::default())
                .with_start_fail_cooldown(Duration::ZERO),
        );
        slot.record_start_failure();
        assert_eq!(slot.start_cooldown_remaining(), None, "0 冷却 = 门禁关闭");
    }

    /// 评审 F7：导航栈变更经转发任务重发状态事件（URL 随导航推送，面板不陈旧）。
    #[tokio::test]
    async fn nav_change_forwards_state_event() {
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-nav-forward-test"),
        ));
        let slot = Arc::new(BrowserSlot::from_parts(
            Some(manager.clone()),
            LaunchConfig::default(),
        ));
        let logs = Arc::new(Mutex::new(Vec::new()));
        slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&logs))));
        // 注入导航栈变更（set_nav 发射 NavStackChanged）→ 转发任务重发状态
        let mut nav = NavStack::new();
        nav.push(
            url::Url::parse("https://a.example").expect("URL 解析"),
            true,
        );
        manager.set_nav(nav);
        // 等待转发任务异步处理
        tokio::time::sleep(Duration::from_millis(200)).await;
        let logs = logs.lock().unwrap_or_else(|p| p.into_inner());
        assert!(
            logs.iter()
                .any(|s| s.contains("browser://state-changed") && s.contains("a.example")),
            "导航变更必须推送含 url 的状态事件：{logs:?}"
        );
    }

    /// 评审 F7：崩溃事件携带原因（`{ state: "crashed", reason }`）。
    #[test]
    fn crash_event_carries_reason() {
        let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
        let logs = Arc::new(Mutex::new(Vec::new()));
        slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&logs))));
        slot.emit_crash(&CrashReason::ProcessExit(1));
        let logs = logs.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(logs.len(), 1, "崩溃事件应发射一次：{logs:?}");
        assert!(
            logs[0].contains("browser://state-changed")
                && logs[0].contains("\"state\":\"crashed\"")
                && logs[0].contains("ProcessExit(1)"),
            "崩溃载荷含 state+reason：{}",
            logs[0]
        );
    }

    /// LazySessionOps 未启动语义（live manager 但从未 start）：readiness
    /// Err（"未启动"）；同步消费面 not_ready。**不触发真实启动**：异步
    /// ensure 路径会经 manager.start 拉起真实浏览器进程（本机 Chrome 存在
    /// 时单测会产生副作用进程/临时 profile）——启动+连接路径属集成面，
    /// conex-browser 假浏览器 harness 覆盖（S7 验收）；异步 not_ready 面
    /// 由 degraded_slot_is_not_ready 覆盖（未注入路径）。
    #[tokio::test]
    async fn lazy_ops_readiness_before_start() {
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-unit-test"),
        ));
        let slot = Arc::new(BrowserSlot::from_parts(
            Some(manager),
            LaunchConfig::default(),
        ));
        let ops = LazySessionOps::new(slot);
        let err = ops.readiness().unwrap_err();
        assert!(err.contains("未启动"), "未启动语义：{err}");
        let err = ops.current_tab().unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
    }

    /// P1-B1：降级槽（manager=None）start_frames 必须失败（不启帧流）；
    /// stop_frames / 帧状态查询幂等收敛（stopped）。
    #[tokio::test]
    async fn frame_stream_degraded_slot_is_not_ready() {
        let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let err = slot.start_frames(channel).await.unwrap_err();
        assert!(err.contains("未注入"), "降级文案：{err}");
        assert_eq!(slot.frames().state(), FrameStreamState::Stopped);
        assert_eq!(slot.stop_frames().await, FrameStreamState::Stopped);
    }

    /// P1-B1：输入路由接线——forward_input 无会话/管线时路由照常（不 panic、
    /// 无副作用）；管线未接线判定。
    #[tokio::test]
    async fn forward_input_routes_without_session() {
        let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
        let evt = BrowserInputEvent {
            kind: panel_input::InputEventKind::Mouse,
            action: Some("down".to_string()),
            x: Some(1.0),
            y: Some(2.0),
            button: Some("left".to_string()),
            buttons: Some(1),
            click_count: Some(1),
            delta_x: None,
            delta_y: None,
            modifiers: Some(0),
            key: None,
            code: None,
            text: None,
            windows_virtual_key_code: None,
            native_virtual_key_code: None,
            auto_repeat: None,
            location: None,
        };
        // 无会话/管线：路由吞掉（debug 留痕），invoke 侧无感（no-wait 语义）
        slot.forward_input(&evt);
        assert!(!slot.input().pipeline_wired(), "未连接时管线未接线");
    }

    /// P1-B1：raw_session 生命周期——降级槽恒 None；stop_inner 清理路径
    /// 不炸（会话槽空 + 帧流退订/释放幂等）。
    #[tokio::test]
    async fn raw_session_cleared_on_stop() {
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-raw-session-test"),
        ));
        let slot = Arc::new(BrowserSlot::from_parts(
            Some(manager),
            LaunchConfig::default(),
        ));
        assert!(slot.raw_session_sync().is_none(), "未连接前无底层会话");
        slot.frames().release_session(); // 幂等
        assert_eq!(slot.stop_frames().await, FrameStreamState::Stopped);
        slot.stop(false).await.expect("未启动停止幂等收敛");
        assert!(slot.raw_session_sync().is_none(), "停止后无底层会话");
        assert!(!slot.input().pipeline_wired(), "停止后管线清除");
    }

    /// E-1 端点暴露守卫（槽级，R-12 安全默认）：默认槽（attach 开关关闭）
    /// 端点**零暴露**——无论 manager 注入与否，`mcp_attach_endpoint` 一律
    /// 结构化拒绝 `tool.browser.capability_disabled`（判定序：开关先行，
    /// 不触碰端点状态；未显式授权不向外部 MCP 暴露受管端点，34 §5.2 E-1）。
    #[tokio::test]
    async fn mcp_attach_guard_default_off_zero_exposure() {
        use conex_browser_tools::codes::TOOL_BROWSER_CAPABILITY_DISABLED;
        // 注入 manager 的槽：即便进程存在，开关关闭仍拒绝（零暴露）
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-mcp-attach-off-test"),
        ));
        let slot = Arc::new(BrowserSlot::from_parts(
            Some(manager),
            LaunchConfig::default(),
        ));
        let err = slot.mcp_attach_endpoint().unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_CAPABILITY_DISABLED);
        // 降级槽（manager=None）：开关关闭同样拒绝（开关先行，与降级无关）
        let degraded = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
        let err = degraded.mcp_attach_endpoint().unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_CAPABILITY_DISABLED);
    }

    /// E-1 端点暴露守卫（槽级，开启面）：`with_mcp_attach_allowed(true)`
    /// 装配后守卫进入放行判定——浏览器未启动（端点不可用）→ 结构化
    /// `tool.browser.not_ready`（不开返回端点；就绪面由 mcp_attach.rs
    /// 纯函数测试以样例端点覆盖——单测不触发真实浏览器启动）。
    #[tokio::test]
    async fn mcp_attach_guard_enabled_requires_running_endpoint() {
        let manager = Arc::new(BrowserManager::new(
            std::env::temp_dir().join("browser-slot-mcp-attach-on-test"),
        ));
        let slot = Arc::new(
            BrowserSlot::from_parts(Some(manager), LaunchConfig::default())
                .with_mcp_attach_allowed(true),
        );
        let err = slot.mcp_attach_endpoint().unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
    }

    /// J1b：storage 发送面生命周期——未连接槽恒为未连接面（get/set 均
    /// not_ready 语义）；注入 mock 后命令面取到 mock（测试替身注入点）；
    /// drop_raw_session 换回未连接（陈旧会话不得滞留）。
    #[tokio::test]
    async fn storage_ops_lifecycle_unwired_then_injected() {
        use conex_browser::cdp::domains::{Cookie as CdpCookie, SetCookieParam};

        struct EchoOps;
        #[async_trait]
        impl StorageStateOps for EchoOps {
            async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String> {
                Err("echo".to_string())
            }
            async fn set_cookies(&self, _cookies: Vec<SetCookieParam>) -> Result<(), String> {
                Err("echo".to_string())
            }
        }

        let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
        // 未连接面：错误文案指向 browser_start（辅助通道须显式启动）
        let err = slot
            .storage_ops()
            .get_all_cookies()
            .await
            .unwrap_err();
        assert!(err.contains("未连接"), "未连接文案：{err}");
        // 注入 mock → 取到注入实现
        slot.inject_storage_ops(Arc::new(EchoOps));
        let err = slot.storage_ops().get_all_cookies().await.unwrap_err();
        assert_eq!(err, "echo");
        // drop_raw_session（停止路径）→ 换回未连接面
        slot.drop_raw_session();
        let err = slot
            .storage_ops()
            .set_cookies(Vec::new())
            .await
            .unwrap_err();
        assert!(err.contains("未连接"), "换回未连接：{err}");
    }

    // —— N6（G-9 遗留接线）集成：真实建连链路上的优雅停止先发 Browser.close ——

    /// 假浏览器 .bat + 迷你 CDP WS 服务端（Windows-only，.bat 语义）：
    /// 覆盖「会话建立 → register_session 接线 → Graceful 停止先发
    /// Browser.close → 自然退出不杀树 → 发送面随停止收尾清空」全链路。
    /// ubuntu 中层 CI 不编译（对齐 conex-browser harness 的 cfg(windows)
    /// 门控；.bat 脚本参数解析不兼容含空格路径，含空格时显式跳过）。
    #[cfg(windows)]
    mod graceful_close_integration {
        use super::*;
        use conex_browser::browser::cft::binary_rel_path;
        use conex_browser::browser::profile::browser_root;
        use conex_browser::LaunchTuning;
        use futures_util::{SinkExt, StreamExt};
        use serde_json::Value;
        use std::net::SocketAddr;
        use std::path::PathBuf;
        use tokio::net::TcpListener;
        use tokio_tungstenite::tungstenite::Message;

        /// 迷你 CDP WS 服务端：应答全部命令（getVersion 真实载荷、
        /// getTargets 空表、其余 Ok）并记录方法；收到 Browser.close 时写
        /// close 标志文件（模拟浏览器收到关闭命令后退出）。
        struct MiniCdpServer {
            addr: SocketAddr,
            received: Arc<Mutex<Vec<String>>>,
            flag_written: Arc<AtomicBool>,
        }

        impl MiniCdpServer {
            async fn spawn(profile_dir: PathBuf) -> Self {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .expect("迷你 CDP 服务端绑定失败");
                let addr = listener.local_addr().expect("地址获取失败");
                let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
                let flag_written = Arc::new(AtomicBool::new(false));
                let (rx, fx) = (Arc::clone(&received), Arc::clone(&flag_written));
                // 测试专用迷你服务端：#[tokio::test] 异步上下文（自带 runtime），
                // 保持 tokio::spawn 即可（与生产面无关；G-13 L3 P0 只涉及同步路径）
                tokio::spawn(async move {
                    loop {
                        let (stream, _) = match listener.accept().await {
                            Ok(v) => v,
                            Err(_) => break,
                        };
                        let (rx, fx) = (Arc::clone(&rx), Arc::clone(&fx));
                        let profile = profile_dir.clone();
                        // 同 async 上下文（外层任务内），保持 tokio::spawn
                        tokio::spawn(async move {
                            let ws = match tokio_tungstenite::accept_async(stream).await {
                                Ok(w) => w,
                                Err(_) => return,
                            };
                            let (mut sink, mut reader) = ws.split();
                            while let Some(Ok(Message::Text(text))) = reader.next().await {
                                let v: Value = match serde_json::from_str(&text) {
                                    Ok(v) => v,
                                    Err(_) => continue,
                                };
                                let method = v["method"].as_str().unwrap_or_default().to_string();
                                rx.lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .push(method.clone());
                                if method == "Browser.close" {
                                    // 模拟浏览器收到 Browser.close 后退出
                                    let _ =
                                        tokio::fs::write(profile.join("close-flag"), "close").await;
                                    fx.store(true, Ordering::SeqCst);
                                }
                                if let Some(id) = v["id"].as_u64() {
                                    let result = match method.as_str() {
                                        "Browser.getVersion" => json!({
                                            "protocolVersion": "1.3",
                                            "product": "Chrome/151.0.0.0"
                                        }),
                                        "Target.getTargets" => json!({ "targetInfos": [] }),
                                        _ => json!({}),
                                    };
                                    let mut msg = json!({ "id": id, "result": result });
                                    if let Some(s) = v["sessionId"].as_str() {
                                        msg["sessionId"] = Value::String(s.to_string());
                                    }
                                    if sink
                                        .send(Message::Text(msg.to_string().into()))
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                        });
                    }
                });
                MiniCdpServer {
                    addr,
                    received,
                    flag_written,
                }
            }

            fn close_count(&self) -> usize {
                self.received
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .iter()
                    .filter(|m| m.as_str() == "Browser.close")
                    .count()
            }
        }

        /// 假浏览器 .bat：解析 --user-data-dir → 写 DevToolsActivePort（指向
        /// 迷你 CDP 服务端端口）→ 轮询 close 标志文件（服务端收到
        /// Browser.close 后写入）→ 自然退出（exit 0）。
        fn fake_browser_script(port: u16) -> String {
            format!(
                "@echo off\r\n\
                 setlocal enabledelayedexpansion\r\n\
                 set PROFILE=\r\n\
                 set NEXT=0\r\n\
                 for %%a in (%*) do (\r\n\
                 \x20 set \"A=%%~a\"\r\n\
                 \x20 if \"!NEXT!\"==\"1\" (\r\n\
                 \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
                 \x20\x20 set \"NEXT=0\"\r\n\
                 \x20 )\r\n\
                 \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
                 \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
                 )\r\n\
                 if not defined PROFILE exit /b 9\r\n\
                 > \"!PROFILE!\\DevToolsActivePort\" echo {port}\r\n\
                 >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
                 :loop\r\n\
                 if exist \"!PROFILE!\\close-flag\" exit /b 0\r\n\
                 ping -n 2 127.0.0.1 >nul\r\n\
                 goto loop\r\n"
            )
        }

        /// N6 验收：会话建立（connect → register_session 接线）后 Graceful
        /// 停止先发 Browser.close → 假浏览器自然退出（不杀树）→ 停止收尾
        /// 清空发送面（M3 自动清空，二次停止不再向已死会话重复发送）。
        #[tokio::test]
        async fn graceful_stop_sends_browser_close_after_session_registered() {
            let dir = tempfile::tempdir().expect("临时目录");
            if dir.path().to_string_lossy().contains(' ') {
                // 路径含空格：.bat 假浏览器参数解析不兼容（显式跳过并说明）
                eprintln!(
                    "跳过 .bat harness 测试：临时目录路径含空格（{}）",
                    dir.path().display()
                );
                return;
            }
            // CfT 缓存占位（discover 命中；实际 spawn 走 binary_override）
            let cache =
                browser_root(dir.path()).join("browsers").join("chrome-151.0.7922.77");
            std::fs::create_dir_all(&cache).expect("缓存目录");
            let rel = binary_rel_path().expect("平台路径");
            let bin = cache.join(rel);
            std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
            std::fs::write(bin, b"placeholder").expect("写入占位");
            // 迷你 CDP 服务端（先于假浏览器绑定端口，端口写入 .bat）
            let server = MiniCdpServer::spawn(dir.path().to_path_buf()).await;
            let bat = dir.path().join("fake-browser.bat");
            std::fs::write(&bat, fake_browser_script(server.addr.port()))
                .expect("写入假浏览器脚本");
            let tuning = LaunchTuning {
                poll_interval: Duration::from_millis(20),
                poll_timeout: Duration::from_secs(3),
                launch_retry_delay: Duration::from_millis(30),
                crash_backoff: Duration::from_millis(60),
                crash_window: Duration::from_secs(30),
                crash_max_restarts: 3,
                // .bat 轮询粒度 ~1s：等待窗口须覆盖一轮以上轮询（对齐
                // conex-browser G-9 用例的 5s 放大，保证自然退出不杀树）
                wait_or_kill: Duration::from_secs(5),
            };
            let manager = Arc::new(BrowserManager::with_tuning(
                dir.path().to_path_buf(),
                tuning,
            ));
            let slot = Arc::new(BrowserSlot::from_parts(
                Some(manager),
                LaunchConfig {
                    binary_override: Some(bat),
                    ..Default::default()
                },
            ));
            // 会话建立：启动 + connect + register_session（N6 接线点）
            let started = slot.start().await.expect("启动+连接应成功");
            assert_eq!(started, "running");
            // Graceful 停止：先发 Browser.close（N6 断言点）
            slot.stop(false).await.expect("优雅停止应收敛");
            assert_eq!(
                server.close_count(),
                1,
                "优雅停止必须先发 Browser.close（经登记会话的发送面）"
            );
            assert!(
                server.flag_written.load(Ordering::SeqCst),
                "服务端应收到 Browser.close 并写退出标志"
            );
            assert_eq!(slot.status().state, "stopped");
            // 会话销毁 → 发送面已自动清空（M3 clear_session_state）：二次
            // 优雅停止幂等，不再向已死会话重复发送 Browser.close
            slot.stop(false).await.expect("二次停止幂等");
            assert_eq!(
                server.close_count(),
                1,
                "停止收尾必须清空发送面：不得向已死会话重复发送"
            );
        }
    }
}
