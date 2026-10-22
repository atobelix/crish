//! 键盘动作派发：key 组合键、type 分块 + 回读校验、focus、select_option（自 keyboard.rs 平移）。

use super::chars::{ascii_key_info, char_event, is_ascii_typeable, key_down, key_up};
use super::parse_key_sequence;
use crate::action::{ActionError, ActionErrorKind, ActionExecutor};

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
        // 释放失败 = 修饰键可能卡在按下态（后续输入会被污染），必须告警；
        // 但主键结果已定，不能因释放失败改写返回值（finally 语义）。
        if let Err(e) = exec
            .ops
            .key_event(key_up(&modifier.name, &modifier.code, mask, modifier.vk))
            .await
        {
            tracing::warn!("修饰键释放失败（{} 可能保持按下态）：{e}", modifier.name);
        }
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
