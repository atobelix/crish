//! 动作原语(04 二期立项 §2.1/§2.3/§2.4)。
//!
//! 动作枚举与参数校验为纯函数(全平台可编译、可单测);
//! Windows 注入实现(`inject::OsInputBackend`)走 enigo 0.6.1(底层即 SendInput),
//! 鼠标移动因 enigo 绝对坐标仅支持主屏原点,改直连 SetCursorPos
//! (04 §2.2 Windows 表列出的选项之一,支持多显示器负坐标)。
//!
//! 输入节奏(04 §2.3):type 按 50 字符分块 + 12ms 节流;hold_key 时长上限 100s。
//!
//! S6 共享层对齐(05 §4.4):`inject::OsInputBackend` 内可变改造(Mutex<Enigo>)后
//! 直接实现 `conex_shared::input::InputBackend`(八方法全形,click/scroll 补坐标
//! 与修饰键参数);既有 `ComputerSession::dispatch` 派发路径继续可用(见 lib.rs)。

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
            Action::HoldKey { key, duration_secs } => {
                if !is_valid_key_name(key) {
                    return Err(ActionError::InvalidParams(format!("未知键名: {key}")));
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
    scale
        .validate_api(p)
        .map_err(|_| ActionError::CoordsOutOfBounds)?;
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

/// Windows 注入后端(enigo 0.6.1 主实现 + 直连 SetCursorPos/GetCursorPos 补足)。
///
/// S6 对齐(05 §4.4):句柄改 `Mutex<Enigo>` 内可变,全部方法 `&self`,
/// 可经 `Arc<dyn InputBackend>` 共享调用;`InputBackend` 实现补全
/// click/scroll 的坐标与修饰键参数(坐标存在先移动;修饰键 press/release 包裹)。
/// 注入序列以纯数据步骤(`InjectStep`)构建,顺序语义可单测断言。
#[cfg(windows)]
pub mod inject {
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    use async_trait::async_trait;
    use conex_shared::input::{
        ClickCount as SharedClickCount, InputBackend, InputBackendError, KeyName as SharedKeyName,
        MouseButton as SharedMouseButton, PhysicalPoint as SharedPoint,
        ScrollDirection as SharedScrollDirection,
    };
    use enigo::{Axis, Button, Coordinate, Direction, Enigo, Keyboard, Mouse, Settings};

    use super::*;

    /// 统一注入错误(动作层向上透传)
    pub type InjectError = String;

    /// enigo 事件标记("conex" ASCII 位):与真实物理输入区分
    const ENIGO_EXTRA_INFO: usize = u64::from_be_bytes(*b"\0\0\0conex") as usize;

    /// 注入原语序列步骤(纯数据:click/scroll/key 的「移动 → 修饰键包裹」顺序
    /// 语义可单测断言;执行器按序逐条落到 enigo / SetCursorPos)
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum InjectStep {
        /// 绝对移动(物理像素,直连 SetCursorPos)
        MoveTo { x: i32, y: i32 },
        /// 按键按下(归一化键名,经 resolve 解析)
        KeyDown { name: String },
        /// 按键抬起(归一化键名)
        KeyUp { name: String },
        /// 鼠标按压-抬起一次
        ButtonClick { button: enigo::Button },
        /// 滚轮(方向 → 增量符号在构建期确定)
        Wheel { axis: enigo::Axis, amount: i32 },
        /// 等待间隔(毫秒;双击/三击间隔与 hold 时长)
        DelayMs { ms: u64 },
    }

    /// 构建点击序列(纯函数,05 §4.4 语义):
    /// 坐标存在先 MoveTo → 修饰键按序 KeyDown → ButtonClick × times
    /// (间隔 DelayMs,≤ 系统双击时间) → 修饰键逆序 KeyUp。
    /// 顺序与既有 dispatch 包裹路径一致(先移动后修饰键,lib.rs)。
    fn build_click_steps(
        btn: enigo::Button,
        times: u32,
        p: Option<SharedPoint>,
        mods: &[SharedKeyName],
    ) -> Vec<InjectStep> {
        let mut steps = Vec::new();
        if let Some(p) = p {
            steps.push(InjectStep::MoveTo { x: p.x, y: p.y });
        }
        for m in mods {
            steps.push(InjectStep::KeyDown { name: m.0.clone() });
        }
        for i in 0..times {
            steps.push(InjectStep::ButtonClick { button: btn });
            if i + 1 < times {
                steps.push(InjectStep::DelayMs {
                    ms: CLICK_INTERVAL_MS,
                });
            }
        }
        for m in mods.iter().rev() {
            steps.push(InjectStep::KeyUp { name: m.0.clone() });
        }
        steps
    }

    /// 构建滚动序列(纯函数):坐标先 MoveTo → 修饰键按序 KeyDown →
    /// Wheel(方向 → 增量符号) → 修饰键逆序 KeyUp。
    fn build_scroll_steps(
        dir: SharedScrollDirection,
        amount: u32,
        p: Option<SharedPoint>,
        mods: &[SharedKeyName],
    ) -> Vec<InjectStep> {
        let mut steps = Vec::new();
        if let Some(p) = p {
            steps.push(InjectStep::MoveTo { x: p.x, y: p.y });
        }
        for m in mods {
            steps.push(InjectStep::KeyDown { name: m.0.clone() });
        }
        let (axis, signed) = match dir {
            SharedScrollDirection::Up => (Axis::Vertical, -(amount as i32)),
            SharedScrollDirection::Down => (Axis::Vertical, amount as i32),
            SharedScrollDirection::Left => (Axis::Horizontal, -(amount as i32)),
            SharedScrollDirection::Right => (Axis::Horizontal, amount as i32),
        };
        steps.push(InjectStep::Wheel {
            axis,
            amount: signed,
        });
        for m in mods.iter().rev() {
            steps.push(InjectStep::KeyUp { name: m.0.clone() });
        }
        steps
    }

    /// 构建组合键序列(纯函数,04 §2.1):修饰键按序 KeyDown →
    /// 主键 KeyDown[/DelayMs(hold)]/KeyUp → 修饰键逆序 KeyUp。
    fn build_key_steps(keys: &[String], hold_ms: Option<u32>) -> Vec<InjectStep> {
        let mut mods = Vec::new();
        let mut main = None;
        for name in keys {
            if is_modifier_name(name) {
                mods.push(name.clone());
            } else if main.is_none() {
                main = Some(name.clone());
            }
        }
        let mut steps = Vec::new();
        for m in &mods {
            steps.push(InjectStep::KeyDown { name: m.clone() });
        }
        if let Some(main) = main {
            steps.push(InjectStep::KeyDown { name: main.clone() });
            if let Some(ms) = hold_ms {
                steps.push(InjectStep::DelayMs { ms: ms as u64 });
            }
            steps.push(InjectStep::KeyUp { name: main });
        }
        for m in mods.iter().rev() {
            steps.push(InjectStep::KeyUp { name: m.clone() });
        }
        steps
    }

    use crate::security::EmergencyStop;
    use std::sync::Arc;

    /// 安全释放所有按键与鼠标按键（急停中断时清理残留按下状态）
    pub fn release_all_keys_and_buttons(enigo: &mut Enigo) {
        let keys = [
            enigo::Key::Control,
            enigo::Key::Alt,
            enigo::Key::Shift,
            enigo::Key::Meta,
        ];
        for k in keys {
            let _ = enigo.key(k, Direction::Release);
        }
        let buttons = [
            enigo::Button::Left,
            enigo::Button::Middle,
            enigo::Button::Right,
        ];
        for b in buttons {
            let _ = enigo.button(b, Direction::Release);
        }
    }

    /// 执行步骤序列（持锁逐条注入；每一步及 5ms 切片休眠原子轮询 EmergencyStop，<=5ms 响应急停）
    #[allow(unsafe_code)]
    pub fn run_steps_guarded(
        enigo: &mut Enigo,
        steps: &[InjectStep],
        stop: Option<&Arc<EmergencyStop>>,
    ) -> Result<(), InjectError> {
        for (idx, step) in steps.iter().enumerate() {
            if let Some(s) = stop {
                if s.stopped() {
                    release_all_keys_and_buttons(enigo);
                    return Err(format!(
                        "急停触发，注入已中止（已完成 {idx}/{} 步）",
                        steps.len()
                    ));
                }
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
                    let key = OsInputBackend::resolve(name)
                        .ok_or_else(|| format!("键名无法解析: {name}"))?;
                    enigo
                        .key(key, Direction::Press)
                        .map_err(|e| format!("按键按下失败: {e:?}"))?;
                }
                InjectStep::KeyUp { name } => {
                    let key = OsInputBackend::resolve(name)
                        .ok_or_else(|| format!("键名无法解析: {name}"))?;
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
                        if let Some(s) = stop {
                            if s.stopped() {
                                release_all_keys_and_buttons(enigo);
                                return Err(format!(
                                    "急停触发，注入已中止（已完成 {idx}/{} 步）",
                                    steps.len()
                                ));
                            }
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

    /// 向后兼容执行器包装
    pub fn run_steps(enigo: &mut Enigo, steps: &[InjectStep]) -> Result<(), InjectError> {
        run_steps_guarded(enigo, steps, None)
    }

    /// 注入后端:enigo 句柄(`Mutex` 内可变,05 §4.4)+ 键名注册表解析 + 5ms 急停原子轮询。
    ///
    /// 内可变改造后全部方法 `&self`,可经 `Arc<dyn InputBackend>` 共享调用;
    /// 注入为同步原语,std 互斥即可(05 §4.4)。序列级原子性由会话层单消费者保证。
    pub struct OsInputBackend {
        enigo: Mutex<Enigo>,
        stop: Mutex<Option<Arc<EmergencyStop>>>,
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

    /// 本地按键 → enigo 键码(动作面三键)
    fn to_enigo_button(button: MouseButton) -> enigo::Button {
        match button {
            MouseButton::Left => Button::Left,
            MouseButton::Middle => Button::Middle,
            MouseButton::Right => Button::Right,
        }
    }

    /// 共享层按键 → enigo 键码(含侧键 Back/Forward,S6 对齐扩展)
    fn to_enigo_button_shared(button: SharedMouseButton) -> enigo::Button {
        match button {
            SharedMouseButton::Left => Button::Left,
            SharedMouseButton::Middle => Button::Middle,
            SharedMouseButton::Right => Button::Right,
            SharedMouseButton::Back => Button::Back,
            SharedMouseButton::Forward => Button::Forward,
        }
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
                stop: Mutex::new(None),
            })
        }

        /// 绑定急停标志
        pub fn with_stop(self, stop: Arc<EmergencyStop>) -> Self {
            *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = Some(stop);
            self
        }

        /// 动态设置/更新急停标志
        pub fn set_stop(&self, stop: Option<Arc<EmergencyStop>>) {
            *self.stop.lock().unwrap_or_else(|e| e.into_inner()) = stop;
        }

        /// 获取当前急停标志引用克隆
        fn stop_ref(&self) -> Option<Arc<EmergencyStop>> {
            self.stop.lock().unwrap_or_else(|e| e.into_inner()).clone()
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

        /// 组合键注入核心:修饰键按序 down → 主键 down/up → 修饰键 up
        /// (04 §2.1「修饰键多键时保持按住其余键」语义);
        /// `hold_ms = Some` 时主键按住后松开(共享层 key 语义,05 §4.1)。
        fn key_hold_inner(&self, keys: &[String], hold_ms: Option<u32>) -> Result<(), InjectError> {
            let steps = build_key_steps(keys, hold_ms);
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            let stop = self.stop_ref();
            run_steps_guarded(&mut enigo, &steps, stop.as_ref())
        }

        /// 组合键注入(dispatch 路径;hold_ms = None)
        pub fn key(&self, keys: &[String]) -> Result<(), InjectError> {
            self.key_hold_inner(keys, None)
        }

        /// 按住指定键 duration 秒后松开(上限 100s 已在校验层约束，5ms 切片原子急停轮询)
        pub fn hold_key(&self, name: &str, duration_secs: f32) -> Result<(), InjectError> {
            let key = Self::resolve(name).ok_or_else(|| format!("键名无法解析: {name}"))?;
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            let stop = self.stop_ref();
            if let Some(ref s) = stop {
                if s.stopped() {
                    release_all_keys_and_buttons(&mut enigo);
                    return Err("急停触发，按键保持中止".to_string());
                }
            }
            enigo
                .key(key, Direction::Press)
                .map_err(|e| format!("按键按下失败: {e:?}"))?;

            let mut remaining_ms = (duration_secs * 1000.0) as u64;
            while remaining_ms > 0 {
                if let Some(ref s) = stop {
                    if s.stopped() {
                        release_all_keys_and_buttons(&mut enigo);
                        return Err("急停触发，按键保持中止".to_string());
                    }
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
        /// 不依赖 IME,37 报告 Gate-B 三应用 0 丢字实证；5ms 切片原子急停轮询)
        fn type_text_inner(&self, text: &str) -> Result<(), InjectError> {
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            let stop = self.stop_ref();
            for chunk in chunk_text(text, TYPING_GROUP_SIZE) {
                if let Some(ref s) = stop {
                    if s.stopped() {
                        release_all_keys_and_buttons(&mut enigo);
                        return Err("急停触发，文本输入中止".to_string());
                    }
                }
                enigo
                    .text(&chunk)
                    .map_err(|e| format!("文本注入失败: {e:?}"))?;
                let mut remaining_ms = TYPING_DELAY_MS;
                while remaining_ms > 0 {
                    if let Some(ref s) = stop {
                        if s.stopped() {
                            release_all_keys_and_buttons(&mut enigo);
                            return Err("急停触发，文本输入中止".to_string());
                        }
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
            let stop = self.stop_ref();
            run_steps_guarded(&mut enigo, &steps, stop.as_ref())
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

        /// 拖拽:起点按下 → 分步线性插值移动 → 终点抬起(04 §2.2 语义；5ms 切片原子急停轮询)
        pub fn drag(&self, from: Point, to: Point) -> Result<(), InjectError> {
            let stop = self.stop_ref();
            if let Some(ref s) = stop {
                if s.stopped() {
                    let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
                    release_all_keys_and_buttons(&mut enigo);
                    return Err("急停触发，拖拽中止".to_string());
                }
            }
            self.mouse_move(from)?;
            self.mouse_button(MouseButton::Left, true)?;
            let dx = to.x - from.x;
            let dy = to.y - from.y;
            let distance = (dx.abs().max(dy.abs())) as i64;
            let steps = (distance + DRAG_STEP_PX as i64 - 1) / DRAG_STEP_PX as i64;
            let steps = steps.max(1);
            for step in 1..=steps {
                if let Some(ref s) = stop {
                    if s.stopped() {
                        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
                        release_all_keys_and_buttons(&mut enigo);
                        return Err("急停触发，拖拽中止".to_string());
                    }
                }
                let t = step as f64 / steps as f64;
                let x = from.x + (dx as f64 * t).round() as i32;
                let y = from.y + (dy as f64 * t).round() as i32;
                self.mouse_move(Point::new(x, y))?;
                let mut remaining_ms = DRAG_STEP_DELAY_MS;
                while remaining_ms > 0 {
                    if let Some(ref s) = stop {
                        if s.stopped() {
                            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
                            release_all_keys_and_buttons(&mut enigo);
                            return Err("急停触发，拖拽中止".to_string());
                        }
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
            let stop = self.stop_ref();
            run_steps_guarded(&mut enigo, &steps, stop.as_ref())
        }

        /// 按住一组修饰键(click/scroll 带 modifiers 语义,dispatch 前置包裹面)
        pub fn press_modifiers(&self, modifiers: &[String]) -> Result<(), InjectError> {
            let steps: Vec<InjectStep> = modifiers
                .iter()
                .map(|m| InjectStep::KeyDown { name: m.clone() })
                .collect();
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            let stop = self.stop_ref();
            run_steps_guarded(&mut enigo, &steps, stop.as_ref())
        }

        /// 抬起一组修饰键(逆序)
        pub fn release_modifiers(&self, modifiers: &[String]) -> Result<(), InjectError> {
            let steps: Vec<InjectStep> = modifiers
                .iter()
                .rev()
                .map(|m| InjectStep::KeyUp { name: m.clone() })
                .collect();
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            let stop = self.stop_ref();
            run_steps_guarded(&mut enigo, &steps, stop.as_ref())
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

    /// 共享层输入后端对齐(05 §4.4):八方法全形,click/scroll 补坐标与修饰键
    /// (坐标存在先移动;修饰键 press/release 包裹)。
    ///
    /// 与既有 `ComputerSession::dispatch` 派发路径并存:dispatch 走本地方法
    /// (坐标/修饰键由 dispatch 前置包裹,lib.rs),共享 trait 方法为 S6 新契约;
    /// 两者共享 `build_*` 序列构建与 `run_steps` 执行器,注入语义一致。
    #[async_trait]
    impl InputBackend for OsInputBackend {
        async fn mouse_move(&self, p: SharedPoint) -> Result<(), InputBackendError> {
            self.mouse_move(Point::new(p.x, p.y))
                .map_err(InputBackendError::Failed)
        }

        async fn click(
            &self,
            btn: SharedMouseButton,
            count: SharedClickCount,
            p: Option<SharedPoint>,
            mods: &[SharedKeyName],
        ) -> Result<(), InputBackendError> {
            let times = match count {
                SharedClickCount::Single => 1,
                SharedClickCount::Double => 2,
                SharedClickCount::Triple => 3,
            };
            let steps = build_click_steps(to_enigo_button_shared(btn), times, p, mods);
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            run_steps(&mut enigo, &steps).map_err(InputBackendError::Failed)
        }

        async fn button(
            &self,
            btn: SharedMouseButton,
            down: bool,
        ) -> Result<(), InputBackendError> {
            let direction = if down {
                Direction::Press
            } else {
                Direction::Release
            };
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            enigo
                .button(to_enigo_button_shared(btn), direction)
                .map_err(|e| InputBackendError::Failed(format!("鼠标按键失败: {e:?}")))
        }

        async fn drag(&self, from: SharedPoint, to: SharedPoint) -> Result<(), InputBackendError> {
            self.drag(Point::new(from.x, from.y), Point::new(to.x, to.y))
                .map_err(InputBackendError::Failed)
        }

        async fn scroll(
            &self,
            dir: SharedScrollDirection,
            amount: u32,
            p: Option<SharedPoint>,
            mods: &[SharedKeyName],
        ) -> Result<(), InputBackendError> {
            let steps = build_scroll_steps(dir, amount, p, mods);
            let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
            run_steps(&mut enigo, &steps).map_err(InputBackendError::Failed)
        }

        async fn type_text(&self, text: &str) -> Result<(), InputBackendError> {
            self.type_text_inner(text)
                .map_err(InputBackendError::Failed)
        }

        async fn key(
            &self,
            keys: &[SharedKeyName],
            hold_ms: Option<u32>,
        ) -> Result<(), InputBackendError> {
            let names: Vec<String> = keys.iter().map(|k| k.0.clone()).collect();
            self.key_hold_inner(&names, hold_ms)
                .map_err(InputBackendError::Failed)
        }

        async fn cursor_position(&self) -> Result<SharedPoint, InputBackendError> {
            let p = self.cursor_physical().map_err(InputBackendError::Failed)?;
            Ok(SharedPoint { x: p.x, y: p.y })
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// 共享坐标构造
        fn p(x: i32, y: i32) -> SharedPoint {
            SharedPoint { x, y }
        }

        /// 共享键名构造
        fn kn(name: &str) -> SharedKeyName {
            SharedKeyName(name.to_string())
        }

        #[test]
        fn click_steps_coord_moves_first_then_mods_wrapped() {
            // 带坐标 + 修饰键:MoveTo → KeyDown(ctrl) → 点击 → KeyUp(ctrl)
            let steps = build_click_steps(Button::Left, 1, Some(p(100, 200)), &[kn("ctrl")]);
            assert_eq!(
                steps,
                vec![
                    InjectStep::MoveTo { x: 100, y: 200 },
                    InjectStep::KeyDown {
                        name: "ctrl".to_string()
                    },
                    InjectStep::ButtonClick {
                        button: Button::Left
                    },
                    InjectStep::KeyUp {
                        name: "ctrl".to_string()
                    },
                ]
            );
        }

        #[test]
        fn click_steps_without_coords_no_move() {
            let steps = build_click_steps(Button::Left, 1, None, &[]);
            assert_eq!(
                steps,
                vec![InjectStep::ButtonClick {
                    button: Button::Left
                }]
            );
        }

        #[test]
        fn click_steps_double_generates_interval_delay() {
            // 双击:两次点击间插入 CLICK_INTERVAL_MS 间隔(≤ 系统双击时间,后端生成)
            let steps = build_click_steps(Button::Right, 2, None, &[]);
            assert_eq!(
                steps,
                vec![
                    InjectStep::ButtonClick {
                        button: Button::Right
                    },
                    InjectStep::DelayMs {
                        ms: CLICK_INTERVAL_MS
                    },
                    InjectStep::ButtonClick {
                        button: Button::Right
                    },
                ]
            );
        }

        #[test]
        fn click_steps_triple_generates_two_delays() {
            let steps = build_click_steps(Button::Left, 3, None, &[]);
            assert_eq!(steps.len(), 5);
            assert_eq!(
                steps[0],
                InjectStep::ButtonClick {
                    button: Button::Left
                }
            );
            assert_eq!(
                steps[2],
                InjectStep::ButtonClick {
                    button: Button::Left
                }
            );
            assert_eq!(
                steps[4],
                InjectStep::ButtonClick {
                    button: Button::Left
                }
            );
            assert_eq!(
                steps[1],
                InjectStep::DelayMs {
                    ms: CLICK_INTERVAL_MS
                }
            );
            assert_eq!(
                steps[3],
                InjectStep::DelayMs {
                    ms: CLICK_INTERVAL_MS
                }
            );
        }

        #[test]
        fn click_steps_multi_mods_press_order_release_reverse() {
            // [ctrl, alt]:按序 down、逆序 up(04 §2.1 修饰键语义)
            let steps = build_click_steps(Button::Left, 1, None, &[kn("ctrl"), kn("alt")]);
            assert_eq!(
                steps,
                vec![
                    InjectStep::KeyDown {
                        name: "ctrl".to_string()
                    },
                    InjectStep::KeyDown {
                        name: "alt".to_string()
                    },
                    InjectStep::ButtonClick {
                        button: Button::Left
                    },
                    InjectStep::KeyUp {
                        name: "alt".to_string()
                    },
                    InjectStep::KeyUp {
                        name: "ctrl".to_string()
                    },
                ]
            );
        }

        #[test]
        fn scroll_steps_move_mods_wheel_wrapped() {
            let steps = build_scroll_steps(
                SharedScrollDirection::Down,
                3,
                Some(p(5, 6)),
                &[kn("shift")],
            );
            assert_eq!(
                steps,
                vec![
                    InjectStep::MoveTo { x: 5, y: 6 },
                    InjectStep::KeyDown {
                        name: "shift".to_string()
                    },
                    InjectStep::Wheel {
                        axis: Axis::Vertical,
                        amount: 3
                    },
                    InjectStep::KeyUp {
                        name: "shift".to_string()
                    },
                ]
            );
        }

        #[test]
        fn scroll_steps_direction_sign_mapping() {
            // 正=下/右,负=上/左(enigo scroll 语义)
            let up = build_scroll_steps(SharedScrollDirection::Up, 4, None, &[]);
            assert_eq!(
                up[0],
                InjectStep::Wheel {
                    axis: Axis::Vertical,
                    amount: -4
                }
            );
            let left = build_scroll_steps(SharedScrollDirection::Left, 2, None, &[]);
            assert_eq!(
                left[0],
                InjectStep::Wheel {
                    axis: Axis::Horizontal,
                    amount: -2
                }
            );
            let right = build_scroll_steps(SharedScrollDirection::Right, 2, None, &[]);
            assert_eq!(
                right[0],
                InjectStep::Wheel {
                    axis: Axis::Horizontal,
                    amount: 2
                }
            );
        }

        #[test]
        fn key_steps_mods_order_and_reverse_release() {
            let steps = build_key_steps(
                &["ctrl".to_string(), "alt".to_string(), "c".to_string()],
                None,
            );
            assert_eq!(
                steps,
                vec![
                    InjectStep::KeyDown {
                        name: "ctrl".to_string()
                    },
                    InjectStep::KeyDown {
                        name: "alt".to_string()
                    },
                    InjectStep::KeyDown {
                        name: "c".to_string()
                    },
                    InjectStep::KeyUp {
                        name: "c".to_string()
                    },
                    InjectStep::KeyUp {
                        name: "alt".to_string()
                    },
                    InjectStep::KeyUp {
                        name: "ctrl".to_string()
                    },
                ]
            );
        }

        #[test]
        fn key_steps_hold_ms_inserts_delay_between_down_up() {
            // hold_ms = Some:主键 down → DelayMs → up(05 §4.1 语义)
            let steps = build_key_steps(&["a".to_string()], Some(500));
            assert_eq!(
                steps,
                vec![
                    InjectStep::KeyDown {
                        name: "a".to_string()
                    },
                    InjectStep::DelayMs { ms: 500 },
                    InjectStep::KeyUp {
                        name: "a".to_string()
                    },
                ]
            );
        }

        #[test]
        fn shared_button_mapping_covers_side_buttons() {
            // 共享层五键全映射(含侧键,05 §4.1 扩展面)
            assert_eq!(
                to_enigo_button_shared(SharedMouseButton::Left),
                Button::Left
            );
            assert_eq!(
                to_enigo_button_shared(SharedMouseButton::Middle),
                Button::Middle
            );
            assert_eq!(
                to_enigo_button_shared(SharedMouseButton::Right),
                Button::Right
            );
            assert_eq!(
                to_enigo_button_shared(SharedMouseButton::Back),
                Button::Back
            );
            assert_eq!(
                to_enigo_button_shared(SharedMouseButton::Forward),
                Button::Forward
            );
            // 动作面三键映射
            assert_eq!(to_enigo_button(MouseButton::Left), Button::Left);
            assert_eq!(to_enigo_button(MouseButton::Middle), Button::Middle);
            assert_eq!(to_enigo_button(MouseButton::Right), Button::Right);
        }

        #[test]
        fn os_input_backend_send_sync_and_implements_trait() {
            // 内可变改造后:可装箱为共享引用 trait 对象(Send + Sync)
            fn assert_send_sync<T: Send + Sync>() {}
            assert_send_sync::<OsInputBackend>();
            fn assert_backend<T: InputBackend>() {}
            assert_backend::<OsInputBackend>();
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
        let action = Action::Type {
            text: String::new(),
        };
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
                matches!(
                    action.validate(&scale_16x9()),
                    Err(ActionError::InvalidParams(_))
                ),
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
            "ctrl",
            "alt",
            "shift",
            "win",
            "a",
            "z",
            "0",
            "9",
            "f1",
            "f12",
            "f24",
            "enter",
            "tab",
            "space",
            "backspace",
            "delete",
            "escape",
            "arrow_up",
            "arrow_down",
            "arrow_left",
            "arrow_right",
            "home",
            "end",
            "page_up",
            "page_down",
            "caps_lock",
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

    #[test]
    #[cfg(windows)]
    fn adversarial_computer_estop_5ms_response() {
        use crate::action::inject::{run_steps_guarded, InjectStep};
        use crate::security::EmergencyStop;
        use std::sync::Arc;

        let stop = Arc::new(EmergencyStop::new());
        let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).unwrap();
        let steps = vec![
            InjectStep::DelayMs { ms: 200 },
            InjectStep::DelayMs { ms: 200 },
        ];

        let stop_clone = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(15));
            stop_clone.panel_stop();
        });

        let start = std::time::Instant::now();
        let res = run_steps_guarded(&mut enigo, &steps, Some(&stop));
        let elapsed = start.elapsed();

        assert!(res.is_err(), "注入必须被急停中断");
        assert!(
            elapsed.as_millis() < 80,
            "急停响应延迟必须 <= 5ms（实际总耗时 {}ms）",
            elapsed.as_millis()
        );
    }
}
