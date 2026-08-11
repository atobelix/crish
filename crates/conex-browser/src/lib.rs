//! conex-browser —— 软件内 AI 协同浏览器的 CDP 通道与事件总线（维度 11）+ 感知快照（维度 13）
//! + 动作执行与定位重试（维度 14）
//!
//! 对外门面 `BrowserSession`：连接 + 发送 + 事件 + 版本四合一（11 文档 §8）；
//! `snapshot` 模块：感知快照（采集/判定/脱敏/序列化/预算，13 文档）；
//! `action` 模块：动作原语与重试状态机（定位/点击/输入/等待/上传，14 文档）。
//!
//! - **连接层**（transport/client）：单长连接常驻、断线才重连（§2）；
//!   重连后执行状态恢复清单（getVersion 复核 → 目标重扫 → 会话重建 →
//!   逐会话 enable → 拦截重挂 → TargetsReconciled，§2.4）
//! - **统一发送层**（sender）：五段管线 幂等→急停→审批→审计→传输（§4），
//!   `CommandPolicyHooks` 由引擎侧（conex-browser-tools）注入实现
//! - **事件总线**（bus）：typed 广播 + screencast 帧专用通道（§5）
//! - **版本面**（version）：per-tab snapshotVersion + global_epoch（R-1 修订版）
//! - **能力探测**（probe）：13 域 CapabilityReport（R-3 补齐）
//! - **对话框状态机**（dialog）：上抛/应答/超时自动 dismiss + window.open 收口（§7）
//! - **感知快照**（snapshot）：CDP 采集 → 可交互判定 → 脱敏 → 序列化；
//!   采集事务化（版本读-采集-校验-提交，M-5）、(tab_id, version) 缓存（M-6）、
//!   预算参数化（T-6）、盲区登记（T-16）
//! - **动作执行**（action）：执行流水线（门禁 → 版本 → abort → 定位 → 派发 →
//!   后置导航复核，T-8）、重试状态机（3 次上限 R-8 / 断连恢复 R-9 / 升级 T-10）、
//!   总预算 120s（T-9）；CDP 交互经 `PageOps` trait 抽象（mock 可测，14 文档）
//!
//! 进程管理（BrowserManager/LaunchConfig 等）属维度 10，由 M2 在
//! `process/` 子模块实现；本 crate 仅定义连接契约 `CdpEndpoint`/`ExpectedBrowser`。
//! 数据导入与持久化（维度 16：来源发现/最小文件集复制/回读校验/profile_meta）
//! 由 M3 在 `import/` 子模块实现，聚合入口 `ImportService`。

pub mod action;
pub mod browser;
pub mod cdp;
pub mod frames;
pub mod import;
pub mod input;
pub mod snapshot;

pub use import::ImportService;

pub use action::evaluate::EvaluateRequest;
pub use action::gate::{DomainGate, GateDenial};
pub use action::keyboard::KeySpec;
pub use action::locate::{Located, ResolvedPoint, ViewportSize};
pub use action::ops::{BrowserPageOps, BrowserSnapshotStore, Delay, PageOps, TokioDelay};
pub use action::retry::{ActionOutcome, RetryPolicy, RetryState, RetryStrategy};
pub use action::wait::{WaitCondition, WaitOptions};
pub use action::{
    ActionError, ActionErrorKind, ActionExecutor, ActionOptions, ActionRequest, ActionSuccess,
    ElementMeta, ElementRef, MouseButton, PathBufLike, Primitive, ScrollDir, SnapshotStore,
    ACTION_TOTAL_TIMEOUT, MAX_ATTEMPTS, TYPE_CHUNK_SIZE,
};

pub use browser::args::EngineMode;
pub use browser::discover::{Backend, BackendOverride, BackendResolution, CandidateProbe};
pub use browser::endpoint::SessionToken;
pub use browser::events::ProcessEvent;
pub use browser::nav_stack::{NavStack, TabEntry};
pub use browser::state::{BrowserState, CrashReason};
pub use browser::{
    BrowserManager, BrowserStatus, LaunchConfig, LaunchReport, LaunchTuning, ProcessError,
    ProfileSpec, StopReason, StopReport,
};
pub use cdp::bus::{
    BrowserEvent, BusHandle, ConsoleLevel, DialogInfo, DomChangeKind, FrameChunk, LifecycleKind,
    TabSummary, VersionReason,
};
pub use cdp::client::{CdpClient, ConnectConfig};
pub use cdp::dialog::{
    DialogRegistry, DialogState, TimeoutDiagnosis, WindowOpenDecision, WindowOpenPolicy,
    DIALOG_AUTO_DISMISS_TIMEOUT,
};
pub use cdp::error::{BrowserError, CancelReason, CdpError, CdpErrorCode};
pub use cdp::probe::{
    BrowserVersion, CapabilityReport, Domain, DomainReport, DomainStatus, FeatureFlags,
    MIN_CHROMIUM_MAJOR, PROBE_BUDGET,
};
pub use cdp::sender::{
    ApprovalDenied, AuditPhase, BrowserAuditEvent, CancellationToken, Command, CommandChannel,
    CommandPolicyHooks, CommandSender, CdpCommandView, IdKey, DEFAULT_TIMEOUT,
};
pub use cdp::transport::{
    backoff_base, backoff_delay, CdpEndpoint, ConnectionState, ExpectedBrowser, RestoreHook,
    Transport, RECONNECT_REPORT_FAILURES, VERIFY_TIMEOUT,
};
pub use cdp::types::{CdpEvent, CdpMessage};
pub use cdp::version::{
    Stale, TabId, VersionTracker, VERSION_BUMP_COALESCE, VERSION_RESET_DELTA,
};
pub use snapshot::budget::{
    BudgetConfig, HARD_TIMEOUT, MAX_OUTPUT_BYTES, MAX_RAW_PAYLOAD_BYTES, MAX_SELECTOR_INDICES,
    MAX_TEXT_LEN, MAX_TREE_NODES, P95_TARGET, SNAPSHOT_CACHE_TOTAL_BYTES,
};
pub use snapshot::collect::{
    AxInfo, AxProperties, Bounds, CdpCollector, CollectedData, EnhancedNode, FixtureCollector,
    FrameMarker, StyleInfo, SnapshotCollector,
};
pub use snapshot::{
    BlindZoneKind, BlindZoneStats, CaptureStateKind, NodeRef, SerializeOptions, SnapshotDocument,
    SnapshotError, SnapshotManager, SnapshotMeta, SimplifiedNode,
};

use crate::cdp::bus::{FRAME_CHANNEL_CAPACITY, TYPED_CHANNEL_CAPACITY};
use crate::cdp::domains::names::*;
use crate::cdp::domains::{AttachToTargetResult, GetTargetsResult};
use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::broadcast;

/// 域 enable 序列超时（5s，§2.3 域 enable；启动路径短超时快速失败进能力探测降级）。
const ENABLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// live 探针超时（1.5s，browser.rs:749-760 同款；防 Memory-Saver 挂起）。
const RENDERER_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 活动标签会话引用（current_session 返回面）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    pub target_id: String,
    pub session: String,
}

/// 恢复流程实现（§2.4 状态恢复清单：幂等、可重入）。
struct SessionRestore {
    bus_tx: broadcast::Sender<BrowserEvent>,
    expected: ExpectedBrowser,
}

#[async_trait]
impl RestoreHook for SessionRestore {
    async fn restore(&self, client: &CdpClient) -> Result<(), BrowserError> {
        restore_session(client, &self.bus_tx, &self.expected).await
    }
}

/// 重连后状态恢复清单（§2.4 恢复表 1-9 项；第 6 步版本跳变由版本驱动在
/// ConnectionRestored 后统一处理；第 9 步 screencast 恢复属维度 12 接线，遗留）。
async fn restore_session(
    client: &CdpClient,
    bus_tx: &broadcast::Sender<BrowserEvent>,
    expected: &ExpectedBrowser,
) -> Result<(), BrowserError> {
    // 1. 浏览器级：getVersion 复核仍指向预期实例（错连 → 断开重来）
    let ver: Value = client
        .send_command(BROWSER_GET_VERSION, None, None)
        .await
        .map_err(|e| BrowserError::Restore(format!("getVersion 复核失败：{e}")))?;
    if let Some(prefix) = &expected.product_prefix {
        let product = ver["product"].as_str().unwrap_or_default();
        if !product.starts_with(prefix) {
            return Err(BrowserError::VerifyMismatch {
                expected: prefix.clone(),
                actual: product.to_string(),
            });
        }
    }

    // 2. Target 发现：setDiscoverTargets + getTargets 重扫
    client
        .send_command(
            TARGET_SET_DISCOVER_TARGETS,
            Some(json!({ "discover": true })),
            None,
        )
        .await
        .map_err(|e| BrowserError::Restore(format!("setDiscoverTargets 失败：{e}")))?;
    let targets: GetTargetsResult = client
        .send_command(TARGET_GET_TARGETS, None, None)
        .await
        .and_then(|v| {
            serde_json::from_value(v).map_err(|e| CdpError::Internal {
                method: Some(TARGET_GET_TARGETS.to_string()),
                message: e.to_string(),
            })
        })
        .map_err(|e| BrowserError::Restore(format!("getTargets 失败：{e}")))?;

    // 3. 会话重建 + 4. 域重 enable（先 live 探测，防 Memory-Saver 挂起）
    let mut tabs = Vec::new();
    for info in targets.target_infos.iter().filter(|t| t.target_type == "page") {
        let attach: AttachToTargetResult = client
            .send_command(
                TARGET_ATTACH_TO_TARGET,
                Some(json!({ "targetId": info.target_id, "flatten": true })),
                None,
            )
            .await
            .and_then(|v| {
                serde_json::from_value(v).map_err(|e| CdpError::Internal {
                    method: Some(TARGET_ATTACH_TO_TARGET.to_string()),
                    message: e.to_string(),
                })
            })
            .map_err(|e| {
                BrowserError::Restore(format!("attachToTarget({}) 失败：{e}", info.target_id))
            })?;
        tabs.push(TabSummary {
            target_id: info.target_id.clone(),
            session: attach.session_id.clone(),
            url: info.url.clone(),
            title: info.title.clone(),
        });
        if !renderer_responds(client, &attach.session_id).await {
            // Memory-Saver 挂起标签跳过 enable（恢复后由工具层 liveness 复活路径接管）
            tracing::warn!("会话 {} 无响应（Memory-Saver），跳过 enable", attach.session_id);
            continue;
        }
        enable_domains(client, &attach.session_id)
            .await
            .map_err(|e| BrowserError::Restore(format!("enable 序列失败：{e}")))?;
        // 5. 拦截恢复：window.open 收口重挂（best-effort）
        let _ = client
            .send_command(PAGE_SET_WINDOW_OPEN_HANDLER, Some(json!({})), Some(&attach.session_id))
            .await;
    }

    // 7. 事件补发：TargetsReconciled（维度 10 导航栈与面板对齐）
    let _ = bus_tx.send(BrowserEvent::TargetsReconciled { tabs });
    Ok(())
}

/// 逐会话 enable 序列（§3.2 顺序：Page/Runtime/DOM/Network + lifecycle +
/// runIfWaitingForDebugger 恢复）。
/// 通道抽象 `&dyn CommandChannel`：恢复流程传 `&CdpClient`（直连），
/// new_tab 显式 attach 传 `&Transport`（重连透明）——顺序与超时单一来源。
async fn enable_domains(channel: &dyn CommandChannel, session: &str) -> Result<(), CdpError> {
    for (method, params) in [
        (PAGE_ENABLE, None),
        (
            PAGE_SET_LIFECYCLE_EVENTS_ENABLED,
            Some(json!({ "enabled": true })),
        ),
        (RUNTIME_ENABLE, None),
        (DOM_ENABLE, None),
        (NETWORK_ENABLE, None),
    ] {
        channel
            .send_command(method, params, Some(session), ENABLE_TIMEOUT)
            .await?;
    }
    // attach 后恢复（Chrome 144+ 目标暂停，runIfWaitingForDebugger 恢复；no-op 兜底）
    let _ = channel
        .send_command_no_wait(RUNTIME_RUN_IF_WAITING_FOR_DEBUGGER, None, Some(session))
        .await;
    Ok(())
}

/// live 探测（Runtime.evaluate("1") 1.5s；失败即视为不可服务，跳 enable）。
async fn renderer_responds(client: &CdpClient, session: &str) -> bool {
    client
        .send_command_with_timeout(
            RUNTIME_EVALUATE,
            Some(json!({ "expression": "1", "returnByValue": true })),
            Some(session),
            RENDERER_PROBE_TIMEOUT,
        )
        .await
        .is_ok()
}

/// 对外门面：连接 + 发送 + 事件 + 版本四合一（§8）。
pub struct BrowserSession {
    transport: Arc<Transport>,
    sender: CommandSender,
    bus: BusHandle,
    version: Arc<VersionTracker>,
    dialogs: Arc<DialogRegistry>,
    active: Arc<Mutex<Option<(String, String)>>>, // (target_id, session) 活动标签
    /// per-tab 会话路由表（P1 多标签）：tab_id(targetId) → 主 frame CDP 会话。
    /// 登记：SessionAttached（首次附着者胜——主 frame 会话优先，iframe 会话不覆盖）；
    /// 清理：TargetDestroyed 移除整条（标签关闭后动作按 tab_id 路由失败 → 目标过期）。
    tabs: Arc<Mutex<std::collections::HashMap<String, String>>>,
    probe: OnceLock<CapabilityReport>,
}

impl BrowserSession {
    /// 建连（握手 + 身份校验 + 恢复流程）；`policy` 由引擎侧注入（conex-browser-tools）。
    ///
    /// 订阅时序铁律（联调 E1 根因修复）：恢复流程会触发 `Target.attachedToTarget`、
    /// 初始 frameNavigated 等事件，而 tokio broadcast 新订阅者**不补发订阅前消息**——
    /// 因此全部消费方（事件泵/版本驱动/对话框/活动标签）必须先完成订阅，
    /// 最后才执行恢复流程（`Transport::restore_now`）。
    pub async fn connect(
        endpoint: CdpEndpoint,
        expected: ExpectedBrowser,
        policy: Arc<dyn CommandPolicyHooks>,
    ) -> Result<Self, BrowserError> {
        let bus = BusHandle::new(TYPED_CHANNEL_CAPACITY, FRAME_CHANNEL_CAPACITY);
        let version = Arc::new(VersionTracker::new(bus.event_tx(), VERSION_BUMP_COALESCE));
        let restore = Arc::new(SessionRestore {
            bus_tx: bus.event_tx(),
            expected: expected.clone(),
        });
        let transport = Transport::connect(
            endpoint,
            expected,
            bus.event_tx(),
            version.epoch_handle(),
            restore.clone(),
        )
        .await?;

        // —— 订阅面（先订阅后动作：全部消费方在恢复流程前完成订阅）——
        // 事件泵：transport 事件面 → 分类 → typed bus / 帧通道
        crate::cdp::bus::spawn_event_pump(transport.subscribe_events(), bus.clone());
        // 版本驱动：推进 + ConnectionRestored → VersionReset + Lagged 自愈（U-2）
        crate::cdp::version::spawn_version_driver(bus.subscribe(), version.clone());

        // 对话框注册表（超时自动 dismiss 走 transport 发送面）
        let transport_dismiss = transport.clone();
        let dismiss_hook: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |session: &str| {
            let transport = transport_dismiss.clone();
            let session = session.to_string();
            tokio::spawn(async move {
                let _ = transport
                    .send_command(
                        PAGE_HANDLE_JAVASCRIPT_DIALOG,
                        Some(json!({ "accept": false })),
                        Some(&session),
                        ENABLE_TIMEOUT,
                    )
                    .await;
            });
        });
        let dialogs = Arc::new(DialogRegistry::new(
            crate::cdp::dialog::DIALOG_AUTO_DISMISS_TIMEOUT,
            dismiss_hook,
        ));
        {
            let dialogs = dialogs.clone();
            let mut rx = bus.subscribe();
            tokio::spawn(async move {
                while let Ok(ev) = rx.recv().await {
                    dialogs.on_event(&ev);
                }
            });
        }

        // 活动标签跟踪（current_session 依据）+ per-tab 会话路由表（P1 多标签）：
        // 同一订阅任务维护双面（SessionAttached 登记、TargetDestroyed 清理），
        // 保证活动标签与路由表视角一致
        let active: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
        let tabs: Arc<Mutex<std::collections::HashMap<String, String>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        {
            let active = active.clone();
            let tabs = tabs.clone();
            let mut rx = bus.subscribe();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(BrowserEvent::SessionAttached { target_id, session }) => {
                            *active.lock().unwrap_or_else(|p| p.into_inner()) =
                                Some((target_id.clone(), session.clone()));
                            // 首次附着者胜：主 frame 会话优先（iframe 双会话路由不顶替）
                            let mut table = tabs.lock().unwrap_or_else(|p| p.into_inner());
                            table.entry(target_id).or_insert(session);
                        }
                        Ok(BrowserEvent::TargetDestroyed { target_id }) => {
                            {
                                let mut guard = active.lock().unwrap_or_else(|p| p.into_inner());
                                if let Some((t, _)) = guard.as_ref() {
                                    if *t == target_id {
                                        *guard = None;
                                    }
                                }
                            }
                            tabs.lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .remove(&target_id);
                        }
                        // 断线：旧会话全部失效——清空路由表，恢复流程重 attach 后
                        // 由 SessionAttached 重新登记（首次附着者胜语义对新生会话
                        // 同样成立；避免陈旧会话滞留导致动作路由到死会话）
                        Ok(BrowserEvent::ConnectionLost { .. }) => {
                            tabs.lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .clear();
                        }
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            });
        }

        let sender = CommandSender::new(transport.clone(), policy);

        // —— 恢复流程：全部订阅就绪后执行（restore 事件不再丢失）——
        transport.restore_now(restore.as_ref()).await?;

        Ok(BrowserSession {
            transport,
            sender,
            bus,
            version,
            dialogs,
            active,
            tabs,
            probe: OnceLock::new(),
        })
    }

    // —— 命令面（全过统一发送层）——

    /// 发送命令并反序列化结果（§8）。
    pub async fn send<T: DeserializeOwned>(&self, cmd: Command) -> Result<T, CdpError> {
        let value = self.sender.execute(cmd).await?;
        serde_json::from_value(value).map_err(|e| CdpError::Internal {
            method: None,
            message: format!("命令结果反序列化失败：{e}"),
        })
    }

    /// 会话级快捷（§8）。
    pub async fn send_page<T: DeserializeOwned>(
        &self,
        session: &str,
        method: &str,
        params: impl serde::Serialize,
    ) -> Result<T, CdpError> {
        self.send(Command::new(method).params(params).with_session(session))
            .await
    }

    /// 会话级 no-wait 快捷（P1-A 遗留 2/2）：写入 CDP socket 即返回，不等待
    /// 响应（输入注入/高频帧面快速路径，agent-browser websocket.rs:609-615
    /// 语义）；断连/序列化失败仍报错。签名对齐 `send_page`。
    pub async fn send_page_no_wait(
        &self,
        session: &str,
        method: &str,
        params: impl serde::Serialize,
    ) -> Result<(), CdpError> {
        let cmd = Command::new(method).params(params).with_session(session);
        self.transport
            .send_command_no_wait(&cmd.method, Some(cmd.params), cmd.session_id.as_deref())
            .await
    }

    /// browser 级快捷（§8）。
    pub async fn send_browser<T: DeserializeOwned>(
        &self,
        method: &str,
        params: impl serde::Serialize,
    ) -> Result<T, CdpError> {
        self.send(Command::new(method).params(params)).await
    }

    /// 活动标签会话（SessionAttached 最新者；无则 Err(NoActiveTab)）。
    pub fn current_session(&self) -> Result<SessionRef, CdpError> {
        match self
            .active
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            Some((target_id, session)) => Ok(SessionRef {
                target_id: target_id.clone(),
                session: session.clone(),
            }),
            None => Err(CdpError::NoActiveTab),
        }
    }

    // —— P1 多标签：per-tab 会话路由面（15 文档 §7）——

    /// 按 tab_id（targetId 语义）路由到对应 CDP 会话（主 frame 会话）。
    /// 标签未 attach 或已关闭（TargetDestroyed 清理）→ None；
    /// 工具面据此返回目标过期（node_gone）语义。
    pub fn tab_session(&self, tab_id: &str) -> Option<SessionRef> {
        let table = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
        table.get(tab_id).map(|session| SessionRef {
            target_id: tab_id.to_string(),
            session: session.clone(),
        })
    }

    /// 显式切换活动标签（P1：Target.activateTarget 不产生 SessionAttached，
    /// 引擎侧活动槽必须显式更新——switch_tab 工具调用后接线）。
    /// 目标标签无会话（未 attach/已关闭）→ Err(NoSuchTab)。
    pub fn activate_tab(&self, tab_id: &str) -> Result<(), CdpError> {
        let session = self
            .tab_session(tab_id)
            .ok_or_else(|| CdpError::NoSuchTab {
                tab_id: tab_id.to_string(),
            })?;
        *self.active.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((session.target_id, session.session));
        Ok(())
    }

    // —— P1 缺陷 F2（K6 实测修复面）：new_tab 会话接线 ——

    /// 显式建立标签会话（createTarget 后的 attach + enable 接线，P1 缺陷 F2）。
    ///
    /// Chrome 151 实测：`Target.createTarget` 创建新标签后**不触发
    /// attachedToTarget 事件** → 新标签无 CDP 会话 → per-tab 快照/动作
    /// 全部 node_gone。本方法在 createTarget 后显式
    /// `Target.attachToTarget(targetId, flatten:true)` + 域 enable（对齐
    /// 恢复路径 [enable_domains] 的顺序与超时），并**确定性登记** per-tab
    /// 路由表与活动槽——不依赖事件到达时序；attachedToTarget 事件随后到达时，
    /// 事件驱动面的「首次附着者胜」语义对同一会话幂等，双路一致。
    ///
    /// 活动标签语义（工具面选择，对齐事件驱动面）：新标签**成为活动标签**——
    /// createTarget 默认聚焦新标签（background=false，工具忽略该参数），
    /// SessionAttached 驱动面亦为「最新附着者即活动」，显式登记保持一致；
    /// 因此 new_tab 后无需 switch 即可直接操作新标签。
    pub async fn attach_tab(&self, target_id: &str) -> Result<SessionRef, BrowserError> {
        let value = self
            .transport
            .send_command(
                TARGET_ATTACH_TO_TARGET,
                Some(json!({ "targetId": target_id, "flatten": true })),
                None,
                ENABLE_TIMEOUT,
            )
            .await?;
        let attach: AttachToTargetResult = serde_json::from_value(value).map_err(|e| {
            BrowserError::Internal(format!("attachToTarget 结果解析失败：{e}"))
        })?;
        enable_domains(self.transport.as_ref(), &attach.session_id)
            .await
            .map_err(|e| {
                BrowserError::Restore(format!("新标签 enable 序列失败（{target_id}）：{e}"))
            })?;
        // 确定性登记（不等事件）：路由表「首次附着者胜」+ 活动槽更新
        {
            let mut table = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
            table
                .entry(target_id.to_string())
                .or_insert_with(|| attach.session_id.clone());
        }
        *self.active.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((target_id.to_string(), attach.session_id.clone()));
        Ok(SessionRef {
            target_id: target_id.to_string(),
            session: attach.session_id,
        })
    }

    // —— 维度 13 §1.5 跨域 iframe 递归：帧级会话（U-4 二期，纯加法）——

    /// 帧级会话建立（跨域 iframe 快照采集用；OOPIF 的 targetId 即其
    /// frameId，直接 `Target.attachToTarget(flatten:true)` + enable 序列）。
    ///
    /// 与 `attach_tab` 的差异：**不登记** per-tab 路由表与活动槽——iframe
    /// 会话仅采集期使用（采集后 `detach_frame` 关闭），执行面跨 iframe 定位
    /// 由快照 `NodeRef.frame_target_id` 承载（13 §3.3；执行侧接线为遗留交接）。
    pub async fn attach_frame(&self, frame_id: &str) -> Result<SessionRef, BrowserError> {
        let value = self
            .transport
            .send_command(
                TARGET_ATTACH_TO_TARGET,
                Some(json!({ "targetId": frame_id, "flatten": true })),
                None,
                ENABLE_TIMEOUT,
            )
            .await?;
        let attach: AttachToTargetResult = serde_json::from_value(value).map_err(|e| {
            BrowserError::Internal(format!("attachToTarget(frame) 结果解析失败：{e}"))
        })?;
        enable_domains(self.transport.as_ref(), &attach.session_id)
            .await
            .map_err(|e| {
                BrowserError::Restore(format!("iframe 会话 enable 序列失败（{frame_id}）：{e}"))
            })?;
        Ok(SessionRef {
            target_id: frame_id.to_string(),
            session: attach.session_id,
        })
    }

    /// 帧级会话关闭（跨域 iframe 采集后立即 detach，避免会话泄漏；best-effort）。
    pub async fn detach_frame(&self, session: &str) -> Result<(), CdpError> {
        self.send_browser::<Value>(TARGET_DETACH_FROM_TARGET, json!({ "sessionId": session }))
            .await
            .map(|_| ())
    }

    // —— 事件面（§8）——

    /// 订阅 typed 事件（先订阅后发送可能产生事件的命令，订阅时序铁律）。
    pub fn subscribe(&self) -> broadcast::Receiver<BrowserEvent> {
        self.bus.subscribe()
    }

    /// 订阅帧流（仅维度 12 调用）。
    pub fn subscribe_frames(&self) -> tokio::sync::mpsc::Receiver<FrameChunk> {
        self.bus.subscribe_frames()
    }

    // —— 版本面（维度 13/14/15 契约，R-1 per-tab）——

    pub fn snapshot_version(&self, tab_id: &TabId) -> u64 {
        self.version.snapshot_version(tab_id)
    }

    pub fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale> {
        self.version.validate_snapshot(tab_id, version)
    }

    /// 显式推进（用户输入注入 / AI 动作执行，R-1 即时 +1）。
    pub fn bump(&self, tab_id: &TabId, reason: VersionReason) {
        self.version.bump(tab_id, reason);
    }

    /// global_epoch（跨标签失效语义）。
    pub fn epoch(&self) -> u64 {
        self.version.epoch()
    }

    /// 构建真实采集快照管理器（维度 13：CdpCollector + 版本源绑定；
    /// 引擎侧 `Arc<BrowserSession>` 后调用；预算可按 T-6 定制，
    /// `budgets.cross_origin_iframes`（U-4 二期开关）随构造传入采集器）。
    pub fn snapshot_manager(self: &Arc<Self>, budgets: crate::snapshot::BudgetConfig) -> SnapshotManager {
        SnapshotManager::new(
            self.version.clone(),
            Arc::new(crate::snapshot::collect::CdpCollector::new(
                self.clone(),
                budgets,
            )),
            budgets,
        )
    }

    // —— 探测/对话框（§8）——

    /// 能力报告（未探测时为 None；探测入口 `probe_now`）。
    pub fn capability(&self) -> Option<&CapabilityReport> {
        self.probe.get()
    }

    /// 执行能力探测并缓存（§6：连接成功后一次性 + 重连后由引擎侧重跑）。
    pub async fn probe_now(&self) -> CapabilityReport {
        if let Some(report) = self.probe.get() {
            return report.clone();
        }
        let report = crate::cdp::probe::run(&self.sender).await;
        let _ = self.probe.set(report.clone());
        report
    }

    /// 对话框应答（§7.1：仅活动未决对话框可应答）。
    pub async fn handle_dialog(
        &self,
        accept: bool,
        prompt_text: Option<&str>,
    ) -> Result<(), CdpError> {
        let session = self
            .dialogs
            .open_session()
            .ok_or(CdpError::NoActiveTab)?;
        self.dialogs
            .handle(&session, accept, prompt_text, self.transport.as_ref())
            .await
    }

    // —— 生命周期（§8）——

    /// 关闭：停止重连 supervisor + 断开 WS（急停/会话结束路径）。
    pub async fn shutdown(&self) {
        self.transport.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::bus::VersionReason;
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::sender::{
        ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, IdKey,
    };
    use std::sync::atomic::AtomicBool;

    /// 放行钩子（会话面集成测试用）。
    struct AllowHooks {
        stop: Arc<AtomicBool>,
        token: CancellationToken,
    }

    impl AllowHooks {
        fn new() -> Self {
            AllowHooks {
                stop: Arc::new(AtomicBool::new(false)),
                token: CancellationToken::new(),
            }
        }
    }

    #[async_trait]
    impl CommandPolicyHooks for AllowHooks {
        async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
            None
        }
        async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
            Ok(())
        }
        fn audit(&self, _event: BrowserAuditEvent) {}
        fn emergency_stop(&self) -> Arc<AtomicBool> {
            self.stop.clone()
        }
        fn abort_token(&self) -> CancellationToken {
            self.token.clone()
        }
    }

    /// 恢复流程所需的 mock 自动应答全表。
    fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
        vec![
            (BROWSER_GET_VERSION, MockReply::Ok(json!({
                "protocolVersion": "1.3",
                "product": "Chrome/131.0.6778.204",
                "revision": "@abc",
                "userAgent": "ua",
                "jsVersion": "13.1.71"
            }))),
            (TARGET_SET_DISCOVER_TARGETS, MockReply::Ok(json!({}))),
            (TARGET_GET_TARGETS, MockReply::Ok(json!({
                "targetInfos": [
                    { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
                ]
            }))),
            (TARGET_ATTACH_TO_TARGET, MockReply::Ok(json!({ "sessionId": "S1" }))),
            (PAGE_ENABLE, MockReply::Ok(json!({}))),
            (PAGE_SET_LIFECYCLE_EVENTS_ENABLED, MockReply::Ok(json!({}))),
            (RUNTIME_ENABLE, MockReply::Ok(json!({}))),
            (DOM_ENABLE, MockReply::Ok(json!({}))),
            (NETWORK_ENABLE, MockReply::Ok(json!({}))),
            (RUNTIME_RUN_IF_WAITING_FOR_DEBUGGER, MockReply::Ok(json!({}))),
            (RUNTIME_EVALUATE, MockReply::Ok(json!({ "result": { "value": 1 } }))),
            (PAGE_SET_WINDOW_OPEN_HANDLER, MockReply::Ok(json!({}))),
            (PAGE_HANDLE_JAVASCRIPT_DIALOG, MockReply::Ok(json!({}))),
        ]
    }

    /// 等指定事件到达（订阅时序铁律下的轮询辅助）。
    async fn wait_for(
        rx: &mut tokio::sync::broadcast::Receiver<BrowserEvent>,
        cond: impl Fn(&BrowserEvent) -> bool,
    ) -> BrowserEvent {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            if let Ok(ev) = rx.try_recv() {
                if cond(&ev) {
                    return ev;
                }
            }
            if tokio::time::Instant::now() > deadline {
                panic!("等待事件超时");
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// 会话面集成冒烟：建连 → 恢复 → 命令往返 → 版本推进 → 对话框状态机。
    #[tokio::test]
    async fn session_connect_and_send_smoke() {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }

        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/session".to_string(),
        };
        let session = BrowserSession::connect(
            endpoint,
            ExpectedBrowser {
                product_prefix: Some("Chrome/".to_string()),
                min_major: None,
            },
            Arc::new(AllowHooks::new()),
        )
        .await
        .expect("建连失败");

        // 先订阅后动作
        let mut rx = session.subscribe();

        // 恢复流程已执行：attach 出的会话为活动标签
        assert!(
            session.current_session().is_err(),
            "未收到 SessionAttached 前不应有活动标签"
        );

        // 注入会话附着 + 导航事件（模拟 Chrome 事件流）
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S1",
                "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
            }),
            None,
        );
        mock.send_event(
            "Page.frameNavigated",
            json!({ "frame": { "id": "F1", "url": "https://a.example", "parentId": null } }),
            Some("S1"),
        );

        // 活动标签就绪（S1/T1）
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while session.current_session().is_err() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let current = session.current_session().expect("应有活动标签");
        assert_eq!(current.session, "S1");
        assert_eq!(current.target_id, "T1");

        // 版本：导航事件 → T1 推进 +1；VersionAdvanced 广播（per-tab）
        let advanced = wait_for(&mut rx, |ev| {
            matches!(ev, BrowserEvent::VersionAdvanced { tab_id, to: 1, .. } if tab_id == "T1")
        })
        .await;
        assert!(matches!(
            advanced,
            BrowserEvent::VersionAdvanced { tab_id, .. } if tab_id == "T1"
        ));

        // 显式推进 + 校验（R-1 契约）
        session.bump(&"T1".to_string(), VersionReason::ActionDone);
        assert_eq!(session.snapshot_version(&"T1".to_string()), 2);
        assert!(session.validate_snapshot(&"T1".to_string(), 1).is_err());

        // 命令往返（经统一发送层）
        mock.set_auto_reply("Browser.getVersion", MockReply::Ok(json!({
            "protocolVersion": "1.3",
            "product": "Chrome/131.0.6778.204",
            "revision": "@abc",
            "userAgent": "ua",
            "jsVersion": "13.1.71"
        })));
        let ver: Value = session
            .send_browser::<Value>("Browser.getVersion", json!({}))
            .await
            .expect("browser 级命令失败");
        assert_eq!(ver["product"], "Chrome/131.0.6778.204");

        // 对话框：注入 opening → 状态机 Open → 应答 → 收敛；版本恒推进
        mock.send_event(
            "Page.javascriptDialogOpening",
            json!({ "url": "https://a.example", "message": "hello", "type": "alert" }),
            Some("S1"),
        );
        wait_for(&mut rx, |ev| matches!(ev, BrowserEvent::DialogOpened(_))).await;
        // 等版本驱动处理 DialogOpened 推进（to:3，恒推进语义）
        wait_for(&mut rx, |ev| {
            matches!(ev, BrowserEvent::VersionAdvanced { tab_id, to: 3, .. } if tab_id == "T1")
        })
        .await;
        session
            .handle_dialog(true, None)
            .await
            .expect("对话框应答失败");
        mock.send_event("Page.javascriptDialogClosed", json!({ "result": true }), Some("S1"));
        // DialogClosed 恒推进（to:4）
        wait_for(&mut rx, |ev| {
            matches!(ev, BrowserEvent::VersionAdvanced { tab_id, to: 4, .. } if tab_id == "T1")
        })
        .await;
        assert_eq!(
            session.snapshot_version(&"T1".to_string()),
            4,
            "对话框出现/关闭应恒推进版本"
        );

        session.shutdown().await;
    }

    /// P1-A 遗留 2/2：send_page_no_wait 不等待响应——mock 不回包（Silent）时
    /// 命令写入 socket 后立即返回 Ok（对比 send_page 会挂到超时/取消）。
    #[tokio::test]
    async fn session_send_page_no_wait_returns_without_reply() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/no-wait".to_string(),
        };
        let session = BrowserSession::connect(
            endpoint,
            ExpectedBrowser::default(),
            Arc::new(AllowHooks::new()),
        )
        .await
        .expect("建连失败");
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S1",
                "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" },
                "waitingForDebugger": false,
            }),
            None,
        );
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while session.current_session().is_err() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        session.current_session().expect("应有活动标签");

        // 目标方法改不回包：no-wait 必须立即返回（不等响应）
        mock.set_auto_reply("Runtime.evaluate", MockReply::Silent);
        let started = tokio::time::Instant::now();
        session
            .send_page_no_wait("S1", "Runtime.evaluate", json!({ "expression": "1" }))
            .await
            .expect("no-wait 写入不应失败");
        assert!(
            started.elapsed() < std::time::Duration::from_millis(500),
            "no-wait 必须不等响应（实际 {:?}）",
            started.elapsed()
        );
        // 命令确已写入 wire
        let cmd = mock.expect_command("Runtime.evaluate").await;
        assert_eq!(cmd["params"]["expression"], "1");
        assert_eq!(cmd["sessionId"], "S1");

        session.shutdown().await;
    }

    /// P1 多标签会话路由（15 §7）：SessionAttached 登记 per-tab 路由表、
    /// 首次附着者胜（iframe 不顶替）、activate_tab 显式切换活动标签、
    /// TargetDestroyed 清理路由与活动槽。
    #[tokio::test]
    async fn session_per_tab_routing_lifecycle() {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/per-tab".to_string(),
        };
        let session = BrowserSession::connect(
            endpoint,
            ExpectedBrowser::default(),
            Arc::new(AllowHooks::new()),
        )
        .await
        .expect("建连失败");

        // 注入双标签附着（T1 主会话 S1、T2 主会话 S2）
        for (target_id, sess) in [("T1", "S1"), ("T2", "S2")] {
            mock.send_event(
                "Target.attachedToTarget",
                json!({
                    "sessionId": sess,
                    "targetInfo": { "targetId": target_id, "type": "page", "title": "", "url": "about:blank" },
                    "waitingForDebugger": false,
                }),
                None,
            );
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while session.tab_session("T1").is_none() || session.tab_session("T2").is_none() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "双标签路由未就绪"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // 未附着/已销毁标签 → None（目标过期语义）
        assert!(session.tab_session("T3").is_none(), "未附着标签不得路由");

        // iframe 双会话路由保护：T1 的 iframe 会话不顶替主会话
        // （先订阅后注入，订阅时序铁律）
        let mut iframe_rx = session.subscribe();
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S1-iframe",
                "targetInfo": { "targetId": "T1", "type": "iframe", "title": "", "url": "about:blank" },
                "waitingForDebugger": false,
            }),
            None,
        );
        // 异步事件处理：等待 iframe 附着事件落表后再断言主会话未被顶替
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut saw_iframe = false;
        while tokio::time::Instant::now() < deadline {
            if let Ok(ev) = tokio::time::timeout(
                std::time::Duration::from_millis(50),
                iframe_rx.recv(),
            )
            .await
            {
                if matches!(ev, Ok(BrowserEvent::SessionAttached { session, .. }) if session == "S1-iframe")
                {
                    saw_iframe = true;
                    break;
                }
            }
        }
        assert!(saw_iframe, "iframe 附着事件应到达");
        let t1 = session.tab_session("T1").expect("T1 应可路由");
        assert_eq!(t1.session, "S1", "iframe 会话不得顶替主 frame 会话（首次附着者胜）");

        // activate_tab：显式切换活动标签（activateTarget 无 SessionAttached）
        session.activate_tab("T2").expect("切换 T2 应成功");
        let current = session.current_session().expect("活动标签应为 T2");
        assert_eq!(current.target_id, "T2");
        assert_eq!(current.session, "S2");
        // 未附着目标 → NoSuchTab（工具面映射 node_gone）
        assert!(matches!(
            session.activate_tab("T9"),
            Err(CdpError::NoSuchTab { .. })
        ));

        // TargetDestroyed：清理路由表 + 活动槽（T2 为活动标签 → 一并清空）
        mock.send_event("Target.targetDestroyed", json!({ "targetId": "T2" }), None);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while session.tab_session("T2").is_some() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "T2 路由表应在 TargetDestroyed 后清理"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(session.tab_session("T2").is_none(), "T2 路由已清理");
        assert!(session.tab_session("T1").is_some(), "T1 不受 T2 关闭影响");
        assert!(
            session.current_session().is_err(),
            "活动标签销毁后 current_session 应无会话"
        );

        session.shutdown().await;
    }

    /// P1 缺陷 F2（K6 实测修复面）：attach_tab（createTarget 后的显式
    /// attach + enable 接线）——attachToTarget(flatten) 响应解析、enable 序列
    /// 顺序与恢复路径一致（Page/Runtime/DOM/Network + runIfWaitingForDebugger）、
    /// 确定性登记路由表与活动槽（不等 attachedToTarget 事件）、返回 SessionRef
    /// 立即可路由。
    #[tokio::test]
    async fn session_attach_tab_registers_routing_and_active() {
        let mut mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/attach-tab".to_string(),
        };
        let session = BrowserSession::connect(
            endpoint,
            ExpectedBrowser::default(),
            Arc::new(AllowHooks::new()),
        )
        .await
        .expect("建连失败");

        // 新标签专用会话（区别于恢复路径 attach 的 S1）
        mock.set_auto_reply("Target.attachToTarget", MockReply::Ok(json!({ "sessionId": "S9" })));
        let attached = session
            .attach_tab("T9")
            .await
            .expect("attach_tab 应成功");
        assert_eq!(attached.target_id, "T9");
        assert_eq!(attached.session, "S9");

        // 命令序列（wire FIFO）：跳过恢复流程命令（getVersion/重扫/恢复 attach/
        // enable 等），定位 attach_tab 的 attachToTarget(T9) → 5 域 enable →
        // resume（enable 均绑定新标签会话 S9，顺序对齐恢复路径）
        let attach_cmd = loop {
            let cmd = mock.next_command().await;
            if cmd["method"] == "Target.attachToTarget"
                && cmd["params"]["targetId"] == "T9"
            {
                break cmd;
            }
        };
        assert_eq!(attach_cmd["params"]["flatten"], true);
        for expected in [
            "Page.enable",
            "Page.setLifecycleEventsEnabled",
            "Runtime.enable",
            "DOM.enable",
            "Network.enable",
        ] {
            let cmd = mock.next_command().await;
            assert_eq!(cmd["method"], expected, "enable 序列顺序应恢复路径一致");
            assert_eq!(cmd["sessionId"], "S9", "{expected} 应绑定新标签会话");
        }
        let cmd = mock.next_command().await;
        assert_eq!(cmd["method"], "Runtime.runIfWaitingForDebugger");

        // 确定性登记（未注入 attachedToTarget 事件即可路由 + 活动）
        let routed = session.tab_session("T9").expect("T9 应可路由");
        assert_eq!(routed.session, "S9");
        let current = session.current_session().expect("新标签应为活动标签");
        assert_eq!(current.target_id, "T9");
        assert_eq!(current.session, "S9");

        // 事件随后到达时幂等（首次附着者胜语义：路由表不被顶替）
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S9",
                "targetInfo": { "targetId": "T9", "type": "page", "title": "", "url": "about:blank" },
                "waitingForDebugger": false,
            }),
            None,
        );
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while session.current_session().is_err() {
            assert!(tokio::time::Instant::now() < deadline, "活动标签应保持");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            session.tab_session("T9").map(|r| r.session).as_deref(),
            Some("S9"),
            "事件驱动登记与显式登记必须同会话（首次附着者胜幂等）"
        );

        session.shutdown().await;
    }

    /// 断线重连：ConnectionLost 清空路由表（旧会话全部失效），恢复流程重 attach
    /// 后由 SessionAttached 重新登记——陈旧会话不得滞留导致动作路由到死会话。
    #[tokio::test]
    async fn session_routing_refreshed_after_disconnect() {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        let endpoint = CdpEndpoint {
            port: mock.addr.port(),
            ws_path: "/devtools/browser/reconnect-routing".to_string(),
        };
        let session = BrowserSession::connect(
            endpoint,
            ExpectedBrowser::default(),
            Arc::new(AllowHooks::new()),
        )
        .await
        .expect("建连失败");
        // 注入双标签附着（T1/S1、T2/S2）
        for (target_id, sess) in [("T1", "S1"), ("T2", "S2")] {
            mock.send_event(
                "Target.attachedToTarget",
                json!({
                    "sessionId": sess,
                    "targetInfo": { "targetId": target_id, "type": "page", "title": "", "url": "about:blank" },
                    "waitingForDebugger": false,
                }),
                None,
            );
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while session.tab_session("T1").is_none() || session.tab_session("T2").is_none() {
            assert!(tokio::time::Instant::now() < deadline, "双标签路由未就绪");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            session.tab_session("T2").map(|r| r.session).as_deref(),
            Some("S2")
        );

        // 强制断线：transport 监督器广播 ConnectionLost → 路由表清空
        // （T2 不被恢复流程重 attach，是「陈旧会话被清除」的判别标签）
        let mut conn_rx = session.subscribe();
        mock.close_connection();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut saw_lost = false;
        let mut saw_restored = false;
        while tokio::time::Instant::now() < deadline {
            if saw_lost && saw_restored {
                break;
            }
            if let Ok(ev) = tokio::time::timeout(
                std::time::Duration::from_millis(50),
                conn_rx.recv(),
            )
            .await
            {
                match ev {
                    Ok(BrowserEvent::ConnectionLost { .. }) => saw_lost = true,
                    Ok(BrowserEvent::ConnectionRestored { .. }) => saw_restored = true,
                    _ => {}
                }
            }
        }
        assert!(saw_lost, "应广播 ConnectionLost");
        assert!(saw_restored, "重连恢复应完成（ConnectionRestored）");
        assert!(
            session.tab_session("T2").is_none(),
            "断线后陈旧会话必须被清除（重连恢复流程不重 attach T2）"
        );

        // 恢复流程重 attach（真实浏览器在 restore 期间重发 attachedToTarget；
        // mock 不合成事件，此处手动注入模拟）→ 路由表以新会话重新登记
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S1-new",
                "targetInfo": { "targetId": "T1", "type": "page", "title": "", "url": "about:blank" },
                "waitingForDebugger": false,
            }),
            None,
        );
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut t1_session = None;
        while tokio::time::Instant::now() < deadline {
            if let Some(r) = session.tab_session("T1") {
                t1_session = Some(r.session);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(
            t1_session.as_deref(),
            Some("S1-new"),
            "恢复后 T1 应重新路由到新会话（陈旧会话不得残留）"
        );

        session.shutdown().await;
    }
}
