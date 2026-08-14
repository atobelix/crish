//! 二进制发现与选择（维度 10 §2）
//!
//! 回退链（§2.1）：CfT 缓存 → （惰性下载 CfT）→ 系统 Chrome → 系统 Edge → 全失败
//! `NoBrowser`（含候选诊断清单，供前端 doctor 卡片渲染）。
//!
//! - 三平台路径表（§2.3）：Windows 完整实现（LOCALAPPDATA 展开），macOS/Linux 路径常量；
//! - 同一次引擎进程生命周期内只解析一次（进程内存缓存由调用方保证，§2.1）；
//! - CfT 下载属惰性按需（§2.1）：仅无缓存且调用方允许时才联网，离线直接跳回退链；
//! - 核心解析 `resolve_inner` 为纯函数（候选列表注入），单测用临时目录 fixture 全量覆盖。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use crate::browser::cft::{ensure_downloaded, find_cft_cached, CftCache, DownloadOpts};
use crate::browser::profile::browser_root;
use crate::browser::ProcessError;
use crate::cdp::transport::ExpectedBrowser;
use std::path::{Path, PathBuf};

/// 候选来源（doctor 诊断与安全门禁 provenance 依据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeSource {
    /// CfT 缓存（`browsers/chrome-<version>/`）。
    CftCache,
    /// CfT 惰性下载。
    CftDownload,
    /// 系统 Chrome。
    SystemChrome,
    /// 系统 Edge。
    SystemEdge,
}

/// 候选探测项：路径/来源 + 失败原因（全失败时汇入 `NoBrowser`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CandidateProbe {
    pub source: ProbeSource,
    pub path: PathBuf,
    /// None = 存在（命中）；Some(原因) = 未命中/损坏。
    pub reason: Option<String>,
}

/// 选定后端（§2.1 Backend 集）。
/// Debug 手动实现：**路径脱敏**（§7.3：日志面不落二进制路径，仅来源与版本）。
#[derive(Clone, PartialEq, Eq)]
pub enum Backend {
    ChromeForTesting { version: String, path: PathBuf },
    SystemChrome { path: PathBuf },
    SystemEdge { path: PathBuf },
}

impl std::fmt::Debug for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Backend::ChromeForTesting { version, .. } => {
                write!(f, "ChromeForTesting {{ version: {version:?} }}")
            }
            Backend::SystemChrome { .. } => f.write_str("SystemChrome"),
            Backend::SystemEdge { .. } => f.write_str("SystemEdge"),
        }
    }
}

impl Backend {
    /// 可执行文件路径。
    pub fn binary(&self) -> &Path {
        match self {
            Backend::ChromeForTesting { path, .. }
            | Backend::SystemChrome { path }
            | Backend::SystemEdge { path } => path,
        }
    }

    /// 身份校验产品名前缀（ExpectedBrowser 第 2 重校验依据）。
    pub fn product_prefix(&self) -> &'static str {
        match self {
            Backend::ChromeForTesting { .. } | Backend::SystemChrome { .. } => "Chrome/",
            Backend::SystemEdge { .. } => "Microsoft Edge/",
        }
    }
}

/// 解析结果（provenance 供维度 17 差异策略；version 启动后经 CDP 实测回填）。
/// Debug 手动实现：候选路径仅统计数量（§7.3 日志纪律）。
#[derive(Clone, PartialEq, Eq)]
pub struct BackendResolution {
    pub backend: Backend,
    /// 全部探测过的候选（含失败原因），供 doctor 与日志。
    pub probes: Vec<CandidateProbe>,
}

impl std::fmt::Debug for BackendResolution {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackendResolution")
            .field("backend", &self.backend)
            .field("probes", &self.probes.len())
            .finish()
    }
}

impl BackendResolution {
    /// 转换为 CDP 身份校验预期（§5.2 连接级验证）。
    pub fn expected_browser(&self) -> ExpectedBrowser {
        ExpectedBrowser {
            product_prefix: Some(self.backend.product_prefix().to_string()),
            min_major: Some(MIN_CHROMIUM_MAJOR),
        }
    }
}

/// 最低 Chromium 主版本线（11 文档 §6.3 降级表）。
pub const MIN_CHROMIUM_MAJOR: u64 = 120;

/// 后端覆盖（启动配置显式指定，Auto = 自动回退链）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BackendOverride {
    #[default]
    Auto,
    ChromeForTesting,
    SystemChrome,
    SystemEdge,
}

/// 解析选项（CfT 下载失败自动回退系统浏览器，不阻塞启动）。
#[derive(Clone, Default)]
pub struct ResolveOptions {
    /// 无缓存时是否允许惰性下载（§2.1：仅用户接受时才联网）。
    pub allow_cft_download: bool,
    /// 下载参数（重试/退避/进度）。
    pub download: DownloadOpts,
}

/// 对外入口：按平台路径表解析回退链。
pub async fn resolve_backend(
    data_root: &Path,
    override_: BackendOverride,
    opts: &ResolveOptions,
) -> Result<BackendResolution, ProcessError> {
    let root = browser_root(data_root);
    resolve_inner(
        &root,
        &platform::chrome_candidates(),
        &platform::edge_candidates(),
        override_,
        opts,
    )
    .await
}

/// 核心解析（候选列表注入，单测全量覆盖）。
async fn resolve_inner(
    root: &Path,
    chrome_candidates: &[PathBuf],
    edge_candidates: &[PathBuf],
    override_: BackendOverride,
    opts: &ResolveOptions,
) -> Result<BackendResolution, ProcessError> {
    let mut probes: Vec<CandidateProbe> = Vec::new();

    match override_ {
        BackendOverride::ChromeForTesting => {
            // 显式指定 CfT：缓存 → 下载 → 失败即报错（不回退系统）
            if let Some(cache) = find_cft_cached(root) {
                return Ok(cft_resolution(cache));
            }
            probes.push(CandidateProbe {
                source: ProbeSource::CftCache,
                path: root.join("browsers"),
                reason: Some("无 CfT 缓存".to_string()),
            });
            if opts.allow_cft_download {
                return match ensure_downloaded(root, &opts.download).await {
                    Ok(cache) => Ok(cft_resolution(cache)),
                    Err(e) => Err(ProcessError::NoBrowser(vec![CandidateProbe {
                        source: ProbeSource::CftDownload,
                        path: root.join("browsers"),
                        reason: Some(format!("CfT 下载失败：{e}")),
                    }])),
                };
            }
            return Err(ProcessError::NoBrowser(probes));
        }
        BackendOverride::SystemChrome => {
            if let Some(backend) =
                first_existing(ProbeSource::SystemChrome, chrome_candidates, &mut probes)
            {
                return Ok(BackendResolution { backend, probes });
            }
            return Err(ProcessError::NoBrowser(probes));
        }
        BackendOverride::SystemEdge => {
            if let Some(backend) =
                first_existing(ProbeSource::SystemEdge, edge_candidates, &mut probes)
            {
                return Ok(BackendResolution { backend, probes });
            }
            return Err(ProcessError::NoBrowser(probes));
        }
        BackendOverride::Auto => {}
    }

    // —— 自动回退链（§2.1 第 1-5 步）——
    // 1. CfT 缓存
    if let Some(cache) = find_cft_cached(root) {
        return Ok(cft_resolution(cache));
    }
    probes.push(CandidateProbe {
        source: ProbeSource::CftCache,
        path: root.join("browsers"),
        reason: Some("无 CfT 缓存".to_string()),
    });
    // 2. 惰性下载（仅用户接受时；失败继续回退，不阻塞启动）
    if opts.allow_cft_download {
        match ensure_downloaded(root, &opts.download).await {
            Ok(cache) => return Ok(cft_resolution(cache)),
            Err(e) => {
                probes.push(CandidateProbe {
                    source: ProbeSource::CftDownload,
                    path: root.join("browsers"),
                    reason: Some(format!("CfT 下载失败：{e}")),
                });
                tracing::warn!("CfT 下载失败，回退系统浏览器：{e}");
            }
        }
    }
    // 3. 系统 Chrome
    if let Some(backend) = first_existing(ProbeSource::SystemChrome, chrome_candidates, &mut probes)
    {
        return Ok(BackendResolution { backend, probes });
    }
    // 4. 系统 Edge
    if let Some(backend) = first_existing(ProbeSource::SystemEdge, edge_candidates, &mut probes) {
        return Ok(BackendResolution { backend, probes });
    }
    // 5. 全失败：doctor 诊断清单（§2.4）
    Err(ProcessError::NoBrowser(probes))
}

fn cft_resolution(cache: CftCache) -> BackendResolution {
    BackendResolution {
        backend: Backend::ChromeForTesting {
            version: cache.version.clone(),
            path: cache.binary.clone(),
        },
        probes: vec![CandidateProbe {
            source: ProbeSource::CftCache,
            path: cache.binary,
            reason: None,
        }],
    }
}

/// 按顺序取第一个存在的文件（记录全部探测项）。
fn first_existing(
    source: ProbeSource,
    candidates: &[PathBuf],
    probes: &mut Vec<CandidateProbe>,
) -> Option<Backend> {
    for p in candidates {
        if p.is_file() {
            probes.push(CandidateProbe {
                source,
                path: p.clone(),
                reason: None,
            });
            let backend = match source {
                ProbeSource::SystemChrome => Backend::SystemChrome { path: p.clone() },
                ProbeSource::SystemEdge => Backend::SystemEdge { path: p.clone() },
                _ => unreachable!("仅系统浏览器走 first_existing"),
            };
            return Some(backend);
        }
        probes.push(CandidateProbe {
            source,
            path: p.clone(),
            reason: Some("文件不存在".to_string()),
        });
    }
    None
}

// ---------- 三平台路径表（§2.3 / §8 差异表收敛点） ----------

#[cfg(windows)]
mod platform {
    /// 系统 Chrome 候选（按探测顺序；LOCALAPPDATA 优先，用户级安装不依赖 Program Files 权限）。
    pub fn chrome_candidates() -> Vec<std::path::PathBuf> {
        let mut v = Vec::new();
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            v.push(
                std::path::PathBuf::from(la)
                    .join("Google")
                    .join("Chrome")
                    .join("Application")
                    .join("chrome.exe"),
            );
        }
        v.push(std::path::PathBuf::from(
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ));
        v.push(std::path::PathBuf::from(
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ));
        v
    }

    /// 系统 Edge 候选（按探测顺序）。
    pub fn edge_candidates() -> Vec<std::path::PathBuf> {
        let mut v = Vec::new();
        v.push(std::path::PathBuf::from(
            "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ));
        v.push(std::path::PathBuf::from(
            "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        ));
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            v.push(
                std::path::PathBuf::from(la)
                    .join("Microsoft")
                    .join("Edge")
                    .join("Application")
                    .join("msedge.exe"),
            );
        }
        v
    }
}

#[cfg(target_os = "macos")]
mod platform {
    /// 系统 Chrome 候选（§2.3 macOS 路径常量，逐项 exists 判断）。
    pub fn chrome_candidates() -> Vec<std::path::PathBuf> {
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
        .iter()
        .map(std::path::PathBuf::from)
        .collect()
    }

    /// 系统 Edge 候选（§2.3 macOS 路径常量）。
    pub fn edge_candidates() -> Vec<std::path::PathBuf> {
        ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
            .iter()
            .map(std::path::PathBuf::from)
            .collect()
    }
}

#[cfg(target_os = "linux")]
mod platform {
    /// PATH 中解析命令名（`which` 语义，参考 agent-browser chrome.rs:885-905）。
    fn which(name: &str) -> Option<std::path::PathBuf> {
        let path = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// 系统 Chrome 候选：chromium 系列最后（协议漂移面最大）。
    pub fn chrome_candidates() -> Vec<std::path::PathBuf> {
        [
            "google-chrome",
            "google-chrome-stable",
            "chromium-browser",
            "chromium",
        ]
        .iter()
        .filter_map(|n| which(n))
        .collect()
    }

    /// 系统 Edge 候选。
    pub fn edge_candidates() -> Vec<std::path::PathBuf> {
        ["microsoft-edge", "microsoft-edge-stable"]
            .iter()
            .filter_map(|n| which(n))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_bin(dir: &std::path::Path, rel: &str) -> PathBuf {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).expect("父目录");
        }
        std::fs::write(&p, b"fake").expect("写入假二进制");
        p
    }

    /// 平台路径表形态断言（跨平台可跑）。
    #[test]
    fn path_tables_shape() {
        #[cfg(windows)]
        {
            assert_eq!(
                platform::chrome_candidates().len(),
                3,
                "Windows Chrome 3 项（LOCALAPPDATA 优先）"
            );
            assert_eq!(platform::edge_candidates().len(), 3);
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(platform::chrome_candidates().len(), 2);
            assert_eq!(platform::edge_candidates().len(), 1);
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!(platform::chrome_candidates().len(), 4);
            assert_eq!(platform::edge_candidates().len(), 2);
        }
    }

    /// 回退链 1：CfT 缓存存在 → 不回退系统（临时目录 fixture）。
    #[tokio::test]
    async fn priority_cft_over_system() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let cache_dir = root.join("browsers").join("chrome-151.0.7922.77");
        std::fs::create_dir_all(&cache_dir).expect("缓存目录");
        let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
        let bin = cache_dir.join(rel);
        std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
        std::fs::write(&bin, b"fake").expect("二进制");
        // 系统候选也伪造存在，验证 CfT 优先
        let chrome = vec![tmp_bin(dir.path(), "sys/chrome.exe")];
        let res = resolve_inner(
            &root,
            &chrome,
            &[],
            BackendOverride::Auto,
            &ResolveOptions::default(),
        )
        .await
        .expect("应命中 CfT");
        match res.backend {
            Backend::ChromeForTesting { version, path } => {
                assert_eq!(version, "151.0.7922.77");
                assert_eq!(path, bin);
            }
            other => panic!("应为 CfT，实际：{other:?}"),
        }
        assert_eq!(res.probes.len(), 1);
        assert_eq!(res.probes[0].source, ProbeSource::CftCache);
    }

    /// 回退链 2：CfT 缺失 → 系统 Chrome。
    #[tokio::test]
    async fn fallback_to_system_chrome() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let chrome = vec![tmp_bin(dir.path(), "sys/chrome.exe")];
        let edge = vec![tmp_bin(dir.path(), "sys/msedge.exe")];
        let res = resolve_inner(
            &root,
            &chrome,
            &edge,
            BackendOverride::Auto,
            &ResolveOptions::default(),
        )
        .await
        .expect("应命中 Chrome");
        assert!(matches!(res.backend, Backend::SystemChrome { .. }));
        assert_eq!(res.probes.len(), 2, "CfT 缺失 + Chrome 命中");
    }

    /// 回退链 3：Chrome 缺失 → 系统 Edge。
    #[tokio::test]
    async fn fallback_to_system_edge() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let edge = vec![tmp_bin(dir.path(), "sys/msedge.exe")];
        let res = resolve_inner(
            &root,
            &[],
            &edge,
            BackendOverride::Auto,
            &ResolveOptions::default(),
        )
        .await
        .expect("应命中 Edge");
        assert!(matches!(res.backend, Backend::SystemEdge { .. }));
    }

    /// 回退链 4：全缺失 → NoBrowser 含候选清单（doctor）。
    #[tokio::test]
    async fn no_browser_error_lists_probes() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let chrome = vec![
            dir.path().join("c1.exe"),
            dir.path().join("c2.exe"),
            dir.path().join("c3.exe"),
        ];
        let edge = vec![dir.path().join("e1.exe"), dir.path().join("e2.exe")];
        let err = resolve_inner(
            &root,
            &chrome,
            &edge,
            BackendOverride::Auto,
            &ResolveOptions::default(),
        )
        .await
        .expect_err("应全失败");
        match err {
            ProcessError::NoBrowser(probes) => {
                assert_eq!(probes.len(), 6, "全部候选进入诊断清单");
                assert!(
                    probes.iter().all(|p| p.reason.is_some()),
                    "失败候选必须携带原因"
                );
                assert_eq!(
                    probes
                        .iter()
                        .filter(|p| p.source == ProbeSource::SystemChrome)
                        .count(),
                    3
                );
                assert_eq!(
                    probes
                        .iter()
                        .filter(|p| p.source == ProbeSource::SystemEdge)
                        .count(),
                    2
                );
                assert_eq!(
                    probes
                        .iter()
                        .filter(|p| p.source == ProbeSource::CftCache)
                        .count(),
                    1
                );
            }
            other => panic!("应为 NoBrowser，实际：{other:?}"),
        }
    }

    /// 显式覆盖：指定 ChromeForTesting 但无缓存 → 报错（不回退系统）。
    #[tokio::test]
    async fn override_cft_without_cache_errors() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let chrome = vec![tmp_bin(dir.path(), "sys/chrome.exe")];
        let err = resolve_inner(
            &root,
            &chrome,
            &[],
            BackendOverride::ChromeForTesting,
            &ResolveOptions::default(),
        )
        .await
        .expect_err("应失败");
        assert!(matches!(err, ProcessError::NoBrowser(_)));
    }

    /// 显式覆盖：指定 SystemChrome → 不走 Edge 回退。
    #[tokio::test]
    async fn override_system_chrome_skips_edge() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let edge = vec![tmp_bin(dir.path(), "sys/msedge.exe")];
        let err = resolve_inner(
            &root,
            &[],
            &edge,
            BackendOverride::SystemChrome,
            &ResolveOptions::default(),
        )
        .await
        .expect_err("应失败（不回退 Edge）");
        assert!(matches!(err, ProcessError::NoBrowser(_)));
    }

    /// ExpectedBrowser 生产：Chrome 前缀 + 最低版本线；Edge 前缀。
    #[test]
    fn expected_browser_from_backend() {
        let res = BackendResolution {
            backend: Backend::SystemChrome {
                path: PathBuf::from("x"),
            },
            probes: vec![],
        };
        let expected = res.expected_browser();
        assert_eq!(expected.product_prefix.as_deref(), Some("Chrome/"));
        assert_eq!(expected.min_major, Some(MIN_CHROMIUM_MAJOR));

        let edge = BackendResolution {
            backend: Backend::SystemEdge {
                path: PathBuf::from("x"),
            },
            probes: vec![],
        };
        assert_eq!(
            edge.expected_browser().product_prefix.as_deref(),
            Some("Microsoft Edge/")
        );
    }

    /// 失败候选 reason 语义：命中项为 None（此前缺失项带原因）。
    #[tokio::test]
    async fn hit_probe_has_no_reason() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let chrome = vec![tmp_bin(dir.path(), "sys/chrome.exe")];
        let res = resolve_inner(
            &root,
            &chrome,
            &[],
            BackendOverride::Auto,
            &ResolveOptions::default(),
        )
        .await
        .expect("命中");
        assert_eq!(res.probes.len(), 2, "CfT 缺失项 + Chrome 命中项");
        assert!(res.probes[0].reason.is_some(), "缺失项带原因");
        assert!(res.probes[1].reason.is_none(), "命中项 reason=None");
        assert_eq!(res.probes[1].source, ProbeSource::SystemChrome);
    }

    // ---------- 公开入口与回退链边界（评审 P2 补强） ----------

    /// 公开入口 resolve_backend：临时 data_root 内建 CfT 缓存 → 必中 CfT
    /// （数据根布局 `conex/browser/browsers/` 语义端到端验证，不依赖系统浏览器）。
    #[tokio::test]
    async fn resolve_backend_entry_cft_cache_hit() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let cache_dir = root.join("browsers").join("chrome-153.0.1.2");
        let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
        let bin = cache_dir.join(rel);
        std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
        std::fs::write(&bin, b"fake").expect("二进制");

        let res = resolve_backend(
            dir.path(),
            BackendOverride::Auto,
            &ResolveOptions::default(),
        )
        .await
        .expect("公开入口应命中 CfT");
        match res.backend {
            Backend::ChromeForTesting { version, path } => {
                assert_eq!(version, "153.0.1.2");
                assert_eq!(path, bin);
            }
            other => panic!("应为 CfT，实际：{other:?}"),
        }
        assert_eq!(res.probes.len(), 1, "命中即止，无回退探测");
        assert_eq!(res.probes[0].source, ProbeSource::CftCache);
    }

    /// 公开入口契约：空 data_root + Auto → 结果形态自洽（环境无关断言）——
    /// 命中则末项 reason=None；全失败则全部候选带原因且含 CfT 缺失项。
    #[tokio::test]
    async fn resolve_backend_entry_contract_any_environment() {
        let dir = tempfile::tempdir().expect("临时目录");
        let res = resolve_backend(
            dir.path(),
            BackendOverride::Auto,
            &ResolveOptions::default(),
        )
        .await;
        match res {
            Ok(res) => {
                assert!(
                    matches!(
                        res.backend,
                        Backend::SystemChrome { .. } | Backend::SystemEdge { .. }
                    ),
                    "无 CfT 缓存时只能命中系统浏览器：{:?}",
                    res.backend
                );
                let last = res.probes.last().expect("命中必有探测记录");
                assert!(last.reason.is_none(), "命中项 reason=None");
                let hit_source = match &res.backend {
                    Backend::SystemChrome { .. } => ProbeSource::SystemChrome,
                    Backend::SystemEdge { .. } => ProbeSource::SystemEdge,
                    Backend::ChromeForTesting { .. } => ProbeSource::CftCache,
                };
                assert_eq!(last.source, hit_source);
            }
            Err(ProcessError::NoBrowser(probes)) => {
                assert!(!probes.is_empty(), "doctor 清单不得为空");
                assert!(
                    probes.iter().all(|p| p.reason.is_some()),
                    "全失败时每个候选必须携带原因"
                );
                assert!(
                    probes.iter().any(|p| p.source == ProbeSource::CftCache),
                    "doctor 清单必须含 CfT 缺失项"
                );
            }
            Err(other) => panic!("Auto 回退链不得返回其他错误：{other:?}"),
        }
    }

    /// 显式覆盖 SystemEdge：即使 Chrome 候选存在也必须走 Edge 且不探测 Chrome。
    #[tokio::test]
    async fn override_system_edge_skips_chrome() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let chrome = vec![tmp_bin(dir.path(), "sys/chrome.exe")];
        let edge = vec![tmp_bin(dir.path(), "sys/msedge.exe")];
        let res = resolve_inner(
            &root,
            &chrome,
            &edge,
            BackendOverride::SystemEdge,
            &ResolveOptions::default(),
        )
        .await
        .expect("应命中 Edge");
        assert!(matches!(res.backend, Backend::SystemEdge { .. }));
        assert_eq!(res.probes.len(), 1, "仅 Edge 被探测（不经过 CfT/Chrome）");
        assert_eq!(res.probes[0].source, ProbeSource::SystemEdge);
    }

    /// 显式覆盖 ChromeForTesting + 禁止下载：错误载荷只含 CftCache 诊断项。
    #[tokio::test]
    async fn override_cft_no_download_single_probe() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let chrome = vec![tmp_bin(dir.path(), "sys/chrome.exe")];
        let err = resolve_inner(
            &root,
            &chrome,
            &[],
            BackendOverride::ChromeForTesting,
            &ResolveOptions::default(),
        )
        .await
        .expect_err("应失败");
        match err {
            ProcessError::NoBrowser(probes) => {
                assert_eq!(probes.len(), 1, "不回退系统时仅 CfT 缓存一项诊断");
                assert_eq!(probes[0].source, ProbeSource::CftCache);
                assert!(probes[0].reason.is_some());
            }
            other => panic!("应为 NoBrowser，实际：{other:?}"),
        }
    }

    /// 多候选按序探测：首个缺失、第二个存在 → 命中第二个（probe 顺序保真）。
    #[tokio::test]
    async fn first_existing_picks_first_valid() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = browser_root(dir.path());
        let missing = dir.path().join("sys/chrome-missing.exe");
        let hit = tmp_bin(dir.path(), "sys/chrome-hit.exe");
        let res = resolve_inner(
            &root,
            &[missing.clone(), hit.clone()],
            &[],
            BackendOverride::SystemChrome,
            &ResolveOptions::default(),
        )
        .await
        .expect("第二个候选应命中");
        assert_eq!(res.backend.binary(), &hit, "必须选中存在者");
        assert_eq!(res.probes.len(), 2);
        assert_eq!(res.probes[0].path, missing);
        assert!(res.probes[0].reason.is_some(), "缺失项带原因");
        assert_eq!(res.probes[1].path, hit);
        assert!(res.probes[1].reason.is_none());
    }

    /// Debug 脱敏（§7.3）：Backend/BackendResolution 日志面不落二进制路径。
    #[test]
    fn backend_debug_redacts_paths() {
        let secret_path = "C:\\Users\\secret-user\\AppData\\Local\\chrome.exe";
        let backend = Backend::SystemChrome {
            path: PathBuf::from(secret_path),
        };
        let debug = format!("{backend:?}");
        assert!(!debug.contains("secret-user"), "Debug 不得含路径：{debug}");
        assert!(!debug.contains("chrome.exe"), "Debug 不得含文件名：{debug}");

        let resolution = BackendResolution {
            backend,
            probes: vec![CandidateProbe {
                source: ProbeSource::SystemChrome,
                path: PathBuf::from(secret_path),
                reason: None,
            }],
        };
        let debug = format!("{resolution:?}");
        assert!(
            !debug.contains("secret-user"),
            "Resolution Debug 不得含路径：{debug}"
        );
        assert!(debug.contains("probes: 1"), "候选仅统计数量：{debug}");
    }
}
