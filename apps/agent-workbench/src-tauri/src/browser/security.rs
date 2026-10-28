//! 原生浏览器物理存储分区与安全门控实现
//!
//! 核心职责（对齐 00-总方案 §2 D2/D5 与 03-分维详案）：
//! 1. 物理存储路径解析（[resolve_browser_udf_path]）：
//!    - Persistent 模式：指向系统 LocalAppData 下 `io.github.conex-community.crish/browser-storage`，
//!      实现 Cookie、LocalStorage 与 HTTP 磁盘缓存的长期留存，支持 Google/GitHub 账号跨重启登录；
//!    - Ephemeral 模式：按 03-分维 §3.4 设计由命令层按 Tab 分配
//!      `browser-storage/ephemeral-{tabId}` 临时子目录（任务终态随 Tab 关闭销毁，
//!      应用退出统一兜底清理），本模块不直接解析 Ephemeral 路径；
//! 2. 导航安全检查门禁（[validate_navigation_url]）：
//!    - 仅放行 `http:`, `https:`, `about:blank` 白名单；
//!    - 本地文件 `file:` 严格经 `canonicalize` 检验限定在 `workspace_root` 内；
//!      **调用方未提供 workspace_root 时 `file:` 一律拒绝**（03-分维 §7.3 第 1 条：
//!      公网上下文对本地文件零泄露，这是本门禁的缺省安全面）；
//!    - 绝对阻断 `javascript:`, `vbscript:`, `data:` 顶层导航及 Windows 自定义私有 scheme；
//! 3. 自签名证书判定（[is_trusted_certificate_target]）：
//!    - 自动豁免 `localhost` / `127.0.0.1` 等本地环回开发服务，保障本地开发调试顺畅。

#![allow(dead_code)]

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use tracing::warn;
use url::Url;

/// 原生浏览器存储分区模式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BrowserStorageMode {
    /// 持久化模式：用户日常浏览，长期持久化 Cookie、LocalStorage 与磁盘缓存
    #[default]
    Persistent,
    /// 临时沙箱模式：Agent 自动化任务或无痕浏览，数据留存内存与临时目录，会话结束自毁
    Ephemeral,
}

/// 导航安全拦截原因枚举
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SecurityDenial {
    /// 非法或畸形 URL 格式
    InvalidUrl(String),
    /// 非白名单或显式禁用的标准协议 (如 javascript:, data:, vbscript:, about:config 等)
    DisallowedScheme { scheme: String, url: String },
    /// 本地文件越界或未授权访问 (file: 协议未受管或跳出工作区)
    DisallowedFileAccess { path: String, reason: String },
    /// 拦截 Windows 操作系统自定义应用私有 Scheme (如 calc:, vscode:, slack: 等)
    DisallowedCustomScheme { scheme: String, url: String },
    /// 其他安全拒绝原因
    Other(String),
}

impl std::fmt::Display for SecurityDenial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(err) => write!(f, "Invalid URL format: {err}"),
            Self::DisallowedScheme { scheme, url } => {
                write!(f, "Disallowed scheme '{scheme}' in navigation URL '{url}'")
            }
            Self::DisallowedFileAccess { path, reason } => {
                write!(f, "Disallowed file access to '{path}': {reason}")
            }
            Self::DisallowedCustomScheme { scheme, url } => {
                write!(f, "Disallowed custom scheme '{scheme}' in URL '{url}'")
            }
            Self::Other(msg) => write!(f, "Security denial: {msg}"),
        }
    }
}

impl std::error::Error for SecurityDenial {}

/// 解析原生浏览器专属的 UserDataFolder (UDF) 物理路径
///
/// 物理隔离保障：
/// - 宿主应用使用 `host-runtime` 目录，原生浏览器使用 `browser-storage`；
/// - 操作系统层面触发独立的 `msedgewebview2.exe` 进程池，物理阻绝共享内存与文件渗透。
pub fn resolve_browser_udf_path(mode: BrowserStorageMode) -> Result<PathBuf, std::io::Error> {
    match mode {
        BrowserStorageMode::Persistent => {
            let base = dirs::data_local_dir()
                .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
                .or_else(dirs::data_dir)
                .unwrap_or_else(std::env::temp_dir);

            let path = base
                .join(crate::host_paths::APP_IDENTIFIER)
                .join("browser-storage");
            std::fs::create_dir_all(&path)?;
            Ok(path)
        }
        BrowserStorageMode::Ephemeral => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Ephemeral UDF 由命令层按 Tab 分配（03-分维 §3.4 设计：\
             browser-storage/ephemeral-{tabId}，随 Tab 关闭销毁）；\
             管理器不得绕过 Tab 语义自行解析临时目录",
        )),
    }
}

/// 导航安全检查门禁
///
/// 校验规则：
/// 1. 白名单放行：`http:`, `https:`, `about:blank`；
/// 2. 本地文件 `file:`：必须提供有效 `workspace_root`，且经 `canonicalize` 严格检验限定在工作区目录内；
/// 3. 绝对阻断：`javascript:`, `vbscript:`, `data:` 顶层导航及 Windows 自定义私有 scheme（防范 RCE 与参数注入）。
pub fn validate_navigation_url(
    url: &str,
    workspace_root: Option<&Path>,
) -> Result<(), SecurityDenial> {
    let trimmed = url.trim();

    // 1. 特例放行：about:blank
    if trimmed == "about:blank" {
        return Ok(());
    }

    // 2. 阻断非 blank 的 about: 内部协议 (如 about:config, about:flags 等)
    if trimmed.starts_with("about:") {
        warn!(target: "browser_security", "拦截非 blank 的 about 协议: {}", trimmed);
        return Err(SecurityDenial::DisallowedScheme {
            scheme: "about".to_string(),
            url: url.to_string(),
        });
    }

    // 3. 解析 URL 结构
    let parsed = Url::parse(trimmed).map_err(|e| SecurityDenial::InvalidUrl(e.to_string()))?;
    let scheme = parsed.scheme().to_ascii_lowercase();

    match scheme.as_str() {
        // 白名单放行标准 Web 协议
        "https" | "http" => Ok(()),

        // 严格受管的本地 file: 协议
        "file" => {
            let root = workspace_root.ok_or_else(|| SecurityDenial::DisallowedFileAccess {
                path: url.to_string(),
                reason: "本地文件浏览必须提供明确的工作区根目录 (Workspace Root)".to_string(),
            })?;

            let target_path =
                parsed
                    .to_file_path()
                    .map_err(|_| SecurityDenial::DisallowedFileAccess {
                        path: url.to_string(),
                        reason: "无法将 file:// URL 转换为合法的本地文件系统路径".to_string(),
                    })?;

            let canonical_root =
                root.canonicalize()
                    .map_err(|e| SecurityDenial::DisallowedFileAccess {
                        path: root.display().to_string(),
                        reason: format!("工作区根目录无法规范化 (canonicalize): {e}"),
                    })?;

            // 目标文件若存在则直接规范化；若不存在则校验其存在的最近祖先目录
            let canonical_target = if target_path.exists() {
                target_path
                    .canonicalize()
                    .map_err(|e| SecurityDenial::DisallowedFileAccess {
                        path: target_path.display().to_string(),
                        reason: format!("目标文件规范化失败: {e}"),
                    })?
            } else {
                let mut ancestor = target_path.as_path();
                while let Some(parent) = ancestor.parent() {
                    if parent.exists() {
                        let canonical_parent = parent.canonicalize().map_err(|e| {
                            SecurityDenial::DisallowedFileAccess {
                                path: parent.display().to_string(),
                                reason: format!("父目录规范化失败: {e}"),
                            }
                        })?;
                        if !canonical_parent.starts_with(&canonical_root) {
                            return Err(SecurityDenial::DisallowedFileAccess {
                                path: target_path.display().to_string(),
                                reason: format!(
                                    "文件路径逃逸出工作区根目录: {}",
                                    canonical_root.display()
                                ),
                            });
                        }
                        break;
                    }
                    ancestor = parent;
                }
                return Err(SecurityDenial::DisallowedFileAccess {
                    path: target_path.display().to_string(),
                    reason: "目标文件在工作区内不存在".to_string(),
                });
            };

            if canonical_target.starts_with(&canonical_root) {
                Ok(())
            } else {
                warn!(
                    target: "browser_security",
                    "拦截跨越工作区边界的本地文件访问: target={}, root={}",
                    canonical_target.display(),
                    canonical_root.display()
                );
                Err(SecurityDenial::DisallowedFileAccess {
                    path: canonical_target.display().to_string(),
                    reason: format!("文件路径逃逸出工作区根目录: {}", canonical_root.display()),
                })
            }
        }

        // 显式高危脚本与数据协议硬阻断
        "javascript" | "vbscript" | "data" => {
            warn!(target: "browser_security", "拦截高危脚本/数据协议: scheme={}, url={}", scheme, url);
            Err(SecurityDenial::DisallowedScheme {
                scheme,
                url: url.to_string(),
            })
        }

        // 浏览器内部保留调试协议阻断
        "chrome" | "edge" | "devtools" | "view-source" => {
            warn!(target: "browser_security", "拦截浏览器内部特权协议: scheme={}, url={}", scheme, url);
            Err(SecurityDenial::DisallowedScheme {
                scheme,
                url: url.to_string(),
            })
        }

        // 阻断 Windows 操作系统私有 Scheme (防止参数注入与 RCE)
        _ => {
            warn!(target: "browser_security", "拦截未授权的系统/私有协议 Scheme: scheme={}, url={}", scheme, url);
            Err(SecurityDenial::DisallowedCustomScheme {
                scheme,
                url: url.to_string(),
            })
        }
    }
}

/// 自签名证书信任判定
///
/// 判定目标主机是否为本地环回开发服务：
/// - 自动豁免 `localhost`、`127.0.0.1`、`[::1]`、`*.localhost` 等开发环境；
/// - 公网与远程主机一律不予豁免，确保真实公网环境下的 TLS 证书安全性。
pub fn is_trusted_certificate_target(host: &str) -> bool {
    let trimmed = host.trim();
    if trimmed.is_empty() {
        return false;
    }

    // 剔除可能的端口号（如 "localhost:5173" -> "localhost"，"[::1]:3000" -> "::1"）
    let clean_host = if let Some(stripped) = trimmed.strip_prefix('[') {
        if let Some(end_bracket) = stripped.find(']') {
            &stripped[..end_bracket]
        } else {
            trimmed
        }
    } else if trimmed.matches(':').count() == 1 {
        // 仅单个冒号为 IPv4:port 或 hostname:port，如 "localhost:5173"
        trimmed.split_once(':').map(|(h, _)| h).unwrap_or(trimmed)
    } else {
        // 无冒号（如 "localhost"）或多个冒号的原始 IPv6（如 "::1"）
        trimmed
    };

    let lower = clean_host.to_ascii_lowercase();

    // 1. 本地标准主机名
    if lower == "localhost" || lower.ends_with(".localhost") {
        return true;
    }

    // 2. 本地特殊 IPv4 / IPv6 文本字面量
    if lower == "127.0.0.1" || lower == "0.0.0.0" || lower == "::1" {
        return true;
    }

    // 3. 解析为 IP 地址并判定是否为 Loopback 环回地址
    if let Ok(ip) = clean_host.parse::<IpAddr>() {
        if ip.is_loopback() {
            return true;
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn test_resolve_browser_udf_path_persistent() {
        let path =
            resolve_browser_udf_path(BrowserStorageMode::Persistent).expect("UDF should resolve");
        assert!(path
            .to_string_lossy()
            .contains(crate::host_paths::APP_IDENTIFIER));
        assert!(path.to_string_lossy().contains("browser-storage"));
        assert!(path.exists());
    }

    #[test]
    fn test_resolve_browser_udf_path_ephemeral_is_command_layer_responsibility() {
        // Ephemeral 路径不归本模块解析（03-分维 §3.4：按 Tab 由命令层分配）
        let res = resolve_browser_udf_path(BrowserStorageMode::Ephemeral);
        assert!(res.is_err(), "Ephemeral 解析应响亮报错而非生成孤儿目录");
    }

    #[test]
    fn test_validate_navigation_whitelist() {
        assert!(validate_navigation_url("https://google.com", None).is_ok());
        assert!(validate_navigation_url("http://localhost:5173", None).is_ok());
        assert!(validate_navigation_url("http://127.0.0.1:3000/app", None).is_ok());
        assert!(validate_navigation_url("about:blank", None).is_ok());
    }

    #[test]
    fn test_validate_navigation_disallowed_schemes() {
        // about:config
        let res = validate_navigation_url("about:config", None);
        assert!(
            matches!(res, Err(SecurityDenial::DisallowedScheme { scheme, .. }) if scheme == "about")
        );

        // javascript:
        let res = validate_navigation_url("javascript:alert(1)", None);
        assert!(
            matches!(res, Err(SecurityDenial::DisallowedScheme { scheme, .. }) if scheme == "javascript")
        );

        // data:
        let res = validate_navigation_url("data:text/html,<b>pwn</b>", None);
        assert!(
            matches!(res, Err(SecurityDenial::DisallowedScheme { scheme, .. }) if scheme == "data")
        );

        // vbscript:
        let res = validate_navigation_url("vbscript:msgbox", None);
        assert!(
            matches!(res, Err(SecurityDenial::DisallowedScheme { scheme, .. }) if scheme == "vbscript")
        );

        // chrome / edge
        let res = validate_navigation_url("chrome://settings", None);
        assert!(
            matches!(res, Err(SecurityDenial::DisallowedScheme { scheme, .. }) if scheme == "chrome")
        );

        // windows custom schemes
        let res = validate_navigation_url("calc:", None);
        assert!(
            matches!(res, Err(SecurityDenial::DisallowedCustomScheme { scheme, .. }) if scheme == "calc")
        );

        let res = validate_navigation_url("vscode://file/C:/app", None);
        assert!(
            matches!(res, Err(SecurityDenial::DisallowedCustomScheme { scheme, .. }) if scheme == "vscode")
        );
    }

    #[test]
    #[allow(clippy::disallowed_methods)] // 测试临时目录清理
    fn test_validate_navigation_file_protocol() {
        let temp_dir = std::env::temp_dir().join("conex-security-test-root");
        std::fs::create_dir_all(&temp_dir).unwrap();
        let valid_file = temp_dir.join("test.html");
        File::create(&valid_file).unwrap();

        let file_url = Url::from_file_path(&valid_file).unwrap().to_string();

        // 1. 无 workspace_root 必须拦截
        let res = validate_navigation_url(&file_url, None);
        assert!(matches!(
            res,
            Err(SecurityDenial::DisallowedFileAccess { .. })
        ));

        // 2. 在 workspace_root 内放行
        let res = validate_navigation_url(&file_url, Some(&temp_dir));
        assert!(res.is_ok());

        // 3. 越界访问敏感系统文件拦截
        let outside_file = if cfg!(windows) {
            "file:///C:/Windows/System32/drivers/etc/hosts"
        } else {
            "file:///etc/hosts"
        };
        let res = validate_navigation_url(outside_file, Some(&temp_dir));
        assert!(matches!(
            res,
            Err(SecurityDenial::DisallowedFileAccess { .. })
        ));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_is_trusted_certificate_target() {
        assert!(is_trusted_certificate_target("localhost"));
        assert!(is_trusted_certificate_target("localhost:5173"));
        assert!(is_trusted_certificate_target("127.0.0.1"));
        assert!(is_trusted_certificate_target("127.0.0.1:8080"));
        assert!(is_trusted_certificate_target("::1"));
        assert!(is_trusted_certificate_target("[::1]:3000"));
        assert!(is_trusted_certificate_target("sub.localhost"));
        assert!(is_trusted_certificate_target("dev.app.localhost:4000"));

        assert!(!is_trusted_certificate_target("google.com"));
        assert!(!is_trusted_certificate_target("github.com:443"));
        assert!(!is_trusted_certificate_target("192.168.1.1"));
        assert!(!is_trusted_certificate_target(""));
    }
}
