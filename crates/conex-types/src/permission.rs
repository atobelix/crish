//! 权限模式（领域枚举，TY-P2：从多端设备协议迁回类型 crate 领域层）
//!
//! `PermissionMode` 是引擎领域概念（会话/子代理能力钳制），不属于设备协议；
//! 设备命令载荷（`conex_device_protocol::commands::RunSettingsDevice.permission_mode`）
//! 只是其中一个接收面，故定义归本模块，协议侧按 `conex_types::permission::
//! PermissionMode` 引用。

use serde::{Deserialize, Serialize};

/// 权限模式（统一三态：每次询问 / 智能命令放行 / 完全允许模式）
///
/// 严格契约：Serde rename_all = "lowercase" 保证网络层传输值严格为 "ask" | "smart" | "full"
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PermissionMode {
    /// 每次询问（全安全底线兜底）
    Ask,
    /// 智能命令放行（全系统推荐默认）
    #[default]
    Smart,
    /// 完全允许模式（系统不因命令而不允许执行，所有执行的命令都是可以运行的）
    Full,
}

impl PermissionMode {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Smart => "smart",
            Self::Full => "full",
        }
    }

    /// 统一别名解析（跨 crate 单一真理源；未知/空 → None）：
    /// - full: full / full-access / full_access / yolo / danger / allow
    /// - smart: smart / auto
    /// - ask: ask / plan / deep / confirm / readonly / read-only / safe /
    ///   cautious / analysis（历史只读语义一律回落最保守档）
    pub fn parse_alias(raw: Option<&str>) -> Option<Self> {
        match raw.map(|m| m.trim().to_ascii_lowercase()) {
            Some(v)
                if v == "full"
                    || v == "full-access"
                    || v == "full_access"
                    || v == "yolo"
                    || v == "danger"
                    || v == "allow" =>
            {
                Some(Self::Full)
            }
            Some(v) if v == "smart" || v == "auto" => Some(Self::Smart),
            Some(v)
                if v == "ask"
                    || v == "plan"
                    || v == "deep"
                    || v == "confirm"
                    || v == "readonly"
                    || v == "read-only"
                    || v == "safe"
                    || v == "cautious"
                    || v == "analysis" =>
            {
                Some(Self::Ask)
            }
            Some(v) => v.parse::<Self>().ok(),
            None => None,
        }
    }

    /// 别名解析 + 缺省安全默认（未知/空 → Smart）
    pub fn parse_alias_or_default(raw: Option<&str>) -> Self {
        Self::parse_alias(raw).unwrap_or_default()
    }
}

impl std::fmt::Display for PermissionMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for PermissionMode {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ask" => Ok(Self::Ask),
            "smart" => Ok(Self::Smart),
            "full" => Ok(Self::Full),
            other => Err(format!(
                "invalid permission mode: '{other}', expected 'ask' | 'smart' | 'full'"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PermissionMode;

    #[test]
    fn permission_mode_alias_parse_covers_three_modes_and_legacy_values() {
        assert_eq!(
            PermissionMode::parse_alias(Some("ask")),
            Some(PermissionMode::Ask)
        );
        assert_eq!(
            PermissionMode::parse_alias(Some("smart")),
            Some(PermissionMode::Smart)
        );
        assert_eq!(
            PermissionMode::parse_alias(Some(" FULL-Access ")),
            Some(PermissionMode::Full)
        );
        for alias in ["full_access", "yolo", "danger", "allow"] {
            assert_eq!(
                PermissionMode::parse_alias(Some(alias)),
                Some(PermissionMode::Full),
                "{alias} 应归一到 full"
            );
        }
        // 历史只读/分析语义绝不升级为可写的 smart/full
        for alias in [
            "plan",
            "deep",
            "confirm",
            "readonly",
            "read-only",
            "safe",
            "cautious",
            "analysis",
        ] {
            assert_eq!(
                PermissionMode::parse_alias(Some(alias)),
                Some(PermissionMode::Ask),
                "{alias} 应安全回落 ask"
            );
        }
        assert_eq!(
            PermissionMode::parse_alias(Some("auto")),
            Some(PermissionMode::Smart)
        );
        assert_eq!(PermissionMode::parse_alias(Some("ultra")), None);
        assert_eq!(PermissionMode::parse_alias(Some("   ")), None);
        assert_eq!(PermissionMode::parse_alias(None), None);
        assert_eq!(
            PermissionMode::parse_alias_or_default(None),
            PermissionMode::default()
        );
        assert_eq!(PermissionMode::default(), PermissionMode::Smart);
    }
}
