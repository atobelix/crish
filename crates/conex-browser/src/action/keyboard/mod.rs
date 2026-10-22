//! 键盘管线（维度 14 §4，keyboard.rs）：type（分块 + 节流 + 回读校验）/ key（组合键）
//!
//! - **type**（§4.1）：50 字符/块（TYPE_CHUNK_SIZE）、块间 12ms 节流、分块间 abort
//!   检查与回读校验（§4.4）；可打印 ASCII 走三事件序列（keyDown → char → keyUp，
//!   isTrusted=true），非 ASCII（CJK 等）整块走 `Input.insertText`（IME 安全路径）；
//!   **keyDown 绝不携带 text/unmodified_text**——文本由独立 char 事件唯一承载
//!   （F1 实测：keyDown 带 text 又发独立 char → Chrome 对两者都插入 → "d" 变 "dd"）；
//! - **key**（§4.3）：`"Control+A"` 组合格式——修饰键按下 → 主键 down/up →
//!   修饰键逆序释放，释放用 try/finally 语义兜底（主键事件抛错也必须释放，防逻辑卡键）；
//! - 键映射表 `KEY_MAP`（§4.3 表：Enter/Tab/Escape/Space/Backspace/Delete/Insert/Home/
//!   End/PageUp/PageDown/方向键/修饰键/F1-F12/Numpad 等，Windows VK 编码）；
//! - 回读校验（§4.4）：固定模板读 activeElement value/innerText，尾部比对，
//!   缺失片段 insertText 补差；连续 2 块失败 → 可重试错误；password 只比对长度。

mod chars;
mod dispatch;
mod keymap;
#[cfg(test)]
mod tests;

use chars::char_spec;
pub use dispatch::{
    dispatch_focus, dispatch_key, dispatch_select_option, dispatch_type, press_key_name,
};
pub(crate) use keymap::KEY_MAP;
pub use keymap::{KeySpec, MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT};

/// 组合键序列（§4.3 解析产物）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeySequence {
    /// 按序按下的修饰键（逆序释放）
    pub modifiers: Vec<KeySpec>,
    /// 主键
    pub main: KeySpec,
}

/// 键名查找（大小写不敏感；§4.3 表）。
pub fn lookup_key(name: &str) -> Option<KeySpec> {
    KEY_MAP
        .iter()
        .find(|spec| spec.name.eq_ignore_ascii_case(name))
        .cloned()
}

/// 解析组合键（`"Control+A"`；`"Control++"` → 修饰键 + 字面 `+`）。
/// 非法键名 → Err（validate_request 拦截为 InvalidInput）。
pub fn parse_key_sequence(keys: &str) -> Result<KeySequence, String> {
    if keys.is_empty() {
        return Err("键串为空".to_string());
    }
    let mut tokens: Vec<&str> = keys.split('+').collect();
    // 尾随 '+' 视为字面加号（"Control++" → [Control, +]；split 的尾随空 token 丢弃）
    let tail_plus = keys.ends_with('+');
    if tail_plus {
        tokens.pop();
    }
    tokens.retain(|t| !t.is_empty());
    if tail_plus {
        tokens.push("+");
    }
    let mut modifiers: Vec<KeySpec> = Vec::new();
    let mut main: Option<KeySpec> = None;
    for token in tokens {
        let spec = lookup_key(token)
            .or_else(|| char_spec(token))
            .ok_or_else(|| format!("非法键名：{token}"))?;
        if spec.modifier_mask != 0 {
            // 修饰键去重（重复按下无意义）
            if !modifiers
                .iter()
                .any(|m| m.modifier_mask == spec.modifier_mask)
            {
                modifiers.push(spec);
            }
        } else if main.is_none() {
            main = Some(spec);
        } else {
            return Err(format!("组合键只能有一个主键：{keys}"));
        }
    }
    let main = match main {
        Some(main) => main,
        None => {
            // 纯修饰键串（如 "Control"）：最后一个修饰键充当主键（down/up 一次）
            modifiers.pop().ok_or_else(|| "缺少主键".to_string())?
        }
    };
    Ok(KeySequence { modifiers, main })
}
