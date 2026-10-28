//! Tauri 事件通道发射器（[conex_run::core_event_bridge::Emitter] 的宿主实现）
//!
//! conex-run 下沉后事件发射契约（Emitter trait）归属 conex-run；本模块是
//! Tauri 宿主侧的唯一实现：`app.emit(channel, payload)`（03 §3.1）。

/// Tauri 事件通道实现：`app.emit(channel, payload)`（03 §3.1）
pub struct TauriEmitter {
    app: tauri::AppHandle,
}

impl TauriEmitter {
    /// 用应用句柄构造（main.rs 接线时传入 `app.handle().clone()`）
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl conex_run::core_event_bridge::Emitter for TauriEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        use tauri::Emitter as _;
        // 发射失败（webview 未就绪等）仅记录，不阻断 run 流程
        if let Err(error) = self.app.emit(channel, payload) {
            tracing::warn!(
                target: "event_bridge",
                channel,
                error = %error,
                "事件通道发射失败（尽力而为）"
            );
        }
    }
}
