//! CfT last-known-good 版本拉取、zip 下载（重试/资源上限）与版本缓存安装流程（自 cft.rs 平移）。

use super::extract::extract_zip_limited;
use super::locate::{cft_root, find_binary, platform_key, sanitize_version_dir};
use super::{log_cleanup_result, CftCache, CftError, CftLimits, DownloadOpts, LKG_URL};
use serde::Deserialize;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

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
async fn fetch_lkg(
    client: &reqwest::Client,
    url: &str,
    key: &str,
) -> Result<(String, String), CftError> {
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
    let items = lkg
        .channels
        .stable
        .downloads
        .chrome
        .ok_or_else(|| CftError::MissingDownload {
            platform: key.to_string(),
        })?;
    let url = items
        .iter()
        .find(|i| i.platform == key)
        .map(|i| i.url.clone())
        .ok_or_else(|| CftError::MissingDownload {
            platform: key.to_string(),
        })?;
    Ok((version, url))
}

/// 下载 zip（重试语义：连接失败/超时/5xx/I/O 重试，4xx 与超限立即失败）。
/// `max_bytes` 为响应字节上限（评审 29 §M7）：Content-Length 已知即超限 → 读取前
/// 中止（零写入）；分块流（无 Content-Length）→ 累积写出量超限中止。
/// 超限为确定性失败（重试无益）→ 不重试，最终失败路径清理半成品文件。
/// 豁免 clippy 删除禁令：失败残留清理是自家生成物（下载半成品），
/// 与「自管文件轮转」同豁免面（clippy.toml 注释），不留可恢复副本。
#[allow(clippy::disallowed_methods)]
pub(super) async fn download_zip(
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
                    log_cleanup_result("下载失败残留清理", dest, std::fs::remove_file(dest));
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
        // 半成品清理（上次失败残留）：失败不阻断本次重下，但必须留痕
        log_cleanup_result(
            "半成品目录清理",
            &dest_dir,
            std::fs::remove_dir_all(&dest_dir),
        );
    }
    std::fs::create_dir_all(&dest_dir)?;
    let zip_path = dest_dir.join("chrome.zip");
    if let Err(e) = download_zip(client, url, &zip_path, opts, limits.max_download_bytes).await {
        log_cleanup_result(
            "下载失败目录清理",
            &dest_dir,
            std::fs::remove_dir_all(&dest_dir),
        );
        return Err(e);
    }
    if let Err(e) = extract_zip_limited(&zip_path, &dest_dir, limits) {
        log_cleanup_result(
            "解压失败目录清理",
            &dest_dir,
            std::fs::remove_dir_all(&dest_dir),
        );
        return Err(e);
    }
    log_cleanup_result("临时 zip 清理", &zip_path, std::fs::remove_file(&zip_path));
    let Some(binary) = find_binary(&dest_dir) else {
        log_cleanup_result(
            "缺少二进制后的目录清理",
            &dest_dir,
            std::fs::remove_dir_all(&dest_dir),
        );
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
