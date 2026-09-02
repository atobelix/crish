//! 智能首尾保留（Head-Tail 40/60）截断算法（维度四 · 详案 04 §2.2）
//!
//! **wire 权威在 Rust**（00-总方案 §三 #5「截断归属裁决」）；前端 TS 同构
//! `apps/crish-desktop/src/utils/attachmentTruncation.ts` 仅用于卡片预览与
//! 展示估算，严禁 TS / Rust / 旧 80KB 尾部 slice 三层截断并存。
//!
//! 机理：头部保留 40% 字符配额 + 尾部保留 60% 字符配额，中间注入清晰可解释的
//! 中文结构化省略标记。尾部配额偏重（60%）以保护终端报错 / 编译日志中最关键
//! 的底部错误概要、Panic 摘要与调用栈——传统尾部直接截断会让模型完全看不到
//! 错误根因。
//!
//! 实现要点：全部按 `char`（Unicode 标量）计数与切分，杜绝在 UTF-8 多字节
//! 字符中间截断产生非法序列；行数统计经 `str::lines`（与详案 §2.2 参考实现
//! 语义一致，省略行数按 head/tail 实际保留行数的差值饱和计算）。

use conex_types::attachment::TruncationInfo;

/// 智能首尾保留截断。
///
/// - `raw_text`：原始文本
/// - `max_chars`：最大允许**字符数**（按 Unicode 标量计数，非字节数）
/// - `kind_label`：实体类型名称（用于中文警告展示，如「终端日志」「代码」）
///
/// 返回 `(截断结果, 截断信息)`。当文本未超限时原样返回且
/// `truncation_strategy` 为 `"none"`，不做任何改动。
pub fn truncate_text_head_tail(
    raw_text: &str,
    max_chars: usize,
    kind_label: &str,
) -> (String, TruncationInfo) {
    let total_chars = raw_text.chars().count();
    let total_lines = raw_text.lines().count();

    if total_chars <= max_chars {
        return (
            raw_text.to_string(),
            TruncationInfo {
                is_truncated: false,
                original_size_bytes: raw_text.len(),
                injected_size_bytes: raw_text.len(),
                original_lines: total_lines,
                injected_lines: total_lines,
                truncation_strategy: "none".to_string(),
            },
        );
    }

    // 头部保留 40%，尾部保留 60%（floor 保证 head + tail = max_chars）
    let head_limit = (max_chars as f64 * 0.40) as usize;
    let tail_limit = max_chars - head_limit;

    let head_str: String = raw_text.chars().take(head_limit).collect();
    let tail_str: String = raw_text.chars().skip(total_chars - tail_limit).collect();

    let omitted_chars = total_chars - head_limit - tail_limit;
    let omitted_lines = total_lines.saturating_sub(
        head_str.lines().count() + tail_str.lines().count(),
    );

    let separator = format!(
        "\n\n... [! 警告：{}内容过长已触发安全截断：已省略中间 {} 行 / {} 字符] ...\n\n",
        kind_label, omitted_lines, omitted_chars
    );

    let mut result =
        String::with_capacity(head_str.len() + separator.len() + tail_str.len());
    result.push_str(&head_str);
    result.push_str(&separator);
    result.push_str(&tail_str);

    let injected_bytes = result.len();
    let injected_lines = result.lines().count();

    (
        result,
        TruncationInfo {
            is_truncated: true,
            original_size_bytes: raw_text.len(),
            injected_size_bytes: injected_bytes,
            original_lines: total_lines,
            injected_lines,
            truncation_strategy: "head-tail".to_string(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 组装确定性多行文本：5 行 × 10 ASCII 字符 + 4 个换行 = 54 字符 / 5 行
    fn multiline_text() -> String {
        "0000000000\n1111111111\n2222222222\n3333333333\n4444444444".to_string()
    }

    #[test]
    fn truncates_head_tail_with_exact_separator() {
        let raw = multiline_text();
        // max_chars=8 → head=3（"000"），tail=5（末行 "44444"），中间 46 字符 / 3 行被省略
        let (result, info) = truncate_text_head_tail(&raw, 8, "终端日志");

        assert!(info.is_truncated);
        assert_eq!(info.truncation_strategy, "head-tail");
        assert_eq!(info.original_size_bytes, raw.len());
        assert_eq!(info.original_lines, 5);
        // 头部 40% + 尾部 60% 精确保留为前缀/后缀
        assert!(result.starts_with("000"));
        assert!(result.ends_with("44444"));

        let expected_separator =
            "\n\n... [! 警告：终端日志内容过长已触发安全截断：已省略中间 3 行 / 46 字符] ...\n\n";
        assert!(result.contains(expected_separator));
        assert_eq!(result, format!("000{expected_separator}44444"));

        // 截断信息字段与结果一致（注入字节/行数、原字节/行数）
        assert_eq!(info.injected_size_bytes, result.len());
        assert_eq!(info.injected_lines, result.lines().count());
    }

    #[test]
    fn no_truncation_when_within_max_chars() {
        let raw = "short log line";
        let (result, info) = truncate_text_head_tail(raw, 100, "终端日志");

        assert_eq!(result, raw);
        assert!(!info.is_truncated);
        assert_eq!(info.truncation_strategy, "none");
        assert_eq!(info.original_size_bytes, raw.len());
        assert_eq!(info.injected_size_bytes, raw.len());
        assert_eq!(info.original_lines, 1);
        assert_eq!(info.injected_lines, 1);
    }

    #[test]
    fn exactly_equal_to_max_chars_is_not_truncated() {
        let raw = multiline_text(); // 54 字符
        let (result, info) = truncate_text_head_tail(&raw, 54, "代码");

        assert_eq!(result, raw);
        assert!(!info.is_truncated);
        assert_eq!(info.original_lines, 5);
        assert_eq!(info.injected_lines, 5);
    }

    #[test]
    fn empty_string_is_never_truncated() {
        let (result, info) = truncate_text_head_tail("", 0, "终端日志");
        assert_eq!(result, "");
        assert!(!info.is_truncated);
        assert_eq!(info.truncation_strategy, "none");
        assert_eq!(info.original_lines, 0);
        assert_eq!(info.injected_lines, 0);
    }

    #[test]
    fn single_char_over_zero_limit_truncates_to_separator_only() {
        // max_chars=0 边界：head/tail 配额皆 0，全部内容省略，仅剩省略标记
        let (result, info) = truncate_text_head_tail("中", 0, "终端日志");
        assert!(info.is_truncated);
        assert_eq!(info.original_lines, 1);
        assert_eq!(
            result,
            "\n\n... [! 警告：终端日志内容过长已触发安全截断：已省略中间 1 行 / 1 字符] ...\n\n"
        );
        assert_eq!(info.injected_size_bytes, result.len());
        assert_eq!(info.injected_lines, result.lines().count());
    }

    #[test]
    fn cjk_multibyte_never_split_mid_char() {
        let unit = "安全截断中文测试内容"; // 10 字符 × 3 字节
        let raw = unit.repeat(20); // 200 字符 / 600 字节
        let (result, info) = truncate_text_head_tail(&raw, 50, "代码");

        assert!(info.is_truncated);
        assert!(!result.contains('\u{FFFD}'), "不得产生 UTF-8 替换符");
        // 50 = head 20 + tail 30：恰好各对齐整段重复（head 2 段 / tail 3 段），
        // 无残缺字符；单行文本 → 省略 0 行 / 150 字符
        let expected = format!(
            "{}{}{}",
            unit.repeat(2),
            "\n\n... [! 警告：代码内容过长已触发安全截断：已省略中间 0 行 / 150 字符] ...\n\n",
            unit.repeat(3)
        );
        assert_eq!(result, expected);
        assert_eq!(info.injected_lines, result.lines().count());
        assert_eq!(info.injected_size_bytes, result.len());
    }

    #[test]
    fn char_count_budget_not_byte_count() {
        // 24 字节 > max_chars=10，但 8 字符 ≤ 10 → 按字符计数不应截断
        let raw = "中文".repeat(4);
        let (result, info) = truncate_text_head_tail(&raw, 10, "代码");
        assert_eq!(result, raw);
        assert!(!info.is_truncated);
    }

    #[test]
    fn truncation_info_fields_match_result() {
        let raw = "第一行\n第二行\n第三行\n第四行\n第五行尾部保留关键 Panic 摘要";
        let (result, info) = truncate_text_head_tail(raw, 12, "终端日志");
        assert!(info.is_truncated);
        // 字段互洽断言（不硬编码行数，防算法实现微调后的脆弱）
        assert_eq!(info.original_size_bytes, raw.len());
        assert_eq!(info.injected_size_bytes, result.len());
        assert_eq!(info.injected_lines, result.lines().count());
        assert_eq!(info.truncation_strategy, "head-tail");
        // 尾部关键信息必须原样保留在结果末尾
        assert!(result.ends_with(&raw.chars().skip(raw.chars().count() - 7).collect::<String>()));
    }
}
