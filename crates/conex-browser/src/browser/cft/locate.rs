//! CfT 平台键映射、解压后二进制定位与版本缓存查找（自 cft.rs 平移）。

use super::{CftCache, CftError};
use std::path::{Path, PathBuf};

/// 平台键映射（§2.2 表）：win64 / mac-arm64 / mac-x64 / linux64。
/// Linux arm64 无官方构建 → 直接报错并引导系统 chromium（install.rs:401-411 同款）。
pub fn platform_key() -> Result<&'static str, CftError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("win64"),
        ("macos", "aarch64") => Ok("mac-arm64"),
        ("macos", "x86_64") => Ok("mac-x64"),
        ("linux", "x86_64") => Ok("linux64"),
        ("linux", "aarch64") => Err(CftError::UnsupportedPlatform(
            "Linux arm64 无官方 CfT 构建，请使用系统 chromium".to_string(),
        )),
        other => Err(CftError::UnsupportedPlatform(format!(
            "{}/{}",
            other.0, other.1
        ))),
    }
}

/// 解压后二进制相对路径（§2.2 表：zip 内规范路径，供缓存布局与测试 fixture 使用）。
pub fn binary_rel_path() -> Result<&'static str, CftError> {
    match platform_key()? {
        "win64" => Ok("chrome-win64/chrome.exe"),
        "mac-arm64" => Ok("chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        "mac-x64" => Ok("chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        "linux64" => Ok("chrome-linux64/chrome"),
        other => Err(CftError::UnsupportedPlatform(other.to_string())),
    }
}

/// 解压后二进制候选路径（双形态探测，参考 install.rs:101-152）：
/// 1. 前缀剥离布局（`<dest>/chrome.exe`，§2.2 剥离语义的主路径）；
/// 2. 未剥离布局（`<dest>/chrome-win64/chrome.exe`，zip 内规范路径兜底）。
fn binary_candidates(dest_dir: &Path) -> Vec<PathBuf> {
    let rel = binary_rel_path().unwrap_or_default();
    let mut v = Vec::new();
    if let Some((_, rest)) = rel.split_once('/') {
        v.push(dest_dir.join(rest));
    }
    v.push(dest_dir.join(rel));
    v
}

/// 取实际存在的二进制（两种布局任一命中）。
pub(super) fn find_binary(dest_dir: &Path) -> Option<PathBuf> {
    binary_candidates(dest_dir)
        .into_iter()
        .find(|p| p.is_file())
}

/// 缓存根（`<root>/browsers/`，root = `<data_root>/conex/browser`）。
pub fn cft_root(root: &Path) -> PathBuf {
    root.join("browsers")
}

/// 已安装判定：二进制存在即视为已装（§2.2；版本校验由启动后 getVersion 兜底）。
pub fn find_cft_cached(root: &Path) -> Option<CftCache> {
    let dir = cft_root(root);
    let mut best: Option<CftCache> = None;
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let version = name.strip_prefix("chrome-")?;
        let binary = find_binary(&path)?;
        // 多版本并存时取版本号最高者（版本目录并存，升级不破坏旧版）
        let take = match &best {
            None => true,
            Some(b) => version_cmp(version, &b.version) == std::cmp::Ordering::Greater,
        };
        if take {
            best = Some(CftCache {
                version: version.to_string(),
                dir: path,
                binary,
            });
        }
    }
    best
}

/// 简单版本比较（数字点分段逐段比，非数字段视为 0）。
pub(super) fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let split = |s: &str| {
        s.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (va, vb) = (split(a), split(b));
    for i in 0..va.len().max(vb.len()) {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            o => return o,
        }
    }
    std::cmp::Ordering::Equal
}

/// 版本目录名 sanitize（评审 29 §M7，防路径注入）：
/// 拒绝空串、`.`/`..`、路径分隔符与 Windows 非法字符，仅放行安全单组件名。
pub(super) fn sanitize_version_dir(version: &str) -> Result<String, CftError> {
    if version.is_empty() {
        return Err(CftError::InvalidVersion("空版本号".to_string()));
    }
    if version == "." || version == ".." {
        return Err(CftError::InvalidVersion(format!("非法版本号：{version}")));
    }
    if version.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*', '\0']) {
        return Err(CftError::InvalidVersion(format!(
            "含路径分隔符或非法字符：{version}"
        )));
    }
    Ok(version.to_string())
}
