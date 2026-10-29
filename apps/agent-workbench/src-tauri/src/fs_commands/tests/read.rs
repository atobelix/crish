use std::fs;

use super::support::*;
use crate::fs_commands::types::{self, WorkspaceFsGuard, MAX_TEXT_FILE_BYTES};

#[test]
fn read_file_content_allows_file_under_root() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    let file = root.join("src").join("main.rs");
    fs::create_dir_all(file.parent().expect("file parent")).expect("create parent");
    fs::write(&file, "fn main() {}\nprintln!(\"ok\");\n").expect("write file");

    let result = read_file_content_at_root(&root, "src/main.rs", Some(1)).expect("read file");

    assert_eq!(result.content, "fn main() {}");
    assert_eq!(result.line_count, 1);
    assert!(result.truncated);
}

#[test]
fn read_file_content_rejects_absolute_path_outside_root() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside.txt");
    fs::create_dir(&root).expect("create root");
    fs::write(&outside, "secret").expect("write outside");

    assert_error_code(
        read_file_content_at_root(&root, &outside.to_string_lossy(), None),
        types::ERR_OUTSIDE_WORKSPACE,
    );
}

#[test]
fn read_file_content_rejects_large_files_before_decoding() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let large = root.join("large.txt");
    fs::create_dir(&root).expect("create root");
    fs::write(&large, vec![b'a'; MAX_TEXT_FILE_BYTES + 1]).expect("write large file");

    assert_error_code(
        read_file_content_at_root(&root, "large.txt", None),
        types::ERR_FILE_TOO_LARGE,
    );
}

#[test]
fn read_file_content_rejects_binary_files() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let binary = root.join("image.bin");
    fs::create_dir(&root).expect("create root");
    fs::write(&binary, [0x66, 0x00, 0x67, 0x68]).expect("write binary file");

    assert_error_code(
        read_file_content_at_root(&root, "image.bin", None),
        types::ERR_BINARY_FILE,
    );
}

#[test]
fn read_file_content_rejects_non_utf8_text() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let file = root.join("latin1.txt");
    fs::create_dir(&root).expect("create root");
    fs::write(&file, [0x66, 0xE9, 0x67]).expect("write non-utf8 file");

    assert_error_code(
        read_file_content_at_root(&root, "latin1.txt", None),
        types::ERR_UNSUPPORTED_ENCODING,
    );
}

#[test]
fn read_file_content_stops_output_at_line_limit() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let file = root.join("many.txt");
    fs::create_dir(&root).expect("create root");
    fs::write(&file, "one\ntwo\nthree\n").expect("write text file");

    let result = read_file_content_at_root(&root, "many.txt", Some(2)).expect("read file");

    assert_eq!(result.content, "one\ntwo");
    assert_eq!(result.line_count, 2);
    assert!(result.truncated);
}

#[test]
fn read_file_content_preserves_content_when_line_limit_matches_file() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let file = root.join("two.txt");
    fs::create_dir(&root).expect("create root");
    fs::write(&file, "one\ntwo\n").expect("write text file");

    let result = read_file_content_at_root(&root, "two.txt", Some(2)).expect("read file");

    assert_eq!(result.content, "one\ntwo\n");
    assert_eq!(result.line_count, 2);
    assert!(!result.truncated);
}

#[test]
fn read_file_content_rejects_symlink_escaping_root() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    let outside = temp.path().join("outside.txt");
    let link = root.join("link.txt");
    fs::create_dir(&root).expect("create root");
    fs::write(&outside, "secret").expect("write outside");

    if create_file_symlink(&outside, &link).is_err() {
        return;
    }

    assert_error_code(
        read_file_content_at_root(&root, "link.txt", None),
        types::ERR_OUTSIDE_WORKSPACE,
    );
}

#[test]
fn guard_new_rejects_unreachable_root() {
    // T07.2 用例 13（P-02 关闭）：根不可达 → 构造失败，不裸用传入根
    let temp = TestDir::new();
    let missing = temp.path().join("no-such-root");
    let err = WorkspaceFsGuard::new(&missing).expect_err("unreachable root must be rejected");
    assert_eq!(err.code, types::ERR_INTERNAL);
}
