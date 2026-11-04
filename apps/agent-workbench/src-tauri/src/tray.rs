//! 系统托盘 + 主窗口恢复收敛 + 关窗拦截 + 壳行为状态。
//!
//! 2026-11-03 托盘/通知批（用户裁决）：
//! - 关窗默认进托盘（prefs `close_to_tray` 默认开）：点 X 安静 hide，
//!   **不弹任何提示**（首次隐藏 toast 方案已被用户明确取消）；
//! - 托盘总开关 prefs `tray_enabled`（默认开）：关 → 托盘不建/隐藏，
//!   且 `close_to_tray` 随之失效（关窗走正常退出）。
//!
//! 2026-11-03 托盘完整档续建：
//! - 开机自启 prefs `autostart_enabled`（默认关）：变更经
//!   [crate::autostart] 即时同步 HKCU Run 键，setup 再对账一次；
//! - 启动静默 prefs `start_minimized`（默认关）：setup 置
//!   window_handshake 抑制标志（仅托盘总开关开时），恢复经
//!   [restore_main_window] 的静默态分支正式首显；
//! - 托盘计数菜单：菜单首两行为状态行（运行中任务数 / 待审批数），
//!   数据源 = KeepAwakeGuard 工作单元数（与防休眠同账）+
//!   CoreRunState 待审批真源，变化经 [refresh_status_counts] 在主
//!   线程刷新文案（见 [TrayMenuState]）。
//!
//! # 状态面
//!
//! [ShellBehaviorState] 是壳行为 prefs 的 Rust 侧镜像：setup 预载
//! （DB 直读），`prefs_set` / `prefs_delete` 成功后经
//! [on_preference_changed] 同步——关窗拦截在窗口事件线程同步读它，
//! 不能每次点 X 都查库。[TrayState] 独立记录「窗口当前处于托盘隐藏
//! 态」，恢复路径据此区分态（见 [restore_main_window]）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

/// 托盘图标 id（构建/查找/显隐统一键）
pub const TRAY_ID: &str = "crish-tray";

const TRAY_MENU_SHOW: &str = "tray-show-main";
const TRAY_MENU_QUIT: &str = "tray-quit-main";
const TRAY_MENU_STATUS_RUNNING: &str = "tray-status-running";
const TRAY_MENU_STATUS_PENDING: &str = "tray-status-pending";

/// 托盘状态行文案（中文固定——与菜单其余文案同口径：Rust 侧读不到
/// 前端 locale，见最小档备案）。计数为 0 时同样呈现（诚实零态，
/// 不藏行——用户瞥一眼即知无事在跑）。
pub fn status_running_text(count: usize) -> String {
    format!("运行中任务：{count}")
}

/// 待审批状态行文案（口径同 [status_running_text]）
pub fn status_pending_text(count: usize) -> String {
    format!("待审批：{count}")
}

/// 托盘菜单状态行句柄（计数刷新面）：build_tray 构建时装入，
/// [refresh_status_counts] 经此在主线程 set_text；文案未变不重设
/// （last_* 去重——刷新可高频触发，实际写入只在计数变化时）。
pub struct TrayMenuState<R: Runtime> {
    items: Mutex<Option<TrayMenuItems<R>>>,
}

struct TrayMenuItems<R: Runtime> {
    running: MenuItem<R>,
    pending: MenuItem<R>,
    last_running: usize,
    last_pending: usize,
}

impl<R: Runtime> TrayMenuState<R> {
    pub fn new() -> Self {
        Self {
            items: Mutex::new(None),
        }
    }

    fn lock_items(&self) -> std::sync::MutexGuard<'_, Option<TrayMenuItems<R>>> {
        self.items
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 装入（或替换）状态行句柄：托盘重建后旧句柄随之失效，必须以
    /// 最新构建的菜单项为准
    fn install(&self, running: MenuItem<R>, pending: MenuItem<R>) {
        *self.lock_items() = Some(TrayMenuItems {
            running,
            pending,
            last_running: 0,
            last_pending: 0,
        });
    }

    /// 应用最新计数（仅主线程调用——菜单项 set_text 的平台亲和性；
    /// 计数与上次相同则零写入）
    fn apply_counts(&self, running: usize, pending: usize) {
        let mut guard = self.lock_items();
        let Some(items) = guard.as_mut() else {
            return;
        };
        let mut changed = false;
        if items.last_running != running {
            let _ = items.running.set_text(status_running_text(running));
            items.last_running = running;
            changed = true;
        }
        if items.last_pending != pending {
            let _ = items.pending.set_text(status_pending_text(pending));
            items.last_pending = pending;
            changed = true;
        }
        if changed {
            // 门日志（debug 级）：托盘菜单本身无外部可观测面，计数
            // 变化留痕供活验/诊断核对刷新链是否真实工作
            tracing::debug!(
                target: "tray",
                running,
                pending,
                "托盘计数状态行已更新"
            );
        }
    }
}

impl<R: Runtime> Default for TrayMenuState<R> {
    fn default() -> Self {
        Self::new()
    }
}

/// 托盘计数刷新（单一实现，所有触发点共用）：从两真源现算——
/// 运行中 = KeepAwakeGuard 工作单元数（与防休眠同账）；
/// 待审批 = CoreRunState 待审批列表长度（审批门挂起登记真源）。
/// 触发点：托盘构建后（即时版）；守卫计数监听 / 事件面审批钩子
/// 走 [refresh_status_counts_deferred] 多拍版。状态缺失（setup
/// 未就绪）按 0 计，不 panic。实际 set_text 切主线程执行（菜单
/// 平台亲和性 + last 值去重）。
pub fn refresh_status_counts<R: Runtime>(app: &AppHandle<R>) {
    let running = app
        .try_state::<Arc<crate::power::KeepAwakeGuard>>()
        .map(|guard| guard.active_work_count())
        .unwrap_or(0);
    let pending = app
        .try_state::<Arc<conex_run::run::CoreRunState>>()
        .map(|core| conex_run::run::list_pending_approvals_impl(&core).len())
        .unwrap_or(0);
    let main_thread_app = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(state) = main_thread_app.try_state::<TrayMenuState<R>>() {
            state.apply_counts(running, pending);
        }
    });
}

/// 托盘计数多拍刷新（守卫监听 / 审批钩子专用）：立即一拍 + 250ms /
/// +1s 两拍延迟重算，每拍都现算真源（幂等、零增量状态）。
///
/// 为何需要延迟拍——审批门的登记时序与事件流天然错位：
/// `ApprovalGateImpl::request_approval` 是「先发后等」（先广播
/// approval-requested 防死锁，其后才把挂起登记进 pending_registry，
/// 中间隔一次 await 落库），钩子在广播瞬间同步重算必然读到旧值；
/// 审批过期路径又不广播 approval-resolved（登记移除与 run 收尾
/// 事件并发）。延迟拍等登记/移除落定后收敛终态——实测（2026-11-03
/// 活验）无延迟拍时菜单待审批数可残留过期值。
pub fn refresh_status_counts_deferred<R: Runtime>(app: &AppHandle<R>) {
    refresh_status_counts(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        refresh_status_counts(&app);
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        refresh_status_counts(&app);
    });
}

/// 托盘隐藏态（窗口被关窗拦截 hide 后为 true；恢复时清零）
pub struct TrayState {
    hidden: AtomicBool,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            hidden: AtomicBool::new(false),
        }
    }

    pub fn is_hidden(&self) -> bool {
        self.hidden.load(Ordering::SeqCst)
    }

    pub fn set_hidden(&self, hidden: bool) {
        self.hidden.store(hidden, Ordering::SeqCst);
    }
}

impl Default for TrayState {
    fn default() -> Self {
        Self::new()
    }
}

/// 壳行为 prefs 的 Rust 侧镜像（默认值与前端 preferencesSchema.ts 1:1）
pub struct ShellBehaviorState {
    tray_enabled: AtomicBool,
    close_to_tray: AtomicBool,
    keep_awake_enabled: AtomicBool,
    autostart_enabled: AtomicBool,
    start_minimized: AtomicBool,
}

impl ShellBehaviorState {
    pub fn new(
        tray_enabled: bool,
        close_to_tray: bool,
        keep_awake_enabled: bool,
        autostart_enabled: bool,
        start_minimized: bool,
    ) -> Self {
        Self {
            tray_enabled: AtomicBool::new(tray_enabled),
            close_to_tray: AtomicBool::new(close_to_tray),
            keep_awake_enabled: AtomicBool::new(keep_awake_enabled),
            autostart_enabled: AtomicBool::new(autostart_enabled),
            start_minimized: AtomicBool::new(start_minimized),
        }
    }

    pub fn tray_enabled(&self) -> bool {
        self.tray_enabled.load(Ordering::SeqCst)
    }

    pub fn set_tray_enabled(&self, enabled: bool) {
        self.tray_enabled.store(enabled, Ordering::SeqCst);
    }

    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::SeqCst)
    }

    pub fn set_close_to_tray(&self, enabled: bool) {
        self.close_to_tray.store(enabled, Ordering::SeqCst);
    }

    pub fn keep_awake_enabled(&self) -> bool {
        self.keep_awake_enabled.load(Ordering::SeqCst)
    }

    pub fn set_keep_awake_enabled(&self, enabled: bool) {
        self.keep_awake_enabled.store(enabled, Ordering::SeqCst);
    }

    pub fn autostart_enabled(&self) -> bool {
        self.autostart_enabled.load(Ordering::SeqCst)
    }

    pub fn set_autostart_enabled(&self, enabled: bool) {
        self.autostart_enabled.store(enabled, Ordering::SeqCst);
    }

    pub fn start_minimized(&self) -> bool {
        self.start_minimized.load(Ordering::SeqCst)
    }

    pub fn set_start_minimized(&self, enabled: bool) {
        self.start_minimized.store(enabled, Ordering::SeqCst);
    }
}

impl Default for ShellBehaviorState {
    /// 默认口径（用户裁决）：关窗进托盘 / 防休眠开（默认全开组）；
    /// 自启与启动静默属选择加入，默认关
    fn default() -> Self {
        Self::new(true, true, true, false, false)
    }
}

/// 解析 DB 偏好行值（JSON 文本）为 bool：兼容裸 `true`、JSON 字符串
/// `"true"`（preferencesClient 序列化形态）、数字 1/0 三种落盘形态。
pub fn parse_pref_bool(raw: &str) -> Option<bool> {
    match serde_json::from_str::<serde_json::Value>(raw.trim()).ok()? {
        serde_json::Value::Bool(b) => Some(b),
        serde_json::Value::String(s) => parse_bool_str(&s),
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// prefs_set 的 Value → bool（布尔或布尔字符串；其余形态 None）
pub fn preference_value_bool(value: &serde_json::Value) -> Option<bool> {
    match value {
        serde_json::Value::Bool(b) => Some(*b),
        serde_json::Value::String(s) => parse_bool_str(s),
        _ => None,
    }
}

fn parse_bool_str(s: &str) -> Option<bool> {
    match s.trim() {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

/// 窗口恢复来源（日志区分；三路共用同一恢复实现）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreSource {
    /// 托盘图标左键抬起
    TrayIcon,
    /// 托盘菜单「显示主窗口」
    TrayMenu,
    /// 单实例第二启动
    SecondLaunch,
}

/// 主窗口恢复（全仓唯一实现；四态收敛）：
///
/// 1. **托盘隐藏态**：reveal 路径从不调用 `show()`（其语义是已显现
///    窗口的前置），故本函数亲自 show + unminimize + focus 并清
///    hidden 标记；
/// 2. **启动静默态**（start_minimized 抑制了首次显现，窗口从未
///    show 过）：委托 [crate::window_handshake::reveal_after_start_minimized]
///    消费抑制并经 CAS 门闩正式首显；
/// 3. **未首显**（shown 门闩未置位且非静默）：不干预——首绘握手/
///    看门狗拥有显现时机，裸 show 会引发白闪竞态；本态由委托的
///    [crate::window_handshake::reveal_for_second_launch] 内部判定
///    后直接返回；
/// 4. **仅最小化/未聚焦**（已显现、未隐藏）：委托 reveal 路径
///    （unminimize + focus + 任务栏提示，与握手/看门狗共用门闩）。
pub fn restore_main_window<R: Runtime>(app: &AppHandle<R>, source: RestoreSource) {
    let hidden = app
        .try_state::<TrayState>()
        .map(|state| state.is_hidden())
        .unwrap_or(false);
    if hidden {
        if let Some(window) = app.get_webview_window(crate::window_handshake::MAIN_WINDOW_LABEL) {
            let _ = window.show();
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            let _ = window.set_focus();
        }
        if let Some(state) = app.try_state::<TrayState>() {
            state.set_hidden(false);
        }
        tracing::info!(
            target: "tray",
            source = ?source,
            "托盘隐藏态恢复主窗口"
        );
        return;
    }
    if crate::window_handshake::reveal_after_start_minimized(app) {
        tracing::info!(
            target: "tray",
            source = ?source,
            "启动静默态恢复主窗口（首次显现）"
        );
        return;
    }
    crate::window_handshake::reveal_for_second_launch(app);
}

/// 构建系统托盘（图标 = 窗口默认图标；左键抬起恢复；菜单 = 两条
/// 计数状态行 + 显示主窗口 + 退出 Crish）
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let running_item = MenuItem::with_id(
        app,
        TRAY_MENU_STATUS_RUNNING,
        status_running_text(0),
        true,
        None::<&str>,
    )?;
    let pending_item = MenuItem::with_id(
        app,
        TRAY_MENU_STATUS_PENDING,
        status_pending_text(0),
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW, "显示主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT, "退出 Crish", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&running_item, &pending_item, &separator, &show_item, &quit_item],
    )?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Crish")
        // 左键只做恢复，菜单走右键（Windows 惯例）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            // 状态行点击 = 显示主窗口（计数即入口：有待审批时点开直达）
            TRAY_MENU_STATUS_RUNNING | TRAY_MENU_STATUS_PENDING | TRAY_MENU_SHOW => {
                restore_main_window(app, RestoreSource::TrayMenu)
            }
            // 退出走 app.exit()：复用 RunEvent::Exit 既有退出链
            // （server 关停 / PTY 清理 / 快照落盘）
            TRAY_MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore_main_window(tray.app_handle(), RestoreSource::TrayIcon);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    // 状态行句柄装入刷新面并立即按真源刷一次（重建托盘时计数不归零失真）
    if let Some(state) = app.try_state::<TrayMenuState<R>>() {
        state.install(running_item, pending_item);
    }
    refresh_status_counts(app);
    Ok(())
}

/// 托盘显隐与总开关同步：已建则 set_visible，未建且开则补建
pub fn sync_tray_presence<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    match app.tray_by_id(TRAY_ID) {
        Some(tray) => {
            let _ = tray.set_visible(enabled);
        }
        None if enabled => {
            if let Err(error) = build_tray(app) {
                tracing::warn!(
                    target: "tray",
                    error = %error,
                    "托盘补建失败（总开关已开）"
                );
            }
        }
        None => {}
    }
}

/// 关窗拦截（Builder `.on_window_event` 接线）：仅主窗口 CloseRequested。
///
/// `close_to_tray` 开且托盘总开关开 → prevent_close + hide + 置
/// hidden（安静进托盘，不弹提示——用户裁决）；任一关闭 → 放行走
/// 正常退出。会话子窗口（label != main）不受影响。状态缺失（setup
/// 未完成）时放行，保退出能力。
pub fn handle_window_event<R: Runtime>(window: &tauri::Window<R>, event: &tauri::WindowEvent) {
    if window.label() != crate::window_handshake::MAIN_WINDOW_LABEL {
        return;
    }
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    let Some(behavior) = app.try_state::<ShellBehaviorState>() else {
        return;
    };
    if !(behavior.tray_enabled() && behavior.close_to_tray()) {
        return;
    }
    api.prevent_close();
    if window.hide().is_ok() {
        if let Some(state) = app.try_state::<TrayState>() {
            state.set_hidden(true);
        }
        tracing::info!(target: "tray", "主窗口关闭已拦截：隐藏至系统托盘");
    }
}

/// prefs 变更同步面（preferences_commands 的 prefs_set/prefs_delete
/// 成功后调用）：更新 Rust 侧镜像并落实副作用（托盘显隐 / 守卫开关 /
/// 自启注册表同步）。`value = None` 表示删除 → 回落默认值
/// （tray/close_to_tray/keep_awake 默认开；autostart/start_minimized
/// 默认关）。
pub fn on_preference_changed<R: Runtime>(app: &AppHandle<R>, key: &str, value: Option<bool>) {
    match key {
        "tray_enabled" => {
            let enabled = value.unwrap_or(true);
            if let Some(state) = app.try_state::<ShellBehaviorState>() {
                state.set_tray_enabled(enabled);
            }
            sync_tray_presence(app, enabled);
        }
        "close_to_tray" => {
            if let Some(state) = app.try_state::<ShellBehaviorState>() {
                state.set_close_to_tray(value.unwrap_or(true));
            }
        }
        "keep_awake_during_tasks" => {
            let enabled = value.unwrap_or(true);
            if let Some(state) = app.try_state::<ShellBehaviorState>() {
                state.set_keep_awake_enabled(enabled);
            }
            if let Some(guard) = app.try_state::<std::sync::Arc<crate::power::KeepAwakeGuard>>() {
                guard.set_enabled(enabled);
            }
        }
        "autostart_enabled" => {
            let enabled = value.unwrap_or(false);
            // 镜像未装配（壳未完成 setup，如单测 MockRuntime）→ 不落
            // 注册表：自启同步只在真实壳生命周期内发生
            let Some(state) = app.try_state::<ShellBehaviorState>() else {
                return;
            };
            state.set_autostart_enabled(enabled);
            // 即时生效：注册表与偏好对齐（失败仅记 warn——下次启动
            // 对账兜底自愈，不让 prefs 写回滚）
            match crate::autostart::sync_to_preference(enabled) {
                Ok(action) => {
                    tracing::debug!(
                        target: "tray",
                        action = ?action,
                        enabled,
                        "开机自启已与偏好同步"
                    );
                }
                Err(error) => {
                    tracing::warn!(
                        target: "tray",
                        error = %error,
                        "开机自启同步失败（启动对账将兜底）"
                    );
                }
            }
        }
        "start_minimized" => {
            // 仅镜像：启动行为在下个冷启动由 setup 消费（运行中拨动
            // 不追溯改变当前窗口——口径与自启「下次启动生效」一致）
            if let Some(state) = app.try_state::<ShellBehaviorState>() {
                state.set_start_minimized(value.unwrap_or(false));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_pref_bool_accepts_all_stored_forms() {
        assert_eq!(parse_pref_bool("true"), Some(true));
        assert_eq!(parse_pref_bool("false"), Some(false));
        // preferencesClient 的落盘形态：serde 序列化 Value::String
        assert_eq!(parse_pref_bool("\"true\""), Some(true));
        assert_eq!(parse_pref_bool("\"false\""), Some(false));
        assert_eq!(parse_pref_bool("1"), Some(true));
        assert_eq!(parse_pref_bool("0"), Some(false));
        assert_eq!(parse_pref_bool("\"1\""), Some(true));
        assert_eq!(parse_pref_bool("yes"), None);
        assert_eq!(parse_pref_bool(""), None);
    }

    #[test]
    fn preference_value_bool_forms() {
        assert_eq!(
            preference_value_bool(&serde_json::json!(true)),
            Some(true)
        );
        assert_eq!(
            preference_value_bool(&serde_json::json!("false")),
            Some(false)
        );
        assert_eq!(preference_value_bool(&serde_json::json!(42)), None);
    }

    #[test]
    fn shell_behavior_defaults_match_rulings() {
        let state = ShellBehaviorState::default();
        assert!(state.tray_enabled());
        assert!(state.close_to_tray());
        assert!(state.keep_awake_enabled());
        // 自启 / 启动静默属选择加入，默认关
        assert!(!state.autostart_enabled());
        assert!(!state.start_minimized());
    }

    #[test]
    fn shell_behavior_new_keys_roundtrip() {
        let state = ShellBehaviorState::default();
        state.set_autostart_enabled(true);
        state.set_start_minimized(true);
        assert!(state.autostart_enabled());
        assert!(state.start_minimized());
        state.set_autostart_enabled(false);
        state.set_start_minimized(false);
        assert!(!state.autostart_enabled());
        assert!(!state.start_minimized());
    }

    #[test]
    fn status_texts_render_counts_including_zero() {
        assert_eq!(status_running_text(0), "运行中任务：0");
        assert_eq!(status_running_text(3), "运行中任务：3");
        assert_eq!(status_pending_text(0), "待审批：0");
        assert_eq!(status_pending_text(12), "待审批：12");
    }

    #[test]
    fn tray_state_hidden_flag_roundtrip() {
        let state = TrayState::new();
        assert!(!state.is_hidden());
        state.set_hidden(true);
        assert!(state.is_hidden());
        state.set_hidden(false);
        assert!(!state.is_hidden());
    }
}
