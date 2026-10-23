pub mod diff_engine {
    use conex_types::{DiffHunk, DiffLine, DiffLineKind, DiffResult};
    use similar::{Algorithm, ChangeTag, TextDiff};

    const CONTEXT_LINES: usize = 3;
    const MAX_SAFE_DIFF_LINES: usize = 20_000;
    const MAX_SAFE_DIFF_BYTES: usize = 5 * 1024 * 1024; // 5 MB
    const DIFF_TIMEOUT_MS: u64 = 200;
    /// KD-05：大文本首尾/中段快速指纹采样阈值与窗口大小
    const FAST_SAMPLE_THRESHOLD_BYTES: usize = 4096;
    const FAST_SAMPLE_WINDOW_BYTES: usize = 64;
    /// KD-05：单个 Hunk 头部行（`@@ -a,b +c,d @@\n`）容量预估上限
    const HUNK_HEADER_ESTIMATED_BYTES: usize = 48;

    pub struct DiffEngine;

    impl DiffEngine {
        pub fn new() -> Self {
            Self
        }

        /// Compute a unified diff between old_text and new_text, returning hunk-structured output.
        /// Includes KD-03 adaptive algorithm selection, execution deadline protection, and
        /// KD-05 fast equality pre-check with line/buffer capacity preallocation.
        pub fn diff(old_text: &str, new_text: &str) -> DiffResult {
            if fast_equal_check(old_text, new_text) {
                return DiffResult {
                    hunks: vec![],
                    added_lines: 0,
                    removed_lines: 0,
                };
            }

            let total_bytes = old_text.len() + new_text.len();
            let old_newline_count = old_text.as_bytes().iter().filter(|&&b| b == b'\n').count();
            let new_newline_count = new_text.as_bytes().iter().filter(|&&b| b == b'\n').count();
            let total_lines = old_newline_count + new_newline_count;

            let old_line_est = estimate_line_count(old_text, old_newline_count);
            let new_line_est = estimate_line_count(new_text, new_newline_count);

            // KD-03: 自适应算法分流与安全预算保护
            // 超大文本（>20,000行或>5MB）自动使用 Patience Diff 切分独立区间，避免 Myers O(N^2) CPU 爆炸；
            // 同时挂载 200ms 执行超时保护，防止单行超大或极低相似度导致的计算停滞。
            let algorithm =
                if total_lines > MAX_SAFE_DIFF_LINES || total_bytes > MAX_SAFE_DIFF_BYTES {
                    Algorithm::Patience
                } else {
                    Algorithm::Myers
                };

            let diff = TextDiff::configure()
                .algorithm(algorithm)
                .timeout(std::time::Duration::from_millis(DIFF_TIMEOUT_MS))
                .diff_lines(old_text, new_text);

            let mut added_lines: usize = 0;
            let mut removed_lines: usize = 0;

            // KD-05: 预估变更行与差异索引容量，通过 Vec::with_capacity 消除动态扩容拷贝
            let changes_cap = estimated_changes_capacity(old_line_est, new_line_est);
            let mod_cap = old_line_est.abs_diff(new_line_est).max(16);
            let mut changes: Vec<(ChangeTag, Option<usize>, Option<usize>, &str)> =
                Vec::with_capacity(changes_cap);
            let mut mod_indices: Vec<usize> = Vec::with_capacity(mod_cap);

            // Collect changes with zero-copy line slices and CRLF/LF normalization (KD-01, KD-04, KD-05)
            for change in diff.iter_all_changes() {
                let tag = change.tag();
                let old_idx = change.old_index();
                let new_idx = change.new_index();
                let content = change.value().trim_end_matches(['\r', '\n']);

                match tag {
                    ChangeTag::Equal => {}
                    ChangeTag::Insert => {
                        added_lines += 1;
                        mod_indices.push(changes.len());
                    }
                    ChangeTag::Delete => {
                        removed_lines += 1;
                        mod_indices.push(changes.len());
                    }
                }
                changes.push((tag, old_idx, new_idx, content));
            }

            // Group changes into hunks with context
            let hunks = build_hunks(&changes, &mod_indices, CONTEXT_LINES);

            DiffResult {
                hunks,
                added_lines,
                removed_lines,
            }
        }

        pub fn compute_diff(&self, old_text: &str, new_text: &str) -> DiffResult {
            Self::diff(old_text, new_text)
        }

        /// KD-05：精确预估统一 Diff 视图输出的（总行数, 字节容量上限）。
        ///
        /// 供统一 Diff 文本渲染与视图行构建一次性执行 `Vec::with_capacity` / `String::with_capacity`，
        /// 彻底避免逐行拼接过程中的多次堆重分配与内存拷贝。
        #[inline]
        pub fn estimate_unified_capacity(
            old_label: &str,
            new_label: &str,
            result: &DiffResult,
        ) -> (usize, usize) {
            if result.hunks.is_empty() {
                return (0, 0);
            }
            // "--- a/{old_label}\n+++ b/{new_label}\n" -> 14 字节固定前缀/换行 + 标签长度
            let mut total_lines = 2_usize;
            let mut total_bytes = 14_usize + old_label.len() + new_label.len();

            for hunk in &result.hunks {
                total_lines += 1 + hunk.lines.len();
                total_bytes += HUNK_HEADER_ESTIMATED_BYTES;
                for line in &hunk.lines {
                    // 1 字节行标记（' ' / '+' / '-'）+ 内容长度 + 1 字节 '\n'
                    total_bytes += line.content.len() + 2;
                }
            }

            (total_lines, total_bytes)
        }

        /// KD-05：基于容量预分配将 `DiffResult` 渲染为标准 Unified Diff 文本（零动态扩容拷贝，零逐行临时 `format!` 分配）。
        pub fn format_unified(old_label: &str, new_label: &str, result: &DiffResult) -> String {
            let (_, estimated_bytes) =
                Self::estimate_unified_capacity(old_label, new_label, result);
            if estimated_bytes == 0 {
                return String::new();
            }

            let mut out = String::with_capacity(estimated_bytes);
            out.push_str("--- a/");
            out.push_str(old_label);
            out.push_str("\n+++ b/");
            out.push_str(new_label);
            out.push('\n');

            for hunk in &result.hunks {
                // 写入 String 不可能失败：直接 push_str，不用可丢弃的 write! 结果
                out.push_str(&format!(
                    "@@ -{},{} +{},{} @@
",
                    hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
                ));
                for line in &hunk.lines {
                    let prefix = match line.kind {
                        DiffLineKind::Context => ' ',
                        DiffLineKind::Addition => '+',
                        DiffLineKind::Deletion => '-',
                    };
                    out.push(prefix);
                    out.push_str(&line.content);
                    out.push('\n');
                }
            }

            out
        }

        /// KD-05：预分配生成带行标记前缀（`@@ ... @@`、`+`、`-`、` `）的 Diff 视图行列表。
        pub fn format_unified_lines(result: &DiffResult) -> Vec<String> {
            if result.hunks.is_empty() {
                return Vec::new();
            }
            let total_view_lines: usize =
                result.hunks.iter().map(|h| 1 + h.lines.len()).sum();
            let mut out = Vec::with_capacity(total_view_lines);

            for hunk in &result.hunks {
                let mut header = String::with_capacity(HUNK_HEADER_ESTIMATED_BYTES);
                header.push_str(&format!(
                    "@@ -{},{} +{},{} @@",
                    hunk.old_start, hunk.old_lines, hunk.new_start, hunk.new_lines
                ));
                out.push(header);

                for line in &hunk.lines {
                    let prefix = match line.kind {
                        DiffLineKind::Context => ' ',
                        DiffLineKind::Addition => '+',
                        DiffLineKind::Deletion => '-',
                    };
                    let mut formatted = String::with_capacity(1 + line.content.len());
                    formatted.push(prefix);
                    formatted.push_str(&line.content);
                    out.push(formatted);
                }
            }

            out
        }
    }

    impl Default for DiffEngine {
        fn default() -> Self {
            Self::new()
        }
    }

    /// KD-05：快速相等性预检（指针短路 + 长度短路 + 大文本首/中/尾 64B 采样短路）。
    #[inline]
    fn fast_equal_check(old_text: &str, new_text: &str) -> bool {
        if old_text.len() != new_text.len() {
            return false;
        }
        if std::ptr::eq(old_text.as_ptr(), new_text.as_ptr()) || old_text.is_empty() {
            return true;
        }
        let len = old_text.len();
        let old_bytes = old_text.as_bytes();
        let new_bytes = new_text.as_bytes();

        if len >= FAST_SAMPLE_THRESHOLD_BYTES {
            let w = FAST_SAMPLE_WINDOW_BYTES;
            // 首部、尾部、中段 64B 快速比对，不等则直接 O(1) 短路进入 Diff，避免全量 memcmp 冲刷缓存
            if old_bytes[..w] != new_bytes[..w]
                || old_bytes[len - w..] != new_bytes[len - w..]
                || old_bytes[len / 2..len / 2 + w] != new_bytes[len / 2..len / 2 + w]
            {
                return false;
            }
        }

        old_bytes == new_bytes
    }

    /// KD-05：根据换行符计数预估文本行数
    #[inline]
    fn estimate_line_count(text: &str, newline_count: usize) -> usize {
        if text.is_empty() {
            0
        } else {
            newline_count + usize::from(!text.as_bytes().ends_with(b"\n"))
        }
    }

    /// KD-05：根据新旧文本行数预估 `changes` 向量容量
    #[inline]
    fn estimated_changes_capacity(old_lines: usize, new_lines: usize) -> usize {
        old_lines.max(new_lines) + old_lines.abs_diff(new_lines)
    }

    /// Build hunk groups from a flat list of changes, including context lines around modifications.
    fn build_hunks(
        changes: &[(ChangeTag, Option<usize>, Option<usize>, &str)],
        mod_indices: &[usize],
        context: usize,
    ) -> Vec<DiffHunk> {
        if changes.is_empty() || mod_indices.is_empty() {
            return vec![];
        }

        // Group modifications that are within 2*context of each other (KD-05 preallocated)
        let mut groups: Vec<(usize, usize)> = Vec::with_capacity(mod_indices.len().clamp(1, 64));
        let mut group_start = 0;

        for i in 1..mod_indices.len() {
            let gap = mod_indices[i] - mod_indices[i - 1];
            if gap > 2 * context {
                groups.push((group_start, i - 1));
                group_start = i;
            }
        }
        groups.push((group_start, mod_indices.len() - 1));

        // Build hunks from groups using a single-pass monotonic cursor (KD-02, KD-05)
        let mut hunks = Vec::with_capacity(groups.len());
        let mut scan_cursor: usize = 0;
        let mut prev_old: usize = 0;
        let mut prev_new: usize = 0;

        for (g_start, g_end) in groups {
            let first_mod = mod_indices[g_start];
            let last_mod = mod_indices[g_end];

            let hunk_start = first_mod.saturating_sub(context);
            let hunk_end = (last_mod + context + 1).min(changes.len());

            // Advance monotonic cursor to hunk_start in O(1) amortized time per change
            while scan_cursor < hunk_start {
                if let Some(o) = changes[scan_cursor].1 {
                    prev_old = o + 1;
                }
                if let Some(n) = changes[scan_cursor].2 {
                    prev_new = n + 1;
                }
                scan_cursor += 1;
            }

            let mut lines = Vec::with_capacity(hunk_end - hunk_start);
            let mut old_start = None;
            let mut new_start = None;
            let mut old_count: usize = 0;
            let mut new_count: usize = 0;

            for &(tag, old_idx, new_idx, content) in &changes[hunk_start..hunk_end] {
                if old_start.is_none() {
                    if let Some(idx) = old_idx {
                        old_start = Some(idx + 1); // 1-based
                    }
                }
                if new_start.is_none() {
                    if let Some(idx) = new_idx {
                        new_start = Some(idx + 1);
                    }
                }

                let kind = match tag {
                    ChangeTag::Equal => {
                        old_count += 1;
                        new_count += 1;
                        DiffLineKind::Context
                    }
                    ChangeTag::Insert => {
                        new_count += 1;
                        DiffLineKind::Addition
                    }
                    ChangeTag::Delete => {
                        old_count += 1;
                        DiffLineKind::Deletion
                    }
                };

                let mut owned_content = String::with_capacity(content.len());
                owned_content.push_str(content);
                lines.push(DiffLine {
                    kind,
                    content: owned_content,
                });
            }

            let final_old_start = old_start.unwrap_or(
                if old_count == 0 {
                    prev_old
                } else {
                    prev_old + 1
                }
                .max(1),
            );
            let final_new_start = new_start.unwrap_or(
                if new_count == 0 {
                    prev_new
                } else {
                    prev_new + 1
                }
                .max(1),
            );

            if !lines.is_empty() {
                hunks.push(DiffHunk {
                    old_start: final_old_start,
                    old_lines: old_count,
                    new_start: final_new_start,
                    new_lines: new_count,
                    lines,
                });
            }
        }

        hunks
    }
}

#[cfg(test)]
mod tests {
    use super::diff_engine::DiffEngine;
    use conex_types::DiffLineKind;

    #[test]
    fn identical_texts_produce_empty_diff() {
        let result = DiffEngine::diff("hello\nworld\n", "hello\nworld\n");
        assert_eq!(result.hunks.len(), 0);
        assert_eq!(result.added_lines, 0);
        assert_eq!(result.removed_lines, 0);
    }

    #[test]
    fn empty_to_content() {
        let result = DiffEngine::diff("", "line1\nline2\n");
        assert_eq!(result.added_lines, 2);
        assert_eq!(result.removed_lines, 0);
        assert!(!result.hunks.is_empty());
        let all_additions = result.hunks[0]
            .lines
            .iter()
            .filter(|l| l.kind == DiffLineKind::Addition)
            .count();
        assert_eq!(all_additions, 2);
    }

    #[test]
    fn content_to_empty() {
        let result = DiffEngine::diff("line1\nline2\n", "");
        assert_eq!(result.added_lines, 0);
        assert_eq!(result.removed_lines, 2);
        assert!(!result.hunks.is_empty());
        let all_deletions = result.hunks[0]
            .lines
            .iter()
            .filter(|l| l.kind == DiffLineKind::Deletion)
            .count();
        assert_eq!(all_deletions, 2);
    }

    #[test]
    fn single_line_modification() {
        let old = "aaa\nbbb\nccc\n";
        let new = "aaa\nxxx\nccc\n";
        let result = DiffEngine::diff(old, new);
        assert_eq!(result.added_lines, 1);
        assert_eq!(result.removed_lines, 1);

        // Should have context lines around the change
        let hunk = &result.hunks[0];
        let contexts = hunk
            .lines
            .iter()
            .filter(|l| l.kind == DiffLineKind::Context)
            .count();
        assert!(contexts >= 2); // at least "aaa" and "ccc" as context
    }

    #[test]
    fn mixed_changes() {
        let old = "line1\nline2\nline3\nline4\nline5\n";
        let new = "line1\nnew2\nline3\nnew4\nextra\nline5\n";
        let result = DiffEngine::diff(old, new);
        assert!(result.added_lines >= 2);
        assert!(result.removed_lines >= 1);
        assert!(!result.hunks.is_empty());
    }

    #[test]
    fn distant_changes_produce_multiple_hunks() {
        // Create content with changes far apart (> 2*3 = 6 lines of context between them)
        let old_lines: Vec<String> = (1..=20).map(|i| format!("line{i}")).collect();
        let mut new_lines = old_lines.clone();
        new_lines[1] = "changed2".into(); // line 2 changed
        new_lines[18] = "changed19".into(); // line 19 changed

        let old = old_lines.join("\n") + "\n";
        let new = new_lines.join("\n") + "\n";
        let result = DiffEngine::diff(&old, &new);

        // Should produce 2 separate hunks since changes are far apart
        assert_eq!(result.hunks.len(), 2);
    }

    #[test]
    fn compute_diff_delegates_to_diff() {
        let engine = DiffEngine::new();
        let r1 = DiffEngine::diff("a\n", "b\n");
        let r2 = engine.compute_diff("a\n", "b\n");
        assert_eq!(r1, r2);
    }

    #[test]
    fn serializes_to_expected_json_shape() {
        let result = DiffEngine::diff("old\n", "new\n");
        let json = serde_json::to_value(&result).unwrap();
        assert!(json["hunks"].is_array());
        assert!(json["addedLines"].is_number());
        assert!(json["removedLines"].is_number());
        if let Some(hunk) = json["hunks"].get(0) {
            assert!(hunk["oldStart"].is_number());
            assert!(hunk["oldLines"].is_number());
            assert!(hunk["newStart"].is_number());
            assert!(hunk["newLines"].is_number());
            assert!(hunk["lines"].is_array());
        }
    }

    #[test]
    fn crlf_lines_strip_carriage_return() {
        let old = "alpha\r\nbeta\r\ngamma\r\n";
        let new = "alpha\r\nbeta_modified\r\ngamma\r\n";
        let result = DiffEngine::diff(old, new);
        assert_eq!(result.added_lines, 1);
        assert_eq!(result.removed_lines, 1);
        assert_eq!(result.hunks.len(), 1);
        for line in &result.hunks[0].lines {
            assert!(
                !line.content.ends_with('\r'),
                "Line content should not contain trailing CR: {:?}",
                line.content
            );
        }
    }

    #[test]
    fn large_file_budget_patience_diff_completes_without_hang() {
        // KD-03: 生成超过 20,000 行的大文本，验证自适应切换至 Patience Diff 并在预算内瞬间完成
        let n = 22_000;
        let mut old_lines = Vec::with_capacity(n);
        let mut new_lines = Vec::with_capacity(n);
        for i in 0..n {
            old_lines.push(format!("constant_line_{i}"));
            if i == 100 || i == 20_000 {
                new_lines.push(format!("modified_line_{i}"));
            } else {
                new_lines.push(format!("constant_line_{i}"));
            }
        }
        let old_text = old_lines.join("\n") + "\n";
        let new_text = new_lines.join("\n") + "\n";

        let start = std::time::Instant::now();
        let result = DiffEngine::diff(&old_text, &new_text);
        let elapsed = start.elapsed();

        assert_eq!(result.added_lines, 2);
        assert_eq!(result.removed_lines, 2);
        assert_eq!(result.hunks.len(), 2);
        assert!(
            elapsed.as_secs_f64() < 5.0,
            "Diff computation exceeded safe budget: {:?}",
            elapsed
        );
    }

    #[test]
    fn kd05_unified_diff_capacity_preallocation_and_view_line_markers() {
        let old = "line1\nline2\nline3\nline4\n";
        let new = "line1\nline2_mod\nline3\nline4\nline5_added\n";
        let result = DiffEngine::diff(old, new);

        let (est_lines, est_bytes) =
            DiffEngine::estimate_unified_capacity("src/a.rs", "src/a.rs", &result);
        assert!(est_lines > 0);
        assert!(est_bytes > 0);

        let unified = DiffEngine::format_unified("src/a.rs", "src/a.rs", &result);
        assert!(
            unified.len() <= est_bytes,
            "Actual unified diff bytes ({}) must fit within preallocated capacity ({est_bytes})",
            unified.len()
        );
        assert_eq!(unified.lines().count(), est_lines);
        assert!(unified.starts_with("--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,4 +1,5 @@\n"));
        assert!(unified.contains("-line2\n+line2_mod\n"));
        assert!(unified.contains("+line5_added\n"));

        let view_lines = DiffEngine::format_unified_lines(&result);
        assert_eq!(view_lines.len(), est_lines - 2);
        assert_eq!(view_lines[0], "@@ -1,4 +1,5 @@");
        assert!(view_lines.iter().any(|l| l == "-line2"));
        assert!(view_lines.iter().any(|l| l == "+line2_mod"));
        assert!(view_lines.iter().any(|l| l == " line3"));

        // 空 Diff 不分配冗余内存
        let empty = DiffEngine::diff("same\n", "same\n");
        assert_eq!(DiffEngine::estimate_unified_capacity("a", "b", &empty), (0, 0));
        assert!(DiffEngine::format_unified("a", "b", &empty).is_empty());
        assert!(DiffEngine::format_unified_lines(&empty).is_empty());
    }

    #[test]
    fn kd05_fast_equal_precheck_large_same_length_texts() {
        // 构造大于 4096B 的等长文本，验证同指针、全同、首/中/尾单字节差异均准确判定
        let base_lines: Vec<String> = (0..300)
            .map(|i| format!("large_sample_line_{i:04}_padding_payload"))
            .collect();
        let old_text = base_lines.join("\n") + "\n";
        assert!(old_text.len() > 8192);

        // 同引用指针 O(1) 短路
        let r_ptr = DiffEngine::diff(&old_text, &old_text);
        assert!(r_ptr.hunks.is_empty());

        // 独立分配但内容完全相同
        let cloned = old_text.clone();
        let r_eq = DiffEngine::diff(&old_text, &cloned);
        assert!(r_eq.hunks.is_empty());

        // 等长但仅在末尾行有 1 个字符差异（测试尾部 64B 采样短路进入 Diff）
        let mut tail_diff = base_lines.clone();
        tail_diff[299] = "large_sample_line_0299_padding_payloaX".to_string();
        let new_tail = tail_diff.join("\n") + "\n";
        assert_eq!(old_text.len(), new_tail.len());
        let r_tail = DiffEngine::diff(&old_text, &new_tail);
        assert_eq!(r_tail.added_lines, 1);
        assert_eq!(r_tail.removed_lines, 1);
        assert_eq!(r_tail.hunks.len(), 1);
    }
}
