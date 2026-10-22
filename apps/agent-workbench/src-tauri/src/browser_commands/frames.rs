use std::sync::Arc;
use crate::browser::frame_stream::FrameStreamState;
use crate::browser::panel_input::BrowserInputEvent;
use crate::core_run_commands::CoreRunState;
use tauri::ipc::Channel;
use super::common::slot;

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
