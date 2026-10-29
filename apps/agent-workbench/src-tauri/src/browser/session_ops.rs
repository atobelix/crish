//! 浏览器会话适配层：Tauri 事件发射器 / storage_state CDP 面 / 惰性会话操作。
//!
//! 装配关系：命令面经 [LazySessionOps]（会话操作）与 [TauriStateEmitter]
//! （状态事件）共用 [super::BrowserSlot] 的同一会话槽（单实例双控制面）。

use super::*;

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
pub(super) struct UnwiredStorageOps;

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
pub(super) struct SessionBackedStorage {
    session: Arc<BrowserSession>,
}

impl SessionBackedStorage {
    pub(super) fn new(session: Arc<BrowserSession>) -> Self {
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

    async fn execute_action(
        &self,
        req: ActionRequest,
    ) -> Result<ActionSuccess, conex_browser::action::ActionError> {
        self.ensure_ready().await.map_err(|e| {
            conex_browser::action::ActionError::new(
                conex_browser::action::ActionErrorKind::ConnectionLost,
                e,
            )
        })?;
        self.session()
            .map_err(|e| {
                conex_browser::action::ActionError::new(
                    conex_browser::action::ActionErrorKind::ConnectionLost,
                    e.to_string(),
                )
            })?
            .execute_action(req)
            .await
    }

    async fn wait_for(
        &self,
        cond: WaitCondition,
        opts: WaitOptions,
    ) -> Result<ActionSuccess, conex_browser::action::ActionError> {
        self.ensure_ready().await.map_err(|e| {
            conex_browser::action::ActionError::new(
                conex_browser::action::ActionErrorKind::ConnectionLost,
                e,
            )
        })?;
        self.session()
            .map_err(|e| {
                conex_browser::action::ActionError::new(
                    conex_browser::action::ActionErrorKind::ConnectionLost,
                    e.to_string(),
                )
            })?
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
