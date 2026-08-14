//! 工具输出清洗管线（T-14：R1-R6 纯函数；接线在轮次 4 wire 面）
//!
//! 规则（00-plan §8.2 / 03 §3.3，wire 面统一应用，R-J）：
//! - R1 ANSI/控制字符剥离（字节安全状态机）
//! - R2 行尾空白
//! - R3 空行合并（连续空行至多 1）
//! - R4 重复行折叠（连续 ≥3 完全相等行 → 保留 1 行 + 折叠标记）
//! - R5 超长行截断（char 边界，尾部省略号）
//! - R6 JSON 压缩（text 通道单行 JSON 重 compact）
//!
//! 不变量：**确定性 + 幂等**（clean(clean(x)) == clean(x)）；落库/事件/
//! 工具返回面保持 raw，本函数只在 wire 序列化面应用（R-J），不产生前缀漂移。

use crate::count_tokens;

/// 清洗选项（Default：max_line_width=120，其余规则全开）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupOptions {
    /// 超长行截断宽度（0 = 不截断）
    pub max_line_width: usize,
    /// R3 空行合并（连续空行至多保留 1）
    pub collapse_empty_lines: bool,
    /// R4 重复行折叠（连续 ≥3 相等行 → 1 行 + 标记）
    pub collapse_duplicate_lines: bool,
    /// R6 JSON 压缩（可解析单行 JSON 重 compact）
    pub compact_json: bool,
}

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            max_line_width: 120,
            collapse_empty_lines: true,
            collapse_duplicate_lines: true,
            compact_json: true,
        }
    }
}

impl CleanupOptions {
    /// Wire 协议投影层专用配置：纯净脱色、收敛空行、绝不截断代码与 JSON
    pub fn wire_safe() -> Self {
        Self {
            max_line_width: 0,
            collapse_empty_lines: true,
            collapse_duplicate_lines: false,
            compact_json: false,
        }
    }
}

/// 清洗结果（规则命中记录 + token 收益）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanupResult {
    pub cleaned: String,
    pub original_bytes: usize,
    pub cleaned_bytes: usize,
    pub tokens_saved: usize,
    pub rules_applied: Vec<&'static str>,
}

/// 规则命中常量（rules_applied 内按管线应用顺序记录）
const R1_ANSI: &str = "R1 ANSI剥离";
const R2_TRIM: &str = "R2 行尾空白";
const R3_EMPTY: &str = "R3 空行合并";
const R4_DUP: &str = "R4 重复行折叠";
const R5_TRUNC: &str = "R5 超长行截断";
const R6_JSON: &str = "R6 JSON 压缩";

/// R4 重复行折叠标记（N = 折叠掉的行数 = 原连续数 - 1）
pub fn duplicate_fold_marker(folded_away: usize) -> String {
    format!("… 重复 {folded_away} 行 …")
}

/// R1：ANSI/控制字符剥离（字节安全状态机）
///
/// - `ESC [ ... m|k|H|J`（CSI）与 `ESC ] ... BEL`（OSC）序列整体剥离；
/// - CSI 支持 ECMA-48 全终结符（0x40..=0x7E）与 64 字节长度保护；
/// - C0 控制字符除 `\n` `\r` `\t` 外剥离（含 DEL 0x7F）；
/// - 嵌套 ESC 按新序列重新进入 Esc 态；序列未终结时后续字节一并剥离。
///
/// 仅剥离 ASCII（< 0x80）字节，而多字节 UTF-8 序列全部字节 ≥ 0x80——
/// 输入为合法 UTF-8 时输出必然仍为合法 UTF-8（可安全 from_utf8）。
fn strip_control_bytes(input: &str) -> String {
    #[derive(Clone, Copy)]
    enum State {
        Normal,
        Esc,
        Csi(usize),
        Osc,
    }
    let mut state = State::Normal;
    let mut kept: Vec<u8> = Vec::with_capacity(input.len());
    for &b in input.as_bytes() {
        if b == 0x1b {
            // ESC 本身剥离；后续字节按序列状态解析
            state = State::Esc;
            continue;
        }
        match state {
            State::Esc => match b {
                b'[' => state = State::Csi(0),
                b']' => state = State::Osc,
                _ => state = State::Normal,
            },
            State::Csi(len) => {
                // ECMA-48 CSI 终结符为 0x40..=0x7E，带 64 字节长度上限保护
                if (0x40..=0x7E).contains(&b) || len >= 64 {
                    state = State::Normal;
                } else {
                    state = State::Csi(len + 1);
                }
            }
            State::Osc => {
                if b == 0x07 {
                    state = State::Normal;
                }
            }
            State::Normal => {
                if matches!(b, b'\n' | b'\r' | b'\t') {
                    kept.push(b);
                } else if b < 0x20 || b == 0x7f {
                    // 其余 C0 / DEL 剥离
                } else {
                    kept.push(b);
                }
            }
        }
    }
    // 剥离仅触及 ASCII 字节 → UTF-8 合法性保持（见函数注释）
    String::from_utf8(kept).expect("剥离仅移除 ASCII 控制字节，UTF-8 合法性保持")
}

/// R1-R6 清洗管线（顺序固定：R1 → R2 → R3 → R4 → R6 → R5）
///
/// 顺序理由：R3 先于 R4（空行先合并，避免被当作重复行折叠）；
/// R6 先于 R5（JSON 压缩后再截断——已截断的 JSON 不再被二次压缩，
/// 保证幂等；截断发生在最外层，避免半截 JSON 被重复折叠）。
pub fn clean_output(raw: &str, opts: &CleanupOptions) -> CleanupResult {
    let original_bytes = raw.len();
    let mut applied: Vec<&'static str> = Vec::new();

    // R1：ANSI/控制字符剥离
    let stripped = strip_control_bytes(raw);
    if stripped.as_bytes() != raw.as_bytes() {
        applied.push(R1_ANSI);
    }

    // R2：行尾空白（str::lines 已剔除 \r，此处兜底空格/Tab）
    let mut r2_changed = false;
    let mut lines: Vec<String> = Vec::new();
    for line in stripped.lines() {
        let trimmed = line.trim_end().to_string();
        if trimmed != line {
            r2_changed = true;
        }
        lines.push(trimmed);
    }
    if r2_changed {
        applied.push(R2_TRIM);
    }

    // R3：空行合并（连续空行至多 1）
    if opts.collapse_empty_lines {
        let mut collapsed: Vec<String> = Vec::with_capacity(lines.len());
        let mut prev_empty = false;
        for line in &lines {
            if line.is_empty() {
                if prev_empty {
                    continue;
                }
                prev_empty = true;
            } else {
                prev_empty = false;
            }
            collapsed.push(line.clone());
        }
        if collapsed.len() != lines.len() {
            applied.push(R3_EMPTY);
        }
        lines = collapsed;
    }

    // R4：重复行折叠（连续 ≥3 完全相等行 → 1 行 + 标记）
    if opts.collapse_duplicate_lines {
        let mut folded: Vec<String> = Vec::with_capacity(lines.len());
        let mut i = 0usize;
        while i < lines.len() {
            let mut count = 1usize;
            while i + count < lines.len() && lines[i + count] == lines[i] {
                count += 1;
            }
            if count >= 3 {
                folded.push(lines[i].clone());
                folded.push(duplicate_fold_marker(count - 1));
                applied.push(R4_DUP);
            } else {
                for _ in 0..count {
                    folded.push(lines[i].clone());
                }
            }
            i += count;
        }
        lines = folded;
    }

    // R6：JSON 压缩（行首为 { 且整体可解析 → 重 compact；失败原样保留）
    if opts.compact_json {
        let mut r6_changed = false;
        for line in lines.iter_mut() {
            if !line.trim_start().starts_with('{') {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                let compact = serde_json::to_string(&value).unwrap_or_default();
                if compact != *line {
                    *line = compact;
                    r6_changed = true;
                }
            }
        }
        if r6_changed {
            applied.push(R6_JSON);
        }
    }

    // R5：超长行截断（char 边界；结果 = max_line_width - 1 字符 + 省略号，
    // 总长 = max_line_width → 二次清洗不再截断，幂等）
    if opts.max_line_width > 0 {
        let mut r5_changed = false;
        for line in lines.iter_mut() {
            if line.chars().count() > opts.max_line_width {
                let mut truncated: String = line
                    .chars()
                    .take(opts.max_line_width.saturating_sub(1))
                    .collect();
                if truncated.ends_with('…') {
                    truncated.pop();
                }
                truncated.push('…');
                *line = truncated;
                r5_changed = true;
            }
        }
        if r5_changed {
            applied.push(R5_TRUNC);
        }
    }

    let cleaned = lines.join("\n");
    let cleaned_bytes = cleaned.len();
    let tokens_saved = count_tokens(raw).saturating_sub(count_tokens(&cleaned));
    CleanupResult {
        cleaned,
        original_bytes,
        cleaned_bytes,
        tokens_saved,
        rules_applied: applied,
    }
}

#[cfg(test)]
mod tests {
    use super::{clean_output, duplicate_fold_marker, CleanupOptions, CleanupResult};

    fn clean(raw: &str) -> CleanupResult {
        clean_output(raw, &CleanupOptions::default())
    }

    /// 幂等断言：clean(clean(x)) 的字节与 clean(x) 一致
    fn assert_idempotent(raw: &str) {
        let once = clean(raw);
        let twice = clean_output(&once.cleaned, &CleanupOptions::default());
        assert_eq!(
            once.cleaned, twice.cleaned,
            "清洗必须幂等：{raw:?} → {once:?} → {twice:?}"
        );
    }

    #[test]
    fn strips_ansi_and_control_chars() {
        let result = clean("\x1b[31mred\x1b[0m\nplain\x1b]0;title\x07");
        assert_eq!(result.cleaned, "red\nplain");
        assert!(result.rules_applied.contains(&"R1 ANSI剥离"));
        // C0 剥离：\x00 与 \x1b（ESC 未终结时后续字节也剥离）
        assert_eq!(clean("a\x00b\x1bc").cleaned, "ab");
        // \n\r\t 保留
        assert_eq!(clean("a\tb\r\nc").cleaned, "a\tb\nc");
        // 无控制字符 → R1 不命中
        assert!(!clean("plain text").rules_applied.contains(&"R1 ANSI剥离"));
    }

    #[test]
    fn trims_trailing_whitespace_per_line() {
        let result = clean("a   \nb \t\nc");
        assert_eq!(result.cleaned, "a\nb\nc");
        assert!(result.rules_applied.contains(&"R2 行尾空白"));
    }

    #[test]
    fn collapses_empty_lines_to_at_most_one() {
        let result = clean("a\n\n\n\nb\n\nc");
        assert_eq!(result.cleaned, "a\n\nb\n\nc");
        assert!(result.rules_applied.contains(&"R3 空行合并"));
        // 单空行不合并
        assert_eq!(clean("a\n\nb").cleaned, "a\n\nb");
    }

    #[test]
    fn folds_duplicate_lines_with_marker() {
        let result = clean("x\nx\nx\ny\n\nz\nz\nz\nz");
        assert_eq!(
            result.cleaned,
            "x\n… 重复 2 行 …\ny\n\nz\n… 重复 3 行 …"
        );
        assert!(result.rules_applied.contains(&"R4 重复行折叠"));
        assert_eq!(duplicate_fold_marker(2), "… 重复 2 行 …");
        // 恰好 2 连续不折叠
        assert_eq!(clean("x\nx\ny").cleaned, "x\nx\ny");
    }

    #[test]
    fn truncates_overlong_lines_at_char_boundary() {
        let long = "字".repeat(200);
        let result = clean(&long);
        // 截断 = 119 字符 + 省略号 = 120 字符（char 边界，不裂多字节）
        assert_eq!(result.cleaned.chars().count(), 120);
        assert!(result.cleaned.ends_with('…'));
        assert!(result.rules_applied.contains(&"R5 超长行截断"));
        // max_line_width = 0 → 不截断
        let opts = CleanupOptions {
            max_line_width: 0,
            ..CleanupOptions::default()
        };
        let result = clean_output(&long, &opts);
        assert_eq!(result.cleaned, long);
    }

    #[test]
    fn compacts_single_line_json() {
        let raw = "{\"a\": 1, \"b\": [2, 3], \"c\": {\"d\": \"e\"}}";
        let result = clean(raw);
        assert_eq!(result.cleaned, "{\"a\":1,\"b\":[2,3],\"c\":{\"d\":\"e\"}}");
        assert!(result.rules_applied.contains(&"R6 JSON 压缩"));
        // 非 JSON（行首非 { 或不可解析）原样保留
        assert_eq!(clean("prefix {not json").cleaned, "prefix {not json");
        assert_eq!(clean("text only").cleaned, "text only");
    }

    #[test]
    fn deterministic_and_idempotent() {
        for raw in [
            "plain text",
            "a\n\n\nb\nb\nb\nb\nc",
            "line with spaces   \n\x1b[32mcolored\x1b[0m\n\n\n{\"x\": 1, \"y\": [1, 2]}",
            &"长".repeat(300),
            "a\nb\nc\nd",
            "",
            "{\"k\": \"v\"}\n{\"k2\": [1,2,3]}",
        ] {
            let once = clean(raw);
            let twice = clean_output(&once.cleaned, &CleanupOptions::default());
            assert_eq!(once.cleaned, twice.cleaned, "幂等失败：{raw:?}");
            assert_idempotent(raw);
        }
    }

    #[test]
    fn tokens_saved_and_byte_counts_reported() {
        // 6 连续相同行：折叠标记固定开销远小于省下的 5 行
        let raw = "same long line here\n".repeat(6);
        let result = clean(&raw);
        assert_eq!(result.original_bytes, raw.len());
        assert_eq!(result.cleaned, "same long line here\n… 重复 5 行 …");
        assert_eq!(result.cleaned_bytes, result.cleaned.len());
        assert!(result.tokens_saved > 0, "折叠后 token 必须下降");
        // 清洗后 ≤ 原始
        assert!(result.cleaned_bytes <= result.original_bytes);
    }

    #[test]
    fn wire_safe_never_truncates_lines_or_modifies_json() {
        let opts = CleanupOptions::wire_safe();
        let long_code = "fn very_long_identifier_that_spans_more_than_one_hundred_and_twenty_characters_in_a_single_line_of_rust_code() -> bool { true }";
        let raw_json = "{\n  \"nested\": {\n    \"key\": \"value\"\n  }\n}";
        let raw = format!("\x1b[33m{}\x1b[0m\n\n\n{}", long_code, raw_json);

        let result = clean_output(&raw, &opts);
        assert!(result.cleaned.contains(long_code), "wire_safe 绝不截断长代码行");
        assert!(result.cleaned.contains(raw_json), "wire_safe 绝不折叠多行 JSON");
        assert!(!result.cleaned.contains("\x1b"), "wire_safe 剥离 ANSI 颜色");
        assert_eq!(result.cleaned, format!("{}\n\n{}", long_code, raw_json));
    }

    #[test]
    fn strips_all_ecma48_csi_commands() {
        // \x1b[2J (erase display), \x1b[1;1H (cursor home), \x1b[?25h (show cursor), \x1b[10C (cursor forward)
        let raw = "prefix\x1b[2Jmid\x1b[1;1H\x1b[?25h\x1b[10Csuffix";
        let result = clean(raw);
        assert_eq!(result.cleaned, "prefixmidsuffix");
    }
}

