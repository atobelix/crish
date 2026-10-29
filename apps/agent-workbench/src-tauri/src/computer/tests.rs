//! 电脑操作会话槽：工具挂载判据 / 惰性恢复 / run 级停止 / 状态事件。

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
