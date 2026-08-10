//! 浏览器面板命令面（27 接线方案 S6 + P1-B1 帧流/输入命令）——
//! browser_start / browser_stop / browser_status / browser_start_frames /
//! browser_stop_frames / browser_frame_status / browser_input
//!
//! ## 接口契约（契约定死，前端消费面）
//! - `browser_start` → `{ state: "running"|"starting"|"error", reason?: string }`；
//! - `browser_stop` → `{ state: "stopped" }`；`force?: boolean` 参数（评审 F3）：
//!   `true` = 急停——不等会话锁，直接走强制杀树路径（launching 中不被会话锁
//!   阻塞至首启超时）；缺省/`false` = 正常停止（Graceful）；
//! - `browser_status` → `{ state: "idle"|"launching"|"running"|"stopping"|
//!   "stopped"|"crashed"|"error", url?: string }`。
//!
//! ## P1-B1 帧流/输入命令（U-13 主控裁决：帧下行 Tauri Channel / 输入上行 invoke）
//! - `browser_start_frames(onFrame: Channel)` → `{ state: "starting"|"active"|
//!   "stopped", reason? }`——前端注册帧通道（Uint8Array 二进制帧，12 §2.2 定长头 +
//!   JPEG），无订阅者时不启帧流（省资源）；帧状态迁移经
//!   `browser://frame-state-changed`（`{ state, reason? }`）独立事件发射；
//! - `browser_stop_frames` → `{ state: "stopped" }`——退订帧流（幂等）；
//! - `browser_frame_status` → `{ state }` 查询；
//! - `browser_input(event)` → `()`——输入上行（kind/坐标/键值/滚动 delta/IME
//!   文本），**no-wait 语义**（invoke 不等待 CDP 注入返回）；高频 mousemove/
//!   wheel 在 Rust 侧按帧间隔合并（权威节流，见 browser/panel_input.rs 模块头）。
//!
//! 状态迁移经 `browser://state-changed`（payload `{ state, url?, reason? }`）Tauri
//! 事件发射（事件来源 = BrowserManager 状态机；评审 F7：崩溃事件携带 reason 原因；
//! 发射接线见 [crate::browser::BrowserSlot::attach_emitter]）。
//!
//! 命令均代理到引擎持有的 [BrowserSlot]（进程级单例，经
//! [CoreRunState::engine] 访问器取用）——不持有独立状态，与工具面
//! LazySessionOps 同一会话槽（单实例双控制面，08 D-2/D-3）。
//!
//! 错误面：start 失败按契约返回 `state: "error"` + reason（不 reject）；
//! stop 失败返回 Err（Tauri reject，无契约错误态）；帧流/输入命令失败返回 Err。
//!
//! ## 注册待办（P1-B1 收尾，主控接线）
//! 本文件命令需在 `main.rs` command_registry! 与 `command_manifest.rs`（registered=true）
//! 登记后方可经 invoke 路由（含前端 commandManifest.ts 快照）；接线前命令面
//! 未注册（前端按 missing 静默降级，帧流显示「帧流未激活」）。

use crate::browser::frame_stream::FrameStreamState;
use crate::browser::panel_input::BrowserInputEvent;
use crate::browser::{BrowserSlot, StartPayload, StatusPayload};
use crate::core_run_commands::CoreRunState;
use std::sync::Arc;
use tauri::ipc::Channel;

/// 取引擎持有的浏览器会话槽（命令面与工具面共享同一进程级单例）。
fn slot(core: &Arc<CoreRunState>) -> Arc<BrowserSlot> {
    core.engine().browser_slot()
}

/// 启动结果 → 契约载荷（Ok = running/starting；Err = error + reason）。
fn start_payload(result: Result<&'static str, String>) -> StartPayload {
    match result {
        Ok(state) => StartPayload {
            state,
            reason: None,
        },
        Err(reason) => StartPayload {
            state: "error",
            reason: Some(reason),
        },
    }
}

#[tauri::command]
pub(crate) async fn browser_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StartPayload, String> {
    let slot = slot(core.inner());
    slot.attach_emitter(Arc::new(crate::browser::TauriStateEmitter::new(app)));
    Ok(start_payload(slot.start().await))
}

#[tauri::command]
pub(crate) async fn browser_stop(
    force: Option<bool>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StatusPayload, String> {
    // 评审 F3：force=true（急停）→ 强制杀树路径（不等会话锁，launching 中
    // 不被阻塞至首启超时）；缺省 = 正常停止（Graceful）
    slot(core.inner()).stop(force.unwrap_or(false)).await?;
    Ok(StatusPayload {
        state: "stopped",
        url: None,
        reason: None,
    })
}

#[tauri::command]
pub(crate) fn browser_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StatusPayload, String> {
    let slot = slot(core.inner());
    // 幂等挂接：命令面先行时也能收到后续状态迁移
    slot.attach_emitter(Arc::new(crate::browser::TauriStateEmitter::new(app)));
    Ok(slot.status())
}

/// 启动帧流（P1-B1）：注册前端帧通道（Uint8Array 二进制）→ 浏览器就绪 →
/// 帧泵启动（startScreencast + ack pacing，8fps Base 档）→ 帧状态
/// `browser://frame-state-changed` 事件发射。无订阅者不启帧流（省资源）。
///
/// `on_frame` 通道须由命令持有（控制器存于 ActiveStream），通道释放
/// （退订/替换）时前端收到 end 事件。
#[tauri::command]
pub(crate) async fn browser_start_frames<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    on_frame: Channel<tauri::ipc::Response>,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<FrameStreamState, String> {
    let slot = slot(core.inner());
    slot.attach_emitter(Arc::new(crate::browser::TauriStateEmitter::new(app)));
    slot.start_frames(on_frame).await
}

/// 退订帧流（P1-B1；幂等）：停止帧泵 + stopScreencast + 状态 stopped。
#[tauri::command]
pub(crate) async fn browser_stop_frames(
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<FrameStreamState, String> {
    Ok(slot(core.inner()).stop_frames().await)
}

/// 帧流状态查询（P1-B1）：starting/active/stopped。
#[tauri::command]
pub(crate) fn browser_frame_status(
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<FrameStreamState, String> {
    Ok(slot(core.inner()).frames().state())
}

/// 输入上行（P1-B1；U-13 裁决：输入走 Tauri invoke 而非 WS）。
///
/// - **no-wait 语义**：仅路由/合并后返回，派发由 P1-A 注入管线后台进行
///   （12 §4.1：不等待 CDP 响应，invoke 立即返回）；
/// - **高频节流**：mousemove/wheel 在 Rust 侧按帧间隔合并（权威节流，
///   见 browser/panel_input.rs 模块头注释——任务书二选一取 Rust 侧）；
/// - 离散事件（down/up/key/text）直通；事件序保真（press 先于积压 move）；
/// - 版本推进（R-1/U-1 注入即时 +1）由管线内部承担。
#[tauri::command]
pub(crate) async fn browser_input(
    event: BrowserInputEvent,
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<(), String> {
    slot(core.inner()).forward_input(&event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_event_bridge::{Emitter, EventBridge};
    use crate::status_diagnostics::StatusDiagnostics;
    use orchestrator::persist::InMemoryStore;
    use orchestrator::restore::SnapshotFileStore;
    use serde_json::json;

    /// 测试发射器（EventBridge 构造面；命令面断言不消费事件内容）。
    struct TestEmitter(Arc<std::sync::Mutex<Vec<String>>>);

    impl Emitter for TestEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.0
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(format!("{channel}:{payload}"));
        }
    }

    /// 构造 mock 引擎状态（CoreRunState 可独立构造；浏览器槽随引擎
    /// 装配为真实惰性槽——单元测试不触发启动，仅查询/停止安全面）。
    fn mock_core_state(temp: &tempfile::TempDir) -> Arc<CoreRunState> {
        let bridge = EventBridge::new("test", Arc::new(TestEmitter(Arc::new(Default::default()))));
        Arc::new(CoreRunState::new(
            Arc::new(InMemoryStore::new()),
            Arc::new(SnapshotFileStore::new(
                temp.path().join("snapshot.json"),
            )),
            bridge,
            Arc::new(StatusDiagnostics::new()),
            None,
        ))
    }

    /// 启动失败 → 契约载荷（state=error + reason；命令面代理语义）。
    #[test]
    fn start_payload_maps_error_and_ok() {
        let ok = start_payload(Ok("running"));
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({ "state": "running" })
        );
        let starting = start_payload(Ok("starting"));
        assert_eq!(
            serde_json::to_value(&starting).unwrap(),
            json!({ "state": "starting" })
        );
        let err = start_payload(Err("浏览器崩溃恢复中".to_string()));
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            json!({ "state": "error", "reason": "浏览器崩溃恢复中" })
        );
    }

    /// browser_status 契约：从未启动 → `{ state: "idle" }`（无 url 键）；
    /// 未启动的 browser_stop 幂等返回 `{ state: "stopped" }`（manager.stop
    /// 无驱动路径直接收敛，安全面）；force 参数缺省/显式均收敛。
    #[tokio::test]
    async fn status_and_stop_contract_on_idle_state() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let status = browser_status(app.handle().clone(), state_ref.clone()).expect("status 不应失败");
        assert_eq!(status.state, "idle", "从未启动 = idle");
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "idle" }),
            "url 缺省不落键（契约形状）"
        );

        let stopped = browser_stop(None, state_ref.clone()).await.expect("未启动 stop 应幂等");
        assert_eq!(
            serde_json::to_value(&stopped).unwrap(),
            json!({ "state": "stopped" })
        );

        // 评审 F3：force 急停参数显式传递亦收敛（未启动幂等安全面）
        let stopped = browser_stop(Some(true), state_ref).await.expect("force stop 应幂等");
        assert_eq!(
            serde_json::to_value(&stopped).unwrap(),
            json!({ "state": "stopped" })
        );
    }

    /// P1-B1：browser_input no-wait 语义——无会话/管线（P1-A 未接线）时
    /// 返回 Ok（事件进入路由即返回，不等待 CDP）；payload 反序列化契约。
    #[tokio::test]
    async fn browser_input_returns_ok_without_session() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let evt = serde_json::from_value(json!({
            "kind": "mouse",
            "action": "move",
            "x": 10.0,
            "y": 20.0,
            "buttons": 1,
            "modifiers": 0
        }))
        .expect("载荷反序列化");
        let result = browser_input(evt, state_ref.clone()).await;
        assert!(result.is_ok(), "no-wait：路由后立即返回 Ok，不得因会话缺失失败");

        let key_evt = serde_json::from_value(json!({
            "kind": "key",
            "action": "down",
            "key": "a",
            "code": "KeyA",
            "text": "a",
            "windowsVirtualKeyCode": 65,
            "nativeVirtualKeyCode": 65,
            "autoRepeat": false,
            "modifiers": 2
        }))
        .expect("键盘载荷反序列化");
        assert!(browser_input(key_evt, state_ref).await.is_ok());
    }

    /// P1-B1：browser_input 载荷非法 kind → 反序列化失败（防御非法前端）。
    #[test]
    fn browser_input_rejects_unknown_kind() {
        let parsed: Result<BrowserInputEvent, _> =
            serde_json::from_value(json!({ "kind": "joystick" }));
        assert!(parsed.is_err(), "未知 kind 必须反序列化失败");
    }

    /// P1-B1：帧状态契约——未启动槽 stop_frames / frame_status 幂等收敛
    /// （stopped，不触发启动链）。
    #[tokio::test]
    async fn frame_commands_idle_contract() {
        use tauri::Manager as _;
        let temp = tempfile::tempdir().expect("临时目录");
        let state = mock_core_state(&temp);
        let app = tauri::test::mock_builder()
            .manage(Arc::clone(&state))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let state_ref = app.state::<Arc<CoreRunState>>();

        let status = browser_frame_status(state_ref.clone()).expect("状态查询不应失败");
        assert_eq!(serde_json::to_value(&status).unwrap(), json!("stopped"));

        let stopped = browser_stop_frames(state_ref).await.expect("退订不应失败");
        assert_eq!(serde_json::to_value(&stopped).unwrap(), json!("stopped"));
    }
}
