use conex_types::CoreError;
use serde::{Deserialize, Serialize};
use std::{env, path::PathBuf};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenerKind {
    FileManager,
    Editor,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenerAvailability {
    Available,
    Unavailable,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenerDiagnostic {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) os: String,
    pub(crate) command: Option<String>,
    pub(crate) path: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpener {
    pub(crate) id: String,
    pub(crate) display_name: String,
    pub(crate) label: String,
    pub(crate) kind: HostOpenerKind,
    pub(crate) availability: HostOpenerAvailability,
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) icon_data_url: Option<String>,
    pub(crate) diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenerError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenTarget {
    #[serde(rename = "type")]
    pub(crate) target_type: HostOpenTargetKind,
    pub(crate) path: Option<String>,
    pub(crate) url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenTargetKind {
    Path,
    Url,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostOpenResult {
    pub(crate) ok: bool,
    pub(crate) opener_id: String,
    pub(crate) target_kind: HostOpenTargetKindForResult,
    pub(crate) target: String,
    pub(crate) command: String,
    pub(crate) diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum HostOpenTargetKindForResult {
    Path,
    Url,
}

#[derive(Clone, Debug)]
pub(crate) struct OpenerCandidate {
    pub(crate) id: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) kind: HostOpenerKind,
    pub(crate) commands: &'static [&'static str],
    pub(crate) known_paths: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
pub(crate) struct ResolvedOpenerCommand {
    pub(crate) command: PathBuf,
    pub(crate) diagnostic: HostOpenerDiagnostic,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ResolvedOpenTarget {
    Path(PathBuf),
    Url(String),
}

pub(crate) fn host_opener_error(
    code: impl Into<String>,
    message: impl Into<String>,
    command: Option<String>,
    path: Option<String>,
) -> HostOpenerError {
    let code = code.into();
    let message = message.into();
    HostOpenerError {
        code: code.clone(),
        message: message.clone(),
        diagnostic: host_opener_diagnostic(code, message, command, path),
    }
}

pub(crate) fn host_opener_diagnostic(
    code: impl Into<String>,
    message: impl Into<String>,
    command: Option<String>,
    path: Option<String>,
) -> HostOpenerDiagnostic {
    HostOpenerDiagnostic {
        code: code.into(),
        message: message.into(),
        os: env::consts::OS.to_string(),
        command,
        path,
    }
}

/// 统一错误协议映射：`HostOpenerError` → `CoreError`（IPC 面唯一协议）。
/// 红线拦截（PermissionDenied）→ `InvalidInput`；其余 → `Internal`（保留 code 前缀）。
pub(crate) fn to_core_error(e: HostOpenerError) -> CoreError {
    if e.code == "PermissionDenied" {
        CoreError::InvalidInput(e.message)
    } else {
        CoreError::Internal(format!("{}: {}", e.code, e.message))
    }
}
