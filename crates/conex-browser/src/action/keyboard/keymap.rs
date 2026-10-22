//! 修饰键位掩码、键规格 KeySpec 与特殊键映射表 KEY_MAP（§4.3 表；自 keyboard.rs 平移）。

/// 修饰键位掩码（§4.3 表）。
pub const MOD_SHIFT: i32 = 8;
pub const MOD_CTRL: i32 = 2;
pub const MOD_ALT: i32 = 1;
pub const MOD_META: i32 = 4;

/// 键规格（§4.3 表条目：键名/key/code/VK/修饰掩码/Shift 依赖）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySpec {
    /// 键名（e.key 字段；单字符键为实际字符）
    pub name: String,
    /// KeyboardEvent.code（"KeyA"/"Digit0"/"ControlLeft" 等）
    pub code: String,
    /// windowsVirtualKeyCode
    pub vk: i32,
    /// 修饰键位掩码（非修饰键为 0：Shift=8/Control=2/Alt=1/Meta=4）
    pub modifier_mask: i32,
    /// 需要 Shift 的组合（大写/上档符号字符）
    pub shift: bool,
}

impl KeySpec {
    fn named(name: &str, code: &str, vk: i32) -> KeySpec {
        KeySpec {
            name: name.to_string(),
            code: code.to_string(),
            vk,
            modifier_mask: 0,
            shift: false,
        }
    }

    fn modifier(name: &str, code: &str, vk: i32, mask: i32) -> KeySpec {
        KeySpec {
            name: name.to_string(),
            code: code.to_string(),
            vk,
            modifier_mask: mask,
            shift: false,
        }
    }
}

/// 特殊键映射表（§4.3 全表：键名 → (code, windowsVirtualKeyCode)）。
pub(crate) static KEY_MAP: std::sync::LazyLock<Vec<KeySpec>> = std::sync::LazyLock::new(|| {
    vec![
        KeySpec::named("Enter", "Enter", 13),
        KeySpec::named("Tab", "Tab", 9),
        KeySpec::named("Escape", "Escape", 27),
        KeySpec::named("Space", "Space", 32),
        KeySpec::named("Backspace", "Backspace", 8),
        KeySpec::named("Delete", "Delete", 46),
        KeySpec::named("Insert", "Insert", 45),
        KeySpec::named("Home", "Home", 36),
        KeySpec::named("End", "End", 35),
        KeySpec::named("PageUp", "PageUp", 33),
        KeySpec::named("PageDown", "PageDown", 34),
        KeySpec::named("ArrowLeft", "ArrowLeft", 37),
        KeySpec::named("ArrowUp", "ArrowUp", 38),
        KeySpec::named("ArrowRight", "ArrowRight", 39),
        KeySpec::named("ArrowDown", "ArrowDown", 40),
        KeySpec::modifier("Shift", "ShiftLeft", 16, MOD_SHIFT),
        KeySpec::modifier("Control", "ControlLeft", 17, MOD_CTRL),
        KeySpec::modifier("Alt", "AltLeft", 18, MOD_ALT),
        KeySpec::modifier("Meta", "MetaLeft", 91, MOD_META),
        KeySpec::named("F1", "F1", 112),
        KeySpec::named("F2", "F2", 113),
        KeySpec::named("F3", "F3", 114),
        KeySpec::named("F4", "F4", 115),
        KeySpec::named("F5", "F5", 116),
        KeySpec::named("F6", "F6", 117),
        KeySpec::named("F7", "F7", 118),
        KeySpec::named("F8", "F8", 119),
        KeySpec::named("F9", "F9", 120),
        KeySpec::named("F10", "F10", 121),
        KeySpec::named("F11", "F11", 122),
        KeySpec::named("F12", "F12", 123),
        KeySpec::named("Numpad0", "Numpad0", 96),
        KeySpec::named("Numpad1", "Numpad1", 97),
        KeySpec::named("Numpad2", "Numpad2", 98),
        KeySpec::named("Numpad3", "Numpad3", 99),
        KeySpec::named("Numpad4", "Numpad4", 100),
        KeySpec::named("Numpad5", "Numpad5", 101),
        KeySpec::named("Numpad6", "Numpad6", 102),
        KeySpec::named("Numpad7", "Numpad7", 103),
        KeySpec::named("Numpad8", "Numpad8", 104),
        KeySpec::named("Numpad9", "Numpad9", 105),
        KeySpec::named("NumpadAdd", "NumpadAdd", 107),
        KeySpec::named("NumpadSubtract", "NumpadSubtract", 109),
        KeySpec::named("NumpadMultiply", "NumpadMultiply", 106),
        KeySpec::named("NumpadDivide", "NumpadDivide", 111),
        KeySpec::named("NumpadDecimal", "NumpadDecimal", 110),
        KeySpec::named(";", "Semicolon", 186),
    ]
});
