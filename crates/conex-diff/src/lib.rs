pub mod diff_engine {
    use conex_types::{DiffHunk, DiffLine, DiffLineKind, DiffResult};
    use similar::{ChangeTag, TextDiff};

    const CONTEXT_LINES: usize = 3;

    pub struct DiffEngine;

    impl DiffEngine {
        pub fn new() -> Self {
            Self
        }

        /// Compute a unified diff between old_text and new_text, returning hunk-structured output.
        pub fn diff(old_text: &str, new_text: &str) -> DiffResult {
            if (std::ptr::eq(old_text.as_ptr(), new_text.as_ptr())
                && old_text.len() == new_text.len())
                || old_text == new_text
            {
                return DiffResult {
                    hunks: vec![],
                    added_lines: 0,
                    removed_lines: 0,
                };
            }

            let diff = TextDiff::from_lines(old_text, new_text);
            let mut added_lines: usize = 0;
            let mut removed_lines: usize = 0;

            // Collect changes with zero-copy line slices and CRLF/LF normalization (KD-01, KD-04)
            let mut changes: Vec<(ChangeTag, Option<usize>, Option<usize>, &str)> = Vec::new();
            for change in diff.iter_all_changes() {
                let tag = change.tag();
                let old_idx = change.old_index();
                let new_idx = change.new_index();
                let content = change.value().trim_end_matches(['\r', '\n']);

                match tag {
                    ChangeTag::Equal => {}
                    ChangeTag::Insert => added_lines += 1,
                    ChangeTag::Delete => removed_lines += 1,
                }
                changes.push((tag, old_idx, new_idx, content));
            }

            // Group changes into hunks with context
            let hunks = build_hunks(&changes, CONTEXT_LINES);

            DiffResult {
                hunks,
                added_lines,
                removed_lines,
            }
        }

        pub fn compute_diff(&self, old_text: &str, new_text: &str) -> DiffResult {
            Self::diff(old_text, new_text)
        }
    }

    impl Default for DiffEngine {
        fn default() -> Self {
            Self::new()
        }
    }

    /// Build hunk groups from a flat list of changes, including context lines around modifications.
    fn build_hunks(
        changes: &[(ChangeTag, Option<usize>, Option<usize>, &str)],
        context: usize,
    ) -> Vec<DiffHunk> {
        if changes.is_empty() {
            return vec![];
        }

        // Find indices of non-equal changes
        let mod_indices: Vec<usize> = changes
            .iter()
            .enumerate()
            .filter(|(_, (tag, _, _, _))| *tag != ChangeTag::Equal)
            .map(|(i, _)| i)
            .collect();

        if mod_indices.is_empty() {
            return vec![];
        }

        // Group modifications that are within 2*context of each other
        let mut groups: Vec<(usize, usize)> = Vec::new(); // (start_mod_idx, end_mod_idx) in mod_indices
        let mut group_start = 0;

        for i in 1..mod_indices.len() {
            let gap = mod_indices[i] - mod_indices[i - 1];
            if gap > 2 * context {
                groups.push((group_start, i - 1));
                group_start = i;
            }
        }
        groups.push((group_start, mod_indices.len() - 1));

        // Build hunks from groups using a single-pass monotonic cursor (KD-02)
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

                lines.push(DiffLine {
                    kind,
                    content: content.to_string(),
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
}
