//! 外部 URL 打开：只允许 http / https / mailto，交给系统默认浏览器。
//!
//! Markdown 外链统一走这里，前端不再使用 `window.open`（避免 WebView2
//! 内部导航与仿冒宿主风险）。

use conex_types::CoreError;

use super::execute::open_with_shell_execute;

/// 校验并交给系统默认浏览器打开外部 URL。
///
/// 仅允许 http / https / mailto；拒绝凭据、控制字符、空白与超长输入。
pub(crate) fn open_external_url(url: String) -> Result<(), CoreError> {
    let validated = validate_external_url(&url)?;
    launch_external_url(&validated)
}

fn validate_external_url(raw: &str) -> Result<String, CoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CoreError::InvalidInput("external URL is empty".to_string()));
    }
    if trimmed.len() > 8192 {
        return Err(CoreError::InvalidInput(
            "external URL exceeds 8192 bytes".to_string(),
        ));
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(CoreError::InvalidInput(
            "external URL contains whitespace/control characters".to_string(),
        ));
    }
    let parsed = url::Url::parse(trimmed)
        .map_err(|error| CoreError::InvalidInput(format!("invalid external URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(CoreError::InvalidInput(
            "only http/https/mailto URLs may be opened externally".to_string(),
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(CoreError::InvalidInput(
            "external URL must not contain credentials".to_string(),
        ));
    }
    Ok(parsed.to_string())
}

#[allow(clippy::disallowed_methods)]
fn launch_external_url(url: &str) -> Result<(), CoreError> {
    #[cfg(windows)]
    {
        let owned = url.to_string();
        let handle = std::thread::spawn(move || open_with_shell_execute(&owned));
        match handle.join() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => Err(CoreError::Internal(format!(
                "failed to open external URL: {message}"
            ))),
            Err(_) => Err(CoreError::Internal(
                "external URL worker thread panicked".to_string(),
            )),
        }
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        status
            .map(|_| ())
            .map_err(|error| CoreError::Internal(format!("failed to open external URL: {error}")))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let status = std::process::Command::new("xdg-open")
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        status
            .map(|_| ())
            .map_err(|error| CoreError::Internal(format!("failed to open external URL: {error}")))
    }
}
