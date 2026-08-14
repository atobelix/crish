//! 电脑操作会话命令面（06 遗留⑨：会话开关 + 急停 + 状态）。
//!
//! ## 接口契约（契约定死，前端消费面 computerSessionApi.ts）
//! - `computer_session_enable` → `{ enabled: true }`（风险确认流在组件层
//!   完成后调用；浏览器会话活跃 → `tool.session.exclusive:<...>`）；
//! - `computer_session_disable` → `{ enabled: false }`（幂等）；
//! - `computer_estop(reason?)` → `{ stopped: true }`（面板急停按钮 →
//!   同一吊销链，04 §4.3 ③；reason 为审计原因）；
//! - `computer_status` → `{ enabled, mode: "idle"|"browser"|"desktop",
//!   reason? }`（触发惰性恢复：session_meta `computer_use_enabled`）。
//!
//! ## 错误面（结构化码前缀，前端按码路由提示）
//! - `tool.session.exclusive:<...>`：会话互斥（浏览器活跃，无法开启电脑操作）；
//! - `tool.computer.not_ready:<...>`：session_meta 持久化失败（not_ready
//!   gating 语义，对齐 browser 线）。
//!
//! ## 事件面
//! 状态迁移经 `computer://state-changed`（`{ enabled?, mode?, reason? }`）
//! Tauri 事件发射——发射接线见 [crate::computer::ComputerSlot::attach_emitter]，
//! 由槽内部在 enable/disable/estop/恢复 各转换点广播（命令面不重复发射）。
//!
//! ## 登记面（已接线）
//! 本文件命令已登记：`main.rs` command_registry!（:290-293）+ command_manifest.rs
//! （registered=true，:213-216）。

use crate::computer::{ComputerSlot, EstopPayload, SessionPayload, StatusPayload};
use std::sync::Arc;
use tauri::State;

/// 显式开启电脑操作会话（04 §4.1：风险确认流在组件层完成后调用）。
///
/// 契约：`{ enabled: true }`；浏览器会话活跃 → `tool.session.exclusive`
/// （互斥硬约束，审批无关）。重复开启按幂等吸收（状态机严格语义保留）。
#[tauri::command]
pub(crate) fn computer_session_enable(
    slot: State<'_, Arc<ComputerSlot>>,
) -> Result<SessionPayload, String> {
    slot.enable().map_err(|e| e.as_command_err())?;
    Ok(SessionPayload { enabled: true })
}

/// 停用电脑操作会话（解除授权；幂等——未开启时停用仅落盘关闭态）。
///
/// 契约：`{ enabled: false }`。
#[tauri::command]
pub(crate) fn computer_session_disable(
    slot: State<'_, Arc<ComputerSlot>>,
) -> Result<SessionPayload, String> {
    slot.disable(None).map_err(|e| e.as_command_err())?;
    Ok(SessionPayload { enabled: false })
}

/// 全局急停（04 §4.3 ③ 面板急停按钮 → 同一吊销链：中止在途注入 → 感知源
/// 停止 → 会话回 Idle；恢复需重新显式开启）。`reason` 为审计原因（可选）。
///
/// 契约：`{ stopped: true }`。
#[tauri::command]
pub(crate) fn computer_estop(
    reason: Option<String>,
    slot: State<'_, Arc<ComputerSlot>>,
) -> Result<EstopPayload, String> {
    slot.estop(reason).map_err(|e| e.as_command_err())?;
    Ok(EstopPayload { stopped: true })
}

/// 查询电脑操作会话状态（触发惰性恢复；挂载/诊断用）。
///
/// 契约：`{ enabled, mode: "idle"|"browser"|"desktop", reason? }`。
#[tauri::command]
pub(crate) fn computer_status(
    slot: State<'_, Arc<ComputerSlot>>,
) -> Result<StatusPayload, String> {
    Ok(slot.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::{ComputerMetaStore, LocalDbComputerMetaStore};
    use conex_db::LocalDb;
    use serde_json::json;
    use tauri::Manager;

    /// 构造内存库槽（真实读写面；命令契约断言不依赖 Tauri 真 app）。
    fn mock_slot() -> Arc<ComputerSlot> {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        Arc::new(ComputerSlot::new(Arc::new(
            LocalDbComputerMetaStore::new(db),
        )))
    }

    fn mock_app(slot: &Arc<ComputerSlot>) -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .manage(Arc::clone(slot))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app 构造应成功")
    }

    /// enable 契约：载荷 `{ enabled: true }`（序列化形状与前端逐字一致）。
    #[test]
    fn enable_returns_contract_payload() {
        let slot = mock_slot();
        let app = mock_app(&slot);
        let out = computer_session_enable(app.state::<Arc<ComputerSlot>>()).expect("开启不应失败");
        assert_eq!(serde_json::to_value(&out).expect("序列化"), json!({ "enabled": true }));
    }

    /// disable 契约：载荷 `{ enabled: false }`（幂等——未开启时停用不报错）。
    #[test]
    fn disable_returns_contract_payload_idempotent() {
        let slot = mock_slot();
        let app = mock_app(&slot);
        let out = computer_session_disable(app.state::<Arc<ComputerSlot>>()).expect("停用不应失败");
        assert_eq!(serde_json::to_value(&out).expect("序列化"), json!({ "enabled": false }));
        // 开启后停用：仍返回 { enabled: false } 并落盘
        slot.enable().expect("开启不应失败");
        let app2 = mock_app(&slot);
        let out = computer_session_disable(app2.state::<Arc<ComputerSlot>>()).expect("停用不应失败");
        assert_eq!(serde_json::to_value(&out).expect("序列化"), json!({ "enabled": false }));
        let status = slot.status();
        assert!(!status.enabled);
    }

    /// estop 契约：载荷 `{ stopped: true }` + 急停旗置位 + reason 审计登记。
    #[test]
    fn estop_returns_contract_payload_with_reason() {
        let slot = mock_slot();
        slot.enable().expect("开启不应失败");
        let app = mock_app(&slot);
        let out = computer_estop(Some("用户点击急停".to_string()), app.state::<Arc<ComputerSlot>>())
            .expect("急停不应失败");
        assert_eq!(serde_json::to_value(&out).expect("序列化"), json!({ "stopped": true }));
        assert!(slot.stop().stopped(), "急停旗必须置位");
        let status = slot.status();
        assert!(!status.enabled, "急停后开启态必须关闭（恢复需重新显式开启）");
        assert_eq!(status.mode, "idle");
    }

    /// status 契约：`{ enabled, mode }` 形状（未开启 + Idle；reason 省略——
    /// 从未开启无关闭原因）。
    #[test]
    fn status_reports_disabled_idle_shape() {
        let slot = mock_slot();
        let app = mock_app(&slot);
        let out = computer_status(app.state::<Arc<ComputerSlot>>()).expect("状态查询不应失败");
        assert_eq!(
            serde_json::to_value(&out).expect("序列化"),
            json!({ "enabled": false, "mode": "idle" }),
            "reason 未开启时省略（skip_serializing_if）"
        );
    }

    /// status 契约：开启后 `{ enabled: true, mode: "desktop" }`。
    #[test]
    fn status_reports_enabled_desktop_after_enable() {
        let slot = mock_slot();
        slot.enable().expect("开启不应失败");
        let app = mock_app(&slot);
        let out = computer_status(app.state::<Arc<ComputerSlot>>()).expect("状态查询不应失败");
        assert_eq!(
            serde_json::to_value(&out).expect("序列化"),
            json!({ "enabled": true, "mode": "desktop" })
        );
    }

    /// status 契约：session_meta 预置开启 → 惰性恢复反射 `{ enabled: true }`
    /// （跨实例恢复面，04 §4.1 第 2 点）。
    #[test]
    fn status_restores_enabled_from_session_meta() {
        let db = LocalDb::open_in_memory().expect("内存库打开应成功");
        db.set_session_meta(conex_computer::security::COMPUTER_USE_ENABLED_KEY, "true")
            .expect("预置开启标记");
        let slot = Arc::new(ComputerSlot::new(Arc::new(
            LocalDbComputerMetaStore::new(db),
        )));
        let app = mock_app(&slot);
        let out = computer_status(app.state::<Arc<ComputerSlot>>()).expect("状态查询不应失败");
        assert_eq!(
            serde_json::to_value(&out).expect("序列化"),
            json!({ "enabled": true, "mode": "desktop" })
        );
    }

    /// 错误路径：浏览器活跃时 enable → `tool.session.exclusive:<...>`
    /// （结构化码前缀；互斥守卫在一切状态变更之前）。
    #[test]
    fn enable_rejected_exclusive_when_browser_active() {
        let slot = mock_slot();
        slot.activation()
            .request_browser()
            .expect("浏览器激活应成功");
        let app = mock_app(&slot);
        let err = computer_session_enable(app.state::<Arc<ComputerSlot>>()).expect_err("必须拒绝");
        assert!(
            err.starts_with("tool.session.exclusive:"),
            "互斥错误码前缀：{err}"
        );
        assert!(!slot.status().enabled, "拒绝时不得变更开启态");
    }

    /// 错误路径：持久化失败 → `tool.computer.not_ready:<...>`（not_ready
    /// gating 语义，对齐 browser 线）。
    #[test]
    fn enable_maps_persist_failure_to_not_ready() {
        struct FailingStore;
        impl ComputerMetaStore for FailingStore {
            fn load_enabled(&self) -> Result<bool, String> {
                Ok(false)
            }
            fn persist_enabled(&self, _enabled: bool) -> Result<(), String> {
                Err("磁盘只读（测试注入）".to_string())
            }
        }
        let slot = Arc::new(ComputerSlot::from_store(Arc::new(FailingStore)));
        let app = mock_app(&slot);
        let err = computer_session_enable(app.state::<Arc<ComputerSlot>>()).expect_err("落盘失败必须报错");
        assert!(
            err.starts_with("tool.computer.not_ready:"),
            "not_ready 错误码前缀：{err}"
        );
    }

    /// 事件面：命令不重复发射——enable/disable 后事件恰好由槽广播一次
    /// （契约 `computer://state-changed`，载荷字段可选）。
    #[test]
    fn commands_do_not_double_emit_state_events() {
        use crate::core_event_bridge::Emitter;
        struct TestEmitter(Arc<std::sync::Mutex<Vec<String>>>);
        impl Emitter for TestEmitter {
            fn emit(&self, channel: &str, payload: &str) {
                self.0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(format!("{channel}:{payload}"));
            }
        }
        let slot = mock_slot();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&events))));
        let app1 = mock_app(&slot);
        computer_session_enable(app1.state::<Arc<ComputerSlot>>()).expect("开启不应失败");
        let app2 = mock_app(&slot);
        computer_session_disable(app2.state::<Arc<ComputerSlot>>()).expect("停用不应失败");
        let events = events.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(events.len(), 2, "开启 + 停用各广播一次（命令面不重复发射）");
        assert!(events[0].starts_with("computer://state-changed:"), "事件名：{}", events[0]);
    }
}
