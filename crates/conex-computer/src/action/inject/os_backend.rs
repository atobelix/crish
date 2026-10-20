//! 注入后端与执行器（执行域 · 对齐 05 详案 D2 os_backend.rs）
//!
//! 包含 OsInputBackend 结构、5ms 切片中止的执行器与全部输入原语实现
//! 保留 Q6 的 abort_check 注入式单路径（不回退为 abort_flag）

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use enigo::{Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

use crate::action::{
    chunk_text, ClickCount, MouseButton, ScrollDirection, DRAG_STEP_DELAY_MS, DRAG_STEP_PX,
    TYPING_DELAY_MS, TYPING_GROUP_SIZE,
};
use crate::coord::Point;

use super::key_map::{resolve_key, to_enigo_button};
use super::inject_steps::{build_click_steps, build_key_steps, build_scroll_steps, InjectStep};

use conex_shared::input::{
    ScrollDirection as SharedScrollDirection,
};

/// 统一注入错误(动作层向上透传)
pub type InjectError = String;

/// enigo 事件标记("conex" ASCII 位):与真实物理输入区分
const ENIGO_EXTRA_INFO: usize = u64::from_be_bytes(*b"\0\0\0conex") as usize;

/// 安全释放所有按键与鼠标按键（停止中断时清理残留按下状态）
pub fn release_all_keys_and_buttons(enigo: &mut Enigo) {
    let keys = [
        enigo::Key::Control,
        enigo::Key::Alt,
        enigo::Key::Shift,
        enigo::Key::Meta,
    ];
    for k in keys {
        if let Err(e) = enigo.key(k, Direction::Release) {
            // 清理路径无法把错误回传调用方（此时多半已在中断/异常分支），但绝不能静默：
            // 释放失败意味着可能残留按下状态，必须留痕便于事后排查
            tracing::error!(error = %e, "释放按键失败（可能残留按下状态）");
        }
    }
    let buttons = [enigo::Button::Left, enigo::Button::Middle, enigo::Button::Right];
    for b in buttons {
        if let Err(e) = enigo.button(b, Direction::Release) {
            tracing::error!(error = %e, "释放鼠标按键失败（可能残留按下状态）");
        }
    }
}

/// 执行步骤序列（持锁逐条注入；每一步及 5ms 切片休眠原子轮询停止查询，<=5ms 响应停止）
#[allow(unsafe_code)]
pub fn run_steps_guarded(
    enigo: &mut Enigo,
    steps: &[InjectStep],
    should_abort: impl Fn() -> bool,
) -> Result<(), InjectError> {
    for (idx, step) in steps.iter().enumerate() {
        if should_abort() {
            release_all_keys_and_buttons(enigo);
            return Err(format!(
                "停止触发，注入已中止（已完成 {idx}/{} 步）",
                steps.len()
            ));
        }
        match step {
            InjectStep::MoveTo { x, y } => {
                let ok = unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos(*x, *y)
                };
                if ok == 0 {
                    return Err(format!("SetCursorPos 失败: ({x}, {y})"));
                }
            }
            InjectStep::KeyDown { name } => {
                let key =
                    resolve_key(name).ok_or_else(|| format!("键名无法解析: {name}"))?;
                enigo
                    .key(key, Direction::Press)
                    .map_err(|e| format!("按键按下失败: {e:?}"))?;
            }
            InjectStep::KeyUp { name } => {
                let key =
                    resolve_key(name).ok_or_else(|| format!("键名无法解析: {name}"))?;
                enigo
                    .key(key, Direction::Release)
                    .map_err(|e| format!("按键抬起失败: {e:?}"))?;
            }
            InjectStep::ButtonClick { button } => {
                enigo
                    .button(*button, Direction::Press)
                    .map_err(|e| format!("按键按下失败: {e:?}"))?;
                enigo
                    .button(*button, Direction::Release)
                    .map_err(|e| format!("按键抬起失败: {e:?}"))?;
            }
            InjectStep::Wheel { axis, amount } => {
                enigo
                    .scroll(*amount, *axis)
                    .map_err(|e| format!("滚动失败: {e:?}"))?;
            }
            InjectStep::DelayMs { ms } => {
                let mut remaining = *ms;
                while remaining > 0 {
                    if should_abort() {
                        release_all_keys_and_buttons(enigo);
                        return Err(format!(
                            "停止触发，注入已中止（已完成 {idx}/{} 步）",
                            steps.len()
                        ));
                    }
                    let slice = remaining.min(5);
                    thread::sleep(Duration::from_millis(slice));
                    remaining -= slice;
                }
            }
        }
    }
    Ok(())
}

/// 注入后端:enigo 句柄(`Mutex` 内可变,05 §4.4)+ 键名注册表解析。
///
/// 内可变改造后全部方法 `&self`,可经 `Arc<dyn InputBackend>` 共享调用;
/// 注入为同步原语,std 互斥即可(05 §4.4)。序列级原子性由会话层单消费者保证。
/// 中止查询经 `ComputerSession::dispatch` 注入（`Option<Arc<dyn Fn()->bool+Send+Sync>>`），
/// 注入循环内 5ms 切片轮询，收敛到单一中止路径。
pub struct OsInputBackend {
    pub(crate) enigo: Mutex<Enigo>,
    /// 注入式中止查询（None = 未注入，不中止；Some = 外部闭包，通常指向 run 级中止信号）
    pub(crate) abort_check: Mutex<Option<Arc<dyn Fn() -> bool + Send + Sync>>>,
}

impl OsInputBackend {
    /// 初始化注入后端(等价 SendInput 直连面)
    pub fn new() -> Result<Self, InjectError> {
        let settings = Settings {
            windows_dw_extra_info: Some(ENIGO_EXTRA_INFO),
            ..Settings::default()
        };
        let enigo = Enigo::new(&settings).map_err(|e| format!("enigo 初始化失败: {e:?}"))?;
        Ok(Self {
            enigo: Mutex::new(enigo),
            abort_check: Mutex::new(None),
        })
    }

    /// 注入中止查询（由 ComputerSession::dispatch 构造时传入，通常为 `|| abort_token.abort()` 的闭包）
    pub fn set_abort_checker(&self, checker: Option<Arc<dyn Fn() -> bool + Send + Sync>>) {
        *self.abort_check.lock().unwrap_or_else(|e| e.into_inner()) = checker;
    }

    /// 当前是否已请求中止（委托给注入的查询；未注入则为 false，单一路径）
    pub(crate) fn aborted(&self) -> bool {
        self.abort_check
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|f| f())
    }

    /// 键名 → enigo 键码（委托到 keys 域，保持单路径解析表）
    fn resolve(name: &str) -> Option<enigo::Key> {
        resolve_key(name)
    }

    /// 组合键注入核心:修饰键按序 down → 主键 down/up → 修饰键 up
    /// (04 §2.1「修饰键多键时保持按住其余键」语义);
    /// `hold_ms = Some` 时主键按住后松开(共享层 key 语义,05 §4.1)。
    pub(crate) fn key_hold_inner(&self, keys: &[String], hold_ms: Option<u32>) -> Result<(), InjectError> {
        let steps = build_key_steps(keys, hold_ms);
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        let should_abort = || self.aborted();
        run_steps_guarded(&mut enigo, &steps, should_abort)
    }

    /// 组合键注入(dispatch 路径;hold_ms = None)
    pub fn key(&self, keys: &[String]) -> Result<(), InjectError> {
        self.key_hold_inner(keys, None)
    }

    /// 按住指定键 duration 秒后松开(上限 100s 已在校验层约束，5ms 切片原子停止轮询)
    pub fn hold_key(&self, name: &str, duration_secs: f32) -> Result<(), InjectError> {
        let key = Self::resolve(name).ok_or_else(|| format!("键名无法解析: {name}"))?;
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        if self.aborted() {
            release_all_keys_and_buttons(&mut enigo);
            return Err("停止触发，按键保持中止".to_string());
        }
        enigo
            .key(key, Direction::Press)
            .map_err(|e| format!("按键按下失败: {e:?}"))?;

        let mut remaining_ms = (duration_secs * 1000.0) as u64;
        while remaining_ms > 0 {
            if self.aborted() {
                release_all_keys_and_buttons(&mut enigo);
                return Err("停止触发，按键保持中止".to_string());
            }
            let slice = remaining_ms.min(5);
            thread::sleep(Duration::from_millis(slice));
            remaining_ms -= slice;
        }

        enigo
            .key(key, Direction::Release)
            .map_err(|e| format!("按键抬起失败: {e:?}"))?;
        Ok(())
    }

    /// 文本输入核心:按 50 字符分块,块间 12ms 节流(04 §2.3;Unicode 直送,
    /// 不依赖 IME,37 报告 Gate-B 三应用 0 丢字实证；5ms 切片原子停止轮询)
    pub(crate) fn type_text_inner(&self, text: &str) -> Result<(), InjectError> {
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        for chunk in chunk_text(text, TYPING_GROUP_SIZE) {
            if self.aborted() {
                release_all_keys_and_buttons(&mut enigo);
                return Err("停止触发，文本输入中止".to_string());
            }
            enigo
                .text(&chunk)
                .map_err(|e| format!("文本注入失败: {e:?}"))?;
            let mut remaining_ms = TYPING_DELAY_MS;
            while remaining_ms > 0 {
                if self.aborted() {
                    release_all_keys_and_buttons(&mut enigo);
                    return Err("停止触发，文本输入中止".to_string());
                }
                let slice = remaining_ms.min(5);
                thread::sleep(Duration::from_millis(slice));
                remaining_ms -= slice;
            }
        }
        Ok(())
    }

    /// 文本输入(dispatch 路径)
    pub fn type_text(&self, text: &str) -> Result<(), InjectError> {
        self.type_text_inner(text)
    }

    /// 鼠标移动:直连 SetCursorPos(物理坐标,支持多显示器负坐标;
    /// enigo 0.6.1 绝对坐标仅支持主屏 0,0 原点)
    #[allow(unsafe_code)]
    pub fn mouse_move(&self, p: Point) -> Result<(), InjectError> {
        let ok = unsafe { windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos(p.x, p.y) };
        if ok == 0 {
            return Err(format!("SetCursorPos 失败: ({}, {})", p.x, p.y));
        }
        Ok(())
    }

    /// 点击系列(含双击/三击,间隔 ≤ 系统双击时间;dispatch 路径无坐标/修饰键,
    /// 该语义由 dispatch 前置包裹;共享层路径走 InputBackend::click)
    pub fn click(&self, button: MouseButton, count: ClickCount) -> Result<(), InjectError> {
        let times = match count {
            ClickCount::Single => 1,
            ClickCount::Double => 2,
            ClickCount::Triple => 3,
        };
        let steps = build_click_steps(to_enigo_button(button), times, None, &[]);
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        let should_abort = || self.aborted();
        run_steps_guarded(&mut enigo, &steps, should_abort)
    }

    /// 按下/抬起分离原语
    pub fn mouse_button(&self, button: MouseButton, down: bool) -> Result<(), InjectError> {
        let direction = if down {
            Direction::Press
        } else {
            Direction::Release
        };
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        enigo
            .button(to_enigo_button(button), direction)
            .map_err(|e| format!("鼠标按键失败: {e:?}"))
    }

    /// 拖拽:起点按下 → 分步线性插值移动 → 终点抬起(04 §2.2 语义；5ms 切片原子停止轮询)
    pub fn drag(&self, from: Point, to: Point) -> Result<(), InjectError> {
        if self.aborted() {
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            release_all_keys_and_buttons(&mut enigo);
            return Err("停止触发，拖拽中止".to_string());
        }
        self.mouse_move(from)?;
        self.mouse_button(MouseButton::Left, true)?;
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        let distance = (dx.abs().max(dy.abs())) as i64;
        let steps = (distance + DRAG_STEP_PX as i64 - 1) / DRAG_STEP_PX as i64;
        let steps = steps.max(1);
        for step in 1..=steps {
            if self.aborted() {
                let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
                release_all_keys_and_buttons(&mut enigo);
                return Err("停止触发，拖拽中止".to_string());
            }
            let t = step as f64 / steps as f64;
            let x = from.x + (dx as f64 * t).round() as i32;
            let y = from.y + (dy as f64 * t).round() as i32;
            self.mouse_move(Point::new(x, y))?;
            let mut remaining_ms = DRAG_STEP_DELAY_MS;
            while remaining_ms > 0 {
                if self.aborted() {
                    let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
                    release_all_keys_and_buttons(&mut enigo);
                    return Err("停止触发，拖拽中止".to_string());
                }
                let slice = remaining_ms.min(5);
                thread::sleep(Duration::from_millis(slice));
                remaining_ms -= slice;
            }
        }
        self.mouse_button(MouseButton::Left, false)
    }

    /// 滚动:方向 → 滚轮增量(enigo scroll 正=下/右,负=上/左;dispatch 路径
    /// 无坐标/修饰键,该语义由 dispatch 前置包裹)
    pub fn scroll(&self, direction: ScrollDirection, amount: u32) -> Result<(), InjectError> {
        let dir = match direction {
            ScrollDirection::Up => SharedScrollDirection::Up,
            ScrollDirection::Down => SharedScrollDirection::Down,
            ScrollDirection::Left => SharedScrollDirection::Left,
            ScrollDirection::Right => SharedScrollDirection::Right,
        };
        let steps = build_scroll_steps(dir, amount, None, &[]);
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        let should_abort = || self.aborted();
        run_steps_guarded(&mut enigo, &steps, should_abort)
    }

    /// 按住一组修饰键(click/scroll 带 modifiers 语义,dispatch 前置包裹面)
    pub fn press_modifiers(&self, modifiers: &[String]) -> Result<(), InjectError> {
        let steps: Vec<InjectStep> = modifiers
            .iter()
            .map(|m| InjectStep::KeyDown { name: m.clone() })
            .collect();
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        let should_abort = || self.aborted();
        run_steps_guarded(&mut enigo, &steps, should_abort)
    }

    /// 抬起一组修饰键(逆序)
    pub fn release_modifiers(&self, modifiers: &[String]) -> Result<(), InjectError> {
        let steps: Vec<InjectStep> = modifiers
            .iter()
            .rev()
            .map(|m| InjectStep::KeyUp { name: m.clone() })
            .collect();
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        let should_abort = || self.aborted();
        run_steps_guarded(&mut enigo, &steps, should_abort)
    }

    /// 当前光标物理坐标(GetCursorPos 直连,多显示器负坐标正确)
    #[allow(unsafe_code)]
    pub fn cursor_physical(&self) -> Result<Point, InjectError> {
        let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        let ok =
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point) };
        if ok == 0 {
            return Err("GetCursorPos 失败".to_string());
        }
        Ok(Point::new(point.x, point.y))
    }

    /// 辅助:绝对移动(供 click/scroll 带坐标时先定位)
    pub fn move_absolute(&self, p: Point) -> Result<(), InjectError> {
        // 预留:enigo 绝对移动仅主屏,统一走 SetCursorPos
        self.mouse_move(p)
    }

    // 注:enigo::Coordinate 仅用于保留类型引用(绝对/相对语义),当前统一绝对坐标
    #[allow(dead_code)]
    fn _coordinate_marker() -> Coordinate {
        Coordinate::Abs
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_input_backend_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<OsInputBackend>();
    }

    #[test]
    fn abort_check_injected_path_single() {
        // 注入后查询应生效，未注入时不中止
        let backend = OsInputBackend::new().expect("初始化失败");
        assert!(!backend.aborted(), "未注入时应为 false");
        backend.set_abort_checker(Some(std::sync::Arc::new(|| true)));
        assert!(backend.aborted(), "注入 true 后应为 true");
        backend.set_abort_checker(Some(std::sync::Arc::new(|| false)));
        assert!(!backend.aborted(), "注入 false 后应为 false");
        backend.set_abort_checker(None);
        assert!(!backend.aborted(), "清除后应为 false");
    }
}
