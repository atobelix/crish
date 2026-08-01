//! 工具输出结构化（任务书 B5.3：序列化 / 预算截断 / 大小统计）
//!
//! 语义来源：
//! - 序列化优先级 text→json→artifacts（02 §二.6 末尾 / 05 §2.5，
//!   对齐 openai-request-build.test.ts:34 的 stringifyToolOutput 行为）
//! - 预算截断 head+marker+tail（对齐 TS tool-output-budget.ts 的 budgetTextForContext：
//!   头部按比例保留、省略统计进标记、标记叠加在正文预算之上）
//!
//! 与 TS agent-tools/tool-output-budget.ts 的差异说明：
//! TS 该文件 artifacts 分支取“text ?? uri ?? title 逐条 join”，
//! 而 05 §2.5 锚点（openai-request-build.test.ts:38）断言 artifacts 整体
//! 序列化包含字段值——本实现以 05 §2.5 测试语义为准（artifacts 数组整体 JSON 序列化）。

use serde_json::Value;

/// 正文预算默认值（字节，对齐 TS DEFAULT_INLINE_CHARS=24000 的量级）
pub const DEFAULT_INLINE_BYTES: usize = 24_000;
/// 头部占比默认值（对齐 TS DEFAULT_HEAD_RATIO=0.4）
pub const DEFAULT_HEAD_RATIO: f64 = 0.4;
/// 头部占比允许区间（对齐 TS clampRatio：0.2..=0.8）
pub const HEAD_RATIO_MIN: f64 = 0.2;
pub const HEAD_RATIO_MAX: f64 = 0.8;

/// 工具输出序列化（优先级 text→json→artifacts，对齐 05 §2.5）
///
/// 规则（对齐 openai-request-build.test.ts:34-40）：
/// - text 为**非空字符串**时直接返回（空字符串视为无文本，回退下一级）
/// - 否则 json 字段存在时返回紧凑 JSON 序列化
/// - 否则 artifacts 为非空数组时返回数组整体 JSON 序列化
/// - 其余情况返回空字符串
pub fn stringify_tool_output(value: &Value) -> String {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            return text.to_string();
        }
    }
    if let Some(json) = value.get("json") {
        if let Ok(compact) = serde_json::to_string(json) {
            return compact;
        }
    }
    if let Some(artifacts) = value.get("artifacts").and_then(Value::as_array) {
        if !artifacts.is_empty() {
            if let Ok(compact) = serde_json::to_string(artifacts) {
                return compact;
            }
        }
    }
    String::new()
}

/// 输出大小统计（字符数 / 字节数）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputSize {
    /// 字符数（UTF-8 字符，对齐 TS text.length 语义）
    pub chars: usize,
    /// 字节数（UTF-8 编码长度）
    pub bytes: usize,
}

impl OutputSize {
    /// 文本的大小统计
    pub fn of_text(text: &str) -> Self {
        Self {
            chars: text.chars().count(),
            bytes: text.len(),
        }
    }

    /// 工具输出的大小统计（按 stringify 后的文本计算）
    pub fn of_value(value: &Value) -> Self {
        Self::of_text(&stringify_tool_output(value))
    }
}

/// 文本的大小统计（等价 `OutputSize::of_text`，方便直接调用）
pub fn output_size(value: &Value) -> OutputSize {
    OutputSize::of_value(value)
}

/// 预算截断选项（对齐 TS ToolOutputBudgetOptions）
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ToolOutputBudgetOptions {
    /// 正文预算（字节）；缺省为 DEFAULT_INLINE_BYTES
    pub inline_bytes: Option<usize>,
    /// 头部占比（0.2..=0.8）；缺省为 DEFAULT_HEAD_RATIO
    pub head_ratio: Option<f64>,
}

/// 文本截断结果（对齐 TS BudgetedText，附加字节统计）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BudgetedText {
    /// 截断后的文本（含省略标记；未截断时与原文一致）
    pub text: String,
    /// 是否发生截断
    pub truncated: bool,
    /// 原文总字符数
    pub original_chars: usize,
    /// 被省略的字符数（head+tail 之外的部分）
    pub omitted_chars: usize,
    /// 原文总字节数
    pub original_bytes: usize,
    /// 截断后文本字节数（含标记；标记叠加在正文预算之上，对齐 TS 行为）
    pub bytes: usize,
}

/// 文本预算截断：超出预算时保留头部（按 head_ratio 占比），
/// 中部以省略标记代替，尾部保留剩余预算的余量（对齐 TS budgetTextForContext）。
///
/// 截断按字节预算、字符边界切片，保证不切破 UTF-8 多字节字符；
/// 头部至少保留 1 个字符（对齐 TS headChars = max(1, ...)）。
pub fn budget_text_for_context(text: &str, options: &ToolOutputBudgetOptions) -> BudgetedText {
    let inline_bytes = options.inline_bytes.unwrap_or(DEFAULT_INLINE_BYTES).max(1);
    let original_chars = text.chars().count();
    let original_bytes = text.len();
    if original_bytes <= inline_bytes {
        return BudgetedText {
            text: text.to_string(),
            truncated: false,
            original_chars,
            omitted_chars: 0,
            original_bytes,
            bytes: original_bytes,
        };
    }

    let head_budget = ((inline_bytes as f64) * clamp_ratio(options.head_ratio))
        .floor()
        .max(1.0) as usize;
    let mut head = head_prefix_by_bytes(text, head_budget);
    if head.is_empty() {
        // 头部至少 1 个字符（预算过小不足以容纳首个多字节字符时，超出预算也要保留）
        if let Some(first) = text.chars().next() {
            head = &text[..first.len_utf8()];
        }
    }
    let head_chars = head.chars().count();

    // 尾部预算 = 正文预算扣除头部实际字节后的余量
    let tail_budget = inline_bytes.saturating_sub(head.len());
    let tail = if tail_budget > 0 {
        tail_suffix_by_bytes(text, head.len(), tail_budget)
    } else {
        ""
    };
    let tail_chars = tail.chars().count();
    let omitted_chars = original_chars.saturating_sub(head_chars + tail_chars);

    let marker = format!(
        "\n\n[... {omitted_chars} characters omitted from {original_chars} total ...]\n\n"
    );
    let budgeted = format!("{head}{marker}{tail}");
    let budgeted_bytes = budgeted.len();
    BudgetedText {
        text: budgeted,
        truncated: true,
        original_chars,
        omitted_chars,
        original_bytes,
        bytes: budgeted_bytes,
    }
}

/// 工具输出预算汇总（对齐 TS budgetToolOutputForContext）
///
/// 超出预算时把输出改写为 ToolOutput 形状：text 为截断文本、
/// json.contextBudget 为标记字段（truncated / originalChars / omittedChars / originalBytes）、
/// artifacts 原样保留；未超预算时原值返回。
#[derive(Debug, Clone, PartialEq)]
pub struct SummarizedOutput {
    /// 预算处理后的工具输出值
    pub value: Value,
    /// 是否发生截断
    pub truncated: bool,
    /// 原文总字符数
    pub original_chars: usize,
    /// 被省略的字符数
    pub omitted_chars: usize,
    /// 原文总字节数
    pub original_bytes: usize,
    /// 处理后文本字节数（含标记）
    pub bytes: usize,
}

/// 对工具输出施加字节预算：先 stringify，再截断，最后重组输出值
pub fn summarize(value: &Value, budget_bytes: usize) -> SummarizedOutput {
    let raw = stringify_tool_output(value);
    let budgeted = budget_text_for_context(
        &raw,
        &ToolOutputBudgetOptions {
            inline_bytes: Some(budget_bytes.max(1)),
            head_ratio: None,
        },
    );
    if !budgeted.truncated {
        return SummarizedOutput {
            value: value.clone(),
            truncated: false,
            original_chars: budgeted.original_chars,
            omitted_chars: 0,
            original_bytes: budgeted.original_bytes,
            bytes: budgeted.bytes,
        };
    }

    let mut out = serde_json::Map::new();
    out.insert("text".to_string(), Value::String(budgeted.text.clone()));
    if let Some(artifacts) = value.get("artifacts") {
        out.insert("artifacts".to_string(), artifacts.clone());
    }
    // 标记字段：对齐 TS contextBudget 形状
    out.insert(
        "json".to_string(),
        serde_json::json!({
            "contextBudget": {
                "truncated": true,
                "originalChars": budgeted.original_chars,
                "omittedChars": budgeted.omitted_chars,
                "originalBytes": budgeted.original_bytes,
            }
        }),
    );
    SummarizedOutput {
        value: Value::Object(out),
        truncated: true,
        original_chars: budgeted.original_chars,
        omitted_chars: budgeted.omitted_chars,
        original_bytes: budgeted.original_bytes,
        bytes: budgeted.bytes,
    }
}

/// 头部占比夹取（非有限值回退默认；区间 0.2..=0.8，对齐 TS clampRatio）
fn clamp_ratio(ratio: Option<f64>) -> f64 {
    match ratio {
        Some(r) if r.is_finite() => r.clamp(HEAD_RATIO_MIN, HEAD_RATIO_MAX),
        _ => DEFAULT_HEAD_RATIO,
    }
}

/// 取文本前缀：字节数不超过预算且不切破字符边界
fn head_prefix_by_bytes(text: &str, budget: usize) -> &str {
    let mut end = budget.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// 取文本尾部：从末尾向前取不超过预算的字节数，
/// 起点不低于 head_end（避免与头部重叠），且落在字符边界上
fn tail_suffix_by_bytes(text: &str, head_end: usize, budget: usize) -> &str {
    let mut start = text.len().saturating_sub(budget);
    if start < head_end {
        start = head_end;
    }
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── stringify_tool_output 优先级（对齐 05 §2.5） ──

    #[test]
    fn stringify_prefers_text_over_json_and_artifacts() {
        let v = json!({
            "text": "ok",
            "json": { "a": 1 },
            "artifacts": [{ "kind": "file", "title": "t" }]
        });
        assert_eq!(stringify_tool_output(&v), "ok");
    }

    #[test]
    fn stringify_uses_json_when_no_text() {
        let v = json!({ "json": { "a": 1 } });
        let s = stringify_tool_output(&v);
        assert!(s.contains('1'));
        assert_eq!(s, r#"{"a":1}"#);
    }

    #[test]
    fn stringify_empty_text_falls_through_to_json() {
        // text 为空字符串视为无文本，回退 json（对齐 TS if (output.text) truthy 判断）
        let v = json!({ "text": "", "json": { "a": 1 } });
        assert_eq!(stringify_tool_output(&v), r#"{"a":1}"#);
    }

    #[test]
    fn stringify_serializes_artifacts_array() {
        let v = json!({ "artifacts": [{ "kind": "file", "path": "a" }] });
        let s = stringify_tool_output(&v);
        assert!(s.contains("a"));
        assert_eq!(s, r#"[{"kind":"file","path":"a"}]"#);
    }

    #[test]
    fn stringify_empty_artifacts_returns_empty() {
        assert_eq!(stringify_tool_output(&json!({ "artifacts": [] })), "");
    }

    #[test]
    fn stringify_empty_object_and_null_json() {
        assert_eq!(stringify_tool_output(&json!({})), "");
        assert_eq!(stringify_tool_output(&json!({ "json": null })), "null");
    }

    // ── 输出大小统计 ──

    #[test]
    fn output_size_counts_chars_and_bytes() {
        let v = json!({ "text": "你好 rust" });
        let size = output_size(&v);
        assert_eq!(size.chars, 7);
        assert_eq!(size.bytes, 11);
        assert_eq!(OutputSize::of_text("abc"), OutputSize {
            chars: 3,
            bytes: 3
        });
    }

    // ── 预算截断 ──

    #[test]
    fn budget_under_limit_not_truncated() {
        let text = "a".repeat(100);
        let out = budget_text_for_context(&text, &ToolOutputBudgetOptions::default());
        assert!(!out.truncated);
        assert_eq!(out.text, text);
        assert_eq!(out.omitted_chars, 0);
        assert_eq!(out.original_chars, 100);
    }

    #[test]
    fn budget_over_limit_truncates_with_marker_keeping_head_and_tail() {
        let text = "a".repeat(200);
        let out = budget_text_for_context(
            &text,
            &ToolOutputBudgetOptions {
                inline_bytes: Some(50),
                head_ratio: None,
            },
        );
        assert!(out.truncated);
        assert_eq!(out.original_chars, 200);
        assert_eq!(out.omitted_chars, 150);
        // 头部按 0.4 占比保留 20 字符，尾部保留剩余 30 字符
        assert!(out.text.starts_with(&"a".repeat(20)));
        assert!(out.text.ends_with(&"a".repeat(30)));
        assert!(out.text.contains("[... 150 characters omitted from 200 total ...]"));
        assert_eq!(out.bytes, out.text.len());
    }

    #[test]
    fn budget_utf8_safe_truncation() {
        let text = "你好世界你好";
        let out = budget_text_for_context(
            text,
            &ToolOutputBudgetOptions {
                inline_bytes: Some(9),
                head_ratio: None,
            },
        );
        assert!(out.truncated);
        // 头部至少 1 字符：预算 9 字节 → 头部 "你"(3 字节)，尾部余量 6 字节 → "你好"
        assert!(out.text.starts_with("你"));
        assert!(out.text.ends_with("你好"));
        assert!(out.text.contains("characters omitted"));
        // 全字符均为合法 UTF-8（未被切破）
        assert!(std::str::from_utf8(out.text.as_bytes()).is_ok());
    }

    #[test]
    fn budget_head_ratio_is_clamped() {
        let text = "a".repeat(100);
        // 0.9 → 夹取到 0.8 → 头部 40 字节
        let out = budget_text_for_context(
            &text,
            &ToolOutputBudgetOptions {
                inline_bytes: Some(50),
                head_ratio: Some(0.9),
            },
        );
        assert!(out.text.starts_with(&"a".repeat(40)));
        // 0.1 → 夹取到 0.2 → 头部 10 字节
        let out = budget_text_for_context(
            &text,
            &ToolOutputBudgetOptions {
                inline_bytes: Some(50),
                head_ratio: Some(0.1),
            },
        );
        assert!(out.text.starts_with(&"a".repeat(10)));
    }

    #[test]
    fn budget_tiny_still_keeps_one_char_head() {
        let text = "你好世界";
        let out = budget_text_for_context(
            text,
            &ToolOutputBudgetOptions {
                inline_bytes: Some(2),
                head_ratio: None,
            },
        );
        assert!(out.truncated);
        assert!(out.text.starts_with("你"));
    }

    // ── summarize 工具输出级预算 ──

    #[test]
    fn summarize_under_budget_returns_original_value() {
        let v = json!({ "text": "short", "json": { "a": 1 } });
        let out = summarize(&v, 10_000);
        assert!(!out.truncated);
        assert_eq!(out.value, v);
        assert_eq!(out.omitted_chars, 0);
    }

    #[test]
    fn summarize_truncates_and_marks_with_artifacts_preserved() {
        let v = json!({
            "text": "a".repeat(200),
            "artifacts": [{ "kind": "file", "title": "big" }]
        });
        let out = summarize(&v, 50);
        assert!(out.truncated);
        assert_eq!(out.original_chars, 200);
        assert!(out.value["text"].as_str().unwrap().contains("characters omitted"));
        // artifacts 原样保留
        assert_eq!(out.value["artifacts"], v["artifacts"]);
        // 标记字段（对齐 TS contextBudget 形状）
        let budget_meta = &out.value["json"]["contextBudget"];
        assert_eq!(budget_meta["truncated"], true);
        assert_eq!(budget_meta["originalChars"], 200);
        assert_eq!(budget_meta["omittedChars"].as_u64().unwrap(), 150);
        assert!(budget_meta["originalBytes"].as_u64().unwrap() > 0);
    }

    #[test]
    fn summarize_tiny_budget_produces_valid_tool_output() {
        let v = json!({ "text": "你好世界你好世界" });
        let out = summarize(&v, 4);
        assert!(out.truncated);
        // 重组后的值仍为 ToolOutput 形状：text + json.contextBudget
        assert!(out.value["text"].is_string());
        assert!(out.value["json"]["contextBudget"].is_object());
    }
}
