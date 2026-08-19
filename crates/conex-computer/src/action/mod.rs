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
/// 按领域拆为四个子模块：
/// - `steps`: 注入步骤枚举与纯函数构建器（步骤构建域）
/// - `keys`: 键名→enigo 映射与按钮映射（键映射域）
/// - `backend`: OsInputBackend 结构与执行器（后端/执行域）
/// - `input`: InputBackend trait 实现（分发域）
#[cfg(windows)]
pub mod inject;

#[cfg(test)]
mod tests;
