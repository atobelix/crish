//! Windows 11 贴靠布局（Snap Layouts）原生热区：盖在前端最大化按钮上的透明子 HWND。
//!
//! # 为什么不子类化主窗口
//! 主窗口 `decorations: false`，客户区被 WebView2 子窗口整片覆盖。光标停在前端最大化
//! 按钮上时，系统把 `WM_NCHITTEST` 发给 WebView2 的子窗口（跨进程的
//! `Chrome_RenderWidgetHostHWND`），主窗口的窗口过程收不到这条消息；对主窗口
//! `SetWindowSubclass` 并返回 `HTMAXBUTTON` 不会生效。
//!
//! # 做法
//! 在主窗口下建一个不绘制的子窗口（`WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS`，无扩展
//! 样式、无背景画刷；`WS_EX_LAYERED` 会丢命中测试，`WS_EX_TRANSPARENT` 会让命中测试穿透），
//! Z 序置顶，恰好盖住前端最大化按钮。它对 `WM_NCHITTEST` 恒返回 `HTMAXBUTTON`，系统据此在
//! 悬停时弹出贴靠布局面板。这块区域的鼠标被它接管，所以：
//! - 悬停 / 按下 / 抬起经 [`SNAP_OVERLAY_EVENT`] 回传前端，前端据此画 hover / active；
//! - 点击（非客户区左键抬起）在这里直接执行最大化 / 还原（走 Tauri 窗口 API，保持 tao 状态一致）。
//!
//! # 矩形来源
//! 前端测量按钮 `getBoundingClientRect()`（CSS 逻辑像素，相对视口 = 主窗口客户区），经
//! `workbench_set_snap_overlay_rect` 上报；本模块乘当前 `scale_factor` 换成物理像素。
//! 前端在按钮尺寸变化、窗口 resize、DPR 变化时重报；无边框窗口最大化后客户区仍以 (0,0)
//! 起算（tao 已处理 `WM_NCCALCSIZE`），无需额外偏移。
//!
//! # 失败语义（QUALITY-GATE：失败可观测，不静默）
//! - 建窗 / 定位失败：`tracing::warn!` 记录并让命令返回 `Err`，前端记 warn 后保持普通点击实现；
//! - 非 Windows：命令返回 `Ok(false)`（平台不提供该能力），前端同样走普通点击。

#[cfg(windows)]
use conex_run::core_error::map_internal_string;
use conex_run::core_error::CoreError;
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

/// 原生热区 → 前端的指针事件（payload = [`SnapOverlayEventPayload`]）。
pub const SNAP_OVERLAY_EVENT: &str = "crish://window-snap-overlay";

/// 前端上报的最大化按钮矩形（CSS 逻辑像素，相对主窗口客户区左上角）。
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapButtonRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 物理像素矩形（客户区坐标）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 逻辑像素坐标的合理上限（远大于任何显示器，防 NaN/溢出类脏数据）。
const MAX_LOGICAL_COORD: f64 = 100_000.0;

/// 逻辑矩形 → 物理矩形。四条边各自四舍五入，保证相邻按钮之间不留缝、也不重叠超过 1px。
pub fn to_physical(rect: &SnapButtonRect, scale: f64) -> Result<PhysicalRect, String> {
    let values = [rect.x, rect.y, rect.width, rect.height, scale];
    if values.iter().any(|v| !v.is_finite()) {
        return Err(format!("按钮矩形含非有限数值: {rect:?} @ scale={scale}"));
    }
    if scale <= 0.0 {
        return Err(format!("缩放比例必须为正: {scale}"));
    }
    if rect.width <= 0.0 || rect.height <= 0.0 {
        return Err(format!("按钮矩形宽高必须为正: {rect:?}"));
    }
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    if [rect.x, rect.y, right, bottom]
        .iter()
        .any(|v| v.abs() > MAX_LOGICAL_COORD)
    {
        return Err(format!("按钮矩形越界: {rect:?}"));
    }
    // 越界已排除，四舍五入后必在 i32 范围内
    #[allow(clippy::cast_possible_truncation)]
    let px = |v: f64| (v * scale).round() as i32;
    let (left, top) = (px(rect.x), px(rect.y));
    let (right, bottom) = (px(right), px(bottom));
    Ok(PhysicalRect {
        x: left,
        y: top,
        width: (right - left).max(1),
        height: (bottom - top).max(1),
    })
}

/// 原生热区回传给前端的指针阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapOverlayPhase {
    Enter,
    Leave,
    Press,
    Release,
}

impl SnapOverlayPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Enter => "enter",
            Self::Leave => "leave",
            Self::Press => "press",
            Self::Release => "release",
        }
    }
}

/// [`SNAP_OVERLAY_EVENT`] 的 payload（`{ "phase": "enter" | "leave" | "press" | "release" }`）。
#[derive(Debug, Clone, Serialize)]
pub struct SnapOverlayEventPayload {
    pub phase: &'static str,
}

/// 上报（`Some`）或撤销（`None`）最大化按钮的贴靠热区（wire 名：`workbench_set_snap_overlay_rect`）。
///
/// 返回 `Ok(true)` = 原生热区已覆盖按钮（前端改由 [`SNAP_OVERLAY_EVENT`] 驱动 hover/active）；
/// `Ok(false)` = 已撤销 / 平台不提供；`Err` = 原生热区失效（已记 warn），前端须回退普通点击。
#[cfg(windows)]
#[tauri::command]
pub async fn workbench_set_snap_overlay_rect(
    window: WebviewWindow,
    rect: Option<SnapButtonRect>,
) -> Result<bool, CoreError> {
    let result = platform::apply(window, rect)
        .await
        .map_err(map_internal_string);
    if let Err(err) = &result {
        tracing::warn!(
            target: "window",
            "贴靠布局热区不可用，最大化按钮回退前端点击实现: {err}"
        );
    }
    result
}

/// 非 Windows：无贴靠布局，明确回报 `false`，前端保持普通点击实现。
#[cfg(not(windows))]
#[tauri::command]
pub async fn workbench_set_snap_overlay_rect(
    window: WebviewWindow,
    rect: Option<SnapButtonRect>,
) -> Result<bool, CoreError> {
    let _ = (window, rect);
    Ok(false)
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod platform {
    use std::cell::{Cell, RefCell};

    use tauri::{Emitter, WebviewWindow};
    use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ValidateRect;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, IsWindow, LoadCursorW, RegisterClassExW, SetWindowPos,
        ShowWindow, HTMAXBUTTON, HWND_TOP, IDC_ARROW, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE,
        WM_ERASEBKGND, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN,
        WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_PAINT, WNDCLASSEXW, WS_CHILD,
        WS_CLIPSIBLINGS, WS_VISIBLE,
    };

    use super::{
        to_physical, PhysicalRect, SnapButtonRect, SnapOverlayEventPayload, SnapOverlayPhase,
        SNAP_OVERLAY_EVENT,
    };
    use crate::window_handshake::MAIN_WINDOW_LABEL;

    const CLASS_NAME: &str = "CrishSnapLayoutOverlay";

    struct OverlayState {
        hwnd: HWND,
        parent: HWND,
        window: WebviewWindow,
        hovering: bool,
        pressed: bool,
    }

    thread_local! {
        // 仅主线程访问（建窗、定位、窗口过程都在主线程）
        static OVERLAY: RefCell<Option<OverlayState>> = const { RefCell::new(None) };
        static CLASS_REGISTERED: Cell<bool> = const { Cell::new(false) };
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> u32 {
        // SAFETY：GetLastError 无参数、只读线程错误码
        unsafe { GetLastError() }
    }

    pub(super) async fn apply(
        window: WebviewWindow,
        rect: Option<SnapButtonRect>,
    ) -> Result<bool, String> {
        if window.label() != MAIN_WINDOW_LABEL {
            return Err(format!(
                "贴靠热区只挂主窗口（{MAIN_WINDOW_LABEL}），收到窗口 {}",
                window.label()
            ));
        }
        let physical = match rect {
            Some(r) => {
                let scale = window
                    .scale_factor()
                    .map_err(|e| format!("读取窗口缩放比例失败: {e}"))?;
                Some(to_physical(&r, scale)?)
            }
            None => None,
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(apply_on_main_thread(&target, physical));
            })
            .map_err(|e| format!("投递到主线程失败: {e}"))?;
        rx.await
            .map_err(|_| "主线程未回传贴靠热区结果".to_string())?
    }

    fn apply_on_main_thread(
        window: &WebviewWindow,
        physical: Option<PhysicalRect>,
    ) -> Result<bool, String> {
        let Some(rect) = physical else {
            hide_overlay();
            return Ok(false);
        };
        let parent = window
            .hwnd()
            .map_err(|e| format!("取主窗口 HWND 失败: {e}"))?
            .0 as HWND;
        let hwnd = ensure_overlay(window, parent)?;
        // SAFETY：hwnd 为本线程创建且仍存活的子窗口；HWND_TOP 让它压在 WebView2 之上
        let ok = unsafe {
            SetWindowPos(
                hwnd,
                HWND_TOP,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        if ok == 0 {
            return Err(format!("SetWindowPos 失败 (GetLastError={})", last_error()));
        }
        tracing::debug!(target: "window", ?rect, "贴靠布局热区已定位");
        Ok(true)
    }

    fn ensure_overlay(window: &WebviewWindow, parent: HWND) -> Result<HWND, String> {
        let existing = OVERLAY.with(|cell| {
            cell.borrow()
                .as_ref()
                .filter(|s| s.parent == parent)
                .map(|s| s.hwnd)
        });
        if let Some(hwnd) = existing {
            // SAFETY：IsWindow 只做句柄有效性查询
            if unsafe { IsWindow(hwnd) } != 0 {
                return Ok(hwnd);
            }
        }
        let hwnd = create_overlay(parent)?;
        OVERLAY.with(|cell| {
            *cell.borrow_mut() = Some(OverlayState {
                hwnd,
                parent,
                window: window.clone(),
                hovering: false,
                pressed: false,
            });
        });
        tracing::info!(target: "window", "贴靠布局（Snap Layouts）原生热区已创建");
        Ok(hwnd)
    }

    fn register_class() -> Result<(), String> {
        if CLASS_REGISTERED.with(Cell::get) {
            return Ok(());
        }
        let class_name = wide(CLASS_NAME);
        // SAFETY：GetModuleHandleW(null) 取当前 exe 模块；LoadCursorW(null, IDC_ARROW) 取系统光标；
        // WNDCLASSEXW 全字段初始化，class_name 在调用期间存活（系统内部复制类名）
        let atom = unsafe {
            let class = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                style: 0,
                lpfnWndProc: Some(overlay_wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: GetModuleHandleW(std::ptr::null()),
                hIcon: std::ptr::null_mut(),
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                // 无背景画刷：窗口从不绘制，按钮视觉完全由前端渲染
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
                hIconSm: std::ptr::null_mut(),
            };
            RegisterClassExW(&class)
        };
        if atom == 0 {
            return Err(format!(
                "RegisterClassExW 失败 (GetLastError={})",
                last_error()
            ));
        }
        CLASS_REGISTERED.with(|c| c.set(true));
        Ok(())
    }

    fn create_overlay(parent: HWND) -> Result<HWND, String> {
        register_class()?;
        let class_name = wide(CLASS_NAME);
        // SAFETY：类已注册；parent 为主窗口有效 HWND；尺寸先给 0，随后 SetWindowPos 定位
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                class_name.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                parent,
                std::ptr::null_mut(),
                GetModuleHandleW(std::ptr::null()),
                std::ptr::null(),
            )
        };
        if hwnd.is_null() {
            return Err(format!(
                "CreateWindowExW 失败 (GetLastError={})",
                last_error()
            ));
        }
        Ok(hwnd)
    }

    fn hide_overlay() {
        let Some((hwnd, was_hovering)) = OVERLAY.with(|cell| {
            cell.borrow_mut().as_mut().map(|s| {
                let was = s.hovering || s.pressed;
                s.hovering = false;
                s.pressed = false;
                (s.hwnd, was)
            })
        }) else {
            return;
        };
        // SAFETY：hwnd 为本线程创建的子窗口；隐藏后不再参与命中测试
        unsafe {
            ShowWindow(hwnd, SW_HIDE);
        }
        if was_hovering {
            emit_phase(SnapOverlayPhase::Leave);
        }
    }

    /// 读取并修改状态后立刻释放借用，再做 emit / 窗口操作（避免重入时 RefCell 双借）。
    fn update_state<R>(hwnd: HWND, f: impl FnOnce(&mut OverlayState) -> R) -> Option<R> {
        OVERLAY.with(|cell| cell.borrow_mut().as_mut().filter(|s| s.hwnd == hwnd).map(f))
    }

    fn current_window() -> Option<WebviewWindow> {
        OVERLAY.with(|cell| cell.borrow().as_ref().map(|s| s.window.clone()))
    }

    fn emit_phase(phase: SnapOverlayPhase) {
        let Some(window) = current_window() else {
            return;
        };
        if let Err(err) = window.emit(
            SNAP_OVERLAY_EVENT,
            SnapOverlayEventPayload {
                phase: phase.as_str(),
            },
        ) {
            tracing::warn!(target: "window", "贴靠热区事件回传前端失败 ({}): {err}", phase.as_str());
        }
    }

    fn toggle_maximize() {
        let Some(window) = current_window() else {
            return;
        };
        let result = match window.is_maximized() {
            Ok(true) => window.unmaximize(),
            Ok(false) => window.maximize(),
            Err(err) => Err(err),
        };
        if let Err(err) = result {
            tracing::warn!(target: "window", "贴靠热区点击：最大化/还原失败: {err}");
        }
    }

    fn track_nonclient_leave(hwnd: HWND) {
        let mut tme = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE | TME_NONCLIENT,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        // SAFETY：tme 为栈上完整初始化结构；hwnd 为本线程窗口
        if unsafe { TrackMouseEvent(&mut tme) } == 0 {
            tracing::warn!(
                target: "window",
                "TrackMouseEvent 失败，贴靠热区 hover 可能无法复位 (GetLastError={})",
                last_error()
            );
        }
    }

    unsafe extern "system" fn overlay_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            // 关键：让系统把这块区域当成最大化按钮 → Win11 悬停弹出贴靠布局面板
            WM_NCHITTEST => HTMAXBUTTON as LRESULT,
            WM_NCMOUSEMOVE => {
                let entered = update_state(hwnd, |s| !std::mem::replace(&mut s.hovering, true))
                    .unwrap_or(false);
                if entered {
                    track_nonclient_leave(hwnd);
                    emit_phase(SnapOverlayPhase::Enter);
                }
                // SAFETY：转交默认处理（参数原样透传）
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
            WM_NCMOUSELEAVE => {
                let left = update_state(hwnd, |s| {
                    let was = s.hovering || s.pressed;
                    s.hovering = false;
                    s.pressed = false;
                    was
                })
                .unwrap_or(false);
                if left {
                    emit_phase(SnapOverlayPhase::Leave);
                }
                0
            }
            // 不交给 DefWindowProc：它会对 HTMAXBUTTON 跑标题按钮跟踪循环，并把
            // SC_MAXIMIZE 发给这个子窗口本身
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                if update_state(hwnd, |s| s.pressed = true).is_some() {
                    emit_phase(SnapOverlayPhase::Press);
                }
                0
            }
            WM_NCLBUTTONUP => {
                let was_pressed = update_state(hwnd, |s| std::mem::replace(&mut s.pressed, false))
                    .unwrap_or(false);
                if was_pressed {
                    emit_phase(SnapOverlayPhase::Release);
                    toggle_maximize();
                }
                0
            }
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                // 从不绘制：只把无效区标记为已处理，避免 WM_PAINT 反复投递
                // SAFETY：hwnd 为当前窗口过程所属窗口
                unsafe {
                    ValidateRect(hwnd, std::ptr::null());
                }
                0
            }
            WM_NCDESTROY => {
                OVERLAY.with(|cell| {
                    let mut slot = cell.borrow_mut();
                    if slot.as_ref().is_some_and(|s| s.hwnd == hwnd) {
                        *slot = None;
                    }
                });
                tracing::info!(target: "window", "贴靠布局原生热区随父窗口销毁");
                // SAFETY：转交默认处理（参数原样透传）
                unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
            }
            // SAFETY：转交默认处理（参数原样透传）
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> SnapButtonRect {
        SnapButtonRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn to_physical_scales_and_rounds_edges() {
        // 150% 缩放：46×36 逻辑像素 → 69×54 物理像素
        let p = to_physical(&rect(1000.0, 0.0, 46.0, 36.0), 1.5).unwrap();
        assert_eq!(
            p,
            PhysicalRect {
                x: 1500,
                y: 0,
                width: 69,
                height: 54
            }
        );
        // 125% + 小数坐标：边各自四舍五入，宽度 = 右边 - 左边
        let p = to_physical(&rect(100.4, 0.0, 46.0, 32.0), 1.25).unwrap();
        assert_eq!(p.x, 126); // 125.5 → 126
        assert_eq!(p.x + p.width, 183); // 183.0
        assert_eq!(p.height, 40);
    }

    #[test]
    fn adjacent_buttons_share_edges_without_gap() {
        let scale = 1.75;
        let max_btn = to_physical(&rect(912.0, 0.0, 46.0, 36.0), scale).unwrap();
        let close_btn = to_physical(&rect(958.0, 0.0, 46.0, 36.0), scale).unwrap();
        assert_eq!(max_btn.x + max_btn.width, close_btn.x);
    }

    #[test]
    fn to_physical_rejects_bad_input() {
        assert!(to_physical(&rect(0.0, 0.0, 0.0, 36.0), 1.0).is_err());
        assert!(to_physical(&rect(0.0, 0.0, 46.0, -1.0), 1.0).is_err());
        assert!(to_physical(&rect(f64::NAN, 0.0, 46.0, 36.0), 1.0).is_err());
        assert!(to_physical(&rect(0.0, 0.0, 46.0, 36.0), 0.0).is_err());
        assert!(to_physical(&rect(0.0, 0.0, 46.0, 36.0), f64::INFINITY).is_err());
        assert!(to_physical(&rect(1e9, 0.0, 46.0, 36.0), 1.0).is_err());
    }

    #[test]
    fn rect_deserializes_from_camel_case_wire() {
        let r: SnapButtonRect =
            serde_json::from_str(r#"{"x":1,"y":2,"width":46,"height":36}"#).unwrap();
        assert_eq!(r, rect(1.0, 2.0, 46.0, 36.0));
    }

    #[test]
    fn phase_wire_names_are_stable() {
        // 前端 windowSnapOverlay.ts 按这四个字面量分派，改名会静默断开 hover/active
        assert_eq!(SNAP_OVERLAY_EVENT, "crish://window-snap-overlay");
        assert_eq!(SnapOverlayPhase::Enter.as_str(), "enter");
        assert_eq!(SnapOverlayPhase::Leave.as_str(), "leave");
        assert_eq!(SnapOverlayPhase::Press.as_str(), "press");
        assert_eq!(SnapOverlayPhase::Release.as_str(), "release");
    }
}
