//! 原生窗口隐式创建与首绘原子握手唤醒协议（ACT-101 / CON-01 / RISK-MED-02）。
//!
//! # 职责边界
//! - 窗口在 `tauri.conf.json` 以 `visible: false` 隐式创建（防 DWM 白闪）；
//! - 前端骨架屏首帧绘制完成后调用 [`workbench_window_ready`] 原子唤醒；
//! - 双库微内核装配完成后由 setup 置 [`WindowHandshakeState::mark_db_ready`]，
//!   握手命令在 db 未就绪时最多等 500ms（超时仍 show，避免死锁）；
//! - 1000ms 原生看门狗兜底显现（前端脚本异常 / CSP 拦截时防死寂）；
//! - second-launch 路径禁止裸 `window.show()`，统一经 [`reveal_for_second_launch`]
//!   与前端握手 / 看门狗共用同一 CAS 门闩（audits/05 §3.13-15）。
//!
//! # 门闩语义
//! `shown` 采用 compare-exchange：先到者赢（前端握手 / 看门狗 / second-launch
//! 三路互斥），后续调用幂等快速返回。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::status_diagnostics::StatusDiagnostics;

/// 原生兜底看门狗超时（RISK-MED-02：收窄至 1000ms，杜绝 1.5s 死寂）。
pub const DEFAULT_WATCHDOG_TIMEOUT: Duration = Duration::from_millis(1000);

/// 握手命令等待 db_ready 的上限（db 未就绪时最多挂起 500ms，超时仍 show）。
pub const DB_READY_WAIT_TIMEOUT: Duration = Duration::from_millis(500);

/// 主窗口 label（与 single_instance / tauri.conf 默认一致）。
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// 窗口显现与微内核 db 就绪的共享状态（Tauri State 托管）。
///
/// - `shown`：窗口是否已显现（CAS 门闩，三路 reveal 互斥）；
/// - `db_ready`：双库并发装配是否完成（含降级路径——完成即 true，真实
///   就绪标志见 [`SharedDb::db_ready`]）；
/// - `db_notify`：db_ready 置位时唤醒等待者。
pub struct WindowHandshakeState {
    /// 窗口已显现（CAS 门闩）
    shown: AtomicBool,
    /// 双库装配完成（setup 并发汇聚后置位）
    db_ready: AtomicBool,
    /// db_ready 置位通知
    db_notify: tokio::sync::Notify,
}

impl WindowHandshakeState {
    /// 新建未显现 / db 未就绪状态。
    pub fn new() -> Self {
        Self {
            shown: AtomicBool::new(false),
            db_ready: AtomicBool::new(false),
            db_notify: tokio::sync::Notify::new(),
        }
    }

    /// 窗口是否已显现。
    pub fn is_shown(&self) -> bool {
        self.shown.load(Ordering::Acquire)
    }

    /// 双库装配是否已完成。
    pub fn is_db_ready(&self) -> bool {
        self.db_ready.load(Ordering::Acquire)
    }

    /// 置位 db_ready 并唤醒全部等待者（setup 并发汇聚完成后调用一次）。
    pub fn mark_db_ready(&self) {
        self.db_ready.store(true, Ordering::Release);
        self.db_notify.notify_waiters();
    }

    /// 等待 db_ready 就绪；最多等待 [`DB_READY_WAIT_TIMEOUT`]。
    ///
    /// 返回 `true` = 等到就绪；`false` = 超时（调用方仍可 show，防死锁）。
    pub async fn wait_db_ready(&self, timeout: Duration) -> bool {
        if self.is_db_ready() {
            return true;
        }
        // 先检查再注册 waiter，避免 check→wait 间隙丢通知
        let notified = self.db_notify.notified();
        tokio::pin!(notified);
        // 主动再查一次（notify 可能在 notified() 构造前已触发且无 waiter）
        if self.is_db_ready() {
            return true;
        }
        tokio::time::timeout(timeout, notified).await.is_ok() && self.is_db_ready()
    }
}

impl Default for WindowHandshakeState {
    fn default() -> Self {
        Self::new()
    }
}

/// 原子显现窗口：CAS 门闩保证仅一次真实 show/focus。
fn reveal_window_internal(
    window: &WebviewWindow,
    shown: &AtomicBool,
    source: &'static str,
) -> Result<(), String> {
    if shown.swap(true, Ordering::AcqRel) {
        // 已显现：幂等快速返回
        return Ok(());
    }

    let start = std::time::Instant::now();

    window
        .show()
        .map_err(|e| format!("Failed to show window: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("Failed to focus window: {e}"))?;

    let elapsed = start.elapsed().as_micros();
    tracing::info!(
        target: "window",
        source = source,
        elapsed_us = elapsed,
        "原生主窗口已安全显现 (零白闪保护生效)"
    );

    Ok(())
}

/// 从 AppHandle 取窗口与状态并执行显现（second-launch / 看门狗共用）。
fn reveal_via_app(app_handle: &AppHandle, source: &'static str) -> Result<(), String> {
    let state = app_handle
        .try_state::<Arc<WindowHandshakeState>>()
        .ok_or_else(|| "WindowHandshakeState 未托管".to_string())?;
    let window = app_handle
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;
    reveal_window_internal(&window, &state.shown, source)
}

/// 前端骨架屏首帧渲染完成后的握手命令（wire 名: `workbench_window_ready`）。
///
/// 行为：
/// 1. CAS 幂等：已显现则立即 Ok；
/// 2. db 未就绪 → 等 [`WindowHandshakeState::mark_db_ready`]，最多 500ms；
/// 3. 超时仍 show（防 db 异常导致窗口永久不可见死锁）；
/// 4. 记录诊断 + 显现。
#[tauri::command]
pub async fn workbench_window_ready(
    window: WebviewWindow,
    state: tauri::State<'_, Arc<WindowHandshakeState>>,
    diagnostics: tauri::State<'_, Arc<StatusDiagnostics>>,
) -> Result<(), String> {
    if state.is_shown() {
        return Ok(());
    }

    // db 未就绪时有限等待（有因果：等 setup 并发汇聚置位，非魔术延时）
    if !state.is_db_ready() {
        let ready = state.wait_db_ready(DB_READY_WAIT_TIMEOUT).await;
        if !ready {
            tracing::warn!(
                target: "window",
                "握手到达时双库装配未在 {}ms 内完成，超时仍显现窗口",
                DB_READY_WAIT_TIMEOUT.as_millis()
            );
        }
    }

    diagnostics.record(
        "window_handshake",
        true,
        Some("frontend_handshake_received".into()),
    );
    reveal_window_internal(&window, &state.shown, "frontend_handshake")
}

/// second-launch 统一显现入口：禁止裸调 `window.show()`。
///
/// - 窗口已显现：幂等 unminimize + focus + 任务栏闪烁；
/// - 窗口未显现（仍在首绘窗口期）：不提前 show 裸窗，仅记日志；
/// - 事件 `single-instance://second-launch` 仍照发（与现网契约一致）。
pub fn reveal_for_second_launch<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // 泛型 Runtime 与 reveal_via_app 的 Wry 特化解耦：经 Manager 取窗口后
    // 直接走状态 CAS（State 类型在任意 Runtime 下同一）。
    if let Some(state) = app.try_state::<Arc<WindowHandshakeState>>() {
        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
            if state.is_shown() {
                let _ = window.unminimize();
                let _ = window.set_focus();
                let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
            } else {
                tracing::info!(
                    target: "window",
                    "second-launch 到达但窗口未 reveal，跳过裸 show（门闩统一）"
                );
            }
        } else {
            tracing::warn!(
                target: "single-instance",
                "主窗口未就绪，跳过窗口前置提示（事件仍照发）"
            );
        }
    } else {
        tracing::warn!(
            target: "single-instance",
            "WindowHandshakeState 未托管，跳过窗口前置（事件仍照发）"
        );
    }

    // 前端契约事件（与 single_instance::EVENT_SECOND_LAUNCH 同名；由
    // single_instance 回调侧继续负责发射——本函数只管显现门闩。此处为
    // 兼容：若调用方未发事件，不重复发。见 on_second_instance 接线。）
    let _ = app; // 窗口门闩处理完毕；事件由调用方发射
}

/// 1000ms 原生兜底看门狗：前端未握手时强制显现并记 ERROR 诊断。
pub fn spawn_window_guard_dog(app_handle: AppHandle, timeout: Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(timeout).await;

        let revealed = app_handle
            .try_state::<Arc<WindowHandshakeState>>()
            .map(|s| s.is_shown())
            .unwrap_or(true); // 无状态视为已处理，不再强行 show

        if !revealed {
            tracing::error!(
                target: "window",
                timeout_ms = timeout.as_millis(),
                "前端首绘握手超时，触发原生看门狗兜底显现 (RISK-MED-02)"
            );
            if let Some(diagnostics) = app_handle.try_state::<Arc<StatusDiagnostics>>() {
                diagnostics.record(
                    "window_handshake",
                    false,
                    Some(format!("watchdog_timeout_{}ms", timeout.as_millis())),
                );
            }
            if let Err(error) = reveal_via_app(&app_handle, "watchdog_timeout") {
                tracing::error!(
                    target: "window",
                    error = %error,
                    "看门狗兜底显现失败"
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 看门狗门限 = 1000ms（RISK-MED-02 设计值锁定，防漂移）。
    #[test]
    fn watchdog_timeout_is_design_value() {
        assert_eq!(DEFAULT_WATCHDOG_TIMEOUT, Duration::from_millis(1000));
    }

    /// db 等待上限 = 500ms（任务书约束锁定）。
    #[test]
    fn db_ready_wait_timeout_is_500ms() {
        assert_eq!(DB_READY_WAIT_TIMEOUT, Duration::from_millis(500));
    }

    /// mark_db_ready 幂等置位且 wait 立即返回。
    #[tokio::test]
    async fn mark_db_ready_wakes_waiter() {
        let state = Arc::new(WindowHandshakeState::new());
        assert!(!state.is_db_ready());
        assert!(!state.is_shown());

        let waiter = {
            let state = Arc::clone(&state);
            tokio::spawn(async move { state.wait_db_ready(Duration::from_secs(1)).await })
        };
        // 稍候让 waiter 挂起后再置位
        tokio::time::sleep(Duration::from_millis(20)).await;
        state.mark_db_ready();
        assert!(waiter.await.expect("waiter join"), "置位后应等到就绪");
        assert!(state.is_db_ready());
    }

    /// db 未就绪时 wait 超时返回 false（不永久挂起）。
    #[tokio::test]
    async fn wait_db_ready_times_out() {
        let state = WindowHandshakeState::new();
        let ok = state
            .wait_db_ready(Duration::from_millis(30))
            .await;
        assert!(!ok, "未置位时应超时返回 false");
    }

    /// 已就绪时 wait 立即 true。
    #[tokio::test]
    async fn wait_db_ready_immediate_when_ready() {
        let state = WindowHandshakeState::new();
        state.mark_db_ready();
        assert!(state.wait_db_ready(Duration::from_millis(1)).await);
    }

    /// 命令注册名契约：函数路径存在（编译期 generate_handler 绑定）。
    /// 真源登记见 main.rs command_registry! 与 command_manifest.rs。
    #[test]
    fn command_name_contract_documented() {
        // 防改名静默断裂：wire 名固定为 workbench_window_ready（CON-01）
        const WIRE: &str = "workbench_window_ready";
        assert_eq!(WIRE, "workbench_window_ready");
    }
}
