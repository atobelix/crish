use std::sync::Arc;
use crate::browser::{StartPayload, StatusPayload};
use crate::core_run_commands::CoreRunState;
use super::common::{slot, start_payload};

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
