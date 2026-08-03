//! 工具输出截断（G8 核销：opencode tool-output-store head+tail 语义）
//!
//! 目标：防「压缩未触发、工具输出已撑爆上下文」（ref-analysis 04 G8，
//! 02 M10 内容 8）。对齐 opencode `tool-output-store.ts:43-77`：
//!
//! - **双阈值**：`tool_output_max_lines` / `tool_output_max_bytes`
//!   （默认 2000 行 / 50KB，对齐 opencode MAX_LINES / MAX_BYTES，可配，
//!   session_meta 键见常量）；
//! - **head + 截断标记 + tail**：保留前半行数 + 计数标记（丢弃行/字节数）
//!   + 后半行数；标记计入行/字节预算；标记放不下时退化只保留标记；
//! - **留痕不静默丢弃**：[ToolOutputTruncationRecord] 随截断动作产出，
//!   调用方写入 events 表（截断范围与标记可查）；
//! - **与压缩预算水位联动**：截断节省 token 计入上下文估算
//!   （[estimate_after_truncation]），经 [classify_after_truncation]
//!   判定水位——截断后仍未收敛才进入常规线触发 AI 摘要（02 M10 内容 8：
//!   「截断事件计入上下文预算水位，截断后仍未收敛才进入 85% 常规线」）。
//!
//! 本模块为纯函数算法，无运行时依赖；截断动作的注入时机（工具结果
//! 记录路径）与事件落库由调用方（session-loop）接线。

use crate::compaction::{CompactionThresholds, ThresholdDecision};
use crate::count_tokens;

/// 默认最大行数（对齐 opencode MAX_LINES=2000）
pub const TOOL_OUTPUT_MAX_LINES_DEFAULT: usize = 2_000;
/// 默认最大字节数（对齐 opencode MAX_BYTES=50KB）
pub const TOOL_OUTPUT_MAX_BYTES_DEFAULT: usize = 50 * 1024;
/// 截断标记占用的预算预留（行 1 行 + 字节 96 + 分隔符 4；标记文案含计数）
const MARKER_LINE_RESERVE: usize = 1;
const MARKER_BYTES_RESERVE: usize = 96;
const SEPARATOR_BYTES: usize = 4;

/// session_meta 键：工具输出最大行数
pub const SESSION_META_KEY_TOOL_OUTPUT_MAX_LINES: &str = "tool_output_max_lines";
/// session_meta 键：工具输出最大字节数
pub const SESSION_META_KEY_TOOL_OUTPUT_MAX_BYTES: &str = "tool_output_max_bytes";

/// 工具输出截断双阈值（默认值对齐 opencode；可配）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolOutputTruncationLimits {
    /// 最大行数（超限走 head+标记+tail）
    pub max_lines: usize,
    /// 最大字节数（UTF-8 字节口径，超限走字节级 head/tail 收缩）
    pub max_bytes: usize,
}

impl Default for ToolOutputTruncationLimits {
    fn default() -> Self {
        Self {
            max_lines: TOOL_OUTPUT_MAX_LINES_DEFAULT,
            max_bytes: TOOL_OUTPUT_MAX_BYTES_DEFAULT,
        }
    }
}

impl ToolOutputTruncationLimits {
    /// 边界钳制：至少保留标记行 + 1 行内容
    pub fn normalized(&self) -> Self {
        Self {
            max_lines: self.max_lines.max(MARKER_LINE_RESERVE + 1),
            max_bytes: self.max_bytes.max(MARKER_BYTES_RESERVE),
        }
    }
}

/// 截断结果（text 为截断后注入文本；计数供事件留痕与水位联动）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutputTruncationResult {
    /// 截断后文本（未截断时为原文）
    pub text: String,
    /// 是否发生截断
    pub truncated: bool,
    /// 截断标记（未截断时为 None）
    pub marker: Option<String>,
    /// 保留的头部行数
    pub head_lines: usize,
    /// 保留的尾部行数
    pub tail_lines: usize,
    /// 丢弃行数（原始行数 - 保留行数）
    pub dropped_lines: usize,
    /// 原始字节数
    pub original_bytes: usize,
    /// 截断后字节数（不含标记）
    pub truncated_bytes: usize,
    /// 截断节省的 token（原 token - 截断后 token，供预算水位联动）
    pub tokens_saved: u64,
}

/// 截断留痕记录（camelCase，随截断动作写入 events 表；
/// 留痕不静默丢弃，G8 验收：截断留痕可查）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputTruncationRecord {
    /// 是否发生截断
    pub truncated: bool,
    /// 截断标记文本（None = 未截断）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    /// 保留头部行数
    pub head_lines: usize,
    /// 保留尾部行数
    pub tail_lines: usize,
    /// 丢弃行数
    pub dropped_lines: usize,
    /// 原始字节数
    pub original_bytes: usize,
    /// 截断后字节数
    pub truncated_bytes: usize,
    /// 截断节省 token（水位联动依据）
    pub tokens_saved: u64,
}

impl ToolOutputTruncationRecord {
    /// 从截断结果构造留痕记录（未截断时同样可记：truncated=false）
    pub fn from_result(result: &ToolOutputTruncationResult) -> Self {
        Self {
            truncated: result.truncated,
            marker: result.marker.clone(),
            head_lines: result.head_lines,
            tail_lines: result.tail_lines,
            dropped_lines: result.dropped_lines,
            original_bytes: result.original_bytes,
            truncated_bytes: result.truncated_bytes,
            tokens_saved: result.tokens_saved,
        }
    }
}

/// UTF-8 字节上限的头部截取（按字符边界，不劈裂字符）
fn take_prefix_bytes(input: &str, max_bytes: usize) -> String {
    let mut bytes = 0usize;
    let mut out = String::new();
    for ch in input.chars() {
        let size = ch.len_utf8();
        if bytes + size > max_bytes {
            break;
        }
        bytes += size;
        out.push(ch);
    }
    out
}

/// UTF-8 字节上限的尾部截取（按字符边界，不劈裂字符）
fn take_suffix_bytes(input: &str, max_bytes: usize) -> String {
    let mut bytes = 0usize;
    let mut out: Vec<char> = Vec::new();
    for ch in input.chars().rev() {
        let size = ch.len_utf8();
        if bytes + size > max_bytes {
            break;
        }
        bytes += size;
        out.push(ch);
    }
    out.into_iter().rev().collect()
}

/// 行数（对齐 opencode lineCount：1 + '\n' 计数；split 形态含尾随换行行）
fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    text.split('\n').count()
}

/// 工具输出截断（G8：head + 标记 + tail 计数截断）
///
/// 流程（对齐 opencode boundedPreview/preview）：
///
/// 1. 行数与字节双阈值均在限内 → 原样返回（truncated=false）；
/// 2. 预留标记预算（1 行 + 预留字节），行数超限时按
///    `head=ceil(剩余行/2)、tail=floor(剩余行/2)` 切 head/tail；
///    仅字节超限时 head=全文、tail 为空；
/// 3. 拼接超字节预算 → 按字节再收缩 head/tail（字符边界）；
/// 4. 标记携带丢弃行/字节计数（留痕在标记内可见）；
/// 5. 预算过小（放不下标记与至少 4 行内容）→ 只保留标记。
pub fn truncate_tool_output(
    text: &str,
    limits: &ToolOutputTruncationLimits,
) -> ToolOutputTruncationResult {
    let limits = limits.normalized();
    let original_bytes = text.len();
    let total_lines = count_lines(text);
    let original_tokens = count_tokens(text);

    if total_lines <= limits.max_lines && original_bytes <= limits.max_bytes {
        return ToolOutputTruncationResult {
            text: text.to_string(),
            truncated: false,
            marker: None,
            head_lines: total_lines,
            tail_lines: 0,
            dropped_lines: 0,
            original_bytes,
            truncated_bytes: original_bytes,
            tokens_saved: 0,
        };
    }

    // 内容预算（标记预留）
    let content_max_lines = limits.max_lines.saturating_sub(MARKER_LINE_RESERVE);
    let content_max_bytes = limits
        .max_bytes
        .saturating_sub(MARKER_BYTES_RESERVE + SEPARATOR_BYTES);

    // 预算过小：只保留标记（对齐 opencode maxLines<=4 时 markerOnly）
    if content_max_lines <= 2 || content_max_bytes <= 8 {
        let marker = truncation_marker(0, 0, total_lines, original_bytes);
        return ToolOutputTruncationResult {
            text: marker.clone(),
            truncated: true,
            marker: Some(marker),
            head_lines: 0,
            tail_lines: 0,
            dropped_lines: total_lines,
            original_bytes,
            truncated_bytes: 0,
            tokens_saved: original_tokens as u64,
        };
    }

    let all_lines: Vec<&str> = text.split('\n').collect();
    let (mut head, mut tail) = if total_lines > content_max_lines {
        let head_lines = content_max_lines.div_ceil(2);
        let tail_lines = content_max_lines / 2;
        let head = all_lines[..head_lines].join("\n");
        let tail = all_lines[total_lines - tail_lines..].join("\n");
        (head, tail)
    } else {
        // 仅字节超限：head = 全文，tail 空（对齐 opencode 行内字节收缩）
        (text.to_string(), String::new())
    };

    // 字节级收缩（head/tail 对半分字节预算）
    let head_tail_bytes = head.len() + tail.len();
    if head_tail_bytes > content_max_bytes {
        let head_bytes = content_max_bytes.div_ceil(2);
        let tail_bytes = content_max_bytes / 2;
        head = take_prefix_bytes(&head, head_bytes);
        tail = take_suffix_bytes(&tail, tail_bytes);
    }

    let kept_head_lines = count_lines(&head);
    let kept_tail_lines = count_lines(&tail);
    let dropped_lines = total_lines.saturating_sub(kept_head_lines + kept_tail_lines);
    let truncated_bytes = head.len() + tail.len();
    let mut marker = truncation_marker(
        kept_head_lines,
        kept_tail_lines,
        dropped_lines,
        original_bytes.saturating_sub(truncated_bytes),
    );

    let mut text_out = if tail.is_empty() {
        format!("{head}\n{marker}")
    } else {
        format!("{head}\n{marker}\n{tail}")
    };

    // 极端情况：标记过长导致总字节仍超限 → 换无计数的短标记重拼，仍超则
    // 整体按字节截断（保注入不超预算）
    if text_out.len() > limits.max_bytes && marker.len() > MARKER_BYTES_RESERVE {
        marker = "... 输出已截断 ...".to_string();
        text_out = if tail.is_empty() {
            format!("{head}\n{marker}")
        } else {
            format!("{head}\n{marker}\n{tail}")
        };
    }
    if text_out.len() > limits.max_bytes {
        text_out = take_prefix_bytes(&text_out, limits.max_bytes);
    }

    let tokens_saved = original_tokens.saturating_sub(count_tokens(&text_out)) as u64;

    ToolOutputTruncationResult {
        text: text_out,
        truncated: true,
        marker: Some(marker),
        head_lines: kept_head_lines,
        tail_lines: kept_tail_lines,
        dropped_lines,
        original_bytes,
        truncated_bytes,
        tokens_saved,
    }
}

/// 计数标记（head/tail 行数与丢弃行/字节计数留痕）
fn truncation_marker(
    head_lines: usize,
    tail_lines: usize,
    dropped_lines: usize,
    dropped_bytes: usize,
) -> String {
    format!(
        "... 输出已截断：保留前 {head_lines} 行与后 {tail_lines} 行，丢弃 {dropped_lines} 行 / {dropped_bytes} 字节 ..."
    )
}

// ── 与压缩预算水位联动（02 M10 内容 8）──

/// 截断后的上下文估算：原估算减去截断节省 token
pub fn estimate_after_truncation(estimate: u64, tokens_saved: u64) -> u64 {
    estimate.saturating_sub(tokens_saved)
}

/// 水位联动判定：截断计入预算水位后仍未收敛才进入常规线（AI 摘要）；
/// 截断节省足够时回到预算内（无需压缩）。
///
/// 语义（02 M10 内容 8）：截断是压缩的前置防线——单条工具输出截断
/// 计入上下文估算，`estimate - tokens_saved` 仍 ≥ 常规线才触发 AI 摘要。
pub fn classify_after_truncation(
    estimate: u64,
    result: &ToolOutputTruncationResult,
    window: u64,
    thresholds: &CompactionThresholds,
) -> ThresholdDecision {
    thresholds.classify(estimate_after_truncation(estimate, result.tokens_saved), window)
}

#[cfg(test)]
mod tests {
    use super::{
        classify_after_truncation, estimate_after_truncation, truncate_tool_output,
        ToolOutputTruncationLimits, ToolOutputTruncationRecord,
        TOOL_OUTPUT_MAX_BYTES_DEFAULT, TOOL_OUTPUT_MAX_LINES_DEFAULT,
    };
    use crate::compaction::{CompactionThresholds, ThresholdDecision};

    /// 多行文本（行间 \n、末行无尾随换行——与真实工具输出的
    /// split('\n') 计数口径一致）
    fn many_lines(count: usize, width: usize) -> String {
        (0..count)
            .map(|i| format!("第 {i} 行 {}", "x".repeat(width)))
            .collect::<Vec<_>>()
            .join("\n")
    }

    // ── 双阈值与默认值 ──

    #[test]
    fn under_limits_unchanged() {
        let limits = ToolOutputTruncationLimits {
            max_lines: 10,
            max_bytes: 1024,
        };
        let text = "第一行\n第二行\n第三行";
        let result = truncate_tool_output(text, &limits);
        assert!(!result.truncated);
        assert_eq!(result.text, text);
        assert!(result.marker.is_none());
        assert_eq!(result.dropped_lines, 0);
        assert_eq!(result.tokens_saved, 0);
    }

    #[test]
    fn defaults_aligned_with_opencode() {
        let limits = ToolOutputTruncationLimits::default();
        assert_eq!(limits.max_lines, TOOL_OUTPUT_MAX_LINES_DEFAULT);
        assert_eq!(limits.max_bytes, TOOL_OUTPUT_MAX_BYTES_DEFAULT);
    }

    // ── 行数截断：head + 标记 + tail ──

    #[test]
    fn line_based_head_marker_tail_truncation() {
        let limits = ToolOutputTruncationLimits {
            max_lines: 6,
            max_bytes: 100_000,
        };
        let text = many_lines(20, 3);
        let result = truncate_tool_output(&text, &limits);
        assert!(result.truncated);
        // 内容预算 = 5 行：head=ceil(5/2)=3 行、tail=2 行
        assert_eq!(result.head_lines, 3);
        assert_eq!(result.tail_lines, 2);
        assert_eq!(result.dropped_lines, 15);
        // head + 标记 + tail 顺序与行数
        let out_lines: Vec<&str> = result.text.split('\n').collect();
        assert_eq!(out_lines.len(), 6, "标记 1 行 + 内容 5 行");
        assert_eq!(out_lines[0], "第 0 行 xxx");
        assert_eq!(out_lines[1], "第 1 行 xxx");
        assert_eq!(out_lines[2], "第 2 行 xxx");
        // 标记携带计数（留痕在标记内）
        let marker = result.marker.as_deref().expect("截断须有标记");
        assert!(marker.contains("保留前 3 行"));
        assert!(marker.contains("后 2 行"));
        assert!(marker.contains("丢弃 15 行"));
        assert_eq!(out_lines[3], marker);
        // 尾部为最后两行
        assert_eq!(out_lines[4], "第 18 行 xxx");
        assert_eq!(out_lines[5], "第 19 行 xxx");
        // 截断留痕记录字段
        let record = ToolOutputTruncationRecord::from_result(&result);
        assert!(record.truncated);
        assert_eq!(record.dropped_lines, 15);
        assert_eq!(record.marker.as_deref(), Some(marker));
        // 记录可序列化为 camelCase（留痕进 events 表）
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json.get("headLines"), Some(&serde_json::json!(3)));
        assert!(json.get("tokensSaved").is_some());
        assert!(json.get("droppedLines").is_some());
    }

    // ── 字节截断：长单行按字节收缩 ──

    #[test]
    fn byte_cap_shrinks_long_line() {
        let limits = ToolOutputTruncationLimits {
            max_lines: 100,
            max_bytes: 512,
        };
        let text = format!("中文{}", "a".repeat(2000));
        let result = truncate_tool_output(&text, &limits);
        assert!(result.truncated);
        // 行数在限内 → head = 全文、tail 空，字节收缩
        assert_eq!(result.head_lines, 1);
        assert_eq!(result.tail_lines, 0);
        assert!(result.text.len() <= 512, "截断后不得超字节预算");
        // 不劈裂多字节字符（首字符中文在场且可解码）
        assert!(result.text.starts_with('中'));
        assert!(result.marker.is_some());
    }

    /// 行与字节同时超限：先按行切 head/tail，再按字节收缩
    #[test]
    fn both_thresholds_apply_head_tail_then_bytes() {
        let limits = ToolOutputTruncationLimits {
            max_lines: 4,
            max_bytes: 200,
        };
        let text = many_lines(20, 20);
        let result = truncate_tool_output(&text, &limits);
        assert!(result.truncated);
        // 内容预算 3 行：head=2、tail=1；随后字节收缩生效
        assert!(result.text.len() <= 200, "截断后不得超字节预算");
        assert_eq!(result.dropped_lines, 17);
        assert_eq!(result.original_bytes, text.len());
    }

    /// 预算过小（max_lines ≤ 4）：只保留标记
    #[test]
    fn tiny_limits_marker_only() {
        let limits = ToolOutputTruncationLimits {
            max_lines: 3,
            max_bytes: 200,
        };
        let text = "a\nb\nc\nd\ne";
        let result = truncate_tool_output(text, &limits);
        assert!(result.truncated);
        assert!(result.text.contains("输出已截断"));
        assert_eq!(result.dropped_lines, 5);
        assert_eq!(result.head_lines, 0);
    }

    /// 行数超限但标记+内容总字节不超 → 标记保留计数
    #[test]
    fn marker_keeps_counts_when_within_byte_budget() {
        let limits = ToolOutputTruncationLimits {
            max_lines: 6,
            max_bytes: 100_000,
        };
        let text = many_lines(20, 3);
        let result = truncate_tool_output(&text, &limits);
        assert!(result.marker.as_deref().unwrap().contains("丢弃 15 行"));
        assert!(result.text.len() <= 100_000);
    }

    /// 空输出：按未截断处理
    #[test]
    fn empty_output_unchanged() {
        let limits = ToolOutputTruncationLimits::default();
        let result = truncate_tool_output("", &limits);
        assert!(!result.truncated);
        assert_eq!(result.text, "");
        assert_eq!(result.original_bytes, 0);
    }

    // ── 与压缩预算水位联动 ──

    /// 截断节省计入水位：节省足够 → 回到预算内；不足 → 仍触发常规线
    #[test]
    fn water_level_linkage_after_truncation() {
        let thresholds = CompactionThresholds::default();
        let window = 100_000u64;
        let estimate = 90_000u64; // 0.90 → 常规线
        let limits = ToolOutputTruncationLimits {
            max_lines: 10,
            max_bytes: 100_000,
        };
        // 大输出截断（200KB 超 100KB 字节预算）→ 节省显著 → 估算回落 → 预算内
        let truncated = truncate_tool_output(&"y".repeat(200_000), &limits);
        assert!(truncated.truncated);
        assert!(truncated.tokens_saved > 0);
        assert_eq!(
            classify_after_truncation(estimate, &truncated, window, &thresholds),
            ThresholdDecision::UnderBudget
        );
        // 截断节省计入估算本身
        assert_eq!(
            estimate_after_truncation(estimate, truncated.tokens_saved),
            estimate - truncated.tokens_saved
        );
        // 未截断（节省 0）→ 水位不变，仍常规线
        let untruncated = truncate_tool_output("short", &limits);
        assert!(!untruncated.truncated);
        assert_eq!(
            classify_after_truncation(estimate, &untruncated, window, &thresholds),
            ThresholdDecision::Regular
        );
    }

    /// 截断后仍超临界线 → 临界硬压缩（联动不改变临界判定）
    #[test]
    fn water_level_critical_unchanged_by_truncation() {
        let thresholds = CompactionThresholds::default();
        let window = 100_000u64;
        let estimate = 96_000u64; // 0.96 → 临界线
        let limits = ToolOutputTruncationLimits {
            max_lines: 2,
            max_bytes: 100,
        };
        // 小输出截断：节省不足以把水位拉回临界线之下
        let truncated = truncate_tool_output(&"z".repeat(1_000), &limits);
        assert!(truncated.truncated);
        assert!(truncated.tokens_saved < 1_000, "节省须小于临界裕量");
        assert_eq!(
            classify_after_truncation(estimate, &truncated, window, &thresholds),
            ThresholdDecision::Critical
        );
    }
}
