use std::fs;

use super::support::*;
use crate::fs_commands::types;

// ── T-EG-05：overwrite 语义（默认拒绝覆盖，与工具侧 write_file 对齐）──

/// 已存在 + 未显式 overwrite → file_exists 拒绝，内容不被改动
#[test]
fn write_file_content_rejects_existing_by_default() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    let file = root.join("a.txt");
    fs::write(&file, "original").expect("write file");

    assert_error_code(
        write_file_content_at_root(&root, "a.txt", "overwritten", false),
        types::ERR_FILE_EXISTS,
    );
    assert_eq!(
        fs::read_to_string(&file).expect("read"),
        "original",
        "拒绝后不得改动原文件"
    );
}

/// 已存在 + overwrite=true → 放行覆盖写入
#[test]
fn write_file_content_existing_with_overwrite_true_succeeds() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    let file = root.join("a.txt");
    fs::write(&file, "original").expect("write file");

    let result = write_file_content_at_root(&root, "a.txt", "new", true).expect("overwrite");
    assert_eq!(fs::read_to_string(&file).expect("read"), "new");
    assert!(result.path.ends_with("a.txt"));
}

/// 目标不存在 → overwrite 参数无影响，默认即放行（新建语义不变）
#[test]
fn write_file_content_new_file_default_succeeds() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");

    let result =
        write_file_content_at_root(&root, "fresh.txt", "hello", false).expect("create file");
    assert_eq!(
        fs::read_to_string(root.join("fresh.txt")).expect("read"),
        "hello"
    );
    assert_eq!(result.bytes_written, 5);
}

// ── P1-S2 红测试：symlink 写路径逃逸（F5-01，R1 确认）──

/// 红测试：dangling symlink 父目录（链接目标不存在）写入必须被拒绝。
/// 修复前 resolve_for_write 祖先循环用 Path::exists（跟随链接，dangling
/// 为 false）一路上溯到根 → 返回词法路径 → create_dir_all + fs::write
/// 跟随 symlink 在根外落盘 → 返回 Ok → 红。
#[test]
fn write_file_content_rejects_dangling_symlink_parent() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    fs::create_dir(&root).expect("create root");
    let link = root.join("link");
    if create_dir_symlink(&outside, &link).is_err() {
        return; // 无符号链接权限环境跳过（Windows 开发者模式）
    }

    assert_error_code(
        write_file_content_at_root(&root, "link/new.txt", "pwned", false),
        types::ERR_OUTSIDE_WORKSPACE,
    );
    assert!(!outside.join("new.txt").exists(), "拒绝后不得在根外落盘");
}

/// 契约锁定：非 dangling symlink（链接目标为根外已存在目录）写入同样
/// 拒绝——resolve_for_write 祖先循环 canonicalize 已解析到根外（F5-01
/// 反向形态，修复前即拦截），防止修复退化。
#[test]
fn write_file_content_rejects_existing_symlink_dir_escaping_root() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&root).expect("create root");
    fs::create_dir(&outside).expect("create outside");
    let link = root.join("link");
    if create_dir_symlink(&outside, &link).is_err() {
        return; // 无符号链接权限环境跳过（Windows 开发者模式）
    }

    assert_error_code(
        write_file_content_at_root(&root, "link/new.txt", "pwned", false),
        types::ERR_OUTSIDE_WORKSPACE,
    );
    assert!(!outside.join("new.txt").exists(), "拒绝后不得在根外落盘");
}
