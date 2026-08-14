//! 电脑操作会话槽（06 遗留⑨：ComputerSlot 命令面托管 + 工具装配接线面）
//!
//! ## 定位
//! 软件内 AI 协同浏览器的电脑操作会话槽：**进程级单例**（main.rs ⑧e 装配段
//! `app.manage(Arc<ComputerSlot>)`），承载 04 §4 安全门槛四件套与命令面：
//! - [`ComputerSlot`]：会话级显式开启（[`SessionEnablement`]）+ 会话互斥门
//!   （[`ActivationGate`]，S3）+ 全动作审批门（[`ApprovalGate`]，04 §4.2）+
//!   三级急停旗（[`EmergencyStop`]，04 §4.3），并经
//!   [register_computer_tools] 后置注册 13 个 `computer_*` 工具（06 文档 §3.1）；
//! - [`LocalDbComputerMetaStore`]：session_meta `computer_use_enabled` 键读写
//!   （键名常量 `conex_computer::security::COMPUTER_USE_ENABLED_KEY`，04 §4.1
//!   持久化范式对齐 conex-types/src/timer.rs:43 的 session_meta 键约定）；
//! - 状态事件：`computer://state-changed`（payload `{ enabled?, mode?, reason? }`，
//!   前端契约 computerSessionApi.ts；由 [ActivationGate] 状态迁移与开启/停用
//!   /急停广播）。
//!
//! ## 挂载判据（06 文档 §3.1 / security.rs `tool_mount_allowed`）
//! 未开启（或未注入判据）→ [ComputerSlot::register_tools] 零注册返回 Ok——
//! `computer_*` 工具不存在，模型侧 tool schema 亦不含（04 §4.1 第 3 点，
//! 安全默认）。注册数由 conex-computer-tools 的注册数断言测试守护。
//!
//! ## 接线点登记（main.rs 装配注释指向本模块头）
//! - **接线点①（engine.rs 并行在途）**：engine 增 `computer_slot` 字段/装配/
//!   访问器后，main.rs ⑧e 托管改为 `core_state.engine().computer_slot()` 取用
//!   同一实例——命令访问面（`State<Arc<ComputerSlot>>`）不变；
//! - **接线点②（工具装配）**：[ComputerSlot::register_tools] 为
//!   `register_computer_tools` 后置注册入口（守卫注入：enablement/activation/
//!   approval/stop 四件套 + 真实会话注入面 [ComputerSlot::set_session]）；
//! - **接线点③（浏览器互斥共享）**：[ComputerSlot::activation] 返回共享互斥门
//!   实例——浏览器线 `browser_*` 工具面与启动命令经同一门做
//!   `request_browser` / 互斥守卫（18 §6.3 两向生效）。
//!
//! ## 惰性恢复（04 §4.1 第 2 点）
//! 构造不读库；首次访问（status / enable / disable / estop / register_tools）时
//! 经 [ComputerSlot::ensure_restored] 从 session_meta 恢复开启态（
//! `restore_from_session_meta`，幂等一次性）。恢复为开启 → 同步请求桌面激活
//! （重启后互斥门处于 Idle，可成功；若被浏览器占用则保持开启态、工具被互斥
//! 守卫 gating，由用户在面板切换）。
//!
//! ## 急停语义（04 §4.3）
//! [ComputerSlot::estop] = 面板急停按钮（StopSource::Panel）→ 置全局急停旗
//! （在途注入批次自查 / 审批门拒绝放行）→ 释放互斥门回 Idle → 停用开启态
//! 并落盘。旗复位（[EmergencyStop::reset]）留待引擎侧清理完成后调用（接线点②
//! 责任面），命令面不自行复位。

use crate::core_event_bridge::Emitter;
#[cfg(test)]
use agent_tools::definition::ToolError;
#[cfg(test)]
use agent_tools::registry::ToolRegistry;
use conex_computer::activation::{ActivationError, ActivationGate, SessionMode};
use conex_computer::security::COMPUTER_USE_ENABLED_KEY;
use conex_computer::{ApprovalGate, EmergencyStop, EnableSource, EnablementError, SessionEnablement};
use conex_computer_tools::session::ComputerOps;
#[cfg(test)]
use conex_computer_tools::{register_computer_tools, ComputerToolsConfig};
use conex_db::LocalDb;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 状态事件名（前端契约：computerSessionApi.ts `COMPUTER_STATE_EVENT`）。
pub(crate) const COMPUTER_STATE_EVENT: &str = "computer://state-changed";

/// 激活模式 → 前端契约串（'idle'|'browser'|'desktop'，06 文档 §3.4 语义：
/// 与前端 ComputerActivation 联合类型逐字对齐，非 SessionMode 的 serde 名）。
fn mode_str(mode: SessionMode) -> &'static str {
    match mode {
        SessionMode::Idle => "idle",
        SessionMode::BrowserActive => "browser",
        SessionMode::DesktopActive => "desktop",
    }
}

/// enable / disable 命令返回载荷（契约：`{ enabled: boolean }`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SessionPayload {
    pub enabled: bool,
}

/// estop 命令返回载荷（契约：`{ stopped: true }`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct EstopPayload {
    pub stopped: bool,
}

/// status 命令返回载荷（契约：`{ enabled, mode, reason? }`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct StatusPayload {
    pub enabled: bool,
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 状态事件载荷（`computer://state-changed`；字段可选——事件只携带变更域，
/// 前端兼容解析，computerSessionApi.ts `ComputerStateEventPayload`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct StateChangePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 命令面结构化错误（06 文档 §5 码表消费面；命令层映射为
/// `tool.session.exclusive:<...>` / `tool.computer.not_ready:<...>`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ComputerError {
    /// 会话互斥（浏览器活跃）：跨线共享码 `tool.session.exclusive`（18 §6.3）。
    Exclusive { current: SessionMode },
    /// session_meta 持久化失败：`tool.computer.not_ready`（对齐 browser 的
    /// not_ready gating 语义）。
    Persist(String),
}

impl ComputerError {
    /// 映射为命令面错误串（结构化码前缀，前端按码路由提示）。
    pub(crate) fn as_command_err(&self) -> String {
        match self {
            ComputerError::Exclusive { current } => format!(
                "tool.session.exclusive: 会话互斥：当前{current}，无法激活电脑操作会话（浏览器活跃中，请先停止浏览器会话）"
            ),
            ComputerError::Persist(reason) => {
                format!("tool.computer.not_ready: 电脑操作状态持久化失败：{reason}")
            }
        }
    }
}

/// session_meta 持久化适配（`computer_use_enabled` 键读写；04 §4.1）。
pub(crate) trait ComputerMetaStore: Send + Sync {
    /// 读取开启标记（缺键/非 true 文本 = 未开启；读失败 → Err）
    fn load_enabled(&self) -> Result<bool, String>;
    /// 落盘开启标记（"true"/"false" 文本，幂等 upsert）
    fn persist_enabled(&self, enabled: bool) -> Result<(), String>;
}

/// 真实存储适配（LocalDb session_meta 表）。
pub(crate) struct LocalDbComputerMetaStore {
    db: LocalDb,
}

impl LocalDbComputerMetaStore {
    /// 用本地库构造（main.rs ⑧e 装配传入 `shared_db.local_db()`）。
    pub(crate) fn new(db: LocalDb) -> Self {
        Self { db }
    }
}

impl ComputerMetaStore for LocalDbComputerMetaStore {
    fn load_enabled(&self) -> Result<bool, String> {
        match self.db.get_session_meta(COMPUTER_USE_ENABLED_KEY) {
            Ok(Some(value)) => Ok(value.trim() == "true"),
            Ok(None) => Ok(false),
            Err(e) => Err(format!("{}: {}", e.kind, e.message)),
        }
    }

    fn persist_enabled(&self, enabled: bool) -> Result<(), String> {
        let value = if enabled { "true" } else { "false" };
        self.db
            .set_session_meta(COMPUTER_USE_ENABLED_KEY, value)
            .map_err(|e| format!("{}: {}", e.kind, e.message))
    }
}

/// 电脑操作会话槽（进程级单例；命令面 + 工具装配接线面）。
///
/// 并发纪律：全部守卫为原子/锁内同步操作（无跨 await 持锁面），
/// 方法可经 `Arc` 跨线程共享；事件发射为尽力而为（发射器缺失时静默跳过）。
pub(crate) struct ComputerSlot {
    /// session_meta 持久化适配（`computer_use_enabled` 键读写）
    meta: Arc<dyn ComputerMetaStore>,
    /// 会话级显式开启状态机（04 §4.1；新会话默认关闭，未开启零注册）
    enablement: Arc<SessionEnablement>,
    /// 会话互斥门（S3：与浏览器共享，两向生效；桌面态 = 本会话活跃）
    activation: Arc<ActivationGate>,
    /// 全动作审批门（04 §4.2；工具注册配置注入 + 引擎审批传输面）
    _approval: Arc<ApprovalGate>,
    /// 三级急停旗（04 §4.3；面板/热键/全局共用同一旗）
    stop: Arc<EmergencyStop>,
    /// 真实会话注入面（接线点② engine 注入 RealComputerSession；未注入时
    /// 工具面 not_ready——守卫① 语义）
    _session: Mutex<Option<Arc<dyn ComputerOps>>>,
    /// 惰性恢复完成标志（幂等一次性；构造不读库）
    restored: AtomicBool,
    /// 事件发射器（`computer://state-changed`；挂接幂等，可重复 attach）
    emitter: Mutex<Option<Arc<dyn Emitter>>>,
}

impl ComputerSlot {
    /// 构造会话槽（main.rs ⑧e 装配；惰性恢复，构造不读库）。
    pub(crate) fn new(meta: Arc<LocalDbComputerMetaStore>) -> Self {
        Self::from_store(meta)
    }

    /// 构造会话槽（自定义存储适配：测试注入 / 引擎自定义持久化面）。
    pub(crate) fn from_store(meta: Arc<dyn ComputerMetaStore>) -> Self {
        Self {
            meta,
            enablement: Arc::new(SessionEnablement::new()),
            activation: Arc::new(ActivationGate::new()),
            _approval: Arc::new(ApprovalGate::new()),
            stop: Arc::new(EmergencyStop::new()),
            _session: Mutex::new(None),
            restored: AtomicBool::new(false),
            emitter: Mutex::new(None),
        }
    }

    /// 挂接状态事件发射器（幂等：重复挂接覆盖旧值；main.rs ⑧e 与命令面
    /// 启动前即挂订阅，enable/disable/estop 不丢事件）。
    pub(crate) fn attach_emitter(&self, emitter: Arc<dyn Emitter>) {
        *self.emitter.lock().unwrap_or_else(|e| e.into_inner()) = Some(emitter);
    }

    /// 会话互斥门共享实例（接线点③：浏览器线经同一门做互斥守卫）。
    #[cfg(test)]
    pub(crate) fn activation(&self) -> Arc<ActivationGate> {
        Arc::clone(&self.activation)
    }

    /// 开启状态机实例（引擎侧审计 / 工具装配判据消费面）。
    #[cfg(test)]
    pub(crate) fn enablement(&self) -> Arc<SessionEnablement> {
        Arc::clone(&self.enablement)
    }

    /// 审批门实例（引擎侧审批传输面：AskDecision 映射 → `settle` 收口）。
    #[cfg(test)]
    pub(crate) fn approval(&self) -> Arc<ApprovalGate> {
        Arc::clone(&self._approval)
    }

    /// 急停旗实例（引擎侧急停链接线：热键/全局触发源共享同一旗）。
    #[cfg(test)]
    pub(crate) fn stop(&self) -> Arc<EmergencyStop> {
        Arc::clone(&self.stop)
    }

    /// 注入真实会话（接线点②：engine 装配 `RealComputerSession`；
    /// 未注入时工具面 `tool.computer.not_ready`——守卫①）。
    #[cfg(test)]
    pub(crate) fn set_session(&self, session: Arc<dyn ComputerOps>) {
        *self._session.lock().unwrap_or_else(|e| e.into_inner()) = Some(session);
    }

    /// 惰性恢复：首次访问从 session_meta 恢复开启态（幂等一次性；构造不读库）。
    /// 恢复为开启 → 同步请求桌面激活（重启后互斥门 Idle 可成功；被浏览器
    /// 占用时保持开启态，工具被互斥守卫 gating）。
    fn ensure_restored(&self) {
        if self.restored.swap(true, Ordering::SeqCst) {
            return;
        }
        let enabled = self.meta.load_enabled().unwrap_or_else(|e| {
            tracing::warn!(
                target: "computer",
                error = %e,
                "session_meta 电脑操作状态恢复失败，按未开启安全默认"
            );
            false
        });
        self.enablement.restore_from_session_meta(enabled);
        if enabled {
            let _ = self.activation.request_desktop();
            self.emit(&StateChangePayload {
                enabled: Some(enabled),
                mode: Some(mode_str(self.activation.current())),
                reason: None,
            });
        }
    }

    /// 显式开启（04 §4.1：仅用户显式操作；Agent 无权自开）。
    ///
    /// 流程：互斥检查（浏览器活跃 → `tool.session.exclusive`，硬约束在
    /// 一切状态变更之前）→ 开启状态机（重复开启按幂等吸收，严格状态机
    /// 语义仍在引擎侧可见）→ session_meta 落盘 `computer_use_enabled=true`
    /// → `computer://state-changed` 广播。
    pub(crate) fn enable(&self) -> Result<(), ComputerError> {
        self.ensure_restored();
        self.activation
            .request_desktop()
            .map_err(|e| match e {
                ActivationError::Exclusive { current, .. } => {
                    ComputerError::Exclusive { current }
                }
            })?;
        match self.enablement.enable(EnableSource::User) {
            Ok(()) => {}
            Err(EnablementError::AlreadyEnabled) => {
                tracing::warn!(
                    target: "computer",
                    "电脑操作重复开启（命令面按幂等吸收，状态机仍严格）"
                );
            }
            Err(EnablementError::NotEnabled) => {
                tracing::warn!(
                    target: "computer",
                    "电脑操作开启异常：NotEnabled"
                );
            }
        }
        self.persist(true)?;
        self.emit(&StateChangePayload {
            enabled: Some(true),
            mode: Some("desktop"),
            reason: None,
        });
        Ok(())
    }

    /// 停用（04 §4.1 解除授权；幂等——未开启时停用仅落盘关闭态）。
    ///
    /// 释放互斥门（仅本会话活跃时；浏览器活跃时不动浏览器状态）→ 关闭
    /// 状态机（原因登记）→ 落盘 `computer_use_enabled=false` → 广播。
    pub(crate) fn disable(&self, reason: Option<String>) -> Result<(), ComputerError> {
        self.ensure_restored();
        let was_active = self.activation.current().is_desktop();
        if was_active {
            self.activation.release();
        }
        self.enablement.disable(reason.clone().unwrap_or_else(|| "用户停用".to_string()));
        self.persist(false)?;
        self.emit(&StateChangePayload {
            enabled: Some(false),
            mode: Some(mode_str(self.activation.current())),
            reason,
        });
        Ok(())
    }

    /// 全局急停（04 §4.3 ③ 面板急停按钮 → 同一吊销链）。
    ///
    /// 置急停旗（Panel 源；在途注入批次自查 / 审批门拒绝放行）→ 释放互斥
    /// 门回 Idle → 停用开启态并落盘（恢复需重新显式开启）→ 广播。
    /// 旗复位（[EmergencyStop::reset]）由引擎侧清理完成后调用（接线点②）。
    pub(crate) fn estop(&self, reason: Option<String>) -> Result<(), ComputerError> {
        self.ensure_restored();
        self.stop.panel_stop();
        let was_active = self.activation.current().is_desktop();
        if was_active {
            self.activation.release();
        }
        self.enablement.disable(reason.clone().unwrap_or_else(|| "面板急停".to_string()));
        self.persist(false)?;
        self.emit(&StateChangePayload {
            enabled: Some(false),
            mode: Some(mode_str(self.activation.current())),
            reason,
        });
        Ok(())
    }

    /// 状态查询（挂载恢复 / 诊断面；触发惰性恢复）。
    pub(crate) fn status(&self) -> StatusPayload {
        self.ensure_restored();
        StatusPayload {
            enabled: self.enablement.enabled(),
            mode: mode_str(self.activation.current()),
            reason: self.enablement.disabled_reason(),
        }
    }

    /// 后置注册 `computer_*` 工具族（接线点② engine 装配入口）。
    ///
    /// 挂载判据：`SessionEnablement::tool_mount_allowed()` 为真才注册；
    /// 未开启 / 未注入 → **零注册返回 Ok**（安全默认，工具不存在）。
    /// 幂等：同名已注册跳过不报冲突（06 文档 §3.2）。
    #[cfg(test)]
    pub(crate) fn register_tools(&self, registry: &mut ToolRegistry) -> Result<(), ToolError> {
        self.ensure_restored();
        register_computer_tools(
            registry,
            ComputerToolsConfig {
                session: self._session.lock().unwrap_or_else(|e| e.into_inner()).clone(),
                enablement: Some(Arc::clone(&self.enablement)),
                activation: Some(Arc::clone(&self.activation)),
                approval: Some(Arc::clone(&self._approval)),
                stop: Some(Arc::clone(&self.stop)),
            },
        )
    }

    /// session_meta 落盘（失败 → not_ready 语义；内存态已变更不回滚——
    /// 重启回退关闭态为安全默认，命令层可见错误提示）。
    fn persist(&self, enabled: bool) -> Result<(), ComputerError> {
        self.meta
            .persist_enabled(enabled)
            .map_err(ComputerError::Persist)
    }

    /// 广播状态事件（尽力而为：序列化失败仅记录，发射器缺失静默跳过）。
    fn emit(&self, payload: &StateChangePayload) {
        let emitter = self.emitter.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(emitter) = emitter else { return };
        let json = serde_json::to_string(payload).unwrap_or_else(|e| {
            tracing::warn!(
                target: "computer",
                error = %e,
                "状态事件序列化失败（跳过发射）"
            );
            String::new()
        });
        if !json.is_empty() {
            emitter.emit(COMPUTER_STATE_EVENT, &json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_computer::perception::{PerceptionError, PerceptionSnapshot};
    use conex_computer::StopSource;
    use conex_computer_tools::ALL_TOOL_NAMES;

    /// 测试发射器（记录 `channel:payload`；断言状态事件契约面）。
    struct TestEmitter(Arc<Mutex<Vec<String>>>);

    impl Emitter for TestEmitter {
        fn emit(&self, _channel: &str, payload: &str) {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(payload.to_string());
        }
    }

    /// 内存库槽（真实 LocalDbComputerMetaStore 读写面）。
    fn in_memory_slot() -> (Arc<ComputerSlot>, LocalDb) {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        let slot = Arc::new(ComputerSlot::new(Arc::new(
            LocalDbComputerMetaStore::new(db.clone()),
        )));
        (slot, db)
    }

    /// 持久化失败的存储替身（命令面 not_ready 错误路径）。
    struct FailingStore;

    impl ComputerMetaStore for FailingStore {
        fn load_enabled(&self) -> Result<bool, String> {
            Ok(false)
        }
        fn persist_enabled(&self, _enabled: bool) -> Result<(), String> {
            Err("磁盘只读（测试注入）".to_string())
        }
    }

    /// 注册后按名排序清单（list_definitions 按 name 升序；与
    /// ALL_TOOL_NAMES 排序后逐项比对，防清单漂移）。
    fn registered_names(registry: &ToolRegistry) -> Vec<String> {
        let mut names: Vec<String> = registry
            .list_definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        names.sort();
        names
    }

    fn sorted_all_tool_names() -> Vec<String> {
        let mut names: Vec<String> = ALL_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
        names.sort();
        names
    }

    /// 挂载判据：新会话默认关闭 → 零注册（04 §4.1 第 3 点安全默认）。
    #[test]
    fn defaults_disabled_zero_tools_registered() {
        let (slot, _db) = in_memory_slot();
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("未开启零注册应返回 Ok");
        assert!(registered_names(&registry).is_empty(), "未开启不得挂载任何 computer_* 工具");
    }

    /// 挂载判据：显式开启后注册全部 13 工具，名称与 ALL_TOOL_NAMES 一致。
    #[test]
    fn enable_mounts_all_13_tools() {
        let (slot, _db) = in_memory_slot();
        slot.enable().expect("开启不应失败");
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("注册不应失败");
        assert_eq!(registered_names(&registry), sorted_all_tool_names());
        assert_eq!(registry.list_definitions().len(), ALL_TOOL_NAMES.len());
    }

    /// 重复注册幂等（06 文档 §3.2：同名跳过不报冲突，注册数不变）。
    #[test]
    fn register_tools_twice_is_idempotent() {
        let (slot, _db) = in_memory_slot();
        slot.enable().expect("开启不应失败");
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("首次注册不应失败");
        slot.register_tools(&mut registry).expect("重复注册应幂等返回 Ok");
        assert_eq!(registry.list_definitions().len(), ALL_TOOL_NAMES.len());
    }

    /// 惰性恢复：session_meta `computer_use_enabled=true` → 恢复开启态并
    /// 挂载 13 工具（跨实例恢复，04 §4.1 第 2 点）。
    #[test]
    fn restore_enabled_from_session_meta_mounts_all() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        db.set_session_meta(COMPUTER_USE_ENABLED_KEY, "true")
            .expect("预置开启标记");
        let slot = Arc::new(ComputerSlot::new(Arc::new(
            LocalDbComputerMetaStore::new(db),
        )));
        let status = slot.status();
        assert!(status.enabled, "恢复后应为开启态");
        assert_eq!(status.mode, "desktop", "恢复开启应同步激活桌面会话");
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("注册不应失败");
        assert_eq!(registered_names(&registry), sorted_all_tool_names());
    }

    /// 惰性恢复：`computer_use_enabled=false` → 恢复关闭态 → 零注册。
    #[test]
    fn restore_disabled_from_session_meta_mounts_zero() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        db.set_session_meta(COMPUTER_USE_ENABLED_KEY, "false")
            .expect("预置关闭标记");
        let slot = Arc::new(ComputerSlot::new(Arc::new(
            LocalDbComputerMetaStore::new(db),
        )));
        let status = slot.status();
        assert!(!status.enabled, "恢复后应为关闭态");
        assert_eq!(status.mode, "idle");
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("零注册应返回 Ok");
        assert!(registered_names(&registry).is_empty());
    }

    /// 惰性恢复：无键默认关闭（新会话默认关闭语义）。
    #[test]
    fn missing_meta_defaults_disabled_idle() {
        let (slot, _db) = in_memory_slot();
        let status = slot.status();
        assert!(!status.enabled);
        assert_eq!(status.mode, "idle");
        assert_eq!(status.reason, None, "从未开启不应有关闭原因");
    }

    /// enable：落盘 `computer_use_enabled=true` + 状态反射（enabled/mode）。
    #[test]
    fn enable_persists_true_and_status_reflects() {
        let (slot, db) = in_memory_slot();
        slot.enable().expect("开启不应失败");
        let persisted = db
            .get_session_meta(COMPUTER_USE_ENABLED_KEY)
            .expect("读库不应失败");
        assert_eq!(persisted.as_deref(), Some("true"));
        let status = slot.status();
        assert!(status.enabled);
        assert_eq!(status.mode, "desktop");
    }

    /// 重复开启幂等（命令面吸收严格状态机错误；状态保持开启）。
    #[test]
    fn enable_twice_is_idempotent() {
        let (slot, _db) = in_memory_slot();
        slot.enable().expect("首次开启不应失败");
        slot.enable().expect("重复开启应幂等返回 Ok");
        assert!(slot.status().enabled);
        assert_eq!(slot.status().mode, "desktop");
    }

    /// disable：释放互斥门回 Idle + 落盘 false + 原因登记（幂等：未开启
    /// 时停用仅落盘关闭态）。
    #[test]
    fn disable_releases_persists_and_records_reason() {
        let (slot, db) = in_memory_slot();
        slot.enable().expect("开启不应失败");
        slot.disable(Some("测试停用".to_string())).expect("停用不应失败");
        assert_eq!(
            db.get_session_meta(COMPUTER_USE_ENABLED_KEY)
                .expect("读库不应失败")
                .as_deref(),
            Some("false")
        );
        let status = slot.status();
        assert!(!status.enabled);
        assert_eq!(status.mode, "idle");
        assert_eq!(status.reason.as_deref(), Some("测试停用"));
        assert!(!slot.activation().current().is_active(), "停用后互斥门应回 Idle");
        // 幂等：未开启时再次停用不报错
        slot.disable(None).expect("重复停用应幂等返回 Ok");
    }

    /// 互斥共享（S3）：浏览器活跃时 enable 拒绝（tool.session.exclusive），
    /// 零状态变更（开启态不动、落盘键不变）——守卫在审批与状态变更之前。
    #[test]
    fn enable_rejected_when_browser_active() {
        let (slot, db) = in_memory_slot();
        slot.activation()
            .request_browser()
            .expect("浏览器激活应成功（Idle → Browser）");
        let err = slot.enable().expect_err("浏览器活跃时必须拒绝开启");
        assert_eq!(
            err,
            ComputerError::Exclusive {
                current: SessionMode::BrowserActive
            }
        );
        assert!(!slot.status().enabled, "拒绝时不得变更开启态");
        assert_eq!(slot.status().mode, "browser");
        assert_eq!(
            db.get_session_meta(COMPUTER_USE_ENABLED_KEY)
                .expect("读库不应失败"),
            None,
            "拒绝时不得落盘"
        );
        assert!(err.as_command_err().starts_with("tool.session.exclusive:"), "错误串：{}", err.as_command_err());
    }

    /// estop：置急停旗（Panel 源）→ 释放互斥门 → 落盘 false（04 §4.3）。
    #[test]
    fn estop_triggers_stop_releases_and_persists() {
        let (slot, db) = in_memory_slot();
        slot.enable().expect("开启不应失败");
        slot.estop(Some("测试急停".to_string())).expect("急停不应失败");
        assert!(slot.stop().stopped(), "急停旗必须置位");
        let records = slot.stop().records();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].source, StopSource::Panel, "面板急停按钮为 Panel 源");
        assert_eq!(
            db.get_session_meta(COMPUTER_USE_ENABLED_KEY)
                .expect("读库不应失败")
                .as_deref(),
            Some("false"),
            "急停后开启态必须落盘关闭（恢复需重新显式开启）"
        );
        let status = slot.status();
        assert!(!status.enabled);
        assert_eq!(status.mode, "idle");
        assert_eq!(status.reason.as_deref(), Some("测试急停"));
    }

    /// 状态事件广播（`computer://state-changed`）：enable/disable 各发一次，
    /// 载荷形状 `{ enabled, mode, reason? }` 与前端契约一致。
    #[test]
    fn state_changed_events_emitted_on_transitions() {
        let (slot, _db) = in_memory_slot();
        let events = Arc::new(Mutex::new(Vec::new()));
        slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&events))));
        slot.enable().expect("开启不应失败");
        slot.disable(Some("测试".to_string())).expect("停用不应失败");
        let events = events.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(events.len(), 2, "enable 与 disable 各广播一次");
        let first: serde_json::Value = serde_json::from_str(&events[0]).expect("事件 JSON");
        assert_eq!(first["enabled"], true);
        assert_eq!(first["mode"], "desktop");
        let second: serde_json::Value = serde_json::from_str(&events[1]).expect("事件 JSON");
        assert_eq!(second["enabled"], false);
        assert_eq!(second["mode"], "idle");
        assert_eq!(second["reason"], "测试");
    }

    /// 惰性恢复广播：恢复即发一次状态事件（启动前已挂订阅，面板可收）。
    #[test]
    fn restore_emits_state_changed() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        db.set_session_meta(COMPUTER_USE_ENABLED_KEY, "true")
            .expect("预置开启标记");
        let slot = Arc::new(ComputerSlot::new(Arc::new(
            LocalDbComputerMetaStore::new(db),
        )));
        let events = Arc::new(Mutex::new(Vec::new()));
        slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&events))));
        let _ = slot.status();
        let events = events.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(events.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&events[0]).expect("事件 JSON");
        assert_eq!(payload["enabled"], true);
        assert_eq!(payload["mode"], "desktop");
    }

    /// 持久化失败 → not_ready 语义（`tool.computer.not_ready:<原因>`）。
    #[test]
    fn persist_failure_maps_to_not_ready() {
        let slot = Arc::new(ComputerSlot::from_store(Arc::new(FailingStore)));
        let err = slot.enable().expect_err("落盘失败必须报错");
        assert!(matches!(err, ComputerError::Persist(_)));
        assert!(
            err.as_command_err().starts_with("tool.computer.not_ready:"),
            "错误串：{}",
            err.as_command_err()
        );
    }

    #[test]
    fn accessors_and_session_injection_smoke() {
        use async_trait::async_trait;
        let (slot, _db) = in_memory_slot();
        let act = slot.activation();
        assert_eq!(act.current(), SessionMode::Idle);
        let en = slot.enablement();
        assert!(!en.enabled());
        let _appr = slot.approval();
        let _st = slot.stop();

        struct DummyOps;
        #[async_trait]
        impl ComputerOps for DummyOps {
            fn readiness(&self) -> Result<(), String> {
                Ok(())
            }
            async fn dispatch(
                &self,
                _action: &conex_computer::Action,
            ) -> Result<conex_computer::ActionResult, conex_computer::SessionError> {
                Err(conex_computer::SessionError::Inject("dummy".into()))
            }
            async fn screenshot(
                &self,
            ) -> Result<conex_computer::CapturedFrame, conex_computer::SessionError> {
                Err(conex_computer::SessionError::Capture("dummy".into()))
            }
            async fn snapshot(
                &self,
            ) -> Result<PerceptionSnapshot, PerceptionError> {
                Err(PerceptionError::NoActiveWindow)
            }
            fn perception_version(&self) -> u64 {
                0
            }
        }
        slot.set_session(Arc::new(DummyOps));
    }
}
