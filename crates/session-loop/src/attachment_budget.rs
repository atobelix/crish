//! 附件动态上下文预算调度（维度四 · 详案 04 §2.5）
//!
//! **wire 权威在 Rust**（00-总方案 §三 #5「截断归属裁决」）；本模块与
//! `attachment_truncation` 配合实现 wire 面的二级防爆护栏：
//!
//! - **顺序接纳**：沿输入顺序逐个接纳附件，累计 `estimated_tokens` 不得超过
//!   `available_tokens`（= ContextWindow - Reserve - Safety - History -
//!   Prompt，计算归 prepare_turn 接线轮）；
//! - **超预算二次深度截断**：对超预算的**文本**附件先做 Head-Tail 二次截断
//!   （clamp 到剩余预算），剩余预算 ≥ 300 Tokens 才允许二次截断；
//! - **安全移除并告警**：剩余预算不足 300（或非文本附件）时安全移除该附件并
//!   生成中文警告——绝不让附件击穿上下文窗口引发下游 API 400/413。
//!
//! `max_chars = remaining_budget × 3.2` 为启发式 字符↔Token 换算（约
//! 0.31 token/字符的宽松上界，承接详案 04 §2.2 的截断字符配额口径）；
//! 本函数保证不变量：**总采纳 token ≤ available_tokens**。

use conex_types::attachment::ContextAttachmentPayload;

use crate::attachment_truncation::truncate_text_head_tail;

/// 二次截断的最小剩余预算门槛（Tokens；详案 04 §2.5：remaining < 300 拒绝）
const MIN_SECONDARY_TRUNCATION_BUDGET: u32 = 300;

/// 字符 ↔ Token 启发式换算系数（max_chars = remaining_budget × 3.2）
const CHARS_PER_TOKEN_FACTOR: f64 = 3.2;

/// 按可用 Token 预算钳制附件序列。
///
/// 返回 `(被接纳附件, 中文警告列表)`；接纳顺序与输入一致（跳过的除外）。
pub fn clamp_attachments_to_budget(
    attachments: Vec<ContextAttachmentPayload>,
    available_tokens: u32,
) -> (Vec<ContextAttachmentPayload>, Vec<String>) {
    // 内部以 u64 累计，避免多个大附件估值相加时 u32 溢出回绕
    let mut total_tokens = 0u64;
    let mut accepted = Vec::new();
    let mut warnings = Vec::new();

    for mut att in attachments {
        let remaining_budget = (available_tokens as u64).saturating_sub(total_tokens);

        // 完整接纳：当前附件估值在剩余预算内
        if u64::from(att.estimated_tokens) <= remaining_budget {
            total_tokens += u64::from(att.estimated_tokens);
            accepted.push(att);
            continue;
        }

        // 超预算：仅文本附件且在剩余预算 ≥ 300 时可做 Head-Tail 二次深度截断
        if remaining_budget >= u64::from(MIN_SECONDARY_TRUNCATION_BUDGET) {
            if let Some(text) = &att.text_content {
                let remaining = remaining_budget as u32;
                let max_chars = (f64::from(remaining) * CHARS_PER_TOKEN_FACTOR) as usize;
                let (truncated_text, trunc_info) =
                    truncate_text_head_tail(text, max_chars, &att.title);
                att.text_content = Some(truncated_text);
                att.estimated_tokens = remaining;
                att.truncation = trunc_info;
                total_tokens += remaining_budget;
                accepted.push(att);
                continue;
            }
        }

        warnings.push(format!(
            "附件「{}」因超出剩余上下文预算（{} Tokens）被安全移除",
            att.title, remaining_budget
        ));
    }

    (accepted, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::attachment::{
        ContextAttachmentKind, ContextAttachmentPayload, TruncationInfo,
    };

    fn make_attachment(
        title: &str,
        tokens: u32,
        text: Option<&str>,
    ) -> ContextAttachmentPayload {
        ContextAttachmentPayload {
            id: format!("att_{}", title),
            kind: ContextAttachmentKind::TerminalLog,
            title: title.to_string(),
            text_content: text.map(str::to_string),
            data_uri_or_path: None,
            estimated_tokens: tokens,
            truncation: TruncationInfo {
                is_truncated: false,
                original_size_bytes: 0,
                injected_size_bytes: 0,
                original_lines: 0,
                injected_lines: 0,
                truncation_strategy: "none".to_string(),
            },
            metadata: serde_json::json!({}),
        }
    }

    #[test]
    fn accepts_all_within_budget_in_order() {
        let attachments = vec![
            make_attachment("a", 300, Some("x")),
            make_attachment("b", 400, Some("y")),
            make_attachment("c", 200, None),
        ];
        let (accepted, warnings) = clamp_attachments_to_budget(attachments, 1000);

        assert_eq!(accepted.len(), 3);
        assert!(warnings.is_empty());
        let titles: Vec<&str> = accepted.iter().map(|a| a.title.as_str()).collect();
        assert_eq!(titles, vec!["a", "b", "c"], "顺序接纳须保持输入顺序");
        let sum: u64 = accepted.iter().map(|a| u64::from(a.estimated_tokens)).sum();
        assert!(sum <= 1000, "总采纳 token 不得超出预算");
    }

    #[test]
    fn oversize_text_attachment_gets_secondary_head_tail_truncation() {
        let long_text = "行日志内容".repeat(600); // 3600 字符
        let attachments = vec![
            make_attachment("first", 500, Some("短内容")),
            make_attachment("huge", 900, Some(&long_text)),
        ];
        let (accepted, warnings) = clamp_attachments_to_budget(attachments, 1000);

        assert!(warnings.is_empty());
        assert_eq!(accepted.len(), 2);
        // 剩余 500 Tokens ≥ 300 → 二次截断接纳，并把预算完全 clamp
        let huge = &accepted[1];
        assert!(huge.truncation.is_truncated);
        assert_eq!(huge.truncation.truncation_strategy, "head-tail");
        assert_eq!(huge.estimated_tokens, 500);
        assert!(huge.text_content.as_deref().unwrap().len() < long_text.len());
        let sum: u64 = accepted.iter().map(|a| u64::from(a.estimated_tokens)).sum();
        assert_eq!(sum, 1000);
    }

    #[test]
    fn rejects_when_remaining_budget_below_300_with_warning() {
        let overflow_text = "超长日志内容".repeat(50);
        let attachments = vec![
            make_attachment("base", 900, Some("短内容")),
            make_attachment("overflow", 400, Some(&overflow_text)),
        ];
        let (accepted, warnings) = clamp_attachments_to_budget(attachments, 1000);

        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].title, "base");
        assert_eq!(warnings.len(), 1);
        // 剩余 100 Tokens < 300 → 二次截断被拒绝，生成中文警告
        assert!(warnings[0].contains("overflow"));
        assert!(warnings[0].contains("100 Tokens"));
        assert!(warnings[0].contains("安全移除"));
    }

    #[test]
    fn rejects_non_text_oversize_attachment_with_warning() {
        let attachments = vec![
            make_attachment("base", 600, Some("x")),
            make_attachment("image", 600, None), // 无文本载荷，无法二次截断
        ];
        let (accepted, warnings) = clamp_attachments_to_budget(attachments, 1000);

        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].title, "base");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("image"));
    }

    #[test]
    fn rejects_zero_budget_except_zero_token_attachments() {
        let attachments = vec![
            make_attachment("free", 0, None),
            make_attachment("costly", 10, Some("x")),
        ];
        let (accepted, warnings) = clamp_attachments_to_budget(attachments, 0);

        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].title, "free");
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("costly"));
        assert!(warnings[0].contains("0 Tokens"));
    }

    #[test]
    fn empty_input_returns_empty_outputs() {
        let (accepted, warnings) = clamp_attachments_to_budget(Vec::new(), 500);
        assert!(accepted.is_empty());
        assert!(warnings.is_empty());
    }

    #[test]
    fn accepted_tokens_never_exceed_budget_accumulation() {
        // 大规模混合序列：累计不变量永远成立
        let big_text = "文本".repeat(200);
        let attachments: Vec<ContextAttachmentPayload> = (0..50)
            .map(|i| {
                if i % 3 == 0 {
                    make_attachment(&format!("big_{i}"), 300, Some(&big_text))
                } else {
                    make_attachment(&format!("small_{i}"), 50, None)
                }
            })
            .collect();
        let (accepted, _warnings) = clamp_attachments_to_budget(attachments, 1000);
        let sum: u64 = accepted.iter().map(|a| u64::from(a.estimated_tokens)).sum();
        assert!(sum <= 1000);
    }
}
