//! 动作原语(04 二期立项 §2.1/§2.3/§2.4)。
//!
//! 动作枚举与参数校验为纯函数(全平台可编译、可单测);
//! Windows 注入实现(`inject::OsInputBackend`)走 enigo 0.6.1(底层即 SendInput),
//! 鼠标移动因 enigo 绝对坐标仅支持主屏原点,改直连 SetCursorPos
//! (04 §2.2 Windows 表列出的选项之一,支持多显示器负坐标)。
//!
//! 输入节奏(04 §2.3):type 按 50 字符分块 + 12ms 节流;hold_key 时长上限 100s。

/// type 分块大小(04 §2.3 TYPING_GROUP_SIZE)
pub const TYPING_GROUP_SIZE: usize = 50;
/// type 字符间隔毫秒(04 §2.3 TYPING_DELAY_MS;Windows 可配 12-30ms)
pub const TYPING_DELAY_MS: u64 = 12;
/// hold_key 时长上限(秒,04 §2.1 硬约束 100s)
pub const HOLD_KEY_MAX_SECS: f32 = 100.0;
/// type 文本最大字符数(超长拒绝)
pub const MAX_TYPE_CHARS: usize = 100_000;
/// 组合键数组最大元素数
pub const MAX_KEYS_IN_COMBO: usize = 16;
/// 双击/三击间隔毫秒(须小于系统双击时间,默认双击时间约 500ms)
pub const CLICK_INTERVAL_MS: u64 = 60;
/// 拖拽分步移动的最大步长(像素)
pub const DRAG_STEP_PX: i32 = 32;
/// 拖拽分步间隔毫秒
pub const DRAG_STEP_DELAY_MS: u64 = 8;

use crate::coord::{Point, ScaleSpec};

/// 鼠标按键
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    /// 左键
    Left,
    /// 中键
    Middle,
    /// 右键
    Right,
}

/// 点击次数语义(双击/三击由后端生成间隔,04 §2.1)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClickCount {
    /// 单击
    Single,
    /// 双击
    Double,
    /// 三击
    Triple,
}

/// 滚动方向(04 §2.1)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    /// 向上(滚轮负增量)
    Up,
    /// 向下(滚轮正增量)
    Down,
    /// 向左(横向滚轮负增量)
    Left,
    /// 向右(横向滚轮正增量)
    Right,
}

/// 动作原语(对齐 04 §2.1 动作空间;感知类 wait/screenshot/zoom 属 S2 感知面,
/// 本层以 `ComputerSession::screenshot()` 门面承载)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Action {
    /// 组合键(数组语义,不做字符串解析;修饰键按序 down → 主键 down/up → 修饰键 up)
    Key {
        /// 归一化键名数组(如 ["ctrl","c"])
        keys: Vec<String>,
    },
    /// 文本输入(50 字符/块 + 12ms 节流;非 ASCII 走 Unicode 直送)
    Type {
        /// 待输入文本(非空,≤100000 字符)
        text: String,
    },
    /// 移动光标到指定 API 坐标
    MouseMove {
        /// 目标坐标(API 空间)
        coordinate: Point,
    },
    /// 点击系列(左/右/中/双击/三击;带坐标先移动再点击;带修饰键按住点击)
    Click {
        /// 按键
        button: MouseButton,
        /// 次数语义
        count: ClickCount,
        /// 目标坐标(API 空间,可省略表示当前光标位置)
        coordinate: Option<Point>,
        /// 按住修饰键(如 ctrl+click)
        modifiers: Vec<String>,
    },
    /// 按下分离原语(作用于当前光标位置)
    MouseDown {
        /// 按键
        button: MouseButton,
    },
    /// 抬起分离原语(作用于当前光标位置)
    MouseUp {
        /// 按键
        button: MouseButton,
    },
    /// 拖拽:按下起点 → 分步插值移动到终点 → 抬起
    Drag {
        /// 起点坐标(API 空间)
        start_coordinate: Point,
        /// 终点坐标(API 空间)
        coordinate: Point,
    },
    /// 滚动(方向映射滚轮增量;带坐标先移动;带修饰键按住滚动)
    Scroll {
        /// 滚动方向
        direction: ScrollDirection,
        /// 滚动量(非负整数;方向语义见 04 §2.1)
        amount: u32,
        /// 目标坐标(API 空间,可省略)
        coordinate: Option<Point>,
        /// 按住修饰键(如 shift+wheel 横向语义由 OS 决定)
        modifiers: Vec<String>,
    },
    /// 按住指定键 duration 后松开(上限 100s)
    HoldKey {
        /// 归一化键名
        key: String,
        /// 按住时长(秒,0 < d ≤ 100)
        duration_secs: f32,
    },
    /// 查询当前光标位置(返回 API 空间坐标)
    CursorPosition,
}

/// 动作参数校验错误(04 §2.1 错误码语义)
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ActionError {
    /// 参数非法(tool.computer.invalid_params)
    #[error("参数非法(tool.computer.invalid_params): {0}")]
    InvalidParams(String),
    /// 坐标越界(tool.computer.coords_out_of_bounds)
    #[error("坐标越界(tool.computer.coords_out_of_bounds)")]
    CoordsOutOfBounds,
}

impl Action {
    /// 参数校验(04 §2.1「参数校验 → 坐标换算 → 审批 → 注入」的第 1 步):
    /// 类型化参数取值、组合合法性、坐标边界(经 ScaleSpec)
    pub fn validate(&self, scale: &ScaleSpec) -> Result<(), ActionError> {
        match self {
            Action::Key { keys } => validate_keys(keys),
            Action::Type { text } => validate_type(text),
            Action::MouseMove { coordinate } => validate_coord(*coordinate, scale),
            Action::Click {
                coordinate,
                modifiers,
                ..
            } => {
                validate_modifiers(modifiers)?;
                if let Some(c) = coordinate {
                    validate_coord(*c, scale)
                } else {
                    Ok(())
                }
            }
            Action::MouseDown { .. } | Action::MouseUp { .. } => Ok(()),
            Action::Drag {
                start_coordinate,
                coordinate,
            } => {
                validate_coord(*start_coordinate, scale)?;
                validate_coord(*coordinate, scale)
            }
            Action::Scroll {
                amount,
                coordinate,
                modifiers,
                ..
            } => {
                validate_modifiers(modifiers)?;
                if let Some(c) = coordinate {
                    validate_coord(*c, scale)?;
                }
                // amount 为非负整数(u32 保证),0 表示无效滚动量:按 04「非负整数」语义放行
                let _ = amount;
                Ok(())
            }
            Action::HoldKey {
                key,
                duration_secs,
            } => {
                if !is_valid_key_name(key) {
                    return Err(ActionError::InvalidParams(format!(
                        "未知键名: {key}"
                    )));
                }
                if !(0.0 < *duration_secs && *duration_secs <= HOLD_KEY_MAX_SECS) {
                    return Err(ActionError::InvalidParams(format!(
                        "hold_key 时长必须满足 0 < d ≤ {HOLD_KEY_MAX_SECS}, 实得 {duration_secs}"
                    )));
                }
                Ok(())
            }
            Action::CursorPosition => Ok(()),
        }
    }
}

/// 组合键数组校验:非空、长度上限、键名全部合法、非修饰键最多一个
fn validate_keys(keys: &[String]) -> Result<(), ActionError> {
    if keys.is_empty() {
        return Err(ActionError::InvalidParams("组合键数组不能为空".to_string()));
    }
    if keys.len() > MAX_KEYS_IN_COMBO {
        return Err(ActionError::InvalidParams(format!(
            "组合键数量超过上限 {MAX_KEYS_IN_COMBO}"
        )));
    }
    let mut plain_keys = 0;
    for key in keys {
        if !is_valid_key_name(key) {
            return Err(ActionError::InvalidParams(format!("未知键名: {key}")));
        }
        if !is_modifier_name(key) {
            plain_keys += 1;
        }
    }
    if plain_keys > 1 {
        return Err(ActionError::InvalidParams(
            "组合键数组只允许一个非修饰键".to_string(),
        ));
    }
    Ok(())
}

/// type 文本校验:非空、字符数上限、禁止 NUL 字节
fn validate_type(text: &str) -> Result<(), ActionError> {
    if text.is_empty() {
        return Err(ActionError::InvalidParams("type 文本不能为空".to_string()));
    }
    let len = text.chars().count();
    if len > MAX_TYPE_CHARS {
        return Err(ActionError::InvalidParams(format!(
            "type 文本超长({len} > {MAX_TYPE_CHARS} 字符)"
        )));
    }
    if text.contains('\0') {
        return Err(ActionError::InvalidParams(
            "type 文本不允许包含 NUL 字节".to_string(),
        ));
    }
    Ok(())
}

/// 修饰键数组校验:键名全部合法且必须为修饰键
fn validate_modifiers(modifiers: &[String]) -> Result<(), ActionError> {
    for m in modifiers {
        if !is_modifier_name(m) {
            return Err(ActionError::InvalidParams(format!(
                "修饰键只允许 ctrl/alt/shift/win, 实得 {m}"
            )));
        }
    }
    Ok(())
}

/// 坐标校验:API 空间非负整数 + 边界(经 ScaleSpec)
fn validate_coord(p: Point, scale: &ScaleSpec) -> Result<(), ActionError> {
    if p.x < 0 || p.y < 0 {
        return Err(ActionError::InvalidParams(format!(
            "坐标必须为非负整数二元组, 实得 ({}, {})",
            p.x, p.y
        )));
    }
    scale.validate_api(p).map_err(|_| ActionError::CoordsOutOfBounds)?;
    Ok(())
}

/// 是否为修饰键名(04 §2.4)
pub fn is_modifier_name(name: &str) -> bool {
    matches!(name, "ctrl" | "alt" | "shift" | "win")
}

/// 键名校验(04 §2.4 键名规范):
/// 修饰键 + a-z/0-9 + F1-F24 + 常用功能键;纯字符串匹配,不依赖平台键码
pub fn is_valid_key_name(name: &str) -> bool {
    if is_modifier_name(name) {
        return true;
    }
    if name.len() == 1 {
        let c = name.chars().next().expect("len=1 必有字符");
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            return true;
        }
    }
    if let Some(f) = name.strip_prefix('f') {
        if let Ok(n) = f.parse::<u32>() {
            if (1..=24).contains(&n) {
                return true;
            }
        }
    }
    matches!(
        name,
        "enter"
            | "tab"
            | "space"
            | "backspace"
            | "delete"
            | "escape"
            | "arrow_up"
            | "arrow_down"
            | "arrow_left"
            | "arrow_right"
            | "home"
            | "end"
            | "page_up"
            | "page_down"
            | "caps_lock"
            | "insert"
            | "pause"
            | "scroll_lock"
            | "num_lock"
    )
}

/// 按 Unicode 标量分块(04 §2.3:50 字符/块;按 char 计数而非字节,
/// 中文/emoji 不会被拦腰截断);空文本返回空数组
pub fn chunk_text(text: &str, group_size: usize) -> Vec<String> {
    if text.is_empty() || group_size == 0 {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(group_size)
        .map(|chunk| chunk.iter().collect())
        .collect()
}

/// Windows 注入后端(enigo 0.6.1 主实现 + 直连 SetCursorPos/GetCursorPos 补足)
#[cfg(windows)]
pub mod inject {
    use std::thread;
    use std::time::Duration;

    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

    use super::*;

    /// 统一注入错误(动作层向上透传)
    pub type InjectError = String;

    /// enigo 事件标记("conex" ASCII 位):与真实物理输入区分
    const ENIGO_EXTRA_INFO: usize = u64::from_be_bytes(*b"\0\0\0conex") as usize;

    /// 注入后端:enigo 句柄 + 键名注册表解析
    pub struct OsInputBackend {
        enigo: Enigo,
    }

    /// 功能键编号 → enigo 键码(F1-F24,enigo 为独立变体)
    fn function_key(n: u8) -> Option<enigo::Key> {
        use enigo::Key;
        Some(match n {
            1 => Key::F1,
            2 => Key::F2,
            3 => Key::F3,
            4 => Key::F4,
            5 => Key::F5,
            6 => Key::F6,
            7 => Key::F7,
            8 => Key::F8,
            9 => Key::F9,
            10 => Key::F10,
            11 => Key::F11,
            12 => Key::F12,
            13 => Key::F13,
            14 => Key::F14,
            15 => Key::F15,
            16 => Key::F16,
            17 => Key::F17,
            18 => Key::F18,
            19 => Key::F19,
            20 => Key::F20,
            21 => Key::F21,
            22 => Key::F22,
            23 => Key::F23,
            24 => Key::F24,
            _ => return None,
        })
    }

    impl OsInputBackend {
        /// 初始化注入后端(等价 SendInput 直连面)
        pub fn new() -> Result<Self, InjectError> {
            let settings = Settings {
                windows_dw_extra_info: Some(ENIGO_EXTRA_INFO),
                ..Settings::default()
            };
            let enigo =
                Enigo::new(&settings).map_err(|e| format!("enigo 初始化失败: {e:?}"))?;
            Ok(Self { enigo })
        }

        /// 键名 → enigo 键码
        fn resolve(name: &str) -> Option<enigo::Key> {
            use enigo::Key;
            match name {
                "ctrl" => Some(Key::Control),
                "alt" => Some(Key::Alt),
                "shift" => Some(Key::Shift),
                "win" => Some(Key::Meta),
                "enter" => Some(Key::Return),
                "tab" => Some(Key::Tab),
                "space" => Some(Key::Space),
                "backspace" => Some(Key::Backspace),
                "delete" => Some(Key::Delete),
                "escape" => Some(Key::Escape),
                "arrow_up" => Some(Key::UpArrow),
                "arrow_down" => Some(Key::DownArrow),
                "arrow_left" => Some(Key::LeftArrow),
                "arrow_right" => Some(Key::RightArrow),
                "home" => Some(Key::Home),
                "end" => Some(Key::End),
                "page_up" => Some(Key::PageUp),
                "page_down" => Some(Key::PageDown),
                "caps_lock" => Some(Key::CapsLock),
                "insert" => Some(Key::Insert),
                "pause" => Some(Key::Pause),
                // Windows 平台上 enigo 的滚动锁定键为 `Scroll` 变体
                // (ScrollLock 仅 unix 平台存在)
                "scroll_lock" => Some(Key::Scroll),
                "num_lock" => Some(Key::Numlock),
                _ => {
                    let mut chars = name.chars();
                    let first = chars.next()?;
                    if chars.next().is_none() {
                        if let Some(digit) = first.to_digit(10) {
                            let vk = digit as u8;
                            return Some(match vk {
                                0 => Key::Num0,
                                1 => Key::Num1,
                                2 => Key::Num2,
                                3 => Key::Num3,
                                4 => Key::Num4,
                                5 => Key::Num5,
                                6 => Key::Num6,
                                7 => Key::Num7,
                                8 => Key::Num8,
                                9 => Key::Num9,
                                _ => return None,
                            });
                        }
                        if first.is_ascii_alphabetic() {
                            let letter = first.to_ascii_uppercase();
                            return Some(match letter {
                                'A' => Key::A,
                                'B' => Key::B,
                                'C' => Key::C,
                                'D' => Key::D,
                                'E' => Key::E,
                                'F' => Key::F,
                                'G' => Key::G,
                                'H' => Key::H,
                                'I' => Key::I,
                                'J' => Key::J,
                                'K' => Key::K,
                                'L' => Key::L,
                                'M' => Key::M,
                                'N' => Key::N,
                                'O' => Key::O,
                                'P' => Key::P,
                                'Q' => Key::Q,
                                'R' => Key::R,
                                'S' => Key::S,
                                'T' => Key::T,
                                'U' => Key::U,
                                'V' => Key::V,
                                'W' => Key::W,
                                'X' => Key::X,
                                'Y' => Key::Y,
                                'Z' => Key::Z,
                                _ => return None,
                            });
                        }
                    }
                    if let Some(f) = name.strip_prefix('f') {
                        if let Ok(n) = f.parse::<u8>() {
                            return function_key(n);
                        }
                    }
                    None
                }
            }
        }

        /// 组合键注入:修饰键按序 down → 主键 down/up → 修饰键 up
        /// (04 §2.1「修饰键多键时保持按住其余键」语义)
        pub fn key(&mut self, keys: &[String]) -> Result<(), InjectError> {
            let mut mods = Vec::new();
            let mut main = None;
            for name in keys {
                let key = Self::resolve(name)
                    .ok_or_else(|| format!("键名无法解析: {name}"))?;
                if is_modifier_name(name) {
                    mods.push(key);
                } else if main.is_none() {
                    main = Some(key);
                }
            }
            for m in &mods {
                self.enigo
                    .key(*m, Direction::Press)
                    .map_err(|e| format!("修饰键按下失败: {e:?}"))?;
            }
            if let Some(main) = main {
                self.enigo
                    .key(main, Direction::Press)
                    .map_err(|e| format!("主键按下失败: {e:?}"))?;
                self.enigo
                    .key(main, Direction::Release)
                    .map_err(|e| format!("主键抬起失败: {e:?}"))?;
            }
            for m in mods.iter().rev() {
                self.enigo
                    .key(*m, Direction::Release)
                    .map_err(|e| format!("修饰键抬起失败: {e:?}"))?;
            }
            Ok(())
        }

        /// 按住指定键 duration 秒后松开(上限 100s 已在校验层约束)
        pub fn hold_key(&mut self, name: &str, duration_secs: f32) -> Result<(), InjectError> {
            let key = Self::resolve(name).ok_or_else(|| format!("键名无法解析: {name}"))?;
            self.enigo
                .key(key, Direction::Press)
                .map_err(|e| format!("按键按下失败: {e:?}"))?;
            thread::sleep(Duration::from_secs_f32(duration_secs));
            self.enigo
                .key(key, Direction::Release)
                .map_err(|e| format!("按键抬起失败: {e:?}"))?;
            Ok(())
        }

        /// 文本输入:按 50 字符分块,块间 12ms 节流(04 §2.3;Unicode 直送,
        /// 不依赖 IME,37 报告 Gate-B 三应用 0 丢字实证)
        pub fn type_text(&mut self, text: &str) -> Result<(), InjectError> {
            for chunk in chunk_text(text, TYPING_GROUP_SIZE) {
                self.enigo
                    .text(&chunk)
                    .map_err(|e| format!("文本注入失败: {e:?}"))?;
                thread::sleep(Duration::from_millis(TYPING_DELAY_MS));
            }
            Ok(())
        }

        /// 鼠标移动:直连 SetCursorPos(物理坐标,支持多显示器负坐标;
        /// enigo 0.6.1 绝对坐标仅支持主屏 0,0 原点)
        #[allow(unsafe_code)]
        pub fn mouse_move(&mut self, p: Point) -> Result<(), InjectError> {
            let ok = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::SetCursorPos(p.x, p.y)
            };
            if ok == 0 {
                return Err(format!("SetCursorPos 失败: ({}, {})", p.x, p.y));
            }
            Ok(())
        }

        /// 点击系列(含双击/三击,间隔 ≤ 系统双击时间)
        pub fn click(
            &mut self,
            button: MouseButton,
            count: ClickCount,
        ) -> Result<(), InjectError> {
            let btn = match button {
                MouseButton::Left => Button::Left,
                MouseButton::Middle => Button::Middle,
                MouseButton::Right => Button::Right,
            };
            let times = match count {
                ClickCount::Single => 1,
                ClickCount::Double => 2,
                ClickCount::Triple => 3,
            };
            for i in 0..times {
                self.enigo
                    .button(btn, Direction::Press)
                    .map_err(|e| format!("按键按下失败: {e:?}"))?;
                self.enigo
                    .button(btn, Direction::Release)
                    .map_err(|e| format!("按键抬起失败: {e:?}"))?;
                if i + 1 < times {
                    thread::sleep(Duration::from_millis(CLICK_INTERVAL_MS));
                }
            }
            Ok(())
        }

        /// 按下/抬起分离原语
        pub fn mouse_button(&mut self, button: MouseButton, down: bool) -> Result<(), InjectError> {
            let btn = match button {
                MouseButton::Left => Button::Left,
                MouseButton::Middle => Button::Middle,
                MouseButton::Right => Button::Right,
            };
            let direction = if down { Direction::Press } else { Direction::Release };
            self.enigo
                .button(btn, direction)
                .map_err(|e| format!("鼠标按键失败: {e:?}"))
        }

        /// 拖拽:起点按下 → 分步线性插值移动 → 终点抬起(04 §2.2 语义)
        pub fn drag(&mut self, from: Point, to: Point) -> Result<(), InjectError> {
            self.mouse_move(from)?;
            self.mouse_button(MouseButton::Left, true)?;
            let dx = to.x - from.x;
            let dy = to.y - from.y;
            let distance = (dx.abs().max(dy.abs())) as i64;
            let steps = (distance + DRAG_STEP_PX as i64 - 1) / DRAG_STEP_PX as i64;
            let steps = steps.max(1);
            for step in 1..=steps {
                let t = step as f64 / steps as f64;
                let x = from.x + (dx as f64 * t).round() as i32;
                let y = from.y + (dy as f64 * t).round() as i32;
                self.mouse_move(Point::new(x, y))?;
                thread::sleep(Duration::from_millis(DRAG_STEP_DELAY_MS));
            }
            self.mouse_button(MouseButton::Left, false)
        }

        /// 滚动:方向 → 滚轮增量(enigo scroll 正=下/右,负=上/左)
        pub fn scroll(
            &mut self,
            direction: ScrollDirection,
            amount: u32,
        ) -> Result<(), InjectError> {
            let (axis, length) = match direction {
                ScrollDirection::Up => (Axis::Vertical, -(amount as i32)),
                ScrollDirection::Down => (Axis::Vertical, amount as i32),
                ScrollDirection::Left => (Axis::Horizontal, -(amount as i32)),
                ScrollDirection::Right => (Axis::Horizontal, amount as i32),
            };
            self.enigo
                .scroll(length, axis)
                .map_err(|e| format!("滚动失败: {e:?}"))
        }

        /// 按住一组修饰键(click/scroll 带 modifiers 语义)
        pub fn press_modifiers(&mut self, modifiers: &[String]) -> Result<(), InjectError> {
            for m in modifiers {
                let key = Self::resolve(m).ok_or_else(|| format!("键名无法解析: {m}"))?;
                self.enigo
                    .key(key, Direction::Press)
                    .map_err(|e| format!("修饰键按下失败: {e:?}"))?;
            }
            Ok(())
        }

        /// 抬起一组修饰键(逆序)
        pub fn release_modifiers(&mut self, modifiers: &[String]) -> Result<(), InjectError> {
            for m in modifiers.iter().rev() {
                let key = Self::resolve(m).ok_or_else(|| format!("键名无法解析: {m}"))?;
                self.enigo
                    .key(key, Direction::Release)
                    .map_err(|e| format!("修饰键抬起失败: {e:?}"))?;
            }
            Ok(())
        }

        /// 当前光标物理坐标(GetCursorPos 直连,多显示器负坐标正确)
        #[allow(unsafe_code)]
        pub fn cursor_physical(&self) -> Result<Point, InjectError> {
            let mut point = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
            let ok = unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut point)
            };
            if ok == 0 {
                return Err("GetCursorPos 失败".to_string());
            }
            Ok(Point::new(point.x, point.y))
        }

        /// 辅助:绝对移动(供 click/scroll 带坐标时先定位)
        pub fn move_absolute(&mut self, p: Point) -> Result<(), InjectError> {
            // 预留:enigo 绝对移动仅主屏,统一走 SetCursorPos
            self.mouse_move(p)
        }

        // 注:enigo::Coordinate 仅用于保留类型引用(绝对/相对语义),当前统一绝对坐标
        #[allow(dead_code)]
        fn _coordinate_marker() -> Coordinate {
            Coordinate::Abs
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scale_16x9() -> ScaleSpec {
        ScaleSpec::new(0, 0, 2560, 1440, 1366, 768)
    }

    #[test]
    fn validate_key_empty_rejected() {
        let action = Action::Key { keys: vec![] };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_key_unknown_rejected() {
        let action = Action::Key {
            keys: vec!["ctrll".to_string()],
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_key_two_plain_keys_rejected() {
        // 组合键只允许一个非修饰键(04 §2.1 数组语义)
        let action = Action::Key {
            keys: vec!["a".to_string(), "b".to_string()],
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_key_ok() {
        let combos = [
            vec!["ctrl".to_string(), "c".to_string()],
            vec!["alt".to_string(), "shift".to_string(), "tab".to_string()],
            vec!["ctrl".to_string(), "alt".to_string(), "delete".to_string()],
        ];
        for keys in combos {
            assert!(
                Action::Key { keys }.validate(&scale_16x9()).is_ok(),
                "合法组合键应通过"
            );
        }
    }

    #[test]
    fn validate_key_overlong_rejected() {
        let keys = (0..=MAX_KEYS_IN_COMBO)
            .map(|_| "ctrl".to_string())
            .collect::<Vec<_>>();
        let action = Action::Key { keys };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_type_empty_rejected() {
        let action = Action::Type { text: String::new() };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_type_overlong_rejected() {
        let text = "a".repeat(MAX_TYPE_CHARS + 1);
        let action = Action::Type { text };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_type_nul_rejected() {
        let action = Action::Type {
            text: "abc\0def".to_string(),
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_type_ok() {
        let action = Action::Type {
            text: "中文 input 测试 ❤️".to_string(),
        };
        assert!(action.validate(&scale_16x9()).is_ok());
    }

    #[test]
    fn validate_mouse_move_negative_coordinate_rejected() {
        let action = Action::MouseMove {
            coordinate: Point::new(-1, 0),
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_mouse_move_out_of_bounds_rejected() {
        let action = Action::MouseMove {
            coordinate: Point::new(1367, 0),
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::CoordsOutOfBounds)
        ));
    }

    #[test]
    fn validate_mouse_move_ok() {
        let action = Action::MouseMove {
            coordinate: Point::new(683, 384),
        };
        assert!(action.validate(&scale_16x9()).is_ok());
    }

    #[test]
    fn validate_drag_endpoints() {
        // 起点负坐标 → 非法参数
        let action = Action::Drag {
            start_coordinate: Point::new(-5, 0),
            coordinate: Point::new(100, 100),
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
        // 终点越界 → 坐标越界
        let action = Action::Drag {
            start_coordinate: Point::new(0, 0),
            coordinate: Point::new(9999, 9999),
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::CoordsOutOfBounds)
        ));
        // 合法
        let action = Action::Drag {
            start_coordinate: Point::new(100, 100),
            coordinate: Point::new(200, 200),
        };
        assert!(action.validate(&scale_16x9()).is_ok());
    }

    #[test]
    fn validate_hold_key_duration() {
        // 0 与负值拒绝
        for bad in [-1.0, 0.0] {
            let action = Action::HoldKey {
                key: "a".to_string(),
                duration_secs: bad,
            };
            assert!(
                matches!(action.validate(&scale_16x9()), Err(ActionError::InvalidParams(_))),
                "时长 {bad} 应拒绝"
            );
        }
        // 超过 100s 拒绝
        let action = Action::HoldKey {
            key: "a".to_string(),
            duration_secs: 100.5,
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
        // 边界 100.0 允许(04 §2.1 上限 100s)
        let action = Action::HoldKey {
            key: "a".to_string(),
            duration_secs: 100.0,
        };
        assert!(action.validate(&scale_16x9()).is_ok());
        // 未知键名拒绝
        let action = Action::HoldKey {
            key: "not-a-key".to_string(),
            duration_secs: 1.0,
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_scroll_params() {
        // 非法修饰键拒绝
        let action = Action::Scroll {
            direction: ScrollDirection::Down,
            amount: 3,
            coordinate: None,
            modifiers: vec!["foo".to_string()],
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
        // 坐标越界拒绝
        let action = Action::Scroll {
            direction: ScrollDirection::Down,
            amount: 3,
            coordinate: Some(Point::new(2000, 0)),
            modifiers: vec![],
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::CoordsOutOfBounds)
        ));
        // 合法(amount=0 按 04 非负整数语义放行)
        let action = Action::Scroll {
            direction: ScrollDirection::Down,
            amount: 0,
            coordinate: None,
            modifiers: vec!["shift".to_string()],
        };
        assert!(action.validate(&scale_16x9()).is_ok());
    }

    #[test]
    fn validate_click_params() {
        // ctrl+click 合法
        let action = Action::Click {
            button: MouseButton::Left,
            count: ClickCount::Single,
            coordinate: Some(Point::new(100, 100)),
            modifiers: vec!["ctrl".to_string()],
        };
        assert!(action.validate(&scale_16x9()).is_ok());
        // 越界坐标拒绝
        let action = Action::Click {
            button: MouseButton::Left,
            count: ClickCount::Single,
            coordinate: Some(Point::new(-1, 0)),
            modifiers: vec![],
        };
        assert!(matches!(
            action.validate(&scale_16x9()),
            Err(ActionError::InvalidParams(_))
        ));
    }

    #[test]
    fn validate_cursor_position_ok() {
        assert!(Action::CursorPosition.validate(&scale_16x9()).is_ok());
    }

    #[test]
    fn is_valid_key_name_covers_spec() {
        // 04 §2.4 键名规范全覆盖
        let spec_names = [
            "ctrl", "alt", "shift", "win", "a", "z", "0", "9", "f1", "f12", "f24", "enter",
            "tab", "space", "backspace", "delete", "escape", "arrow_up", "arrow_down",
            "arrow_left", "arrow_right", "home", "end", "page_up", "page_down", "caps_lock",
        ];
        for name in spec_names {
            assert!(is_valid_key_name(name), "规范键名 {name} 应合法");
        }
        // 扩展键
        for name in ["insert", "pause", "scroll_lock", "num_lock"] {
            assert!(is_valid_key_name(name));
        }
        // 非法键名
        for name in ["f25", "bogus", "ctrl+a", "", "ü"] {
            assert!(!is_valid_key_name(name), "非法键名 {name} 应拒绝");
        }
    }

    #[test]
    fn chunk_text_groups_by_chars() {
        // 42 中文 → 1 块
        let text = "中".repeat(42);
        let chunks = chunk_text(&text, TYPING_GROUP_SIZE);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].chars().count(), 42);
        // 86 → 2 块(50 + 36)
        let text = "a".repeat(86);
        let chunks = chunk_text(&text, TYPING_GROUP_SIZE);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), 50);
        assert_eq!(chunks[1].chars().count(), 36);
        // emoji 代理对不被截断:"❤️🙂" 为 3 个 char(❤=1 + VS16=1 + 🙂=1),
        // 30 次重复 = 90 字符,分块后字符总数不变
        let text = "❤️🙂".repeat(30);
        let chunks = chunk_text(&text, TYPING_GROUP_SIZE);
        assert_eq!(chunks.iter().map(|c| c.chars().count()).sum::<usize>(), 90);
        // 空文本 → 空数组
        assert!(chunk_text("", TYPING_GROUP_SIZE).is_empty());
        // 组大小 0 防御
        assert!(chunk_text("abc", 0).is_empty());
    }

    #[test]
    fn action_serde_roundtrip() {
        let action = Action::Click {
            button: MouseButton::Right,
            count: ClickCount::Double,
            coordinate: Some(Point::new(10, 20)),
            modifiers: vec!["ctrl".to_string()],
        };
        let json = serde_json::to_string(&action).expect("序列化失败");
        let back: Action = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(action, back);
    }
}
