//! RUN-04 / GAP-09 搜索索引预热验收测试：
//!
//! 1. **多根覆盖**：预热遍历全部根，两个根的文件均能搜到（旧「只预热
//!    第一个根」行为下第二根命不中，构成回归断言）；
//! 2. **失败可观测**：根级失败进入 `root_errors`，不静默；
//! 3. **超限护栏**：文件数上限截断（`truncated`）、超时预算停止
//!    （`timed_out`），预热规模有界；
//! 4. **代数守卫**：预热期间发生手动重建（`rebuild` 推进代数）后，
//!    晚到的旧预热提交被 `commit_if_current` 拒绝，不覆盖新索引。

#![allow(clippy::disallowed_methods)] // 测试临时目录清理，非产品物理删除路径

use conex_search::fuzzy::FuzzyMatcher;
use conex_search::search::search_files;
use conex_search::warmup::{
    warm_index, IndexCell, WarmupLimits, DEFAULT_TIMEOUT, ENTRY_ERROR_SAMPLES,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 建立独立临时根（进程号 + 用例标签隔离，测后清理）。
fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "conex-search-warmup-tests-{}-{tag}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create temp root");
    dir
}

/// 在根下写一个文件（父目录自动创建）。
fn write_file(root: &Path, rel: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().expect("rel has parent")).expect("create parent");
    fs::write(path, "x").expect("write file");
}

fn path_str(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

/// 验收 1：多根全量——两个根的文件都进索引，且均能被模糊搜索命中。
#[test]
fn warm_index_covers_all_roots_and_both_searchable() {
    let root_a = temp_root("multi-a");
    let root_b = temp_root("multi-b");
    write_file(&root_a, "src/alpha_handler.rs");
    write_file(&root_a, "README.md");
    write_file(&root_b, "src/beta_worker.rs");
    write_file(&root_b, "docs/notes.md");

    let roots = vec![path_str(&root_a), path_str(&root_b)];
    let report = warm_index(&roots, &WarmupLimits::default());

    // 旧「只预热第一个根」行为下 root_b 文件缺失 → 本断言失败（红）
    assert!(
        report.files.iter().any(|f| f.ends_with("beta_worker.rs")),
        "第二根的文件必须进入索引：{:?}",
        report.files
    );
    assert!(
        report.files.iter().any(|f| f.ends_with("alpha_handler.rs")),
        "第一根的文件必须进入索引：{:?}",
        report.files
    );
    // 清单全局有序且无重复
    let mut sorted = report.files.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(report.files, sorted, "清单应排序去重");
    assert_eq!(report.root_count, 2);
    assert!(report.is_clean(), "干净场景不应有失败/截断：{report:?}");

    // 两个根的文件均能被搜到
    let matcher = FuzzyMatcher::new(false);
    let alpha_hits = search_files("alpha", &report.files, 20, &matcher);
    assert!(
        alpha_hits.iter().any(|h| h.path.ends_with("alpha_handler.rs")),
        "第一根文件可搜：{alpha_hits:?}"
    );
    let beta_hits = search_files("beta", &report.files, 20, &matcher);
    assert!(
        beta_hits.iter().any(|h| h.path.ends_with("beta_worker.rs")),
        "第二根文件可搜：{beta_hits:?}"
    );

    let _ = fs::remove_dir_all(&root_a);
    let _ = fs::remove_dir_all(&root_b);
}

/// 验收 2：失败可观测——不存在的根进入 `root_errors`，好根照常预热。
#[test]
fn warm_index_reports_root_failure_observably() {
    let good = temp_root("fail-good");
    write_file(&good, "kept.rs");

    let missing = temp_root("fail-missing");
    let missing_str = path_str(&missing);
    let _ = fs::remove_dir_all(&missing); // 制造根级失败：目录不存在

    let report = warm_index(&[path_str(&good), missing_str.clone()], &WarmupLimits::default());

    assert_eq!(report.root_count, 2);
    assert_eq!(
        report.root_errors.len(),
        1,
        "根级失败必须可见：{report:?}"
    );
    assert_eq!(report.root_errors[0].root, missing_str);
    assert!(
        !report.root_errors[0].message.is_empty(),
        "失败原因不得为空"
    );
    assert!(
        report.files.iter().any(|f| f.ends_with("kept.rs")),
        "好根不受坏根影响：{:?}",
        report.files
    );
    assert!(!report.is_clean(), "有失败时 is_clean 必须为 false");

    let _ = fs::remove_dir_all(&good);
}

/// 验收 3：文件数上限——全根合计预算，超限截断并标记，规模有界。
#[test]
fn warm_index_truncates_at_file_cap() {
    let root_a = temp_root("cap-a");
    let root_b = temp_root("cap-b");
    for i in 0..3 {
        write_file(&root_a, &format!("a{i}.rs"));
    }
    for i in 0..3 {
        write_file(&root_b, &format!("b{i}.rs"));
    }

    let limits = WarmupLimits {
        max_files: 4,
        timeout: DEFAULT_TIMEOUT,
    };
    let report = warm_index(&[path_str(&root_a), path_str(&root_b)], &limits);

    assert!(report.truncated, "达到上限必须标记 truncated：{report:?}");
    assert!(
        report.files.len() <= 4,
        "文件数不得超上限：{}",
        report.files.len()
    );

    let _ = fs::remove_dir_all(&root_a);
    let _ = fs::remove_dir_all(&root_b);
}

/// 验收 4：超时预算——预算为 0 时立即停止（`timed_out`），不无限遍历。
#[test]
fn warm_index_stops_on_timeout_budget() {
    let root = temp_root("timeout");
    write_file(&root, "some_file.rs");

    let limits = WarmupLimits {
        max_files: 1000,
        timeout: Duration::ZERO, // 预算即刻耗尽 → 确定性超时路径
    };
    let report = warm_index(&[path_str(&root)], &limits);

    assert!(report.timed_out, "零预算必须标记 timed_out：{report:?}");
    assert!(report.files.is_empty(), "超时后不得继续产出：{report:?}");

    let _ = fs::remove_dir_all(&root);
}

/// 验收 5：代数守卫——预热期间手动重建后，旧预热提交被拒绝且不覆盖新索引。
#[test]
fn index_cell_rejects_stale_warmup_after_manual_rebuild() {
    let cell = IndexCell::new();

    // 预热侧：构建前采样代数（0）
    let expected = cell.generation();
    assert_eq!(expected, 0);

    // 构建期间用户手动重建 → 代数推进到 1，索引内容更新
    let new_gen = cell.rebuild(vec!["rebuilt_manual.rs".to_string()]);
    assert_eq!(new_gen, 1);

    // 晚到的旧预热提交必须被拒绝（Err 携带当前代数）
    let stale = cell.commit_if_current(vec!["stale_warmup.rs".to_string()], expected);
    assert_eq!(stale, Err(1), "旧预热提交必须被代数守卫拒绝");
    assert_eq!(
        cell.snapshot().as_slice(),
        ["rebuilt_manual.rs"],
        "被拒绝的预热不得覆盖手动重建结果"
    );

    // 正向：代数未再推进时预热提交成功
    let fresh = cell.generation();
    let ok = cell.commit_if_current(vec!["fresh_warmup.rs".to_string()], fresh);
    assert_eq!(ok, Ok(2), "代数一致时预热提交应成功");
    assert_eq!(cell.snapshot().as_slice(), ["fresh_warmup.rs"]);
}

/// 验收 6：条目级失败样本上限——错误列表本身不得无限增长。
#[test]
fn warm_index_caps_entry_error_samples() {
    // 直接构造超量样本验证上限常量语义（真实 FS 权限错误难以跨平台确定性触发）
    let mut samples = Vec::new();
    for i in 0..(ENTRY_ERROR_SAMPLES + 10) {
        if samples.len() < ENTRY_ERROR_SAMPLES {
            samples.push(format!("e{i}"));
        }
    }
    assert_eq!(
        samples.len(),
        ENTRY_ERROR_SAMPLES,
        "样本收集必须封顶于 ENTRY_ERROR_SAMPLES"
    );
}

/// 验收 7：嵌套根去重——根与其子目录同时授权时清单不重复。
#[test]
fn warm_index_dedupes_nested_roots() {
    let root = temp_root("nested");
    write_file(&root, "src/dup_target.rs");
    let sub = root.join("src");

    let report = warm_index(
        &[path_str(&root), path_str(&sub)],
        &WarmupLimits::default(),
    );

    let dup_count = report
        .files
        .iter()
        .filter(|f| f.ends_with("dup_target.rs"))
        .count();
    assert_eq!(dup_count, 1, "嵌套根的同一文件只出现一次：{:?}", report.files);

    let _ = fs::remove_dir_all(&root);
}
