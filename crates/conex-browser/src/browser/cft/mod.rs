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
use std::path::{Path, PathBuf};
use std::time::Duration;

mod download;
mod extract;
mod locate;
#[cfg(test)]
mod tests;

pub use download::ensure_downloaded;
pub use extract::extract_zip;
pub use locate::{binary_rel_path, cft_root, find_cft_cached, platform_key};

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

/// 残留清理结果记录（best-effort）：上述删除对象均为本模块自管的
/// 下载缓存半成品/临时 zip（clippy 删除禁令的既有豁免面），删除失败不改写
/// 主流程结论（下载/解压本已失败或缓存本就损坏），但必须留痕——
/// 否则「清理成功」与「磁盘残留」无从区分。NotFound 视为已完成（幂等）。
fn log_cleanup_result(scene: &str, path: &Path, result: std::io::Result<()>) {
    match result {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("CfT {scene}失败（忽略）：{}：{e}", path.display()),
    }
}

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

/// 将 CftError 汇入 ProcessError（供 discover 汇总）。
impl From<CftError> for ProcessError {
    fn from(e: CftError) -> Self {
        ProcessError::Internal(format!("CfT 错误：{e}"))
    }
}
