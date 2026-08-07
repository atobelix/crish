pub mod fuzzy {
    /// Fuzzy matcher using subsequence scoring with bonuses for consecutive matches,
    /// word boundaries, and case-exact matches.
    pub struct FuzzyMatcher {
        case_sensitive: bool,
    }

    impl FuzzyMatcher {
        pub fn new(case_sensitive: bool) -> Self {
            Self { case_sensitive }
        }

        /// Score a query against a target string.
        /// Returns (score, match_indices). Score 0 means no match.
        pub fn score_and_indices(&self, query: &str, target: &str) -> (i32, Vec<usize>) {
            if query.is_empty() {
                return (0, vec![]);
            }

            // Pre-collect chars to avoid O(n) nth() calls in the loop
            let orig_q: Vec<char> = query.chars().collect();
            let orig_t: Vec<char> = target.chars().collect();

            // 折叠 case 时逐字符构建「折叠后位置 → 原始位置」映射（F3-03 根因修复）：
            // to_lowercase 可将单个字符展开为多个（如 İ(U+0130) → i + U+0307），使折叠
            // 后的 Vec 比原始 Vec 更长；若用折叠索引直接回查原始 Vec（旧实现 :68）会越界
            // panic。匹配索引与 case-exact bonus 均须经该映射对齐回原始坐标，而不是用
            // 下标截断掩盖（clamp 会丢失坐标语义）。
            let fold_with_map = |orig: &[char]| -> (Vec<char>, Vec<usize>) {
                let mut folded = Vec::with_capacity(orig.len());
                let mut to_orig = Vec::with_capacity(orig.len());
                for (i, &c) in orig.iter().enumerate() {
                    for fc in c.to_lowercase() {
                        folded.push(fc);
                        to_orig.push(i);
                    }
                }
                (folded, to_orig)
            };

            let identity_map = |len: usize| (0..len).collect::<Vec<usize>>();

            let (q, q_to_orig) = if self.case_sensitive {
                (orig_q.clone(), identity_map(orig_q.len()))
            } else {
                fold_with_map(&orig_q)
            };
            let (t, t_to_orig) = if self.case_sensitive {
                (orig_t.clone(), identity_map(orig_t.len()))
            } else {
                fold_with_map(&orig_t)
            };

            if q.len() > t.len() {
                return (0, vec![]);
            }

            // Greedy subsequence match with scoring
            let mut score: i32 = 0;
            let mut match_indices: Vec<usize> = Vec::with_capacity(q.len());
            let mut qi = 0;
            let mut consecutive: i32 = 0;

            for (ti, &tc) in t.iter().enumerate() {
                if qi >= q.len() {
                    break;
                }
                if tc == q[qi] {
                    // 记录原始坐标（多字符展开的多个折叠字符可映射到同一原始索引，
                    // 坐标不越界且单调不减）
                    match_indices.push(t_to_orig[ti]);
                    qi += 1;
                    consecutive += 1;

                    // Base score per character
                    score += 1;

                    // Consecutive bonus (grows with streak, capped at 5)
                    if consecutive > 1 {
                        score += consecutive.min(5);
                    }

                    // Word boundary bonus: start of string, after separator
                    if ti == 0 || is_separator(t[ti - 1]) {
                        score += 3;
                    }

                    // Case-exact bonus: 两侧均经折叠映射对齐回原始坐标，折叠展开
                    // （查询或目标任一侧）都不会越界
                    if !self.case_sensitive && orig_t[t_to_orig[ti]] == orig_q[q_to_orig[qi - 1]] {
                        score += 1;
                    }
                } else {
                    consecutive = 0;
                }
            }

            // All query characters must be found
            if qi < q.len() {
                return (0, vec![]);
            }

            // Length proximity bonus: shorter targets score higher
            let len_diff = t.len() as i32 - q.len() as i32;
            if len_diff < 10 {
                score += 10 - len_diff;
            }

            (score, match_indices)
        }

        /// Simple score-only interface (backward compatible).
        pub fn score(&self, query: &str, target: &str) -> i32 {
            self.score_and_indices(query, target).0
        }
    }

    fn is_separator(c: char) -> bool {
        matches!(c, '/' | '\\' | '.' | '-' | '_' | ' ')
    }
}

pub mod search {
    use super::fuzzy::FuzzyMatcher;
    use conex_types::FileHit;

    /// Search paths using fuzzy matching, returning top-N hits sorted by score.
    pub fn search_files(query: &str, paths: &[String], limit: usize, matcher: &FuzzyMatcher) -> Vec<FileHit> {
        if query.is_empty() || paths.is_empty() || limit == 0 {
            return vec![];
        }

        let mut hits: Vec<FileHit> = paths
            .iter()
            .filter_map(|path| {
                // Match against filename (last component) for better relevance
                let filename = path.rsplit(['/', '\\']).next().unwrap_or(path);
                let (score, indices) = matcher.score_and_indices(query, filename);
                if score > 0 {
                    Some(FileHit {
                        path: path.clone(),
                        score,
                        match_indices: indices,
                    })
                } else {
                    // Fallback: try matching against full path
                    let (path_score, path_indices) = matcher.score_and_indices(query, path);
                    if path_score > 0 {
                        Some(FileHit {
                            path: path.clone(),
                            score: path_score / 2, // penalize full-path matches
                            match_indices: path_indices,
                        })
                    } else {
                        None
                    }
                }
            })
            .collect();

        hits.sort_by(|a, b| b.score.cmp(&a.score));
        hits.truncate(limit);
        hits
    }

    /// Parallel version: splits paths into chunks and searches concurrently using thread::scope.
    pub fn search_files_parallel(query: &str, paths: &[String], limit: usize, matcher: &FuzzyMatcher) -> Vec<FileHit> {
        if query.is_empty() || paths.is_empty() || limit == 0 {
            return vec![];
        }

        let thread_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8);

        let chunk_size = paths.len().div_ceil(thread_count);

        // Use thread::scope to avoid cloning paths into each thread
        let all_hits: Vec<FileHit> = std::thread::scope(|s| {
            let handles: Vec<_> = paths
                .chunks(chunk_size)
                .map(|chunk| {
                    s.spawn(move || search_files(query, chunk, limit, matcher))
                })
                .collect();

            handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .flatten()
                .collect()
        });

        let mut sorted = all_hits;
        sorted.sort_by(|a, b| b.score.cmp(&a.score));
        sorted.truncate(limit);
        sorted
    }
}

pub mod walker {
    use ignore::WalkBuilder;

    const SKIP_DIRS: &[&str] = &[".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "target"];

    /// Build a directory index of file paths, respecting .gitignore and skipping common non-source dirs.
    pub fn build_directory_index(dir: &str) -> Vec<String> {
        let mut files = Vec::new();

        let walker = WalkBuilder::new(dir)
            .hidden(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .max_depth(Some(12))
            .build();

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };

            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                continue;
            }

            let path = entry.path();

            // Skip known non-source directories
            let should_skip = path.components().any(|comp| {
                comp.as_os_str()
                    .to_str()
                    .map(|s| SKIP_DIRS.contains(&s))
                    .unwrap_or(false)
            });
            if should_skip {
                continue;
            }

            if let Some(path_str) = path.to_str() {
                files.push(path_str.to_string());
            }
        }

        files.sort();
        files
    }
}

#[cfg(test)]
mod tests {
    use super::fuzzy::FuzzyMatcher;
    use super::search::{search_files, search_files_parallel};
    use super::walker::build_directory_index;

    #[test]
    fn exact_match_scores_high() {
        let matcher = FuzzyMatcher::new(false);
        let (score, indices) = matcher.score_and_indices("main", "main.rs");
        assert!(score > 0);
        assert_eq!(indices, vec![0, 1, 2, 3]);
    }

    #[test]
    fn subsequence_match_works() {
        let matcher = FuzzyMatcher::new(false);
        let (score, indices) = matcher.score_and_indices("mrs", "main.rs");
        assert!(score > 0);
        assert_eq!(indices.len(), 3);
    }

    #[test]
    fn no_match_returns_zero() {
        let matcher = FuzzyMatcher::new(false);
        let (score, indices) = matcher.score_and_indices("xyz", "main.rs");
        assert_eq!(score, 0);
        assert!(indices.is_empty());
    }

    #[test]
    fn empty_query_returns_zero() {
        let matcher = FuzzyMatcher::new(false);
        let (score, _) = matcher.score_and_indices("", "anything");
        assert_eq!(score, 0);
    }

    #[test]
    fn case_insensitive_by_default() {
        let matcher = FuzzyMatcher::new(false);
        let (score, _) = matcher.score_and_indices("MAIN", "main.rs");
        assert!(score > 0);
    }

    #[test]
    fn case_sensitive_mode() {
        let matcher = FuzzyMatcher::new(true);
        let (score, _) = matcher.score_and_indices("MAIN", "main.rs");
        assert_eq!(score, 0); // uppercase won't match lowercase
    }

    #[test]
    fn unicode_fold_expansion_target_does_not_panic() {
        // F3-03（红）：查询串命中折叠展开产物（i + U+0307），目标 `xİ` 小写折叠后
        // 变长（İ → i + U+0307），旧实现 lib.rs:68 用折叠索引回查原始 Vec 越界 panic。
        let matcher = FuzzyMatcher::new(false);
        let (score, indices) = matcher.score_and_indices("i\u{307}", "xİ");
        assert!(score > 0);
        // 两个折叠字符均来自原始索引 1（'İ'），坐标回退到原始串
        assert_eq!(indices, vec![1, 1]);
    }

    #[test]
    fn unicode_fold_expansion_query_does_not_panic() {
        // F3-03（红）同根因的查询侧形态：查询 `İ` 折叠为两字符后，
        // 旧实现 :68 `orig_q[qi - 1]` 匹配展开第二字符时越界 panic。
        let matcher = FuzzyMatcher::new(false);
        let (score, indices) = matcher.score_and_indices("İ", "xİ");
        assert!(score > 0);
        assert_eq!(indices, vec![1, 1]);
    }

    #[test]
    fn sharp_s_fold_matches_lowercase() {
        // F3-03 相关回归：实测 Rust 中 ẞ(U+1E9E) 小写折叠为单字符 ß（不展开，
        // 与审计推演的 "ss" 不符——R1 只实测过 İ 形态），折叠路径应正常匹配。
        let matcher = FuzzyMatcher::new(false);
        let (score, indices) = matcher.score_and_indices("ß", "xẞ");
        assert!(score > 0);
        assert_eq!(indices, vec![1]);
    }

    #[test]
    fn search_files_unicode_fold_no_panic() {
        // F3-03（红）集成形态：索引内容含 İ 等展开字符 + 折叠查询，
        // 文件名恰为 "İ" 时折叠索引越过原始长度 → 旧实现 search_files 内 panic。
        let matcher = FuzzyMatcher::new(false);
        let paths = vec!["dir/İ".to_string(), "dir/İstanbul.rs".to_string()];
        let hits = search_files("i\u{307}", &paths, 10, &matcher);
        assert_eq!(hits.len(), 2);
        // match_indices 必须是原始文件名坐标，不得越界
        for hit in &hits {
            let filename_len = hit.path.rsplit(['/', '\\']).next().unwrap().chars().count();
            assert!(hit.match_indices.iter().all(|&i| i < filename_len), "越界坐标: {hit:?}");
            assert!(hit.score > 0);
        }
    }

    #[test]
    fn word_boundary_bonus() {
        let matcher = FuzzyMatcher::new(false);
        // "sr" matches "src" at word start vs "descriptor" mid-word
        let (score_start, _) = matcher.score_and_indices("sr", "src/main.rs");
        let (score_mid, _) = matcher.score_and_indices("sr", "descriptor.rs");
        // Both should match, but word-start should score higher
        assert!(score_start > 0);
        if score_mid > 0 {
            assert!(score_start >= score_mid);
        }
    }

    #[test]
    fn search_files_returns_sorted_by_score() {
        let matcher = FuzzyMatcher::new(false);
        let paths = vec![
            "src/main.rs".to_string(),
            "src/lib.rs".to_string(),
            "src/components/MainPanel.tsx".to_string(),
            "README.md".to_string(),
        ];
        let hits = search_files("main", &paths, 10, &matcher);
        assert!(!hits.is_empty());
        // First hit should have highest score
        for window in hits.windows(2) {
            assert!(window[0].score >= window[1].score);
        }
    }

    #[test]
    fn search_files_respects_limit() {
        let matcher = FuzzyMatcher::new(false);
        let paths: Vec<String> = (0..100).map(|i| format!("file{i}.ts")).collect();
        let hits = search_files("file", &paths, 5, &matcher);
        assert!(hits.len() <= 5);
    }

    #[test]
    fn search_files_empty_inputs() {
        let matcher = FuzzyMatcher::new(false);
        assert!(search_files("", &["a.ts".into()], 10, &matcher).is_empty());
        assert!(search_files("test", &[], 10, &matcher).is_empty());
        assert!(search_files("test", &["a.ts".into()], 0, &matcher).is_empty());
    }

    #[test]
    fn parallel_search_matches_sequential() {
        let matcher = FuzzyMatcher::new(false);
        let paths: Vec<String> = (0..200).map(|i| format!("module_{i}/component_{i}.tsx")).collect();
        let sequential = search_files("comp", &paths, 10, &matcher);
        let parallel = search_files_parallel("comp", &paths, 10, &matcher);
        // Both should find results
        assert!(!sequential.is_empty());
        assert!(!parallel.is_empty());
        // Top scores should be similar
        assert_eq!(sequential[0].score, parallel[0].score);
    }

    #[test]
    fn build_directory_index_on_nonexistent_dir() {
        let files = build_directory_index("/nonexistent/path/that/does/not/exist");
        assert!(files.is_empty());
    }

    #[test]
    fn build_directory_index_on_crate_dir() {
        // Use the conex-search crate itself as test target
        let files = build_directory_index(env!("CARGO_MANIFEST_DIR"));
        assert!(!files.is_empty());
        // Should contain Cargo.toml
        assert!(files.iter().any(|f| f.ends_with("Cargo.toml")));
        // Should contain src/lib.rs
        assert!(files.iter().any(|f| f.ends_with("src/lib.rs") || f.ends_with("src\\lib.rs")));
    }
}
