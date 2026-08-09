//! 浏览器面板命令面（27 接线方案 S6）——browser_start / browser_stop /
//! browser_status
//!
//! ## 接口契约（契约定死，前端消费面）
//! - `browser_start` → `{ state: "running"|"starting"|"error", reason?: string }`；
//! - `browser_stop` → `{ state: "stopped" }`；
//! - `browser_status` → `{ state: "idle"|"launching"|"running"|"stopping"|
//!   "stopped"|"crashed"|"error", url?: string }`。
//!
//! 状态迁移经 `browser://state-changed`（payload `{ state, url? }`）Tauri
//! 事件发射（事件来源 = BrowserManager 状态机；发射接线见
//! [crate::browser::BrowserSlot::attach_emitter]）。
//!
//! 命令均代理到引擎持有的 [BrowserSlot]（进程级单例，经
//! [CoreRunState::engine] 访问器取用）——不持有独立状态，与工具面
//! LazySessionOps 同一会话槽（单实例双控制面，08 D-2/D-3）。
//!
//! 错误面：start 失败按契约返回 `state: "error"` + reason（不 reject）；
//! stop 失败返回 Err（Tauri reject，无契约错误态）。

use crate::browser::{BrowserSlot, StartPayload, StatusPayload};
use crate::core_run_commands::CoreRunState;
use std::sync::Arc;

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
    core: tauri::State<'_, Arc<CoreRunState>>,
) -> Result<StatusPayload, String> {
    slot(core.inner()).stop().await?;
    Ok(StatusPayload {
        state: "stopped",
        url: None,
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
    /// 无驱动路径直接收敛，安全面）。
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

        let stopped = browser_stop(state_ref).await.expect("未启动 stop 应幂等");
        assert_eq!(
            serde_json::to_value(&stopped).unwrap(),
            json!({ "state": "stopped" })
        );
    }
}
