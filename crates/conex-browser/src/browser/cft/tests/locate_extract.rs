//! 平台键/版本比较/缓存查找/版本目录 sanitize 与 zip 解压（含资源上限）用例（自 cft.rs 平移）。

use super::*;
use crate::browser::cft::extract::extract_zip_limited;
use crate::browser::cft::locate::{sanitize_version_dir, version_cmp};

/// 平台键映射（当前编译平台合法）。
#[test]
fn platform_key_current() {
    let key = platform_key().expect("当前平台应有键");
    assert!(
        ["win64", "mac-arm64", "mac-x64", "linux64"].contains(&key),
        "意外平台键：{key}"
    );
    // 二进制相对路径非空
    assert!(!binary_rel_path().expect("路径").is_empty());
}

/// 版本比较：多版本并存取最高。
#[test]
fn version_cmp_orders() {
    assert_eq!(
        version_cmp("151.0.7922.77", "151.0.7922.72"),
        std::cmp::Ordering::Greater
    );
    assert_eq!(
        version_cmp("150.0.7922.77", "151.0.1.1"),
        std::cmp::Ordering::Less
    );
    assert_eq!(
        version_cmp("151.0.0.1", "151.0.0.1"),
        std::cmp::Ordering::Equal
    );
    assert_eq!(version_cmp("151", "151.0.0.1"), std::cmp::Ordering::Less);
}

/// 缓存查找：多版本并存 → 版本最高者。
#[test]
fn find_cft_picks_highest() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path().join("browser");
    let rel = binary_rel_path().expect("路径");
    for (v, marker) in [
        ("151.0.7922.77", "a"),
        ("152.0.1.2", "b"),
        ("151.0.1.1", "c"),
    ] {
        let d = cft_root(&root).join(format!("chrome-{v}"));
        std::fs::create_dir_all(&d).expect("目录");
        let b = d.join(rel);
        std::fs::create_dir_all(b.parent().unwrap()).expect("父目录");
        std::fs::write(&b, marker.as_bytes()).expect("写入");
    }
    let cache = find_cft_cached(&root).expect("应命中");
    assert_eq!(cache.version, "152.0.1.2");
}

/// 缓存查找：二进制缺失 → 视为未装。
#[test]
fn find_cft_requires_binary() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path().join("browser");
    let d = cft_root(&root).join("chrome-151.0.0.1");
    std::fs::create_dir_all(&d).expect("目录");
    assert!(find_cft_cached(&root).is_none(), "无二进制不得视为已装");
}

/// 解压：正常 zip（含顶部前缀剥离 + 嵌套目录）。
#[test]
fn extract_strips_prefix_and_nested() {
    let dir = tempfile::tempdir().expect("临时目录");
    let zip_path = dir.path().join("c.zip");
    let src = dir.path().join("src");
    std::fs::create_dir_all(src.join("chrome-win64/sub")).expect("目录");
    std::fs::write(src.join("chrome-win64/chrome.exe"), b"bin").expect("写入");
    std::fs::write(src.join("chrome-win64/sub/file.txt"), b"txt").expect("写入");
    write_test_zip(&zip_path, &src);

    let dest = dir.path().join("dest");
    extract_zip(&zip_path, &dest).expect("解压");
    assert!(dest.join("chrome.exe").is_file(), "顶部前缀应剥离");
    assert_eq!(std::fs::read(dest.join("chrome.exe")).unwrap(), b"bin");
    assert_eq!(std::fs::read(dest.join("sub/file.txt")).unwrap(), b"txt");
}

/// 解压：路径穿越条目（`../` 与绝对路径）→ 拒绝。
#[test]
fn extract_rejects_traversal() {
    let dir = tempfile::tempdir().expect("临时目录");
    let zip_path = dir.path().join("evil.zip");
    write_evil_zip(&zip_path, "../evil.txt", b"evil");
    let dest = dir.path().join("dest");
    assert!(extract_zip(&zip_path, &dest).is_err(), "路径穿越必须拒绝");
    assert!(!dir.path().join("evil.txt").exists(), "不得写出目录");

    let zip2 = dir.path().join("abs.zip");
    write_evil_zip(&zip2, "C:/absolute.txt", b"evil");
    assert!(extract_zip(&zip2, &dest).is_err(), "绝对路径必须拒绝");
}

/// 评审 29 §M7：版本目录名 sanitize 放行合法版本。
#[test]
fn sanitize_version_dir_accepts_valid() {
    assert_eq!(
        sanitize_version_dir("151.0.7922.77").expect("合法版本"),
        "151.0.7922.77"
    );
}

/// 评审 29 §M7：非法版本目录名全部拒绝（路径注入面）。
#[test]
fn sanitize_version_dir_rejects_injection() {
    for bad in ["../evil", "a/b", "a\\b", "..", ".", "", "a:b", "a\0b"] {
        assert!(
            sanitize_version_dir(bad).is_err(),
            "应拒绝非法版本名：{bad:?}"
        );
    }
}

/// 评审 29 §M7：解压条目数超限 → 中止（中心目录 O(1) 校验，目标目录零创建）。
#[test]
fn extract_limits_entries_exceeded() {
    let dir = tempfile::tempdir().expect("临时目录");
    let zip_path = dir.path().join("many.zip");
    std::fs::write(
        &zip_path,
        build_test_zip(&["a.txt", "b.txt", "c.txt"], b"x"),
    )
    .expect("写入");
    let dest = dir.path().join("dest");
    let limits = CftLimits {
        max_download_bytes: 0,
        max_entries: 2,
        max_extract_bytes: 0,
    };
    let err = extract_zip_limited(&zip_path, &dest, limits).expect_err("应拒绝超条目数");
    assert!(
        matches!(
            err,
            CftError::TooLarge {
                what: "解压条目数",
                limit: 2,
                actual: 3
            }
        ),
        "应为条目数上限错误：{err}"
    );
    assert!(!dest.exists(), "超条目数不得创建目标目录");
}

/// 评审 29 §M7：解压总字节超限 → 中止（按实际写出量累计，不信任声明值）。
#[test]
fn extract_limits_bytes_exceeded() {
    let dir = tempfile::tempdir().expect("临时目录");
    let zip_path = dir.path().join("bomb.zip");
    let content = vec![0x42u8; 4096];
    // 两层路径：首段作顶部前缀被剥离后仍剩文件名（单层名会被整段剥离而跳过）
    std::fs::write(&zip_path, build_test_zip(&["dir/big.bin"], &content)).expect("写入");
    let dest = dir.path().join("dest");
    let limits = CftLimits {
        max_download_bytes: 0,
        max_entries: 100,
        max_extract_bytes: 1024,
    };
    let err = extract_zip_limited(&zip_path, &dest, limits).expect_err("应拒绝超字节数");
    assert!(
        matches!(
            err,
            CftError::TooLarge {
                what: "解压总字节数",
                limit: 1024,
                actual: 4096
            }
        ),
        "应为字节数上限错误：{err}"
    );
}
