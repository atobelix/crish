//! 电脑操作会话槽（06 遗留⑨：ComputerSlot 托管状态 + 工具装配接线面）
//!
//! ## 定位
//! 软件内 AI 协同浏览器的电脑操作会话槽：**进程级单例**（main.rs ⑧e 装配段
//! `app.manage(Arc<ComputerSlot>)`），承载会话级开启态与会话互斥：
//! - [`ComputerSlot`]：会话级开启态（[`SessionEnablement`]）+ 会话互斥门
//!   （[`ActivationGate`]，S3）并经
//!   `register_computer_tools` 后置注册 12 个 `computer_*` 工具（06 文档 §3.1，
//!   维度 1 收敛后 13→12，已移除 `computer_estop`，三段守卫：①会话注入+开启态合并
//!   / ②互斥 / ③停止自查）；
//! - [`LocalDbComputerMetaStore`]：session_meta `computer_use_enabled` 键读写
//!   （键名常量 `conex_computer::security::COMPUTER_USE_ENABLED_KEY`，04 §4.1
//!   持久化范式对齐 conex-types/src/timer.rs:43 的 session_meta 键约定）；
//! - 状态事件：`computer://state-changed`（payload `{ enabled?, mode?, reason? }`，
//!   前端契约 computerSessionApi.ts；由 [ActivationGate] 状态迁移与停止广播）。
//!
//! ## 命令面退役登记（2026-09-15 真漂移债务清零 · 物理切除）
//! `computer_session_enable` / `computer_session_disable` / `computer_status`
//! 三条命令及其**专属**辅助项（`SessionPayload` / `StatusPayload` /
//! `ComputerError::Exclusive` / `ComputerError::as_command_err` 与
//! [ComputerSlot] 上仅被这三条命令消费的 `new` / `enable` / `disable` / `status`）
//! 已从实现面**物理删除**——computer-panel 前端面（computerSessionApi /
//! ComputerPanel / useComputerSession）已物理删除，生产代码零消费。
//! 恢复接线时按四方登记流程重新注册并重写实现。
//!
//! ## 挂载判据（06 文档 §3.1 / security.rs `tool_mount_allowed`）
//! 未开启（或未注入判据）→ [ComputerSlot::register_tools] 零注册返回 Ok——
//! `computer_*` 工具不存在，模型侧 tool schema 亦不含（04 §4.1 第 3 点，
//! 安全默认）。注册数由 conex-computer-tools 的注册数断言测试守护。
//!
//! ## 接线点登记（main.rs 装配注释指向本模块头）
//! - **接线点①（engine.rs 并行在途）**：engine 增 `computer_slot` 字段/装配/
//!   访问器后，main.rs ⑧e 托管改为 `core_state.engine().computer_slot()` 取用
//!   同一实例；
//! - **接线点②（工具装配）**：[ComputerSlot::register_tools] 为
//!   `register_computer_tools` 后置注册入口（守卫注入：enablement/activation
//!   两件套 + 真实会话注入面 [ComputerSlot::set_session]；维度 1 收敛后三段守卫：
//!   ①会话注入+开启态合并 / ②互斥 / ③停止自查——仅查 `abort_token`）；
//! - **接线点③（浏览器互斥共享）**：[ComputerSlot::activation] 返回共享互斥门
//!   实例——浏览器线 `browser_*` 工具面与启动命令经同一门做
//!   `request_browser` / 互斥守卫（18 §6.3 两向生效）。
//!
//! ## 惰性恢复（04 §4.1 第 2 点）
//! 构造不读库；首次访问（register_tools / on_run_stopped）时
//! 经 [ComputerSlot::ensure_restored] 从 session_meta 恢复开启态（
//! `restore_from_session_meta`，幂等一次性）。恢复为开启 → 同步请求桌面激活
//! （重启后互斥门处于 Idle，可成功；若被浏览器占用则保持开启态、工具被互斥
//! 守卫 gating，由用户在面板切换）。
//!
//! ## 停止语义（维度 1 收敛后：普通停止）
//! 停止合并到 run 级 `AbortSignal`（维度 1 收敛，替代原三级急停）：
//! `spawn_computer_stop_watcher` 监听 run 级 `AbortSignal` → 触发后调
//! [ComputerSlot::on_run_stopped] 释放互斥门回 Idle → 关闭开启态并落盘 → 广播。
//! 普通停止语义，不置急停旗，不叫急停。

use crate::core_event_bridge::Emitter;
#[cfg(test)]
use agent_tools::definition::ToolError;
#[cfg(test)]
use agent_tools::registry::ToolRegistry;
use conex_computer::activation::{ActivationGate, SessionMode};
use conex_computer::security::COMPUTER_USE_ENABLED_KEY;
use conex_computer::SessionEnablement;
use conex_computer_tools::session::ComputerOps;
#[cfg(test)]
use conex_computer_tools::{register_computer_tools, ComputerToolsConfig};
use conex_db::LocalDb;
use serde::Serialize;
use session_loop::AbortSignal;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 状态事件名（前端契约：computerSessionApi.ts `COMPUTER_STATE_EVENT`）。
pub(crate) const COMPUTER_STATE_EVENT: &str = "computer://state-changed";

/// 激活模式 → 前端契约串（'idle'|'browser'|'desktop'）。
fn mode_str(mode: SessionMode) -> &'static str {
    match mode {
        SessionMode::Idle => "idle",
        SessionMode::BrowserActive => "browser",
        SessionMode::DesktopActive => "desktop",
    }
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

/// 会话槽持久化错误（06 文档 §5 码表消费面；`tool.computer.not_ready`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ComputerError {
    /// session_meta 持久化失败：`tool.computer.not_ready`（对齐 browser 的
    /// not_ready gating 语义）。
    Persist(String),
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
    /// 用本地库构造（engine_build 装配传入 `shared_db.local_db()`）。
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

/// 无库降级存储适配（进程内内存镜像；engine_build 装配 `db: None` 时启用）。
///
/// 语义对齐全应用「缺库不阻断装配」哲学（timer/wait store 的 Option 模式）：
/// 开关状态保存在进程内存中，功能完整可用、进程退出即失（无持久化镜像）。
/// 与 [SessionEnablement]（会话级内存状态机）分层：本类型是 meta 键的
/// 内存替身，不是状态机本身。
pub(crate) struct MemoryComputerMetaStore {
    enabled: AtomicBool,
}

impl Default for MemoryComputerMetaStore {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
        }
    }
}

impl ComputerMetaStore for MemoryComputerMetaStore {
    fn load_enabled(&self) -> Result<bool, String> {
        Ok(self.enabled.load(Ordering::Relaxed))
    }

    fn persist_enabled(&self, enabled: bool) -> Result<(), String> {
        self.enabled.store(enabled, Ordering::Relaxed);
        Ok(())
    }
}

/// 电脑操作会话槽（进程级单例；托管状态 + 工具装配接线面）。
///
/// 并发纪律：全部守卫为原子/锁内同步操作（无跨 await 持锁面），
/// 方法可经 `Arc` 跨线程共享；事件发射为尽力而为（发射器缺失时静默跳过）。
pub(crate) struct ComputerSlot {
    /// session_meta 持久化适配（`computer_use_enabled` 键读写）
    meta: Arc<dyn ComputerMetaStore>,
    /// 会话级开启状态机（新会话默认关闭，未开启零注册）
    enablement: Arc<SessionEnablement>,
    /// 会话互斥门（S3：与浏览器共享，两向生效；桌面态 = 本会话活跃）
    activation: Arc<ActivationGate>,
    /// 真实会话注入面（接线点② engine 注入 RealComputerSession；未注入时
    /// 工具面 not_ready——守卫① 语义）
    _session: Mutex<Option<Arc<dyn ComputerOps>>>,
    /// 惰性恢复完成标志（幂等一次性；构造不读库）
    restored: AtomicBool,
    /// 事件发射器（`computer://state-changed`；挂接幂等，可重复 attach）
    emitter: Mutex<Option<Arc<dyn Emitter>>>,
}

impl ComputerSlot {
    /// 构造会话槽（自定义存储适配：engine 装配 / 测试注入）。
    pub(crate) fn from_store(meta: Arc<dyn ComputerMetaStore>) -> Self {
        Self {
            meta,
            enablement: Arc::new(SessionEnablement::new()),
            activation: Arc::new(ActivationGate::new()),
            _session: Mutex::new(None),
            restored: AtomicBool::new(false),
            emitter: Mutex::new(None),
        }
    }

    /// 挂接状态事件发射器（幂等：重复挂接覆盖旧值；main.rs ⑧e 在
    /// 恢复/停止转换前即挂订阅，状态事件不丢）。
    pub(crate) fn attach_emitter(&self, emitter: Arc<dyn Emitter>) {
        *self.emitter.lock().unwrap_or_else(|e| {
            tracing::error!(target: "computer", "emitter 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        }) = Some(emitter);
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

    /// 注入真实会话（接线点②：engine 装配 `RealComputerSession`；
    /// 未注入时工具面 `tool.computer.not_ready`——守卫①）。
    #[cfg(test)]
    pub(crate) fn set_session(&self, session: Arc<dyn ComputerOps>) {
        *self._session.lock().unwrap_or_else(|e| {
            tracing::error!(target: "computer", "computer session 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        }) = Some(session);
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

    /// run 级停止桥接（维度 1 收敛：替代原 estop，普通停止语义）。
    ///
    /// 由 [spawn_computer_stop_watcher] 在 run 级 abort_signal 触发后调用：
    /// 释放互斥门（若 desktop 活跃）→ 关闭开启态并落盘 → 广播。
    /// 不置急停旗（EmergencyStop 已删除），不叫急停（普通停止语义）。
    pub(crate) fn on_run_stopped(&self) {
        self.ensure_restored();
        let was_active = self.activation.current().is_desktop();
        if was_active {
            self.activation.release();
        }
        self.enablement.disable("run 级停止");
        let _ = self.persist(false);
        self.emit(&StateChangePayload {
            enabled: Some(false),
            mode: Some(mode_str(self.activation.current())),
            reason: Some("run 级停止".to_string()),
        });
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
                session: self
                    ._session
                    .lock()
                    .unwrap_or_else(|e| {
                        tracing::error!(target: "computer", "computer session 锁中毒，按恢复模式继续：{e}");
                        e.into_inner()
                    })
                    .clone(),
                enablement: Some(Arc::clone(&self.enablement)),
                activation: Some(Arc::clone(&self.activation)),
            },
        )
    }

    /// session_meta 落盘（失败 → not_ready 语义；内存态已变更不回滚——
    /// 重启回退关闭态为安全默认）。
    fn persist(&self, enabled: bool) -> Result<(), ComputerError> {
        self.meta
            .persist_enabled(enabled)
            .map_err(ComputerError::Persist)
    }

    /// 广播状态事件（尽力而为：序列化失败仅记录，发射器缺失静默跳过）。
    fn emit(&self, payload: &StateChangePayload) {
        let emitter = self
            .emitter
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!(target: "computer", "emitter 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .clone();
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

/// run 级停止 watcher（维度 1 收敛：对齐 browser 线 spawn_browser_estop_watcher 先例）。
///
/// 监听 run 级 `AbortSignal`，触发后调 [ComputerSlot::on_run_stopped] 释放互斥门 +
/// 关闭开启态 + 落盘。装配点：run_launch.rs run 装配块（与 browser watcher 并列）。
///
/// 同步入口函数（无 async 签名）：调用方上下文不保证有 tokio runtime，
/// 统一走 tauri::async_runtime::spawn（全局 runtime，同步/异步上下文均安全）。
pub(crate) fn spawn_computer_stop_watcher(slot: Arc<ComputerSlot>, signal: AbortSignal) {
    tauri::async_runtime::spawn(async move {
        signal.wait_aborted().await;
        slot.on_run_stopped();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_computer::perception::{PerceptionError, PerceptionSnapshot};
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
        let slot = Arc::new(ComputerSlot::from_store(Arc::new(
            LocalDbComputerMetaStore::new(db.clone()),
        )));
        (slot, db)
    }

    /// 预置 session_meta 开启态的内存库槽。
    ///
    /// 命令面物理切除后，开启态的唯一生产入口是惰性恢复
    /// （[ComputerSlot::ensure_restored]，由 register_tools / on_run_stopped 触发），
    /// 因此测试统一经此装配面建立开启态。
    fn slot_with_meta(enabled: bool) -> (Arc<ComputerSlot>, LocalDb) {
        let (slot, db) = in_memory_slot();
        db.set_session_meta(
            COMPUTER_USE_ENABLED_KEY,
            if enabled { "true" } else { "false" },
        )
        .expect("预置开启标记");
        (slot, db)
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
        slot.register_tools(&mut registry)
            .expect("未开启零注册应返回 Ok");
        assert!(
            registered_names(&registry).is_empty(),
            "未开启不得挂载任何 computer_* 工具"
        );
    }

    /// 挂载判据：开启态下注册全部 12 工具，名称与 ALL_TOOL_NAMES 一致。
    #[test]
    fn enabled_slot_mounts_all_12_tools() {
        let (slot, _db) = slot_with_meta(true);
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("注册不应失败");
        assert_eq!(registered_names(&registry), sorted_all_tool_names());
        assert_eq!(registry.list_definitions().len(), ALL_TOOL_NAMES.len());
    }

    /// 重复注册幂等（06 文档 §3.2：同名跳过不报冲突，注册数不变）。
    #[test]
    fn register_tools_twice_is_idempotent() {
        let (slot, _db) = slot_with_meta(true);
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry)
            .expect("首次注册不应失败");
        slot.register_tools(&mut registry)
            .expect("重复注册应幂等返回 Ok");
        assert_eq!(registry.list_definitions().len(), ALL_TOOL_NAMES.len());
    }

    /// 惰性恢复：session_meta `computer_use_enabled=true` → 恢复开启态并
    /// 挂载 12 工具（跨实例恢复，04 §4.1 第 2 点）。
    #[test]
    fn restore_enabled_from_session_meta_mounts_all() {
        let (slot, _db) = slot_with_meta(true);
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("注册不应失败");
        assert!(slot.enablement().enabled(), "恢复后应为开启态");
        assert!(
            slot.activation().current().is_desktop(),
            "恢复开启应同步激活桌面会话"
        );
        assert_eq!(registered_names(&registry), sorted_all_tool_names());
    }

    /// 惰性恢复：`computer_use_enabled=false` → 恢复关闭态 → 零注册。
    #[test]
    fn restore_disabled_from_session_meta_mounts_zero() {
        let (slot, _db) = slot_with_meta(false);
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("零注册应返回 Ok");
        assert!(!slot.enablement().enabled(), "恢复后应为关闭态");
        assert_eq!(slot.activation().current(), SessionMode::Idle);
        assert!(registered_names(&registry).is_empty());
    }

    /// 惰性恢复：无键默认关闭（新会话默认关闭语义）。
    #[test]
    fn missing_meta_defaults_disabled_idle() {
        let (slot, _db) = in_memory_slot();
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry).expect("零注册应返回 Ok");
        assert!(!slot.enablement().enabled());
        assert_eq!(slot.activation().current(), SessionMode::Idle);
        assert_eq!(
            slot.enablement().disabled_reason(),
            None,
            "从未开启不应有关闭原因"
        );
        assert!(registered_names(&registry).is_empty());
    }

    /// on_run_stopped：释放互斥门 → 关闭开启态 → 落盘 false（维度 1 收敛：
    /// 替代原 estop，普通停止语义，不置急停旗）。
    #[test]
    fn on_run_stopped_releases_and_persists() {
        let (slot, db) = slot_with_meta(true);
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry)
            .expect("恢复注册不应失败");
        assert!(
            slot.activation().current().is_desktop(),
            "恢复后应处于桌面活跃态"
        );
        slot.on_run_stopped();
        assert_eq!(
            db.get_session_meta(COMPUTER_USE_ENABLED_KEY)
                .expect("读库不应失败")
                .as_deref(),
            Some("false"),
            "停止后开启态必须落盘关闭（恢复需重新显式开启）"
        );
        assert!(!slot.enablement().enabled());
        assert_eq!(slot.activation().current(), SessionMode::Idle);
        assert_eq!(
            slot.enablement().disabled_reason().as_deref(),
            Some("run 级停止")
        );
    }

    /// 状态事件广播（`computer://state-changed`）：惰性恢复与 run 级停止各发
    /// 一次，载荷形状 `{ enabled, mode, reason? }` 与前端契约一致。
    #[test]
    fn state_changed_events_emitted_on_transitions() {
        let (slot, _db) = slot_with_meta(true);
        let events = Arc::new(Mutex::new(Vec::new()));
        slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&events))));
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry)
            .expect("恢复注册不应失败");
        slot.on_run_stopped();
        let events = events.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(events.len(), 2, "恢复与停止各广播一次");
        let first: serde_json::Value = serde_json::from_str(&events[0]).expect("事件 JSON");
        assert_eq!(first["enabled"], true);
        assert_eq!(first["mode"], "desktop");
        let second: serde_json::Value = serde_json::from_str(&events[1]).expect("事件 JSON");
        assert_eq!(second["enabled"], false);
        assert_eq!(second["mode"], "idle");
        assert_eq!(second["reason"], "run 级停止");
    }

    /// 惰性恢复广播：恢复即发一次状态事件（启动前已挂订阅，面板可收）。
    #[test]
    fn restore_emits_state_changed() {
        let (slot, _db) = slot_with_meta(true);
        let events = Arc::new(Mutex::new(Vec::new()));
        slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&events))));
        let mut registry = ToolRegistry::new();
        slot.register_tools(&mut registry)
            .expect("恢复注册不应失败");
        let events = events.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(events.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&events[0]).expect("事件 JSON");
        assert_eq!(payload["enabled"], true);
        assert_eq!(payload["mode"], "desktop");
    }

    /// 命令面退役负向不变量（2026-09-15 真漂移债务清零 · 物理切除）：
    /// `computer_session_enable` / `computer_session_disable` / `computer_status`
    /// 三条命令及其**专属**辅助项（`SessionPayload` / `StatusPayload` /
    /// `ComputerError::Exclusive` / `ComputerError::as_command_err` 与槽方法
    /// `new` / `enable` / `disable` / `status`）已从实现面物理删除——前端
    /// computer-panel 面已物理删除，生产代码零消费。
    ///
    /// 原 5 条断言钉的正是这三条命令的行为（命令体 = 槽方法薄封装），随命令一并
    /// 退役，逐条对账见本轮汇报：
    /// - `enable_persists_true_and_status_reflects`（落盘 true + 状态反射）；
    /// - `enable_twice_is_idempotent`（重复开启幂等）；
    /// - `disable_releases_persists_and_records_reason`（释放互斥门 + 落盘 false
    ///   + 原因登记）——三条不变量由 `on_run_stopped_releases_and_persists` 继续守护；
    /// - `enable_rejected_when_browser_active`（浏览器活跃 → `tool.session.exclusive`）；
    /// - `persist_failure_maps_to_not_ready`（落盘失败 → `tool.computer.not_ready`）。
    ///
    /// 注册面负向断言见 `tests/config_command_names_contract.rs`。
    #[test]
    fn retired_computer_command_surface_is_physically_removed() {
        // needle 分片拼接：避免断言文案自身命中源文本
        let source = include_str!("mod.rs");
        for removed in [
            concat!("struct Session", "Payload"),
            concat!("struct Status", "Payload"),
            concat!("fn as_command", "_err"),
            concat!("pub(crate) fn en", "able("),
            concat!("pub(crate) fn dis", "able("),
            concat!("pub(crate) fn stat", "us("),
        ] {
            assert!(
                !source.contains(removed),
                "已退役命令面 {removed} 严禁在实现面复活"
            );
        }
    }

    #[test]
    fn accessors_and_session_injection_smoke() {
        use async_trait::async_trait;
        let (slot, _db) = in_memory_slot();
        let act = slot.activation();
        assert_eq!(act.current(), SessionMode::Idle);
        let en = slot.enablement();
        assert!(!en.enabled());

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
            async fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError> {
                Err(PerceptionError::NoActiveWindow)
            }
            fn perception_version(&self) -> u64 {
                0
            }
        }
        slot.set_session(Arc::new(DummyOps));
    }
}
