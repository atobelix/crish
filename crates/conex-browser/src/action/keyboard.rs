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

use crate::action::{ActionError, ActionErrorKind, ActionExecutor};
use crate::cdp::domains::DispatchKeyEventParams;

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

/// 单个字符键的 KeySpec（§4.2：按字符值注入，布局无关）。
fn char_spec(token: &str) -> Option<KeySpec> {
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
fn ascii_key_info(c: char) -> Option<(String, String, i32, bool)> {
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
fn is_ascii_typeable(c: char) -> bool {
    c.is_ascii() && !c.is_ascii_control()
}

// —— 事件参数构造（§4.2 三事件序列 + 组合键）——

/// keyDown 参数（§4.2/§4.3）：**不携带 text/unmodified_text**——文本插入由
/// 独立 char 事件唯一承载。F1 实测：keyDown 带 text 时 Chrome 立即插入文本，
/// 再加独立 char 事件将双写（`keyDown(text)+char` → "d"→"dd"；组合键
/// `Control+A` 亦双写 → "AA"）。key/code 保留（页面 keydown 处理器读 e.key/e.code）。
fn key_down(key: &str, code: &str, modifiers: i32, vk: i32) -> DispatchKeyEventParams {
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

fn key_up(key: &str, code: &str, modifiers: i32, vk: i32) -> DispatchKeyEventParams {
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

fn char_event(text: &str) -> DispatchKeyEventParams {
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

/// 组合键派发（§4.3：修饰键按下 → 主键 down/char/up → 修饰键逆序释放）。
/// 释放段用 try/finally 语义：主键事件抛错也必须释放已按下的修饰键（防逻辑卡键）。
/// 组合键派发（§4.3：修饰键按下 → 主键 down/char/up → 修饰键逆序释放）。
/// 释放段用 try/finally 语义：修饰键按下与主键事件**任一**抛错都必须释放已按下的
/// 修饰键（防逻辑卡键）——整段按下序列包在 async 块中，释放循环在其后无条件执行。
pub async fn dispatch_key(exec: &ActionExecutor, keys: &str) -> Result<(), ActionError> {
    let sequence = parse_key_sequence(keys).map_err(|e| {
        ActionError::new(
            ActionErrorKind::InvalidInput,
            format!("非法键名：{keys}（{e}）"),
        )
    })?;
    let mut mask = 0;
    let press_result: Result<(), ActionError> = async {
        // 修饰键按下（掩码累计）
        for modifier in &sequence.modifiers {
            mask |= modifier.modifier_mask;
            exec.ops
                .key_event(key_down(&modifier.name, &modifier.code, mask, modifier.vk))
                .await?;
        }
        // 主键 down/up（可打印单字符补 char 事件；text 由 char 事件唯一承载，
        // keyDown 不携带 text（F1：Chrome 对两者都插入 → 双写）；§4.2
        // 「按字符值注入，布局无关」——不额外叠加 Shift 位，对齐 Puppeteer 语义）
        let main_mask = mask;
        let printable = sequence.main.name.chars().count() == 1;
        exec.ops
            .key_event(key_down(
                &sequence.main.name,
                &sequence.main.code,
                main_mask,
                sequence.main.vk,
            ))
            .await?;
        if printable {
            exec.ops.key_event(char_event(&sequence.main.name)).await?;
        }
        exec.ops
            .key_event(key_up(
                &sequence.main.name,
                &sequence.main.code,
                main_mask,
                sequence.main.vk,
            ))
            .await?;
        Ok(())
    }
    .await;
    // try/finally：修饰键逆序释放（无论主键成败）
    for modifier in sequence.modifiers.iter().rev() {
        mask &= !modifier.modifier_mask;
        let _ = exec
            .ops
            .key_event(key_up(&modifier.name, &modifier.code, mask, modifier.vk))
            .await;
    }
    press_result
}

/// 单键按下（submit_key / 特殊键，§2.3）。
pub async fn press_key_name(exec: &ActionExecutor, key_name: &str) -> Result<(), ActionError> {
    dispatch_key(exec, key_name).await
}

/// type 派发（§4.1：分块 + 节流 + abort 中断 + 回读校验；submit 键在末尾）。
pub async fn dispatch_type(
    exec: &ActionExecutor,
    node_id: i64,
    text: &str,
    submit_key: Option<&str>,
    is_password: bool,
) -> Result<(), ActionError> {
    // 无坐标路径：DOM.focus 进入可输入焦点（§2.3）
    exec.ops.focus_node(node_id).await?;
    let chars: Vec<char> = text.chars().collect();
    let mut pos = 0usize;
    let mut failures = 0u32;
    while pos < chars.len() {
        // 分块间 abort 检查（§4.1；用户接管即中断，已输入部分保留，E2E-17）
        if exec.abort.is_cancelled() {
            return Err(ActionError::new(
                ActionErrorKind::Aborted,
                "用户接管/令牌吊销（type 分块间中断）",
            ));
        }
        let end = (pos + exec.opts.type_chunk_size).min(chars.len());
        let chunk = &chars[pos..end];
        let chunk_text: String = chunk.iter().collect();
        if chunk.iter().all(|c| is_ascii_typeable(*c)) {
            // 可打印 ASCII：逐字符三事件序列（§4.2）
            for c in chunk {
                dispatch_char(exec, *c).await?;
            }
        } else {
            // 非 ASCII（中文等）整块 insertText（IME 组合输入处理，§4.4）
            exec.ops.insert_text(&chunk_text).await?;
        }
        pos = end;
        if pos < chars.len() {
            // 块间节流（§4.1：12ms）+ 回读校验（§4.4）
            exec.delay.sleep(exec.opts.type_chunk_delay).await;
            let expected: String = chars.iter().take(pos).collect();
            if !verify_progress(exec, &expected, is_password).await? {
                failures += 1;
                if failures >= 2 {
                    return Err(ActionError::new(
                        ActionErrorKind::NotInteractive,
                        "type 回读校验连续 2 块失败（页面吞字符，§4.4）",
                    ));
                }
            } else {
                failures = 0;
            }
        }
    }
    if let Some(key_name) = submit_key {
        press_key_name(exec, key_name).await?;
    }
    Ok(())
}

/// 单字符三事件序列（§4.2：keyDown → char → keyUp，key 传实际字符；
/// 布局无关注入——不叠加 Shift 位，text 由 char 事件唯一承载——
/// keyDown 不带 text，防 Chrome 双写（F1 实测））。
async fn dispatch_char(exec: &ActionExecutor, c: char) -> Result<(), ActionError> {
    let (name, code, vk, _shift) = ascii_key_info(c).ok_or_else(|| {
        ActionError::new(
            ActionErrorKind::Unsupported,
            format!("字符 {c:?} 不在可注入面（应走 insertText 路径）"),
        )
    })?;
    exec.ops.key_event(key_down(&name, &code, 0, vk)).await?;
    exec.ops.key_event(char_event(&name)).await?;
    exec.ops.key_event(key_up(&name, &code, 0, vk)).await?;
    Ok(())
}

/// 回读校验（§4.4）：读 activeElement value/innerText，与已输入前缀比对。
/// - password：只比对长度（不比对明文，审计脱敏口径）；
/// - 尾部缺失（页面吞字符）：insertText 补差；
/// - 不可恢复分歧：返回 false（连续 2 块失败 → 中断）。
async fn verify_progress(
    exec: &ActionExecutor,
    expected: &str,
    is_password: bool,
) -> Result<bool, ActionError> {
    let value = exec.ops.evaluate(ACTIVE_VALUE_TEMPLATE).await?;
    let actual = value.as_str().unwrap_or_default().to_string();
    if is_password {
        return Ok(actual.chars().count() == expected.chars().count());
    }
    if actual.ends_with(expected) {
        return Ok(true);
    }
    // 补差：实际值是 expected 的前缀 → 缺失片段 insertText 补入（§4.4）
    if actual.len() < expected.len() && expected.starts_with(&actual) {
        let missing = &expected[actual.len()..];
        exec.ops.insert_text(missing).await?;
        return Ok(true);
    }
    Ok(false)
}

/// 回读固定模板（只读 activeElement；无模型输入，R-5 纪律）。
pub(crate) const ACTIVE_VALUE_TEMPLATE: &str = r#"(() => { const el = document.activeElement; if (!el) return ""; if ("value" in el) return String(el.value); return el.innerText || ""; })()"#;

/// focus 派发（DOM.focus，无坐标路径）。
pub async fn dispatch_focus(exec: &ActionExecutor, node_id: i64) -> Result<(), ActionError> {
    exec.ops.focus_node(node_id).await?;
    Ok(())
}

/// select_option 派发（§2.3：resolveNode → callFunctionOn 设值 + change/input + 回读校验）。
pub async fn dispatch_select_option(
    exec: &ActionExecutor,
    node_id: i64,
    value: &str,
) -> Result<Option<serde_json::Value>, ActionError> {
    let object_id = exec.ops.resolve_node(node_id).await?;
    // 参数为原始值（call_function_on 内部统一包装 CallArgument.value，勿二次包装）
    let args = vec![serde_json::json!(value)];
    let result = exec
        .ops
        .call_function_on(&object_id, SELECT_TEMPLATE, &args)
        .await?;
    let applied = result.as_str().unwrap_or_default();
    if applied != value {
        return Err(ActionError::new(
            ActionErrorKind::Timeout,
            format!("select_option 回读校验不符：期望 {value}，实际 {applied}"),
        ));
    }
    Ok(Some(serde_json::json!({ "selected": value })))
}

/// select 固定模板（设 value + 触发 input/change，返回回读值；参数 v 经序列化注入）。
const SELECT_TEMPLATE: &str = r#"function(v) { if (!this.options) return ""; this.value = v; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.value; }"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;
    use crate::action::{
        ActionErrorKind, ActionExecutor, ElementMeta, ElementRef, TYPE_CHUNK_DELAY_MS,
    };
    use crate::cdp::sender::CancellationToken;
    use std::sync::Arc;
    use std::time::Duration;

    fn executor(
        ops: MockOps,
        snapshot: MockSnapshotStore,
    ) -> (ActionExecutor, MockOps, Arc<RecordingDelay>) {
        let token = CancellationToken::new();
        let delay = Arc::new(RecordingDelay::new());
        let exec = ActionExecutor::new(Arc::new(ops.clone()), Arc::new(snapshot), token)
            .with_gate(Arc::new(AllowGate))
            .with_delay(delay.clone());
        (exec, ops, delay)
    }

    /// 键映射表全覆盖（§4.3 表逐项）。
    #[test]
    fn key_map_full_coverage() {
        let names = [
            "Enter",
            "Tab",
            "Escape",
            "Space",
            "Backspace",
            "Delete",
            "Insert",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "ArrowLeft",
            "ArrowUp",
            "ArrowRight",
            "ArrowDown",
            "Shift",
            "Control",
            "Alt",
            "Meta",
            "F1",
            "F2",
            "F3",
            "F4",
            "F5",
            "F6",
            "F7",
            "F8",
            "F9",
            "F10",
            "F11",
            "F12",
            "Numpad0",
            "Numpad1",
            "Numpad2",
            "Numpad3",
            "Numpad4",
            "Numpad5",
            "Numpad6",
            "Numpad7",
            "Numpad8",
            "Numpad9",
            "NumpadAdd",
            "NumpadSubtract",
            "NumpadMultiply",
            "NumpadDivide",
            "NumpadDecimal",
            ";",
        ];
        assert_eq!(KEY_MAP.len(), names.len(), "映射表条目与键名表一致");
        for name in names {
            assert!(lookup_key(name).is_some(), "缺键：{name}");
        }
        // 掩码抽查
        assert_eq!(lookup_key("control").unwrap().modifier_mask, MOD_CTRL);
        assert_eq!(lookup_key("Shift").unwrap().modifier_mask, MOD_SHIFT);
        assert_eq!(lookup_key("Enter").unwrap().vk, 13);
        assert_eq!(lookup_key("F12").unwrap().vk, 123);
        assert_eq!(lookup_key("NumpadDecimal").unwrap().vk, 110);
    }

    /// 组合键解析（§4.3）：修饰键 + 主键；"Control++" 尾随加号字面键。
    #[test]
    fn parse_key_sequences() {
        let seq = parse_key_sequence("Control+A").expect("合法组合键");
        assert_eq!(seq.modifiers.len(), 1);
        assert_eq!(seq.modifiers[0].modifier_mask, MOD_CTRL);
        assert_eq!(seq.main.name, "A");
        assert!(seq.main.shift, "大写 A 需 Shift");

        let seq = parse_key_sequence("Control+Shift+ArrowUp").expect("多修饰键");
        assert_eq!(seq.modifiers.len(), 2);
        assert_eq!(seq.main.code, "ArrowUp");

        let seq = parse_key_sequence("Control++").expect("尾随 + 为字面键");
        assert_eq!(seq.main.name, "+");

        let seq = parse_key_sequence("Enter").expect("单键");
        assert!(seq.modifiers.is_empty());
        assert_eq!(seq.main.vk, 13);

        let seq = parse_key_sequence("control+a").expect("大小写不敏感");
        assert_eq!(seq.modifiers[0].modifier_mask, MOD_CTRL);

        // 非法键名
        assert!(parse_key_sequence("").is_err());
        assert!(parse_key_sequence("BogusKey").is_err());
        assert!(parse_key_sequence("Control+A+B").is_err(), "多个主键非法");
        assert!(
            parse_key_sequence("Control+").is_ok(),
            "Control+ 尾随 + 为字面加号"
        );
    }

    /// 组合键掩码序列（§4.3）：Control+A → down(2) → down(2)/char/up(2) → up(0)。
    #[tokio::test]
    async fn key_modifier_mask_sequence() {
        let (exec, ops, _delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        exec.key(&"t1".to_string(), 1, "Control+A")
            .await
            .expect("组合键应成功");
        let events = ops.calls_of(MockOp::KeyEvent);
        let summary: Vec<String> = events.iter().map(|c| c.detail.clone()).collect();
        assert_eq!(events.len(), 5, "down(Ctrl) down(A) char(A) up(A) up(Ctrl)");
        assert!(
            summary[0].contains("keyDown key=\"Control\"") && summary[0].contains("mods=2"),
            "{}",
            summary[0]
        );
        assert!(
            summary[1].contains("keyDown key=\"A\"") && summary[1].contains("mods=2"),
            "{}",
            summary[1]
        );
        assert!(
            summary[2].contains("char") && summary[2].contains("text=\"A\""),
            "{}",
            summary[2]
        );
        assert!(
            summary[3].contains("keyUp key=\"A\"") && summary[3].contains("mods=2"),
            "{}",
            summary[3]
        );
        assert!(
            summary[4].contains("keyUp key=\"Control\"") && summary[4].contains("mods=0"),
            "{}",
            summary[4]
        );
    }

    /// 多修饰键掩码序列：Control+Shift+A → 2/10/10/10/8/0（逆序释放）。
    #[tokio::test]
    async fn key_multi_modifier_release_order() {
        let (exec, ops, _delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        exec.key(&"t1".to_string(), 1, "Control+Shift+A")
            .await
            .expect("组合键应成功");
        let summary: Vec<String> = ops
            .calls_of(MockOp::KeyEvent)
            .iter()
            .map(|c| c.detail.clone())
            .collect();
        assert_eq!(summary.len(), 7);
        assert!(summary[0].contains("keyDown key=\"Control\"") && summary[0].contains("mods=2"));
        assert!(
            summary[1].contains("keyDown key=\"Shift\"") && summary[1].contains("mods=10"),
            "{}",
            summary[1]
        );
        assert!(summary[2].contains("keyDown key=\"A\"") && summary[2].contains("mods=10"));
        assert!(summary[3].contains("char") && summary[3].contains("text=\"A\""));
        assert!(summary[4].contains("keyUp key=\"A\"") && summary[4].contains("mods=10"));
        assert!(
            summary[5].contains("keyUp key=\"Shift\"") && summary[5].contains("mods=2"),
            "逆序释放 Shift（Control 仍按下）"
        );
        assert!(summary[6].contains("keyUp key=\"Control\"") && summary[6].contains("mods=0"));
    }

    /// try/finally 卡键恢复（§4.3）：主键 keyDown 抛错 → 修饰键仍逆序释放。
    /// 错误持久注入：3 次尝试均失败 → 最终 Fatal（每次尝试的释放事件都必须存在）。
    #[tokio::test]
    async fn key_finally_releases_modifiers_on_error() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().persist_errors.insert(
            MockOp::KeyEvent,
            ActionError::new(ActionErrorKind::ContextGone, "执行上下文销毁"),
        );
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            )),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let err = exec
            .key(&"t1".to_string(), 1, "Control+Shift+A")
            .await
            .expect_err("应失败");
        assert_eq!(err.kind, ActionErrorKind::ContextGone);
        let summary: Vec<String> = ops
            .calls_of(MockOp::KeyEvent)
            .iter()
            .map(|c| c.detail.clone())
            .collect();
        // 每次尝试 = down(失败) + 释放×2 = 3 条；3 次尝试共 9 条
        assert_eq!(summary.len(), 9, "3 次尝试 × 3 条（每次含释放）");
        // 每次尝试的末尾两条必须是修饰键释放（try/finally 兜底，防逻辑卡键）
        for base in [0usize, 3, 6] {
            assert!(
                summary[base + 1].contains("keyUp key=\"Shift\"")
                    && summary[base + 1].contains("mods=2"),
                "{}",
                summary[base + 1]
            );
            assert!(
                summary[base + 2].contains("keyUp key=\"Control\"")
                    && summary[base + 2].contains("mods=0"),
                "{}",
                summary[base + 2]
            );
        }
    }

    /// 单键（Enter/Tab）：无修饰键序列。
    #[tokio::test]
    async fn key_single_enter() {
        let (exec, ops, _delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        exec.key(&"t1".to_string(), 1, "Enter")
            .await
            .expect("单键应成功");
        let summary: Vec<String> = ops
            .calls_of(MockOp::KeyEvent)
            .iter()
            .map(|c| c.detail.clone())
            .collect();
        assert_eq!(summary.len(), 2, "down + up");
        assert!(
            summary[0].contains("keyDown key=\"Enter\"")
                && summary[0].contains("mods=0")
                && summary[0].contains("vk=13")
        );
        assert!(
            summary[1].contains("keyUp key=\"Enter\"")
                && summary[1].contains("mods=0")
                && summary[1].contains("vk=13")
        );
    }

    /// type 分块边界（§4.1）：49/50 单块零延迟；51 两块一次 12ms 节流。
    #[tokio::test]
    async fn type_chunk_boundaries() {
        let (exec, ops, delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        let el = ElementRef {
            index: 0,
            backend_node_id: 11,
        };
        let tab = "t1".to_string();
        // 49 字符：1 块，无节流
        exec.type_text(&tab, 1, el, &"a".repeat(49), None)
            .await
            .expect("49 应成功");
        assert_eq!(ops.count(MockOp::KeyEvent), 49 * 3, "49 字符三事件");
        assert!(delay.durations().is_empty(), "49 字符不应有块间延迟");
        assert_eq!(ops.count(MockOp::FocusNode), 1, "type 先 focus");
        assert_eq!(ops.count(MockOp::Evaluate), 0, "单块无回读");

        // 50 字符：1 块，无节流
        exec.type_text(&tab, 1, el, &"a".repeat(50), None)
            .await
            .expect("50 应成功");
        assert_eq!(ops.count(MockOp::KeyEvent), (49 + 50) * 3);
        assert!(delay.durations().is_empty());

        // 51 字符：2 块，恰 1 次 12ms 节流 + 回读
        exec.type_text(&tab, 1, el, &"a".repeat(51), None)
            .await
            .expect("51 应成功");
        assert_eq!(ops.count(MockOp::KeyEvent), (49 + 50 + 51) * 3);
        assert_eq!(delay.durations().len(), 1, "恰 1 次块间节流");
        assert_eq!(
            delay.durations()[0],
            Duration::from_millis(TYPE_CHUNK_DELAY_MS)
        );
    }

    /// F1 回归：ASCII 输入插入载体唯一——keyDown 不得携带 text（text 只能由
    /// char 事件承载，且同一字符恰一个载体）。Chrome 实测（K6）：keyDown(text)
    /// 又发独立 char → 双写（"d"→"dd"；组合键 Control+A → "AA"）；mock 层
    /// 参数面锁住该不变量：所有 text 非空的 KeyEvent 必须是 char 事件。
    #[tokio::test]
    async fn type_ascii_insert_carrier_unique() {
        let (exec, ops, _delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        exec.type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            "demo",
            None,
        )
        .await
        .expect("ASCII 输入应成功");
        let events = ops.calls_of(MockOp::KeyEvent);
        assert_eq!(events.len(), 12, "4 字符 × 三事件");
        let mut carriers: Vec<String> = Vec::new();
        for call in &events {
            let text_field = call
                .detail
                .split("text=")
                .nth(1)
                .unwrap_or_default()
                .to_string();
            if !text_field.starts_with("\"\"") {
                assert!(
                    call.detail.starts_with("char"),
                    "text 只能由 char 事件携带（keyDown 携 text 即双写面）：{}",
                    call.detail
                );
                carriers.push(text_field);
            }
        }
        assert_eq!(carriers.len(), 4, "每个字符恰一个插入载体：{carriers:?}");
        for c in ['d', 'e', 'm', 'o'] {
            assert!(
                carriers.iter().any(|t| t == &format!("\"{c}\"")),
                "缺字符 {c} 的插入载体：{carriers:?}"
            );
        }

        // 组合键路径同规则（§4.3）：keyDown A 不携 text，char 唯一承载
        let base = ops.calls_of(MockOp::KeyEvent).len();
        exec.key(&"t1".to_string(), 1, "Control+A")
            .await
            .expect("组合键应成功");
        let combo_events = &ops.calls_of(MockOp::KeyEvent)[base..];
        let keydown_a = combo_events
            .iter()
            .find(|c| c.detail.contains("keyDown key=\"A\""))
            .expect("组合键应含 keyDown A");
        assert!(
            !keydown_a.detail.contains("text=\"A\""),
            "组合键 keyDown A 不得携带 text：{}",
            keydown_a.detail
        );
        let char_carriers: Vec<&MockCall> = combo_events
            .iter()
            .filter(|c| c.detail.starts_with("char") && !c.detail.contains("text=\"\""))
            .collect();
        assert_eq!(char_carriers.len(), 1, "组合键 char 恰一个插入载体");
        assert!(char_carriers[0].detail.contains("text=\"A\""));
    }

    /// type 节流时长（注入时钟断言 12ms 定值）。
    #[tokio::test]
    async fn type_chunk_delay_value() {
        let (exec, _ops, delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        // 120 字符 → 3 块 → 2 次节流
        exec.type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            &"x".repeat(120),
            None,
        )
        .await
        .expect("120 应成功");
        assert_eq!(delay.durations().len(), 2);
        for d in delay.durations() {
            assert_eq!(
                d,
                Duration::from_millis(TYPE_CHUNK_DELAY_MS),
                "块间节流定值 12ms"
            );
        }
    }

    /// 分块间 abort（E2E-17）：第 1 块派发完成后接管 → 已输入部分保留，返回 Aborted。
    #[tokio::test]
    async fn type_abort_between_chunks() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        // 第 50 个字符事件后触发接管（恰在第 1 块末尾）
        ops.state.lock().unwrap().cancel_after_char = Some((50, token.clone()));
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            )),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let err = exec
            .type_text(
                &"t1".to_string(),
                1,
                ElementRef {
                    index: 0,
                    backend_node_id: 11,
                },
                &"a".repeat(60),
                None,
            )
            .await
            .expect_err("分块间应中断");
        assert_eq!(err.kind, ActionErrorKind::Aborted);
        assert_eq!(
            ops.count(MockOp::KeyEvent),
            50 * 3,
            "第 1 块完整保留（已输入部分）"
        );
        // 块间回读校验可能已做补差（第 1 块收尾），但第 2 块零注入（E2E-17）
        assert!(
            ops.count(MockOp::InsertText) <= 1,
            "第 2 块不得注入（补差最多 1 次）"
        );
    }

    /// 回读校验补差（§4.4）：页面吞字符 → insertText 补缺失片段。
    #[tokio::test]
    async fn type_verify_replenishes_missing() {
        let ops = MockOps::new();
        // activeElement 值保持空（页面吞掉第 1 块）
        ops.state.lock().unwrap().active_value = String::new();
        let (exec, ops, _delay) = executor(
            ops,
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        exec.type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            &"a".repeat(51),
            None,
        )
        .await
        .expect("补差后应成功");
        let inserts: Vec<String> = ops
            .calls_of(MockOp::InsertText)
            .iter()
            .map(|c| c.detail.clone())
            .collect();
        assert!(
            inserts
                .iter()
                .any(|d| d.contains(&format!("\"{}\"", "a".repeat(50)))),
            "应补差插入缺失片段：{inserts:?}"
        );
    }

    /// 回读校验连续 2 块失败 → 可重试错误（页面吞字符且不可恢复）。
    #[tokio::test]
    async fn type_verify_two_failures_stops() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().active_value = "junk-diverged".to_string();
        let (exec, ops, _delay) = executor(
            ops,
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        let err = exec
            .type_text(
                &"t1".to_string(),
                1,
                ElementRef {
                    index: 0,
                    backend_node_id: 11,
                },
                &"a".repeat(120),
                None,
            )
            .await
            .expect_err("连续 2 块失败应中断");
        assert_eq!(err.kind, ActionErrorKind::NotInteractive);
        assert_eq!(ops.count(MockOp::InsertText), 0, "分歧不可恢复时不做补差");
    }

    /// password 回读只比对长度（§4.4）：长度一致 → 成功。
    #[tokio::test]
    async fn type_password_readback_length_only() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().active_value = "x".repeat(100);
        let snapshot = MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: true,
            }],
        );
        let (exec, ops, _delay) = executor(ops, snapshot);
        exec.type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            &"a".repeat(120),
            None,
        )
        .await
        .expect("长度一致应通过");
        // 120 字符 → 3 块 → 2 次回读；密码回读无明文补差
        assert_eq!(ops.count(MockOp::InsertText), 0, "密码路径不补明文");
    }

    /// M2：password 输入目标 + CJK 文本走整块 insertText（IME 路径），回读仅
    /// 长度比对（页面掩码态不回读明文比对）——密码框输入在工具面可用。
    #[tokio::test]
    async fn type_password_cjk_insert_text_length_only() {
        let ops = MockOps::new();
        // 页面掩码态：回读值恒为掩码字符（"x"×100）——若走明文前缀比对，
        // 两次回读必失配 → NotInteractive 中断；成功即证明仅长度比对（M2）
        ops.state.lock().unwrap().active_value = "x".repeat(100);
        let snapshot = MockSnapshotStore::with_elements(
            1,
            &[ElementMeta {
                backend_node_id: 11,
                is_password: true,
            }],
        );
        let (exec, ops, _delay) = executor(ops, snapshot);
        let text = "密码输入测试".repeat(10); // 100 个中文字符 → 2 整块
        exec.type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            &text,
            None,
        )
        .await
        .expect("密码框中文输入应成功（insertText + 长度比对）");
        assert_eq!(ops.count(MockOp::KeyEvent), 0, "CJK 不走逐字符三事件");
        assert_eq!(
            ops.count(MockOp::InsertText),
            2,
            "两整块 insertText（IME 路径）"
        );
    }

    /// CJK 整块 insertText（IME 路径，§4.4）：中文 60 字符 → 2 块 insertText + 1 次补差。
    #[tokio::test]
    async fn type_cjk_uses_insert_text() {
        let (exec, ops, _delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        let text = "中文输入测试".repeat(10); // 60 个中文字符
        exec.type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            &text,
            None,
        )
        .await
        .expect("中文输入应成功");
        assert_eq!(ops.count(MockOp::KeyEvent), 0, "CJK 不走逐字符三事件");
        // 块 1(50) + 块间补差(50) + 块 2(10) = 3 次 insertText
        assert_eq!(
            ops.count(MockOp::InsertText),
            3,
            "整块 insertText（2 块 + 1 补差）"
        );
    }

    /// submit_key：末尾按键。
    #[tokio::test]
    async fn type_submit_key_pressed() {
        let (exec, ops, _delay) = executor(
            MockOps::new(),
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        exec.type_text(
            &"t1".to_string(),
            1,
            ElementRef {
                index: 0,
                backend_node_id: 11,
            },
            "hello",
            Some("Enter"),
        )
        .await
        .expect("提交键应成功");
        let summary: Vec<String> = ops
            .calls_of(MockOp::KeyEvent)
            .iter()
            .map(|c| c.detail.clone())
            .collect();
        assert!(summary.last().unwrap().contains("keyUp key=\"Enter\""));
    }

    /// select_option：设值 + change/input + 回读一致。
    #[tokio::test]
    async fn select_option_success() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().select_return = "value2".to_string();
        let (exec, ops, _delay) = executor(
            ops,
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        let success = exec
            .select_option(
                &"t1".to_string(),
                1,
                ElementRef {
                    index: 0,
                    backend_node_id: 11,
                },
                "value2",
            )
            .await
            .expect("选中应成功");
        assert_eq!(success.payload.as_ref().unwrap()["selected"], "value2");
        let calls = ops.calls_of(MockOp::CallFunctionOn);
        assert!(
            calls[0].detail.contains("this.options"),
            "固定模板设值：{}",
            calls[0].detail
        );
        assert!(
            calls[0].detail.contains("args=[String(\"value2\")]"),
            "参数应为原始值（call_function_on 统一包装，禁二次包装，联调 E3 根因）：{}",
            calls[0].detail
        );
    }

    /// select_option 回读不符 → Timeout 可重试（重试 1 次仍不符 → Fatal）。
    #[tokio::test]
    async fn select_option_readback_mismatch_fatal() {
        let ops = MockOps::new(); // select_return 默认空串 ≠ value2
        let (exec, _ops, _delay) = executor(
            ops,
            MockSnapshotStore::with_elements(
                1,
                &[ElementMeta {
                    backend_node_id: 11,
                    is_password: false,
                }],
            ),
        );
        let err = exec
            .select_option(
                &"t1".to_string(),
                1,
                ElementRef {
                    index: 0,
                    backend_node_id: 11,
                },
                "value2",
            )
            .await
            .expect_err("回读不符应失败");
        assert_eq!(err.kind, ActionErrorKind::Timeout);
        assert!(err.message.contains("回读校验不符"));
    }
}
