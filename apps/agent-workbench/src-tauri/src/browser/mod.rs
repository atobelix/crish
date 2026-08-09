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

use crate::core_event_bridge::Emitter;
use agent_tools::definition::ToolError;
use async_trait::async_trait;
use conex_browser::action::gate::{DomainGate, GateDenial};
use conex_browser::action::{ActionRequest, ActionSuccess, ElementMeta, WaitCondition, WaitOptions};
use conex_browser::browser::profile::data_root;
use conex_browser::browser::state::BrowserState;
use conex_browser::cdp::sender::CancellationToken;
use conex_browser::cdp::transport::ExpectedBrowser;
use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::{
    BrowserManager, LaunchConfig, ProcessEvent, SessionRef, StopReason,
};
use conex_browser_tools::codes::TOOL_BROWSER_NOT_READY;
use conex_browser_tools::gate::MvpDomainGate;
use conex_browser_tools::policy::AllowAllPolicy;
use conex_browser_tools::session::{ConsoleEntry, NetworkEntry, RealSession, SessionOps, SnapshotView};
use serde::Serialize;
use session_loop::AbortSignal;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::MutexGuard as AsyncMutexGuard;

/// 面板状态载荷（browser_status 返回 + `browser://state-changed` 事件负载；
/// 27 方案 S6 契约定死：`{ state, url? }`）。
#[derive(Debug, Clone, Serialize)]
pub(crate) struct StatusPayload {
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
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
                let mut guard = self.session.lock().await;
                if guard.is_some() && self.endpoint_matches(&manager) {
                    return Ok("running");
                }
                self.start_and_connect_locked(&manager, &mut guard).await?;
                Ok("running")
            }
            // 启动/停止在途：返回 starting（状态迁移经事件流推送面板）
            BrowserState::Launching { .. } | BrowserState::Stopping { .. } => Ok("starting"),
            BrowserState::Crashed { .. } => {
                Err("浏览器崩溃恢复中（退避重启），请稍后重试".to_string())
            }
        }
    }

    /// 面板停止命令入口（27 方案 S6）：丢弃会话 + Graceful 停止进程。
    pub(crate) async fn stop(&self) -> Result<(), String> {
        let Some(manager) = self.manager.clone() else {
            return Err("浏览器未注入（数据根解析失败降级）".to_string());
        };
        let mut guard = self.session.lock().await;
        // 丢弃会话（Transport 断开）；进程收口由 manager.stop 承担
        *guard = None;
        manager
            .stop(StopReason::Graceful)
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
                let mut guard = self.session.lock().await;
                if guard.is_some() && self.endpoint_matches(&manager) {
                    let Some(rs) = guard.as_ref() else {
                        return Err("浏览器会话不可用（异常状态）".to_string());
                    };
                    return Ok(Arc::clone(rs));
                }
                self.start_and_connect_locked(&manager, &mut guard).await?;
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
    pub(crate) fn attach_emitter(self: &Arc<Self>, emitter: Arc<dyn Emitter>) {
        *self.emitter.lock().unwrap_or_else(|p| p.into_inner()) = Some(emitter);
        if self.forwarder_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(manager) = self.manager.clone() else {
            return;
        };
        let mut rx = manager.subscribe();
        let slot = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ProcessEvent::StateChanged { state, .. }) => {
                        slot.emit_state_changed(&state);
                    }
                    Ok(_) => {}
                    Err(_) => break,
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
        Ok(Arc::new(RealSession::new(
            session,
            Some(Arc::clone(manager)),
            Arc::clone(&self.gate),
            BudgetConfig::active(),
        )))
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
    tokio::spawn(async move {
        signal.wait_aborted().await;
        slot.cancel_estop();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_browser::CrashReason;
    use serde_json::json;

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
        let err = slot.stop().await.unwrap_err();
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

    /// 载荷契约形状（27 方案 S6）：url/reason 缺省时不落键（skip_serializing_if），
    /// 携带时按 `{ state, url? }` / `{ state, reason? }` 序列化。
    #[test]
    fn payload_contract_shapes() {
        let idle = StatusPayload {
            state: "idle",
            url: None,
        };
        assert_eq!(
            serde_json::to_value(&idle).unwrap(),
            json!({ "state": "idle" })
        );
        let running = StatusPayload {
            state: "running",
            url: Some("https://e.com/".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&running).unwrap(),
            json!({ "state": "running", "url": "https://e.com/" })
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
}
