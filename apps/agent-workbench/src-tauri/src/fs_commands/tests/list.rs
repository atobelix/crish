use std::fs;

use super::support::*;
use crate::fs_commands::types;

#[test]
fn list_directory_rejects_path_traversal_outside_root() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    fs::create_dir_all(root.join("nested")).expect("create nested");
    fs::create_dir(&outside).expect("create outside");

    let traversal = root
        .join("nested")
        .join("..")
        .join("..")
        .join("outside")
        .to_string_lossy()
        .to_string();

    assert_error_code(
        list_directory_at_root(&root, &traversal),
        types::ERR_OUTSIDE_WORKSPACE,
    );
}

/// U-BLOCK / D0：目录条目超硬限时截断并给出 truncated/cursor/total
#[test]
fn list_directory_truncates_over_limit() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    // 超过 FS_LIST_DIRECTORY_DEFAULT_LIMIT（2000）+ 1
    for i in 0..(conex_shared::perf_budget::FS_LIST_DIRECTORY_DEFAULT_LIMIT + 1) {
        fs::write(root.join(format!("f{i:04}.txt")), b"x").expect("write file");
    }

    let result = list_directory_at_root(&root, "").expect("list dir");
    assert_eq!(
        result.items.len(),
        conex_shared::perf_budget::FS_LIST_DIRECTORY_DEFAULT_LIMIT
    );
    assert!(result.truncated);
    assert_eq!(
        result.cursor,
        Some(conex_shared::perf_budget::FS_LIST_DIRECTORY_DEFAULT_LIMIT)
    );
    assert_eq!(
        result.total,
        conex_shared::perf_budget::FS_LIST_DIRECTORY_DEFAULT_LIMIT + 1
    );
}
