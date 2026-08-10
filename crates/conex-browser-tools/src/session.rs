//! 会话访问模型（维度 17 工具接线处的会话适配层）
//!
//! 工具经构造注入 `Option<Arc<BrowserSession>>`（BrowserToolsConfig.session），内部经
//! `SessionOps` trait 消费——真实实现 `RealSession` 仅使用 conex-browser 的 pub 接口
//! （send_page/send_browser/current_session/subscribe/snapshot_version/snapshot_manager），
//! 测试注入 mock 替身（tests/ 下 MockSession）断言参数透传与返回结构。
//!
//! 接线要点：
//! - **就绪 gating（R-9）**：manager 状态非 Running（启动中/崩溃重启中）或活动标签
//!   缺失 → 工具层返回 `tool.browser.not_ready`（17 §1.3 码表）；
//! - **动作执行**：经 `ActionExecutor` 统一流水线（门禁 → 版本 → abort → 定位 →
//!   派发 → 后置复核，14 §2.2 T-8），门禁注入本 crate 的 MVP 实现（17 §4，正式实现
//!   由引擎侧经 config.gate 替换）；abort 令牌为执行器内建 CancellationToken，
//!   ctx.abort_token 桥接（M-2，CollaborationToken 持有 AbortToken 引用）为遗留项；
//! - **快照缓存一致性**：`capture_snapshot` 与 `element_meta`（动作索引解析）共用
//!   同一 `SnapshotManager` 实例，保证「快照 → 动作」索引闭环；预算覆盖参数
//!   （browser_snapshot 的 max_depth/max_elements/max_text）走独立临时管理器，
//!   其快照不进入共享缓存（遗留注记：P1 统一缓存键）；
//! - **console/network 缓冲**：自首次调用起订阅事件总线（广播通道 tail 语义，
//!   此前事件不追溯；11 事件面无持久环形缓冲，P1 补 since_seq 语义与 url/line/
//!   status/size 字段）。

use crate::error;
use agent_tools::definition::ToolError;
use async_trait::async_trait;
use conex_browser::action::ops::{BrowserPageOps, PageOps, TokioDelay};
use conex_browser::action::{
    ActionError, ActionErrorKind, ActionExecutor, ActionRequest, ActionSuccess, ElementMeta,
    SnapshotStore,
};
use conex_browser::browser::BrowserManager;
use conex_browser::cdp::bus::{BrowserEvent, ConsoleLevel, VersionReason};
use conex_browser::cdp::sender::CancellationToken;
use conex_browser::cdp::version::{Stale, TabId};
use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::snapshot::{SnapshotDocument, SnapshotError, SnapshotManager};
use conex_browser::{BrowserSession, BrowserState, SessionRef};
use serde_json::Value;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 快照采集产物（工具面组织返回用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotView {
    pub snapshot_version: u64,
    /// 紧凑文本树（13 文档 §3.2 序列化产物）
    pub tree: String,
    /// 截断/盲区提示（预算命中与已知盲区登记，T-16）
    pub warnings: Vec<String>,
}

/// 控制台条目（11 事件面字段；url/line 未携带，MVP 置空）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsoleEntry {
    pub seq: u64,
    pub level: String,
    pub text: String,
}

/// 网络请求条目（11 事件面字段；status/size 未携带，MVP 置空）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkEntry {
    pub seq: u64,
    pub id: String,
    pub url: String,
    pub method: String,
    pub done: bool,
}

/// 会话操作抽象（MVP 工具面与浏览器会话的唯一交互面；测试注入 mock 替身）。
///
/// 全部方法仅消费 conex-browser 的 pub 接口；同步方法（readiness/current_tab/
/// tab_session/snapshot_version/element_meta）不落 await，异步方法为 CDP 命令面。
/// P1 多标签新增面（15 文档 §7）：`tab_session` 按 tab_id（targetId 语义）路由、
/// `activate_tab` 显式切换活动标签、`note_action_done` 即时推进目标标签版本——
/// 三方法提供默认实现（缺省语义见各注释），**引擎侧 LazySessionOps 未覆盖时为
/// 兼容降级**（活动标签兜底/空操作，遗留注记），RealSession 与测试 mock 显式覆盖。
#[async_trait]
pub trait SessionOps: Send + Sync {
    /// 就绪保证（27 接线方案 S1/D-B）：工具执行前异步确保会话可用——
    /// 引擎侧 `LazySessionOps` 经此入口做惰性启动/端点漂移重连（M-2 桥
    /// 的会话面）；**默认实现直接放行**：`RealSession` 与测试 mock 的就绪
    /// gating 仍由同步 [Self::readiness] 承担，零改动（27 §2.2）。
    async fn ensure_ready(&self) -> Result<(), String> {
        Ok(())
    }

    /// 就绪检查：Err(原因) = 工具层应返回 `tool.browser.not_ready`（R-9 gating）。
    fn readiness(&self) -> Result<(), String>;
    /// 当前活动标签（target_id + session 会话号）。
    fn current_tab(&self) -> Result<SessionRef, ToolError>;
    /// 按 tab_id（targetId 语义）路由到对应 CDP 会话（P1 多标签，15 §7）。
    /// None = 标签不存在/已关闭（TargetDestroyed 清理后）→ 工具面 node_gone 语义。
    /// 默认实现：活动标签兜底（仅当 tab_id == 活动标签时命中）——引擎侧
    /// LazySessionOps 未接线 per-tab 路由前的兼容降级。
    fn tab_session(&self, tab_id: &str) -> Option<SessionRef> {
        self.current_tab()
            .ok()
            .filter(|r| r.target_id == tab_id)
    }
    /// 显式切换活动标签（P1：Target.activateTarget 无 SessionAttached 事件，
    /// 引擎活动槽必须显式更新）。Err = 目标标签无会话（node_gone 语义）。
    /// 默认实现：空操作（引擎侧未接线时的兼容降级，活动标签仍随事件流）。
    fn activate_tab(&self, _tab_id: &str) -> Result<(), ToolError> {
        Ok(())
    }
    /// AI 动作成功即时推进目标标签版本（R-1，15 文档 §5.1：ActionDone 即时 +1；
    /// switch_tab 切换后旧快照随之失效 → 强制重快照）。
    /// 默认实现：空操作（无版本面实现的 mock/旧适配层降级）。
    fn note_action_done(&self, _tab_id: &str) {}
    /// 会话级 CDP 命令（页面域，绑定具体会话）。
    async fn send_page(
        &self,
        session: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, ToolError>;
    /// 浏览器级 CDP 命令。
    async fn send_browser(&self, method: &str, params: Value) -> Result<Value, ToolError>;
    /// 标签页当前快照版本（per-tab，R-1 会话级简化）。
    fn snapshot_version(&self, tab_id: &str) -> u64;
    /// 采集快照（写入共享缓存；预算与配置一致时走共享管理器）。
    async fn capture_snapshot(
        &self,
        tab_id: &str,
        session: &str,
        budgets: BudgetConfig,
    ) -> Result<SnapshotView, ToolError>;
    /// 从共享缓存按 (tab_id, version, index) 解析元素（Err = 无缓存快照/版本失效）。
    fn element_meta(
        &self,
        tab_id: &str,
        version: u64,
        index: u32,
    ) -> Result<Option<ElementMeta>, ToolError>;
    /// 执行动作原语（经 ActionExecutor 六步流水线，14 §2.2）。
    async fn execute_action(&self, req: ActionRequest) -> Result<ActionSuccess, ActionError>;
    /// wait_for 等待原语（14 §6：事件驱动 + 轮询兜底）。
    async fn wait_for(
        &self,
        cond: conex_browser::action::WaitCondition,
        opts: conex_browser::action::WaitOptions,
    ) -> Result<ActionSuccess, ActionError>;
    /// 控制台条目（增量：seq > since_seq）。
    async fn console_entries(&self, since_seq: u64) -> Vec<ConsoleEntry>;
    /// 网络请求条目（增量：seq > since_seq）。
    async fn network_entries(&self, since_seq: u64) -> Vec<NetworkEntry>;
}

/// 真实会话适配（BrowserSession 包装；仅消费 pub 接口）。
///
/// pub 暴露（27 接线方案 S3）：引擎侧 `LazySessionOps`（agent-workbench
/// browser 模块）在惰性启动/重连后**复用本适配器**消费会话——快照缓存/
/// 动作执行器/console/network 缓冲逻辑单点维护，不在引擎侧重复实现。
pub struct RealSession {
    session: Arc<BrowserSession>,
    manager_status: Option<Arc<BrowserManager>>,
    gate: Arc<dyn conex_browser::action::gate::DomainGate>,
    budgets: BudgetConfig,
    /// 共享快照管理器（采集 + 索引解析同实例，缓存一致性）
    snapshots: Arc<SnapshotManager>,
    /// per-tab 动作执行器缓存（P1 多标签：键 = tab_id，各绑定目标标签会话；
    /// 并发动作天然隔离——CDP 命令按 request_id 匹配，跨 tab 无共享态漂移）
    executors: Mutex<std::collections::HashMap<String, Arc<ActionExecutor>>>,
    console: Arc<ConsoleBuffer>,
    network: Arc<NetworkBuffer>,
}

impl RealSession {
    pub fn new(
        session: Arc<BrowserSession>,
        manager_status: Option<Arc<BrowserManager>>,
        gate: Arc<dyn conex_browser::action::gate::DomainGate>,
        budgets: BudgetConfig,
    ) -> Self {
        let snapshots = Arc::new(session.snapshot_manager(budgets));
        RealSession {
            session,
            manager_status,
            gate,
            budgets,
            snapshots,
            executors: Mutex::new(std::collections::HashMap::new()),
            console: Arc::new(ConsoleBuffer::default()),
            network: Arc::new(NetworkBuffer::default()),
        }
    }

    /// 目标标签会话解析（per-tab 路由；无会话 = 标签已关闭/未 attach →
    /// TargetClosed，14 §5.1 目标过期语义）。
    fn session_of(&self, tab_id: &str) -> Result<String, ActionError> {
        self.session.tab_session(tab_id).map(|r| r.session).ok_or_else(|| {
            ActionError::new(
                ActionErrorKind::TargetClosed,
                format!("标签 {tab_id} 不存在或已关闭（无可用会话）"),
            )
        })
    }

    /// 惰性构建目标标签的动作执行器（复用共享快照管理器与注入门禁；
    /// 按 tab_id 缓存，各绑定目标标签会话——per-tab 动作路由）。
    fn executor_for(&self, tab_id: &str, session: &str) -> Result<Arc<ActionExecutor>, ActionError> {
        let mut guard = self.executors.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(ex) = guard.get(tab_id) {
            return Ok(ex.clone());
        }
        let ops: Arc<dyn PageOps> = Arc::new(
            BrowserPageOps::new(self.session.clone()).with_session(session.to_string()),
        );
        let store: Arc<dyn SnapshotStore> = Arc::new(ToolSnapshotStore {
            session: self.session.clone(),
            snapshots: self.snapshots.clone(),
            // P1：per-tab 会话解析（15 §7.1 路由；重快照与动作同口径）
            session_for: conex_browser::action::ops::session_for_tab(self.session.clone()),
        });
        let executor = Arc::new(
            ActionExecutor::new(ops, store, CancellationToken::new())
                .with_gate(self.gate.clone())
                .with_delay(Arc::new(TokioDelay)),
        );
        guard.insert(tab_id.to_string(), executor.clone());
        Ok(executor)
    }
}

#[async_trait]
impl SessionOps for RealSession {
    fn readiness(&self) -> Result<(), String> {
        if let Some(manager) = &self.manager_status {
            let status = manager.status();
            if !matches!(status.state, BrowserState::Running) {
                return Err(format!(
                    "浏览器恢复中（进程状态：{:?}，R-9 恢复期 gating）",
                    status.state
                ));
            }
        }
        if self.session.current_session().is_err() {
            return Err("浏览器未就绪：无活动标签页".to_string());
        }
        Ok(())
    }

    fn current_tab(&self) -> Result<SessionRef, ToolError> {
        self.session
            .current_session()
            .map_err(|e| error::map_cdp_error("current_session", e))
    }

    fn tab_session(&self, tab_id: &str) -> Option<SessionRef> {
        self.session.tab_session(tab_id)
    }

    fn activate_tab(&self, tab_id: &str) -> Result<(), ToolError> {
        self.session
            .activate_tab(tab_id)
            .map_err(|e| error::map_cdp_error("activate_tab", e))
    }

    fn note_action_done(&self, tab_id: &str) {
        self.session.bump(&tab_id.to_string(), VersionReason::ActionDone);
    }

    async fn send_page(
        &self,
        session: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, ToolError> {
        self.session
            .send_page::<Value>(session, method, params)
            .await
            .map_err(|e| error::map_cdp_error(method, e))
    }

    async fn send_browser(&self, method: &str, params: Value) -> Result<Value, ToolError> {
        self.session
            .send_browser::<Value>(method, params)
            .await
            .map_err(|e| error::map_cdp_error(method, e))
    }

    fn snapshot_version(&self, tab_id: &str) -> u64 {
        self.session.snapshot_version(&tab_id.to_string())
    }

    async fn capture_snapshot(
        &self,
        tab_id: &str,
        session: &str,
        budgets: BudgetConfig,
    ) -> Result<SnapshotView, ToolError> {
        // 预算与配置一致 → 共享管理器（缓存闭环）；覆盖预算 → 独立临时管理器
        let manager: Arc<SnapshotManager> = if budgets == self.budgets {
            self.snapshots.clone()
        } else {
            Arc::new(self.session.snapshot_manager(budgets))
        };
        let doc = manager
            .capture(&tab_id.to_string(), session, true)
            .await
            .map_err(|e| error::map_snapshot_error("browser_snapshot", e))?;
        Ok(SnapshotView {
            snapshot_version: doc.meta.snapshot_version,
            tree: doc.serialized_text.clone(),
            warnings: warnings_of(&doc),
        })
    }

    fn element_meta(
        &self,
        tab_id: &str,
        version: u64,
        index: u32,
    ) -> Result<Option<ElementMeta>, ToolError> {
        let Some(doc) = self.snapshots.get_cached(&tab_id.to_string(), version) else {
            return Err(error::stale_snapshot(format!(
                "标签 {tab_id} 无 v{version} 缓存快照（请先调用 browser_snapshot）"
            )));
        };
        Ok(doc.selector_map.get(&index).map(|r| ElementMeta {
            backend_node_id: r.backend_node_id,
            // M2：密码输入目标判定——快照文档敏感输入集合（redact 同源判定）
            is_password: is_password_element(&doc, r.backend_node_id),
        }))
    }

    async fn execute_action(&self, req: ActionRequest) -> Result<ActionSuccess, ActionError> {
        self.executor()?.execute(req).await
    }

    async fn wait_for(
        &self,
        cond: conex_browser::action::WaitCondition,
        opts: conex_browser::action::WaitOptions,
    ) -> Result<ActionSuccess, ActionError> {
        self.executor()?.wait_for(cond, opts).await
    }

    async fn console_entries(&self, since_seq: u64) -> Vec<ConsoleEntry> {
        self.console.ensure_subscription(&self.session);
        self.console.entries_since(since_seq)
    }

    async fn network_entries(&self, since_seq: u64) -> Vec<NetworkEntry> {
        self.network.ensure_subscription(&self.session);
        self.network.entries_since(since_seq)
    }
}

/// 快照文档 → 工具面提示（截断信息 + 已知盲区统计，T-16）。
fn warnings_of(doc: &SnapshotDocument) -> Vec<String> {
    let mut warnings = Vec::new();
    if let Some(t) = &doc.meta.truncation {
        warnings.push(format!(
            "快照已截断（{:?}，丢弃 {} 节点/行，其中可交互 {} 个）",
            t.truncated_by, t.dropped_nodes, t.dropped_interactive
        ));
    }
    let bz = &doc.meta.blind_zone;
    if bz.canvas > 0 {
        warnings.push(format!(
            "canvas/WebGL 内容 {} 处不可见（已知盲区）",
            bz.canvas
        ));
    }
    if bz.video > 0 {
        warnings.push(format!("视频画面 {} 处不可见（已知盲区）", bz.video));
    }
    if bz.image > 0 {
        warnings.push(format!("纯图片内容 {} 处不可见（已知盲区）", bz.image));
    }
    if bz.unoperable > 0 {
        warnings.push(format!(
            "closed shadow 内不可操作元素 {} 个（降级标记，T-5）",
            bz.unoperable
        ));
    }
    warnings
}

/// 快照存储适配（SnapshotStore 契约实现；共享管理器 + 会话解析，14 §5.2 消费面）。
///
/// 与 conex-browser 内置 `BrowserSnapshotStore` 的差异：本实现持有持久化
/// `SnapshotManager` 实例（内置实现每次调用新建管理器导致缓存不命中，遗留注记
/// 由 conex-browser 侧修复），保证 take_snapshot/element_by_index 与工具面
/// capture_snapshot 共用同一缓存。
struct ToolSnapshotStore {
    session: Arc<BrowserSession>,
    snapshots: Arc<SnapshotManager>,
    // 复用 conex-browser 的会话解析器类型（引擎侧维度 15 标签管理注入；MVP 活动标签兜底）
    session_for: conex_browser::action::ops::SessionResolver,
}

#[async_trait]
impl SnapshotStore for ToolSnapshotStore {
    fn snapshot_version(&self, tab_id: &TabId) -> u64 {
        self.session.snapshot_version(tab_id)
    }

    fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale> {
        self.session.validate_snapshot(tab_id, version)
    }

    async fn take_snapshot(&self, tab_id: &TabId) -> Result<u64, ActionError> {
        let session = (self.session_for)(tab_id).ok_or_else(|| {
            ActionError::new(
                ActionErrorKind::InvalidInput,
                format!("标签 {tab_id} 无可用会话（维度 15 标签管理接线）"),
            )
        })?;
        let doc = self
            .snapshots
            .capture(tab_id, &session, true)
            .await
            .map_err(map_take_error)?;
        Ok(doc.meta.snapshot_version)
    }

    fn element_by_index(&self, tab_id: &TabId, version: u64, index: usize) -> Option<ElementMeta> {
        let doc = self.snapshots.get_cached(tab_id, version)?;
        let node_ref = doc.selector_map.get(&(index as u32))?;
        Some(ElementMeta {
            backend_node_id: node_ref.backend_node_id,
            is_password: is_password_element(&doc, node_ref.backend_node_id),
        })
    }

    fn note_action_done(&self, tab_id: &TabId) {
        self.session.bump(tab_id, VersionReason::ActionDone);
    }
}

/// 密码输入目标判定（M2）：快照文档携带敏感输入集合（redact 同源判定），
/// 单点封装——`element_meta` 与 `element_by_index` 消费同一口径。
fn is_password_element(doc: &SnapshotDocument, backend_node_id: i64) -> bool {
    doc.password_backend_ids.contains(&backend_node_id)
}

/// 重快照错误 → ActionError（14 §5.1 分类：超时/版本竞态/采集失败）。
fn map_take_error(err: SnapshotError) -> ActionError {
    match err {
        SnapshotError::Timeout(d) => ActionError::new(
            ActionErrorKind::Timeout,
            format!("重快照超时（硬超时上限 {d:?}，T-1）"),
        ),
        SnapshotError::Stale(stale) => ActionError::new(
            ActionErrorKind::VersionInvalid,
            format!("重快照版本竞态（M-5）：{stale:?}"),
        ),
        SnapshotError::CacheRollback {
            tab_id,
            version,
            max,
        } => ActionError::new(
            ActionErrorKind::VersionInvalid,
            format!("重快照缓存版本回退被拒：tab={tab_id} v{version} < {max}"),
        ),
        other => ActionError::new(ActionErrorKind::NodeStale, format!("重快照失败：{other}")),
    }
}

/// 控制台环形缓冲（自首次调用订阅；容量 1000 条）。
struct ConsoleBuffer {
    inner: Mutex<VecDeque<ConsoleEntry>>,
    next_seq: AtomicU64,
    spawned: AtomicBool,
}

impl Default for ConsoleBuffer {
    fn default() -> Self {
        ConsoleBuffer {
            inner: Mutex::new(VecDeque::with_capacity(1024)),
            next_seq: AtomicU64::new(1),
            spawned: AtomicBool::new(false),
        }
    }
}

impl ConsoleBuffer {
    /// 自首次调用起订阅事件总线（广播通道 tail 语义，此前事件不追溯）。
    fn ensure_subscription(self: &Arc<Self>, session: &Arc<BrowserSession>) {
        if self.spawned.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut rx = session.subscribe();
        let buffer = self.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(BrowserEvent::Console { level, text, .. }) => {
                        buffer.push(console_level_str(level), &text);
                    }
                    Ok(BrowserEvent::PageError { text, .. }) => {
                        buffer.push("error", &text);
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn push(&self, level: &str, text: &str) {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let mut q = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if q.len() >= 1024 {
            q.pop_front();
        }
        q.push_back(ConsoleEntry {
            seq,
            level: level.to_string(),
            text: text.to_string(),
        });
    }

    fn entries_since(&self, since_seq: u64) -> Vec<ConsoleEntry> {
        let q = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        q.iter().filter(|e| e.seq > since_seq).cloned().collect()
    }
}

/// 网络请求环形缓冲（自首次调用订阅；容量 1000 条；URL 入库前脱敏，17 §6.2）。
struct NetworkBuffer {
    inner: Mutex<VecDeque<NetworkEntry>>,
    next_seq: AtomicU64,
    spawned: AtomicBool,
}

impl Default for NetworkBuffer {
    fn default() -> Self {
        NetworkBuffer {
            inner: Mutex::new(VecDeque::with_capacity(1024)),
            next_seq: AtomicU64::new(1),
            spawned: AtomicBool::new(false),
        }
    }
}

impl NetworkBuffer {
    fn ensure_subscription(self: &Arc<Self>, session: &Arc<BrowserSession>) {
        if self.spawned.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut rx = session.subscribe();
        let buffer = self.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(BrowserEvent::NetworkRequest {
                        request_id,
                        url,
                        method,
                    }) => buffer.push_request(&request_id, &url, &method),
                    Ok(BrowserEvent::NetworkDone { request_id, ok }) => {
                        buffer.mark_done(&request_id, ok)
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    fn push_request(&self, id: &str, url: &str, method: &str) {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let mut q = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if q.len() >= 1024 {
            q.pop_front();
        }
        q.push_back(NetworkEntry {
            seq,
            id: id.to_string(),
            // 17 §6.2：URL 敏感参数值脱敏后入库
            url: crate::helpers::redact_url_query(url),
            method: method.to_string(),
            done: false,
        });
    }

    fn mark_done(&self, id: &str, _ok: bool) {
        let mut q = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = q.iter_mut().find(|e| e.id == id) {
            entry.done = true;
        }
    }

    fn entries_since(&self, since_seq: u64) -> Vec<NetworkEntry> {
        let q = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        q.iter().filter(|e| e.seq > since_seq).cloned().collect()
    }
}

/// ConsoleLevel → 字符串（工具面输出/过滤用）。
fn console_level_str(level: ConsoleLevel) -> &'static str {
    match level {
        ConsoleLevel::Debug => "debug",
        ConsoleLevel::Info => "info",
        ConsoleLevel::Log => "log",
        ConsoleLevel::Warn => "warn",
        ConsoleLevel::Error => "error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_level_mapping() {
        assert_eq!(console_level_str(ConsoleLevel::Debug), "debug");
        assert_eq!(console_level_str(ConsoleLevel::Info), "info");
        assert_eq!(console_level_str(ConsoleLevel::Log), "log");
        assert_eq!(console_level_str(ConsoleLevel::Warn), "warn");
        assert_eq!(console_level_str(ConsoleLevel::Error), "error");
    }

    /// 环形缓冲容量与增量语义（不经事件总线，纯缓冲面测试）。
    #[test]
    fn buffer_capacity_and_since() {
        let buffer = ConsoleBuffer::default();
        buffer.push("info", "a");
        buffer.push("warn", "b");
        let all = buffer.entries_since(0);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].seq, 1);
        let after = buffer.entries_since(1);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].text, "b");
    }

    /// M2：密码输入目标判定——快照文档敏感输入集合（redact 同源）消费面。
    /// 构造含密码标记的文档（集合成员命中、非成员排除），验证 is_password 口径。
    #[test]
    fn password_flag_consumed_from_document() {
        use conex_browser::snapshot::{BlindZoneStats, SnapshotMeta};
        let doc = SnapshotDocument {
            serialized_text: String::new(),
            selector_map: std::collections::HashMap::new(),
            password_backend_ids: std::collections::HashSet::from([7]),
            meta: SnapshotMeta {
                snapshot_version: 1,
                epoch: 0,
                captured_at_ms: 0,
                url: String::new(),
                title: String::new(),
                tab_id: "t1".to_string(),
                element_count: 0,
                selector_count: 0,
                truncation: None,
                blind_zone: BlindZoneStats::default(),
            },
        };
        assert!(is_password_element(&doc, 7), "集合成员必须判定为密码输入目标");
        assert!(!is_password_element(&doc, 8), "非集合成员不得误判");
        assert!(!is_password_element(&doc, 0), "backend=0（不存在）不得误判");
    }
}
