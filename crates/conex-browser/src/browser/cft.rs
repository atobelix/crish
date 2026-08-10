//! Chrome for Testing 下载/解压/版本缓存（维度 10 §2.2，离线可跳过）
//!
//! - 版本真源：last-known-good versions JSON（`channels.Stable.version`，确定性钉死）；
//! - 缓存布局：`<data_root>/conex/browser/browsers/chrome-<version>/`（版本目录并存）；
//! - 解压：zip 流式解压 + 顶部 `chrome-<platform>/` 前缀剥离 +
//!   `enclosed_name()` 路径穿越防护（§2.2 表）；
//! - 下载重试：3 次退避 1s/2s，仅连接失败/超时/5xx 重试，4xx 立即失败；
//! - 资源上限（评审 29 §M7）：下载响应 ≤512MB（含分块流累积校验）、解压条目
//!   ≤10 万、解压总字节 ≤2GB（zip 炸弹防护），超限即中止并清理半成品；
//! - 版本目录名 `chrome-{version}` 先经 sanitize（拒绝分隔符/`..`/Windows 非法
//!   字符），防路径注入逃逸缓存根；
//! - 失败即 `remove_dir_all` 目标版本目录（残留清理），下载失败走系统回退链。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use crate::browser::ProcessError;
use serde::Deserialize;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// 版本真源（与 agent-browser install.rs:8 同源）。
pub const LKG_URL: &str = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
/// 下载重试次数（§2.2：仅连接失败/超时/5xx 重试）。
pub const DEFAULT_RETRIES: u32 = 3;
/// 退避序列（1s/2s，§2.2）。
pub const DEFAULT_BACKOFF: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(2)];

/// 下载响应字节上限（评审 29 §M7：防超大响应整包入内存）。
pub const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// 解压条目数上限（评审 29 §M7：zip 炸弹防护）。
pub const MAX_EXTRACT_ENTRIES: usize = 100_000;
/// 解压总字节数上限（评审 29 §M7：zip 炸弹防护）。
pub const MAX_EXTRACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// 下载/解压资源上限（测试可注入缩小值做确定性覆盖，生产恒用默认）。
#[derive(Debug, Clone, Copy)]
pub struct CftLimits {
    /// 下载响应最大字节数（含无 Content-Length 的分块流累积校验）。
    pub max_download_bytes: u64,
    /// 解压条目数上限。
    pub max_entries: usize,
    /// 解压总字节数上限（按实际写出量累计，不信任中心目录声明值）。
    pub max_extract_bytes: u64,
}

impl Default for CftLimits {
    fn default() -> Self {
        CftLimits {
            max_download_bytes: MAX_DOWNLOAD_BYTES,
            max_entries: MAX_EXTRACT_ENTRIES,
            max_extract_bytes: MAX_EXTRACT_BYTES,
        }
    }
}

/// CfT 缓存命中项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CftCache {
    pub version: String,
    pub dir: PathBuf,
    pub binary: PathBuf,
}

/// 下载选项（重试/退避可注入，测试缩短）。
#[derive(Clone)]
pub struct DownloadOpts {
    pub retries: u32,
    pub backoff: Vec<Duration>,
    /// 进度回调（已下载字节/总字节；None = 无进度面）。
    pub progress: Option<Arc<dyn Fn(u64, u64) + Send + Sync>>,
}

impl Default for DownloadOpts {
    fn default() -> Self {
        DownloadOpts {
            retries: DEFAULT_RETRIES,
            backoff: DEFAULT_BACKOFF.to_vec(),
            progress: None,
        }
    }
}

use std::sync::Arc;

/// CfT 错误（进程管理侧内部错误，最终汇入回退链/NoBrowser 诊断）。
#[derive(Debug, thiserror::Error)]
pub enum CftError {
    #[error("平台不受支持：{0}")]
    UnsupportedPlatform(String),
    #[error("HTTP 错误：{0}")]
    Http(String),
    #[error("JSON 解析失败：{0}")]
    Json(String),
    #[error("响应中缺少 Stable 版本或 {platform} 下载项")]
    MissingDownload { platform: String },
    #[error("下载失败（重试 {retries} 次后）：{last}")]
    DownloadFailed { retries: u32, last: String },
    #[error("解压失败：{0}")]
    Extract(String),
    #[error("超出{what}上限：上限 {limit}，实际 {actual}")]
    TooLarge {
        what: &'static str,
        limit: u64,
        actual: u64,
    },
    #[error("版本目录名非法：{0}")]
    InvalidVersion(String),
    #[error("I/O 错误：{0}")]
    Io(String),
}

impl From<std::io::Error> for CftError {
    fn from(e: std::io::Error) -> Self {
        CftError::Io(e.to_string())
    }
}

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
        other => Err(CftError::UnsupportedPlatform(format!("{}/{}", other.0, other.1))),
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
fn find_binary(dest_dir: &Path) -> Option<PathBuf> {
    binary_candidates(dest_dir).into_iter().find(|p| p.is_file())
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
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
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
fn sanitize_version_dir(version: &str) -> Result<String, CftError> {
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

/// last-known-good JSON 响应（只取用到的字段，宽容解析）。
#[derive(Debug, Deserialize)]
struct LkgResponse {
    channels: LkgChannels,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct LkgChannels {
    stable: LkgStable,
}

#[derive(Debug, Deserialize)]
struct LkgStable {
    version: String,
    downloads: LkgDownloads,
}

#[derive(Debug, Deserialize)]
struct LkgDownloads {
    #[serde(rename = "chrome")]
    chrome: Option<Vec<LkgDownloadItem>>,
}

#[derive(Debug, Deserialize)]
struct LkgDownloadItem {
    platform: String,
    url: String,
}

/// 拉取 last-known-good JSON 并解析出 Stable 版本与下载 URL。
async fn fetch_lkg(client: &reqwest::Client, url: &str, key: &str) -> Result<(String, String), CftError> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| CftError::Http(e.to_string()))?
        .error_for_status()
        .map_err(|e| CftError::Http(e.to_string()))?;
    let lkg: LkgResponse = resp
        .json()
        .await
        .map_err(|e| CftError::Json(e.to_string()))?;
    let version = lkg.channels.stable.version;
    let items = lkg.channels.stable.downloads.chrome.ok_or_else(|| {
        CftError::MissingDownload { platform: key.to_string() }
    })?;
    let url = items
        .iter()
        .find(|i| i.platform == key)
        .map(|i| i.url.clone())
        .ok_or_else(|| CftError::MissingDownload { platform: key.to_string() })?;
    Ok((version, url))
}

/// 下载 zip（重试语义：连接失败/超时/5xx/I/O 重试，4xx 与超限立即失败）。
/// `max_bytes` 为响应字节上限（评审 29 §M7）：Content-Length 已知即超限 → 读取前
/// 中止（零写入）；分块流（无 Content-Length）→ 累积写出量超限中止。
/// 超限为确定性失败（重试无益）→ 不重试，最终失败路径清理半成品文件。
/// 豁免 clippy 删除禁令：失败残留清理是自家生成物（下载半成品），
/// 与「自管文件轮转」同豁免面（clippy.toml 注释），不留可恢复副本。
#[allow(clippy::disallowed_methods)]
async fn download_zip(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    opts: &DownloadOpts,
    max_bytes: u64,
) -> Result<(), CftError> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match download_once(client, url, dest, opts, max_bytes).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                let retryable = match &e {
                    CftError::Http(m) => !m.starts_with("4xx 立即失败"),
                    CftError::TooLarge { .. } => false,
                    CftError::Io(_) => true,
                    _ => true,
                };
                if attempt >= opts.retries || !retryable {
                    let _ = std::fs::remove_file(dest);
                    return Err(CftError::DownloadFailed {
                        retries: attempt,
                        last: e.to_string(),
                    });
                }
                let idx = ((attempt - 1) as usize).min(opts.backoff.len().saturating_sub(1));
                let delay = opts
                    .backoff
                    .get(idx)
                    .copied()
                    .unwrap_or(Duration::from_secs(1));
                tokio::time::sleep(delay).await;
            }
        }
    }
}

async fn download_once(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    opts: &DownloadOpts,
    max_bytes: u64,
) -> Result<(), CftError> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| CftError::Http(format!("连接失败：{e}")))?;
    let status = resp.status();
    if status.is_client_error() {
        return Err(CftError::Http(format!("4xx 立即失败：{status}")));
    }
    if status.is_server_error() {
        return Err(CftError::Http(format!("5xx 服务端错误：{status}")));
    }
    // 上限防护（评审 29 §M7）：Content-Length 已知且超限 → 创建文件前即中止（零写入）。
    let declared = resp.content_length().unwrap_or(0);
    if declared > max_bytes {
        return Err(CftError::TooLarge {
            what: "下载字节数",
            limit: max_bytes,
            actual: declared,
        });
    }
    let total = declared;
    let mut written = 0u64;
    let mut out = std::fs::File::create(dest)?;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| CftError::Http(format!("读响应失败：{e}")))?
    {
        out.write_all(&chunk)?;
        written += chunk.len() as u64;
        // 分块流（无 Content-Length）或声明值失真的累积兜底校验
        if written > max_bytes {
            return Err(CftError::TooLarge {
                what: "下载字节数",
                limit: max_bytes,
                actual: written,
            });
        }
        if let Some(progress) = &opts.progress {
            progress(written, total);
        }
    }
    out.flush()?;
    Ok(())
}

/// 解压 zip 到目标目录（带资源上限，评审 29 §M7）：
/// 条目数超限在解压任何文件前中止（中心目录 O(1) 校验，目标目录零创建）；
/// 总字节数按实际写出量累计（不信任中心目录声明值，防声明失真的 zip 炸弹）。
/// 超限中止时已写出的部分文件残留由调用方清理（`ensure_downloaded_from`
/// 失败即 `remove_dir_all` 版本目录，§2.2 残留清理）。
fn extract_zip_limited(
    zip_path: &Path,
    dest_dir: &Path,
    limits: CftLimits,
) -> Result<(), CftError> {
    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| CftError::Extract(format!("打开 zip 失败：{e}")))?;
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
        let enclosed = entry.enclosed_name().ok_or_else(|| {
            CftError::Extract(format!("条目 {i} 路径穿越：enclosed_name 拒绝"))
        })?;
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
        if rel
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
        {
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
/// 下载并解压到版本缓存目录；失败即清理目标目录（残留清理，§2.2）。
pub async fn ensure_downloaded(root: &Path, opts: &DownloadOpts) -> Result<CftCache, CftError> {
    let key = platform_key()?;
    let client = build_client()?;
    let (version, url) = fetch_lkg(&client, LKG_URL, key).await?;
    ensure_downloaded_from(&client, &version, &url, root, opts, CftLimits::default()).await
}

/// 内部流程（URL 注入，测试用 mock 服务端全量覆盖下载/解压/清理路径）。
/// `pub(crate)`（评审 G2 修复）：下载失败回退链（discover::resolve_inner 的
/// CftDownload 探测项 → 回退系统浏览器）以本函数的失败信号为输入，跨模块
/// 可见性使 mock 下载失败可在回退链测试中注入（不真实联网）。
/// `limits` 为下载/解压资源上限（评审 29 §M7，测试注入缩小值；生产恒默认）。
/// 豁免 clippy 删除禁令：版本目录/zip 是自家缓存生成物，失败即清半成品
/// （§2.2 残留清理），与「自管文件轮转」同豁免面。
#[allow(clippy::disallowed_methods)]
pub(crate) async fn ensure_downloaded_from(
    client: &reqwest::Client,
    version: &str,
    url: &str,
    root: &Path,
    opts: &DownloadOpts,
    limits: CftLimits,
) -> Result<CftCache, CftError> {
    // 版本目录名 sanitize（评审 29 §M7）：先于一切路径操作，防 `chrome-{version}`
    // 拼接逃逸缓存根（version 含 `/`/`\`/`..` 等直接拒绝，结构化错误）。
    let dest_dir = cft_root(root).join(format!("chrome-{}", sanitize_version_dir(version)?));
    // 已存在且二进制完整 → 视为已装（不校验 hash，§2.2）
    if let Some(binary) = find_binary(&dest_dir) {
        return Ok(CftCache {
            version: version.to_string(),
            dir: dest_dir.clone(),
            binary,
        });
    }
    if dest_dir.exists() {
        // 半成品清理（上次失败残留）
        let _ = std::fs::remove_dir_all(&dest_dir);
    }
    std::fs::create_dir_all(&dest_dir)?;
    let zip_path = dest_dir.join("chrome.zip");
    if let Err(e) = download_zip(client, url, &zip_path, opts, limits.max_download_bytes).await {
        let _ = std::fs::remove_dir_all(&dest_dir);
        return Err(e);
    }
    if let Err(e) = extract_zip_limited(&zip_path, &dest_dir, limits) {
        let _ = std::fs::remove_dir_all(&dest_dir);
        return Err(e);
    }
    let _ = std::fs::remove_file(&zip_path);
    let Some(binary) = find_binary(&dest_dir) else {
        let _ = std::fs::remove_dir_all(&dest_dir);
        return Err(CftError::Extract(format!(
            "解压后缺少预期二进制：{}",
            dest_dir.display()
        )));
    };
    Ok(CftCache {
        version: version.to_string(),
        dir: dest_dir,
        binary,
    })
}

fn build_client() -> Result<reqwest::Client, CftError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| CftError::Http(e.to_string()))
}

/// 将 CftError 汇入 ProcessError（供 discover 汇总）。
impl From<CftError> for ProcessError {
    fn from(e: CftError) -> Self {
        ProcessError::Internal(format!("CfT 错误：{e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

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
        assert_eq!(version_cmp("151.0.7922.77", "151.0.7922.72"), std::cmp::Ordering::Greater);
        assert_eq!(version_cmp("150.0.7922.77", "151.0.1.1"), std::cmp::Ordering::Less);
        assert_eq!(version_cmp("151.0.0.1", "151.0.0.1"), std::cmp::Ordering::Equal);
        assert_eq!(version_cmp("151", "151.0.0.1"), std::cmp::Ordering::Less);
    }

    /// 缓存查找：多版本并存 → 版本最高者。
    #[test]
    fn find_cft_picks_highest() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path().join("browser");
        let rel = binary_rel_path().expect("路径");
        for (v, marker) in [("151.0.7922.77", "a"), ("152.0.1.2", "b"), ("151.0.1.1", "c")] {
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

    /// 下载重试：4xx 立即失败（mock 服务端）。
    #[tokio::test]
    async fn download_4xx_fails_immediately() {
        let (_server, url) = mock_server(move |_req| 404, 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let dest = dir.path().join("out.zip");
        let err = download_zip(
            &client,
            &url,
            &dest,
            &DownloadOpts {
                retries: 5,
                backoff: vec![Duration::from_millis(5)],
                progress: None,
            },
            CftLimits::default().max_download_bytes,
        )
        .await
        .expect_err("应失败");
        assert!(err.to_string().contains("4xx"), "4xx 应即时失败：{err}");
        assert!(matches!(err, CftError::DownloadFailed { retries, .. } if retries == 1));
    }

    /// 下载重试：5xx 重试至上限（计数断言）。
    #[tokio::test]
    async fn download_5xx_retries_then_fails() {
        let (_server, url) = mock_server(move |_req| 500, 4).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let dest = dir.path().join("out.zip");
        let err = download_zip(
            &client,
            &url,
            &dest,
            &DownloadOpts {
                retries: 3,
                backoff: vec![Duration::from_millis(2)],
                progress: None,
            },
            CftLimits::default().max_download_bytes,
        )
        .await
        .expect_err("应失败");
        assert!(
            matches!(err, CftError::DownloadFailed { retries: 3, .. }),
            "5xx 应重试 3 次：{err}"
        );
    }

    /// 下载成功：字节一致 + 进度回调触发。
    #[tokio::test]
    async fn download_success_with_progress() {
        let payload = b"hello chrome zip".to_vec();
        let (_server, url) = mock_server(move |_req| 200, 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let dest = dir.path().join("out.zip");
        let calls = Arc::new(AtomicU64::new(0));
        let calls2 = calls.clone();
        download_zip(
            &client,
            &url,
            &dest,
            &DownloadOpts {
                retries: 1,
                backoff: vec![],
                progress: Some(Arc::new(move |_, _| {
                    calls2.fetch_add(1, Ordering::SeqCst);
                })),
            },
            CftLimits::default().max_download_bytes,
        )
        .await
        .expect("下载");
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        assert!(calls.load(Ordering::SeqCst) >= 1, "进度回调应触发");
    }

    /// 磁盘满/写失败模拟：目标路径父级被文件占位 → 下载失败（I/O 错误可重试后放弃）。
    #[tokio::test]
    async fn download_write_failure_cleans_up() {
        let (_server, url) = mock_server(move |_req| 200, 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        // 目标父路径被文件占位 → File::create 失败（模拟磁盘满/权限拒绝）
        let blocker = dir.path().join("block");
        std::fs::write(&blocker, b"not a dir").expect("占位");
        let dest = blocker.join("out.zip");
        let err = download_zip(
            &client,
            &url,
            &dest,
            &DownloadOpts {
                retries: 2,
                backoff: vec![Duration::from_millis(2)],
                progress: None,
            },
            CftLimits::default().max_download_bytes,
        )
        .await
        .expect_err("应失败");
        assert!(matches!(err, CftError::DownloadFailed { .. }));
        assert!(!dest.exists(), "失败后不得残留半成品");
    }

    /// 下载/解压失败 → ensure_downloaded_from 清理版本目录（损坏 zip 注入）。
    #[tokio::test]
    async fn ensure_downloaded_corrupt_zip_cleans_up() {
        let (_server, url) = mock_vec_server(b"corrupt-zip-bytes".to_vec(), 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path().join("browser");
        let err = ensure_downloaded_from(&client, "9.9.9.9", &url, &root, &DownloadOpts::default(), CftLimits::default())
            .await
            .expect_err("损坏 zip 应失败");
        assert!(
            err.to_string().contains("解压") || err.to_string().contains("zip"),
            "错误应指向解压失败：{err}"
        );
        assert!(
            !cft_root(&root).join("chrome-9.9.9.9").exists(),
            "失败后版本目录必须清理（残留清理，§2.2）"
        );
    }

    /// 评审 G2（32 评审 G8 补强）：HTTP 下载失败路径（4xx 立即失败）——
    /// 返回 `DownloadFailed` 且版本目录零残留。该失败信号即 discover 回退链
    /// 的输入：Auto 链将 CftDownload 探测项 + 原因汇入 probes 后继续回退
    /// 系统浏览器（不阻塞启动）；零残留保证回退链无需处理半成品状态。
    #[tokio::test]
    async fn ensure_downloaded_http_failure_clean_for_fallback() {
        let (_server, url) = mock_server(move |_req| 404, 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path().join("browser");
        let err = ensure_downloaded_from(
            &client,
            "9.9.9.8",
            &url,
            &root,
            &DownloadOpts {
                retries: 1,
                backoff: vec![],
                progress: None,
            },
            CftLimits::default(),
        )
        .await
        .expect_err("4xx 下载必须失败");
        assert!(
            matches!(err, CftError::DownloadFailed { retries: 1, .. }),
            "4xx 应立即失败（不重试）：{err}"
        );
        assert!(
            !cft_root(&root).join("chrome-9.9.9.8").exists(),
            "下载失败后版本目录必须清理（回退链前置条件：零残留）"
        );
    }

    /// 完整成功路径：mock 服务端提供合法 zip → 缓存目录 + 二进制就位。
    #[tokio::test]
    async fn ensure_downloaded_success_end_to_end() {
        // 构造平台一致的 zip（顶部前缀 chrome-<key>/）
        let key = platform_key().expect("平台键");
        let dir = tempfile::tempdir().expect("临时目录");
        let zip_bytes = {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let top = format!("chrome-{key}");
            writer.start_file(format!("{top}/chrome.exe"), options).expect("start");
            writer.write_all(b"bin").expect("写入");
            writer.start_file(format!("{top}/sub/f.txt"), options).expect("start");
            writer.write_all(b"txt").expect("写入");
            writer.finish().expect("finish").into_inner()
        };
        let (_server, url) = mock_vec_server(zip_bytes, 1).await;
        let client = reqwest::Client::new();
        let root = dir.path().join("browser");
        let cache = ensure_downloaded_from(&client, "151.0.7922.77", &url, &root, &DownloadOpts::default(), CftLimits::default())
            .await
            .expect("成功");
        assert_eq!(cache.version, "151.0.7922.77");
        assert!(cache.binary.is_file(), "二进制必须就位：{}", cache.binary.display());
        assert_eq!(std::fs::read(&cache.binary).unwrap(), b"bin");
        assert!(!cft_root(&root).join("chrome-151.0.7922.77/chrome.zip").exists(), "zip 残留应删除");
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

    /// 评审 29 §M7：版本注入经 ensure_downloaded_from 拒绝——
    /// sanitize 先于一切路径操作（零网络零写入），结构化错误 + 缓存根零残留。
    #[tokio::test]
    async fn ensure_downloaded_rejects_version_injection() {
        let client = reqwest::Client::new();
        for bad in ["../evil", "a/b", "a\\b", "..", ""] {
            let dir = tempfile::tempdir().expect("临时目录");
            let root = dir.path().join("browser");
            let err = ensure_downloaded_from(
                &client,
                bad,
                "http://127.0.0.1:1/never",
                &root,
                &DownloadOpts::default(),
                CftLimits::default(),
            )
            .await
            .expect_err("非法版本必须拒绝");
            assert!(
                matches!(err, CftError::InvalidVersion(_)),
                "应报 InvalidVersion：{err}"
            );
            assert!(
                !cft_root(&root).join("evil").exists(),
                "路径注入不得写出缓存根外"
            );
            let leftover = if cft_root(&root).exists() {
                std::fs::read_dir(cft_root(&root)).unwrap().count()
            } else {
                0
            };
            assert_eq!(leftover, 0, "缓存根必须零残留");
        }
    }

    /// 评审 29 §M7：下载超限（Content-Length 已知超限）→ 读取前中止、
    /// 不重试（确定性失败）、半成品清理。
    #[tokio::test]
    async fn download_too_large_aborts_and_cleans() {
        let payload = vec![0x41u8; 65536];
        let (_server, url) = mock_vec_server(payload, 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let dest = dir.path().join("out.zip");
        let err = download_zip(
            &client,
            &url,
            &dest,
            &DownloadOpts {
                retries: 3,
                backoff: vec![Duration::from_millis(2)],
                progress: None,
            },
            1024,
        )
        .await
        .expect_err("应因超限失败");
        assert!(err.to_string().contains("上限"), "错误应指向超限：{err}");
        assert!(
            matches!(err, CftError::DownloadFailed { retries: 1, .. }),
            "超限不得重试：{err}"
        );
        assert!(!dest.exists(), "失败后不得残留半成品");
    }

    /// 评审 29 §M7：分块流（无 Content-Length）累积字节超限 → 中止 + 清理。
    #[tokio::test]
    async fn download_chunked_too_large_aborts_and_cleans() {
        let payload = vec![0x42u8; 65536];
        let (_server, url) = mock_chunked_server(payload, 4096, 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let dest = dir.path().join("out.zip");
        let err = download_zip(
            &client,
            &url,
            &dest,
            &DownloadOpts {
                retries: 1,
                backoff: vec![],
                progress: None,
            },
            1024,
        )
        .await
        .expect_err("应因累积超限失败");
        assert!(err.to_string().contains("上限"), "错误应指向超限：{err}");
        assert!(!dest.exists(), "失败后不得残留半成品");
    }

    /// 评审 29 §M7：解压条目数超限 → 中止（中心目录 O(1) 校验，目标目录零创建）。
    #[test]
    fn extract_limits_entries_exceeded() {
        let dir = tempfile::tempdir().expect("临时目录");
        let zip_path = dir.path().join("many.zip");
        std::fs::write(&zip_path, build_test_zip(&["a.txt", "b.txt", "c.txt"], b"x"))
            .expect("写入");
        let dest = dir.path().join("dest");
        let limits = CftLimits {
            max_download_bytes: 0,
            max_entries: 2,
            max_extract_bytes: 0,
        };
        let err = extract_zip_limited(&zip_path, &dest, limits)
            .expect_err("应拒绝超条目数");
        assert!(
            matches!(
                err,
                CftError::TooLarge { what: "解压条目数", limit: 2, actual: 3 }
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
        let err = extract_zip_limited(&zip_path, &dest, limits)
            .expect_err("应拒绝超字节数");
        assert!(
            matches!(
                err,
                CftError::TooLarge { what: "解压总字节数", limit: 1024, actual: 4096 }
            ),
            "应为字节数上限错误：{err}"
        );
    }

    /// 评审 29 §M7：解压超限经 ensure_downloaded_from → 中止 + 版本目录清理。
    #[tokio::test]
    async fn ensure_downloaded_extract_limit_cleans_up() {
        let key = platform_key().expect("平台键");
        let dir = tempfile::tempdir().expect("临时目录");
        let zip_bytes = {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            let top = format!("chrome-{key}");
            writer.start_file(format!("{top}/chrome.exe"), options).expect("start");
            writer.write_all(b"bin").expect("写入");
            writer.start_file(format!("{top}/sub/f.txt"), options).expect("start");
            writer.write_all(b"txt").expect("写入");
            writer.finish().expect("finish").into_inner()
        };
        let (_server, url) = mock_vec_server(zip_bytes, 1).await;
        let client = reqwest::Client::new();
        let root = dir.path().join("browser");
        let limits = CftLimits {
            max_download_bytes: 1024 * 1024 * 1024,
            max_entries: 1,
            max_extract_bytes: 0,
        };
        let err = ensure_downloaded_from(
            &client,
            "9.9.9.7",
            &url,
            &root,
            &DownloadOpts::default(),
            limits,
        )
        .await
        .expect_err("超条目数应失败");
        assert!(
            matches!(err, CftError::TooLarge { .. }),
            "应为上限错误：{err}"
        );
        assert!(
            !cft_root(&root).join("chrome-9.9.9.7").exists(),
            "失败后版本目录必须清理（残留清理，§2.2）"
        );
    }

    /// 评审 29 §M7：截断 zip（合法文件头 + 截断中心目录）→ 结构化错误 + 版本目录清理。
    #[tokio::test]
    async fn ensure_downloaded_truncated_zip_cleans_up() {
        let full = build_test_zip(&["chrome-win64/chrome.exe"], b"bin");
        let truncated = full[..full.len() / 2].to_vec();
        let (_server, url) = mock_vec_server(truncated, 1).await;
        let client = reqwest::Client::new();
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path().join("browser");
        let err = ensure_downloaded_from(
            &client,
            "9.9.9.6",
            &url,
            &root,
            &DownloadOpts::default(),
            CftLimits::default(),
        )
        .await
        .expect_err("截断 zip 应失败");
        assert!(
            err.to_string().contains("zip"),
            "错误应指向解压失败：{err}"
        );
        assert!(
            !cft_root(&root).join("chrome-9.9.9.6").exists(),
            "失败后版本目录必须清理"
        );
    }

    // ---------- mock HTTP 服务端（tokio TcpListener，仅测试用） ----------

    /// 按状态码应答（200 返回固定正文）。
    async fn mock_server<F>(mut handler: F, count: usize) -> (tokio::task::JoinHandle<()>, String)
    where
        F: FnMut(&str) -> u16 + Send + 'static,
    {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("绑定");
        let addr = listener.local_addr().expect("地址");
        let url = format!("http://{addr}/file.zip");
        let handle = tokio::spawn(async move {
            let mut served = 0;
            while served < count {
                let (mut sock, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                served += 1;
                let mut buf = [0u8; 2048];
                let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                let status = handler("req");
                let body = if status == 200 { b"hello chrome zip".to_vec() } else { Vec::new() };
                let reason = if status == 200 { "OK" } else { "Err" };
                write_http(&mut sock, status, reason, &body).await;
            }
        });
        (handle, url)
    }

    /// 固定字节应答（损坏 zip / 合法 zip 注入）。
    async fn mock_vec_server(payload: Vec<u8>, count: usize) -> (tokio::task::JoinHandle<()>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("绑定");
        let addr = listener.local_addr().expect("地址");
        let url = format!("http://{addr}/payload");
        let handle = tokio::spawn(async move {
            for _ in 0..count {
                let (mut sock, _) = listener.accept().await.expect("accept");
                let mut buf = [0u8; 2048];
                let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                write_http(&mut sock, 200, "OK", &payload).await;
            }
        });
        (handle, url)
    }

    /// 分块编码应答（无 Content-Length，测累积字节上限路径）。
    async fn mock_chunked_server(
        payload: Vec<u8>,
        chunk: usize,
        count: usize,
    ) -> (tokio::task::JoinHandle<()>, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("绑定");
        let addr = listener.local_addr().expect("地址");
        let url = format!("http://{addr}/chunked");
        let handle = tokio::spawn(async move {
            for _ in 0..count {
                let (mut sock, _) = listener.accept().await.expect("accept");
                let mut buf = [0u8; 2048];
                let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
                use tokio::io::AsyncWriteExt;
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                    )
                    .await;
                for part in payload.chunks(chunk) {
                    let _ = sock
                        .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                        .await;
                    let _ = sock.write_all(part).await;
                    let _ = sock.write_all(b"\r\n").await;
                }
                let _ = sock.write_all(b"0\r\n\r\n").await;
            }
        });
        (handle, url)
    }

    /// 构造简单 zip（多文件同内容，Stored 压缩，供上限测试的确定性 fixture）。
    fn build_test_zip(files: &[&str], content: &[u8]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for name in files {
            writer.start_file(name.to_string(), options).expect("start_file");
            writer.write_all(content).expect("写入");
        }
        writer.finish().expect("finish").into_inner()
    }

    async fn write_http(
        sock: &mut tokio::net::TcpStream,
        status: u16,
        reason: &str,
        body: &[u8],
    ) {
        use tokio::io::AsyncWriteExt;
        let head = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = sock.write_all(head.as_bytes()).await;
        if !body.is_empty() {
            let _ = sock.write_all(body).await;
        }
    }

    /// 写入正常 zip（src 目录整体打包）。
    fn write_test_zip(zip_path: &Path, src: &Path) {
        let file = std::fs::File::create(zip_path).expect("创建 zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        fn add_dir(
            writer: &mut zip::ZipWriter<std::fs::File>,
            base: &Path,
            rel: &Path,
            options: zip::write::SimpleFileOptions,
        ) {
            for entry in std::fs::read_dir(base.join(rel)).expect("read_dir") {
                let entry = entry.expect("entry");
                let path = entry.path();
                let rel_path = rel.join(entry.file_name());
                if path.is_dir() {
                    let name = format!("{}/", rel_path.to_string_lossy().replace('\\', "/"));
                    writer
                        .add_directory(name, options)
                        .expect("add_directory");
                    add_dir(writer, base, &rel_path, options);
                } else {
                    let name = rel_path.to_string_lossy().replace('\\', "/");
                    writer
                        .start_file(name, options)
                        .expect("start_file");
                    std::io::copy(&mut std::fs::File::open(&path).expect("open"), writer)
                        .expect("copy");
                }
            }
        }
        add_dir(&mut writer, src, Path::new(""), options);
        writer.finish().expect("finish");
    }

    /// 写入含路径穿越条目的 zip（手工构造条目名）。
    fn write_evil_zip(zip_path: &Path, evil_name: &str, content: &[u8]) {
        let file = std::fs::File::create(zip_path).expect("创建 zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer
            .start_file(evil_name.to_string(), options)
            .expect("start_file");
        writer.write_all(content).expect("写入");
        writer.finish().expect("finish");
    }
}
