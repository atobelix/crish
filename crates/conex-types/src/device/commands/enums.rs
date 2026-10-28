use serde::{Deserialize, Serialize};

// ── 共享枚举 ──

/// 分页方向（wire lowercase；backward 仅 UI 历史浏览）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageDirection {
    /// 向前（游标单调推进；默认）
    Forward,
    /// 向后（首屏尾部倒序拉取）
    Backward,
}

/// 状态查询包含项（C01 参数）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StatusInclude {
    /// 核心状态卡
    CoreStatus,
    /// 活跃 run 列表
    ActiveRuns,
    /// 待审批列表
    PendingApprovals,
    /// 后台任务摘要
    BgTaskSummary,
}

/// 审批仲裁方（C13 待办条目；wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Arbiter {
    /// 用户裁决
    User,
    /// 主 agent 裁决（子代理来源请求）
    MainAgent,
}

/// 审批决策渠道（C14 历史条目）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalChannel {
    /// 桌面端
    Desktop,
    /// 移动端（远程审批）
    Mobile,
    /// 自动裁决
    Auto,
}

/// 命令预检决策（C15；wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckDecision {
    /// 放行
    Allowed,
    /// 需审批
    RequiresApproval,
    /// 拦截
    Blocked,
}

/// 资源类别（C22；wire lowercase）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetKind {
    /// 图片
    Image,
    /// PDF
    Pdf,
    /// 缩略图（≤128px）
    Thumbnail,
}

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

/// run 控制级别（C25 L0-L3；wire snake_case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunControlLevel {
    /// L0 继续（payload.message 可选）
    Continue,
    /// L1 软注入（payload.text 必填）
    SoftInject,
    /// L2 协作停止（本轮结束不续）
    CooperativeStop,
    /// L3 强制取消
    ForceCancel,
}

/// 设置键（C29；wire camelCase；仅白名单三键）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetSettingsKey {
    /// 回复风格
    ResponseStyle,
    /// 启用分析
    EnableAnalytics,
    /// 启用崩溃遥测
    EnableCrashTelemetry,
}

/// 设置确认动作（C30）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingsConfirmAction {
    /// 撤回待确认请求
    Withdraw,
    /// 查询状态
    Query,
}

/// 设置确认状态（C30 响应）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingsConfirmStatus {
    /// 待确认
    Pending,
    /// 已撤回
    Withdrawn,
    /// 已接受
    Accepted,
    /// 已拒绝
    Rejected,
    /// 已过期
    Expired,
}

/// 设备类型（C33）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceType {
    /// 桌面
    Desktop,
    /// 手机
    Phone,
    /// 平板
    Tablet,
}

/// 设备角色（C33；this = 本端 / peer = 对端）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceRole {
    /// 本端
    This,
    /// 对端
    Peer,
}

/// 设备通道（C33）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceChannel {
    /// 局域网直连
    Lan,
    /// 云中继
    Relay,
}

/// 配对状态（C36）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairState {
    /// 未配对
    None,
    /// 扫描中
    Scanning,
    /// 输入码
    Inputting,
    /// 握手
    Handshaking,
    /// 完成
    Done,
    /// 失败
    Failed,
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
