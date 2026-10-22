//! CfT zip 解压：顶部前缀剥离、路径穿越防护与资源上限（自 cft.rs 平移）。

use super::{CftError, CftLimits};
use std::path::{Component, Path, PathBuf};

/// 解压 zip 到目标目录（带资源上限，评审 29 §M7）：
/// 条目数超限在解压任何文件前中止（中心目录 O(1) 校验，目标目录零创建）；
/// 总字节数按实际写出量累计（不信任中心目录声明值，防声明失真的 zip 炸弹）。
/// 超限中止时已写出的部分文件残留由调用方清理（`ensure_downloaded_from`
/// 失败即 `remove_dir_all` 版本目录，§2.2 残留清理）。
pub(super) fn extract_zip_limited(
    zip_path: &Path,
    dest_dir: &Path,
    limits: CftLimits,
) -> Result<(), CftError> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| CftError::Extract(format!("打开 zip 失败：{e}")))?;
    // 条目数上限：先于 create_dir_all 与任何写出（防海量条目写爆目录）
    if archive.len() > limits.max_entries {
        return Err(CftError::TooLarge {
            what: "解压条目数",
            limit: limits.max_entries as u64,
            actual: archive.len() as u64,
        });
    }
    std::fs::create_dir_all(dest_dir)?;

    // 顶部前缀探测：取第一个条目的第一段（Chrome 包统一 `chrome-<platform>/`）
    let top_prefix = {
        let first = archive
            .by_index(0)
            .map_err(|e| CftError::Extract(format!("读首条目失败：{e}")))?;
        let name = first.enclosed_name().ok_or_else(|| {
            CftError::Extract("首个条目路径穿越（enclosed_name 拒绝）".to_string())
        })?;
        name.components()
            .next()
            .map(|c| c.as_os_str().to_os_string())
    };

    let mut extracted_bytes = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| CftError::Extract(format!("读条目 {i} 失败：{e}")))?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| CftError::Extract(format!("条目 {i} 路径穿越：enclosed_name 拒绝")))?;
        if enclosed.as_os_str().is_empty() {
            continue;
        }
        // 剥离顶部前缀（若与探测一致）
        let first = enclosed.components().next();
        let strip = first.is_some_and(|c| Some(c.as_os_str()) == top_prefix.as_deref());
        let rel: PathBuf = if strip {
            enclosed
                .components()
                .skip(1)
                .map(|c| c.as_os_str())
                .collect()
        } else {
            enclosed.to_path_buf()
        };
        if rel.as_os_str().is_empty() {
            continue;
        }
        // 深度校验：相对路径不得含 ParentDir/RootDir/Prefix 组件（防御 `..` 变体）
        if rel.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(CftError::Extract(format!(
                "条目 {i} 含非法路径组件：{}",
                enclosed.display()
            )));
        }
        let dest = dest_dir.join(&rel);
        if !dest.starts_with(dest_dir) {
            return Err(CftError::Extract(format!("条目 {i} 逃逸目标目录")));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = std::fs::File::create(&dest)?;
            let copied = std::io::copy(&mut entry, &mut out)?;
            extracted_bytes += copied;
            // 总解压字节上限：按实际写出量累计，超限即中止（zip 炸弹防护）
            if extracted_bytes > limits.max_extract_bytes {
                return Err(CftError::TooLarge {
                    what: "解压总字节数",
                    limit: limits.max_extract_bytes,
                    actual: extracted_bytes,
                });
            }
            // unix 权限位回写（install.rs 同款；Windows 无此语义）
            #[cfg(unix)]
            {
                if let Some(mode) = entry.unix_mode() {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(mode))?;
                }
            }
        }
    }
    Ok(())
}

/// 解压 zip 到目标目录（默认资源上限）：顶部 `chrome-<platform>/` 前缀剥离 +
/// `enclosed_name()` 路径穿越防护 + `starts_with(dest)` 校验（§2.2）。
pub fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), CftError> {
    extract_zip_limited(zip_path, dest_dir, CftLimits::default())
}
