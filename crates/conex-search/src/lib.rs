pub mod fuzzy {
    /// Pre-compiled query representation avoiding repeated char collection and Unicode
    /// lowercase folding across candidate evaluations (KS-02).
    #[derive(Debug, Clone)]
    pub struct PreparedQuery {
        orig_q: Vec<char>,
        q: Vec<char>,
        q_to_orig: Vec<usize>,
    }

    impl PreparedQuery {
        #[inline]
        pub fn is_empty(&self) -> bool {
            self.q.is_empty()
        }
    }

    /// Fuzzy matcher using subsequence scoring with bonuses for consecutive matches,
    /// word boundaries, and case-exact matches.
    pub struct FuzzyMatcher {
        case_sensitive: bool,
    }

    impl FuzzyMatcher {
        pub fn new(case_sensitive: bool) -> Self {
            Self { case_sensitive }
        }

        /// Pre-compile a query string once before scanning candidate paths (KS-02).
        pub fn prepare_query(&self, query: &str) -> PreparedQuery {
            let orig_q: Vec<char> = query.chars().collect();
            let (q, q_to_orig) = if self.case_sensitive {
                let to_orig = (0..orig_q.len()).collect();
                (orig_q.clone(), to_orig)
            } else {
                fold_with_map(&orig_q)
            };
            PreparedQuery {
                orig_q,
                q,
                q_to_orig,
            }
        }

        /// Score a pre-compiled query against a target string.
        /// Returns (score, match_indices). Score 0 means no match.
        pub fn score_and_indices_prepared(
            &self,
            prepared: &PreparedQuery,
            target: &str,
        ) -> (i32, Vec<usize>) {
            if prepared.is_empty() {
                return (0, vec![]);
            }

            let orig_t: Vec<char> = target.chars().collect();
            let (folded_t, folded_t_to_orig);
            let (t, t_to_orig): (&[char], Option<&[usize]>) = if self.case_sensitive {
                (&orig_t, None)
            } else {
                (folded_t, folded_t_to_orig) = fold_with_map(&orig_t);
                (&folded_t, Some(&folded_t_to_orig))
            };

            let q = &prepared.q;
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
                    let orig_ti = t_to_orig.map_or(ti, |m| m[ti]);
                    match_indices.push(orig_ti);
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
                    if !self.case_sensitive
                        && orig_t[orig_ti] == prepared.orig_q[prepared.q_to_orig[qi - 1]]
                    {
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

        /// Score a query against a target string.
        /// Returns (score, match_indices). Score 0 means no match.
        pub fn score_and_indices(&self, query: &str, target: &str) -> (i32, Vec<usize>) {
            if query.is_empty() {
                return (0, vec![]);
            }
            let prepared = self.prepare_query(query);
            self.score_and_indices_prepared(&prepared, target)
        }

        /// Simple score-only interface (backward compatible).
        pub fn score(&self, query: &str, target: &str) -> i32 {
            self.score_and_indices(query, target).0
        }
    }

    // 折叠 case 时逐字符构建「折叠后位置 → 原始位置」映射（F3-03 根因修复）：
    // to_lowercase 可将单个字符展开为多个（如 İ(U+0130) → i + U+0307），使折叠
    // 后的 Vec 比原始 Vec 更长；若用折叠索引直接回查原始 Vec（旧实现 :68）会越界
    // panic。匹配索引与 case-exact bonus 均须经该映射对齐回原始坐标，而不是用
    // 下标截断掩盖（clamp 会丢失坐标语义）。
    fn fold_with_map(orig: &[char]) -> (Vec<char>, Vec<usize>) {
        let mut folded = Vec::with_capacity(orig.len());
        let mut to_orig = Vec::with_capacity(orig.len());
        for (i, &c) in orig.iter().enumerate() {
            for fc in c.to_lowercase() {
                folded.push(fc);
                to_orig.push(i);
            }
        }
        (folded, to_orig)
    }

    fn is_separator(c: char) -> bool {
        matches!(c, '/' | '\\' | '.' | '-' | '_' | ' ')
    }
}

pub mod search {
    use super::fuzzy::{FuzzyMatcher, PreparedQuery};
    use conex_types::FileHit;
    use std::cmp::Ordering;
    use std::collections::BinaryHeap;

    #[derive(Debug)]
    struct TopKEntry {
        score: i32,
        hit: FileHit,
    }

    impl PartialEq for TopKEntry {
        fn eq(&self, other: &Self) -> bool {
            self.score == other.score
        }
    }

    impl Eq for TopKEntry {}

    impl Ord for TopKEntry {
        fn cmp(&self, other: &Self) -> Ordering {
            // Min-Heap: 反转 score 比较，使堆顶始终为 Top-K 中的最小得分
            other.score.cmp(&self.score)
        }
    }

    impl PartialOrd for TopKEntry {
        fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
            Some(self.cmp(other))
        }
    }

    pub(crate) fn search_files_with_prepared(
        prepared: &PreparedQuery,
        paths: &[String],
        limit: usize,
        matcher: &FuzzyMatcher,
    ) -> Vec<FileHit> {
        if prepared.is_empty() || paths.is_empty() || limit == 0 {
            return vec![];
        }

        // KS-01: 采用容量固定为 limit 的 Top-K 有界最小堆，
        // 避免对全量数十万候选文件进行全量克隆与全排序。未进入门槛的候选绝对不执行 path.clone()
        let mut heap: BinaryHeap<TopKEntry> = BinaryHeap::with_capacity(limit);

        for path in paths {
            let min_top_score = if heap.len() == limit {
                heap.peek().map(|top| top.score).unwrap_or(0)
            } else {
                0
            };

            // Match against filename (last component) for better relevance
            let filename = path.rsplit(['/', '\\']).next().unwrap_or(path);
            let (score, indices) = matcher.score_and_indices_prepared(prepared, filename);

            let (final_score, final_indices) = if score > 0 {
                (score, indices)
            } else {
                // Fallback: try matching against full path
                let (path_score, path_indices) = matcher.score_and_indices_prepared(prepared, path);
                let penalized = path_score / 2;
                if penalized > 0 {
                    (penalized, path_indices)
                } else {
                    continue;
                }
            };

            if final_score <= 0 {
                continue;
            }

            // 仅在当前得分能入围 Top-K 时才执行路径字符串克隆与入堆
            if heap.len() < limit {
                heap.push(TopKEntry {
                    score: final_score,
                    hit: FileHit {
                        path: path.clone(),
                        score: final_score,
                        match_indices: final_indices,
                    },
                });
            } else if final_score > min_top_score {
                heap.pop();
                heap.push(TopKEntry {
                    score: final_score,
                    hit: FileHit {
                        path: path.clone(),
                        score: final_score,
                        match_indices: final_indices,
                    },
                });
            }
        }

        let mut hits: Vec<FileHit> = heap.into_iter().map(|entry| entry.hit).collect();
        hits.sort_by_key(|a| std::cmp::Reverse(a.score));
        hits
    }

    /// Search paths using fuzzy matching, returning top-N hits sorted by score.
    pub fn search_files(
        query: &str,
        paths: &[String],
        limit: usize,
        matcher: &FuzzyMatcher,
    ) -> Vec<FileHit> {
        if query.is_empty() || paths.is_empty() || limit == 0 {
            return vec![];
        }

        // Pre-compile query once outside the candidate loop (KS-02)
        let prepared = matcher.prepare_query(query);
        search_files_with_prepared(&prepared, paths, limit, matcher)
    }

    /// Parallel version: splits paths into chunks and searches concurrently using thread::scope.
    pub fn search_files_parallel(
        query: &str,
        paths: &[String],
        limit: usize,
        matcher: &FuzzyMatcher,
    ) -> Vec<FileHit> {
        if query.is_empty() || paths.is_empty() || limit == 0 {
            return vec![];
        }

        // Pre-compile query once and share across all worker threads (KS-02)
        let prepared = matcher.prepare_query(query);
        let prepared_ref = &prepared;

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
                    s.spawn(move || search_files_with_prepared(prepared_ref, chunk, limit, matcher))
                })
                .collect();

            handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .flatten()
                .collect()
        });

        let mut sorted = all_hits;
        sorted.sort_by_key(|a| std::cmp::Reverse(a.score));
        sorted.truncate(limit);
        sorted
    }
}

pub mod walker {
    use ignore::WalkBuilder;
    use std::time::Instant;

    const SKIP_DIRS: &[&str] = &[
        ".git",
        "node_modules",
        "dist",
        "build",
        ".next",
        ".turbo",
        ".cache",
        "target",
    ];

    /// Build a directory index of file paths, respecting .gitignore and skipping common non-source dirs.
    pub fn build_directory_index(dir: &str) -> Vec<String> {
        build_directory_index_limited(dir, None, None).files
    }

    /// 受限遍历结果（RUN-04 预热护栏）。
    #[derive(Debug, Default)]
    pub struct WalkOutcome {
        /// 收集到的文件路径（未排序；调用方排序）。
        pub files: Vec<String>,
        /// 是否因达到 `max_files` 上限提前截断。
        pub truncated: bool,
        /// 是否因 `deadline` 超时提前停止。
        pub timed_out: bool,
        /// 条目级失败（路径, 错误信息）——不再静默吞掉（R-13）。
        pub entry_errors: Vec<(String, String)>,
    }

    /// 受限遍历：可选文件数上限 + 可选超时期限 + 条目级错误收集。
    ///
    /// 语义与 [`build_directory_index`] 一致（.gitignore / SKIP_DIRS /
    /// max_depth=12），额外提供预热护栏；`None` 时退化为既有无限遍历。
    pub fn build_directory_index_limited(
        dir: &str,
        max_files: Option<usize>,
        deadline: Option<Instant>,
    ) -> WalkOutcome {
        let mut outcome = WalkOutcome::default();

        // Prune ignored directories directly at entry level via filter_entry (KS-04)
        let walker = WalkBuilder::new(dir)
            .hidden(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .max_depth(Some(12))
            .filter_entry(|entry| {
                if entry.depth() > 0 && entry.file_type().is_some_and(|ft| ft.is_dir()) {
                    if let Some(name) = entry.file_name().to_str() {
                        if SKIP_DIRS.contains(&name) {
                            return false;
                        }
                    }
                }
                true
            })
            .build();

        for entry in walker {
            // 超时护栏：逐条目检查 deadline，超限提前停止
            if deadline.is_some_and(|dl| Instant::now() >= dl) {
                outcome.timed_out = true;
                break;
            }
            // 文件数护栏：达到上限即截断
            if max_files.is_some_and(|cap| outcome.files.len() >= cap) {
                outcome.truncated = true;
                break;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(err) => {
                    // 失败可观测：记录路径与错误信息，不再静默 continue
                    let path = walk_error_path(&err)
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    outcome.entry_errors.push((path, err.to_string()));
                    continue;
                }
            };

            if !entry.file_type().is_some_and(|ft| ft.is_file()) {
                continue;
            }

            if let Some(path_str) = entry.path().to_str() {
                outcome.files.push(path_str.to_string());
            }
        }

        outcome.files.sort();
        outcome
    }

    /// 从 `ignore::Error` 提取关联路径（该版本未提供 `path()` 方法；
    /// 无路径变体返回 `None`）。
    fn walk_error_path(err: &ignore::Error) -> Option<std::path::PathBuf> {
        match err {
            ignore::Error::WithPath { path, .. } => Some(path.clone()),
            ignore::Error::Loop { child, .. } => Some(child.clone()),
            ignore::Error::Partial(errs) => errs.iter().find_map(walk_error_path),
            _ => None,
        }
    }
}

pub mod warmup;

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
            assert!(
                hit.match_indices.iter().all(|&i| i < filename_len),
                "越界坐标: {hit:?}"
            );
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
        let paths: Vec<String> = (0..200)
            .map(|i| format!("module_{i}/component_{i}.tsx"))
            .collect();
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
        assert!(files
            .iter()
            .any(|f| f.ends_with("src/lib.rs") || f.ends_with("src\\lib.rs")));
    }

    #[test]
    #[allow(clippy::disallowed_methods)]
    fn build_directory_index_prunes_skip_dirs() {
        let dir =
            std::env::temp_dir().join(format!("conex_search_prune_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join("target/debug")).unwrap();
        std::fs::write(dir.join("src/index.ts"), "export {};").unwrap();
        std::fs::write(
            dir.join("node_modules/pkg/index.js"),
            "module.exports = {};",
        )
        .unwrap();
        std::fs::write(dir.join("target/debug/out.rlib"), "bin").unwrap();

        let files = build_directory_index(dir.to_str().unwrap());
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(files.len(), 1);
        assert!(files[0].ends_with("index.ts"));
    }

    #[test]
    fn search_files_top_k_large_candidate_set() {
        // KS-01: 50,000 个候选路径下的 Top-K 有界堆收集与排序测试
        let matcher = FuzzyMatcher::new(false);
        let paths: Vec<String> = (0..50_000)
            .map(|i| format!("src/components/item_{i}/file_{i}.rs"))
            .collect();
        let limit = 20;
        let hits = search_files("file_42", &paths, limit, &matcher);
        assert!(!hits.is_empty());
        assert!(hits.len() <= limit);
        for window in hits.windows(2) {
            assert!(window[0].score >= window[1].score);
        }
        assert!(hits[0].path.contains("file_42"));
    }
}
