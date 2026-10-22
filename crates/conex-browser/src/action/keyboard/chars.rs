//! 字符键规格（§4.2）与 keyDown/char/keyUp 事件参数构造（自 keyboard.rs 平移）。

use super::KeySpec;
use crate::cdp::domains::DispatchKeyEventParams;

/// 单个字符键的 KeySpec（§4.2：按字符值注入，布局无关）。
pub(super) fn char_spec(token: &str) -> Option<KeySpec> {
    let mut chars = token.chars();
    let c = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    ascii_key_info(c).map(|(name, code, vk, shift)| KeySpec {
        name,
        code,
        vk,
        modifier_mask: 0,
        shift,
    })
}

/// ASCII 可打印字符 → (key, code, VK, 需要 Shift)。
/// 上档符号（!@# 等）按 US 布局取未上档键位（§4.2：key/text 传实际字符，VK 传对应键）。
pub(super) fn ascii_key_info(c: char) -> Option<(String, String, i32, bool)> {
    match c {
        'a'..='z' => {
            let upper = c.to_ascii_uppercase();
            Some((c.to_string(), format!("Key{upper}"), upper as i32, false))
        }
        'A'..='Z' => Some((c.to_string(), format!("Key{c}"), c as i32, true)),
        '0'..='9' => Some((c.to_string(), format!("Digit{c}"), c as i32, false)),
        ' ' => Some((" ".to_string(), "Space".to_string(), 32, false)),
        '!' => Some(("!".to_string(), "Digit1".to_string(), 49, true)),
        '@' => Some(("@".to_string(), "Digit2".to_string(), 50, true)),
        '#' => Some(("#".to_string(), "Digit3".to_string(), 51, true)),
        '$' => Some(("$".to_string(), "Digit4".to_string(), 52, true)),
        '%' => Some(("%".to_string(), "Digit5".to_string(), 53, true)),
        '^' => Some(("^".to_string(), "Digit6".to_string(), 54, true)),
        '&' => Some(("&".to_string(), "Digit7".to_string(), 55, true)),
        '*' => Some(("*".to_string(), "Digit8".to_string(), 56, true)),
        '(' => Some(("(".to_string(), "Digit9".to_string(), 57, true)),
        ')' => Some((")".to_string(), "Digit0".to_string(), 48, true)),
        '_' => Some(("_".to_string(), "Minus".to_string(), 189, true)),
        '-' => Some(("-".to_string(), "Minus".to_string(), 189, false)),
        '+' => Some(("+".to_string(), "Equal".to_string(), 187, true)),
        '=' => Some(("=".to_string(), "Equal".to_string(), 187, false)),
        '{' => Some(("{".to_string(), "BracketLeft".to_string(), 219, true)),
        '[' => Some(("[".to_string(), "BracketLeft".to_string(), 219, false)),
        '}' => Some(("}".to_string(), "BracketRight".to_string(), 221, true)),
        ']' => Some(("]".to_string(), "BracketRight".to_string(), 221, false)),
        '|' => Some(("|".to_string(), "Backslash".to_string(), 220, true)),
        '\\' => Some(("\\".to_string(), "Backslash".to_string(), 220, false)),
        ':' => Some((":".to_string(), "Semicolon".to_string(), 186, true)),
        ';' => Some((";".to_string(), "Semicolon".to_string(), 186, false)),
        '"' => Some(("\"".to_string(), "Quote".to_string(), 222, true)),
        '\'' => Some(("'".to_string(), "Quote".to_string(), 222, false)),
        '<' => Some(("<".to_string(), "Comma".to_string(), 188, true)),
        ',' => Some((",".to_string(), "Comma".to_string(), 188, false)),
        '>' => Some((">".to_string(), "Period".to_string(), 190, true)),
        '.' => Some((".".to_string(), "Period".to_string(), 190, false)),
        '?' => Some(("?".to_string(), "Slash".to_string(), 191, true)),
        '/' => Some(("/".to_string(), "Slash".to_string(), 191, false)),
        '~' => Some(("~".to_string(), "Backquote".to_string(), 192, true)),
        '`' => Some(("`".to_string(), "Backquote".to_string(), 192, false)),
        _ => None,
    }
}

/// 可打印 ASCII（type 逐字符三事件序列适用面）。
pub(super) fn is_ascii_typeable(c: char) -> bool {
    c.is_ascii() && !c.is_ascii_control()
}

// —— 事件参数构造（§4.2 三事件序列 + 组合键）——

/// keyDown 参数（§4.2/§4.3）：**不携带 text/unmodified_text**——文本插入由
/// 独立 char 事件唯一承载。F1 实测：keyDown 带 text 时 Chrome 立即插入文本，
/// 再加独立 char 事件将双写（`keyDown(text)+char` → "d"→"dd"；组合键
/// `Control+A` 亦双写 → "AA"）。key/code 保留（页面 keydown 处理器读 e.key/e.code）。
pub(super) fn key_down(key: &str, code: &str, modifiers: i32, vk: i32) -> DispatchKeyEventParams {
    DispatchKeyEventParams {
        event_type: "keyDown".to_string(),
        key: Some(key.to_string()),
        code: Some(code.to_string()),
        text: None,
        unmodified_text: None,
        windows_virtual_key_code: Some(vk),
        native_virtual_key_code: None,
        modifiers: Some(modifiers),
    }
}

pub(super) fn key_up(key: &str, code: &str, modifiers: i32, vk: i32) -> DispatchKeyEventParams {
    DispatchKeyEventParams {
        event_type: "keyUp".to_string(),
        key: Some(key.to_string()),
        code: Some(code.to_string()),
        text: None,
        unmodified_text: None,
        windows_virtual_key_code: Some(vk),
        native_virtual_key_code: None,
        modifiers: Some(modifiers),
    }
}

pub(super) fn char_event(text: &str) -> DispatchKeyEventParams {
    DispatchKeyEventParams {
        event_type: "char".to_string(),
        key: None,
        code: None,
        text: Some(text.to_string()),
        unmodified_text: None,
        windows_virtual_key_code: None,
        native_virtual_key_code: None,
        modifiers: None,
    }
}
