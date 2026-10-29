//! BrowserSlot 事件面：发射器挂接、状态转发任务与状态/崩溃载荷发射。

use super::*;

impl BrowserSlot {
    /// 挂接事件发射器并启动状态转发任务（惰性单飞：manager 事件 →
    /// `browser://state-changed`；main.rs setup 与命令面均可调用，幂等）。
    ///
    /// 转发语义（评审 F5/F7）：
    /// - `StateChanged` → 发射状态迁移（payload 携带当前 url）；
    /// - `NavStackChanged` → 重发当前状态（URL 随导航推送，防面板 URL 陈旧）；
    /// - `CrashRestarting` → 发射 `{ state: "crashed", reason }`（崩溃带原因）；
    /// - 订阅掉队（`Lagged`）**不终止转发**——重订阅续传 + 以当前状态快照补发
    ///   （旧实现 `Err(_) => break` 导致永久停发）；通道关闭才退出。
    ///
    /// 帧流状态事件（`browser://frame-state-changed`）随同一发射器接线
    /// （P1-B1：帧状态 starting/active/stopped，独立事件不与面板状态机混流）。
    pub(crate) fn attach_emitter(self: &Arc<Self>, emitter: Arc<dyn Emitter>) {
        *self.emitter.lock().unwrap_or_else(|p| p.into_inner()) = Some(emitter.clone());
        self.frames.attach_emitter(emitter);
        if self.forwarder_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(manager) = self.manager.clone() else {
            return;
        };
        let mut rx = manager.subscribe();
        let slot = Arc::clone(self);
        // 同步上下文守卫（G-13 L3 P0）：本函数在 main.rs setup（无 tokio
        // runtime 的同步回调）与命令面（browser_status 为同步命令）均可达——
        // 直接 tokio::spawn 会 panic（"no reactor running"）。改用
        // tauri::async_runtime::spawn：Tauri 全局 runtime（惰性初始化，
        // setup 中可用），任务在应用 runtime 线程池运行，语义不变。
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ProcessEvent::StateChanged { state, .. }) => {
                        slot.emit_state_changed(&state);
                    }
                    Ok(ProcessEvent::NavStackChanged { .. }) => {
                        // F7：导航变更 → 重发当前状态（URL 随导航推送）
                        slot.emit_state_changed(&manager.status().state);
                    }
                    Ok(ProcessEvent::CrashRestarting { reason, .. }) => {
                        // F7：崩溃事件补原因（前端兼容解析 reason 字段）
                        slot.emit_crash(&reason);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // F5：掉队 ≠ 通道关闭——重订阅续传；掉队期间状态以
                        // 当前快照补发一次，面板不陈旧
                        tracing::warn!(target: "browser", "状态事件转发掉队（Lagged），重订阅续传");
                        rx = manager.subscribe();
                        slot.emit_state_changed(&manager.status().state);
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// 丢弃底层会话句柄（停止/重连/重建前调用）：释放帧流会话（shutdown，
    /// 转发任务随 sink 关闭退出）+ 清除输入管线（旧管线 Drop 终止消费任务）。
    ///
    /// **不触碰 G-9 关闭发送面**（N6 顺序契约）：stop_inner 在本方法之后
    /// 才调 `manager.stop(Graceful)`——发送面须存活至 Browser.close 发出；
    /// 清除由管理器停止收尾自动完成（M3 `clear_session_state` 自动清空），
    /// 重连/重启路径由 [Self::connect] 重新登记覆盖旧发送面。
    pub(super) fn drop_raw_session(&self) {
        *self.raw_session.lock().unwrap_or_else(|p| p.into_inner()) = None;
        // J1b：会话失效 → storage 发送面换回未连接（陈旧会话不得滞留）
        *self.storage_ops.lock().unwrap_or_else(|p| p.into_inner()) = Arc::new(UnwiredStorageOps);
        self.frames.release_session();
        self.input.clear_pipeline();
    }

    /// 当前活动标签 URL（nav_stack 只读面；无标签/未启动 → None）。
    pub(super) fn current_url(&self) -> Option<String> {
        let manager = self.manager.as_ref()?;
        let nav = manager.nav_stack();
        nav.tabs.get(nav.active).map(|t| t.url.to_string())
    }

    /// 状态迁移发射（`browser://state-changed`，payload `{ state, url? }`）。
    fn emit_state_changed(&self, state: &BrowserState) {
        let Some(emitter) = self
            .emitter
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            return;
        };
        let payload = StatusPayload {
            state: panel_state_str(
                state,
                self.ever_started.load(Ordering::SeqCst),
                self.manager.is_none(),
            ),
            url: self.current_url(),
            reason: None,
        };
        let json = match serde_json::to_string(&payload) {
            Ok(json) => json,
            Err(error) => {
                tracing::error!(target: "browser", error = %error, "状态载荷序列化失败（跳过发射）");
                return;
            }
        };
        emitter.emit("browser://state-changed", &json);
    }

    /// 崩溃事件发射（`browser://state-changed`，payload `{ state: "crashed",
    /// reason }`；评审 F7：面板崩溃态带原因，前端兼容解析）。
    pub(super) fn emit_crash(&self, reason: &CrashReason) {
        let Some(emitter) = self
            .emitter
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            return;
        };
        let payload = StatusPayload {
            state: "crashed",
            url: self.current_url(),
            reason: Some(format!("{reason:?}")),
        };
        let json = match serde_json::to_string(&payload) {
            Ok(json) => json,
            Err(error) => {
                tracing::error!(target: "browser", error = %error, "崩溃载荷序列化失败（跳过发射）");
                return;
            }
        };
        emitter.emit("browser://state-changed", &json);
    }
}
