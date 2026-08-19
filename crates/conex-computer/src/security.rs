//! 电脑操作安全门槛（维度 1 收敛后：会话级显式开启 + 密码框抑制登记）。
//!
//! 分层说明：
//! - [`SessionEnablement`]：会话级显式开启状态机（新会话默认关闭；未开启时
//!   工具面不挂载、动作准入拒绝——零副作用）；持久化经 session_meta 键
//!   [COMPUTER_USE_ENABLED_KEY]，读写接线由引擎侧完成；
//! - 密码框抑制：UIA 层数据面抑制（18 §3.3）已实现，本模块登记约束
//!   （占位符 / 键名模式 / 判定纯函数）供审计与工具层消费。
//!
//! 全部类型与函数为纯逻辑（无设备调用、无引擎依赖），跨平台可编译，
//! 行为面由 tests/security_*.rs 穷举。

use std::sync::Mutex;

// ===== 会话级显式开启 =====

/// session_meta 键名：`computer_use_enabled`
/// （持久化范式对齐 conex-types/src/timer.rs:43 的 session_meta 键约定——
/// 键名登记在本常量，读写接线由引擎侧 session_meta 层完成）
pub const COMPUTER_USE_ENABLED_KEY: &str = "computer_use_enabled";

/// 开启状态机错误
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EnablementError {
    /// 会话未开启（新会话默认关闭，或已禁用）——工具面未挂载、
    /// 动作准入被拒（零副作用，不触碰输入设备）
    #[error("电脑操作未开启（新会话默认关闭，启用需用户显式操作）")]
    NotEnabled,
}

/// 开启状态（内部登记）
#[derive(Debug, Clone, PartialEq, Eq)]
enum EnableState {
    /// 已开启
    Enabled,
    /// 已关闭（原因登记供审计；无原因 = 从未开启的默认态）
    Disabled { reason: Option<String> },
}

/// 会话级显式开启状态机。
///
/// 状态转换：
/// - `Disabled --enable--> Enabled`（唯一合法转换；重复 enable 按幂等吸收）；
/// - `Enabled --disable(reason)--> Disabled`（停止/会话结束回 Idle 时调用，
///   原因登记；重复 disable 仅覆盖原因，不报错）；
/// - 恢复 = 重新 enable（停止/会话结束后的回 Idle 都不自动恢复）。
///
/// 安全语义：
/// - **未开启时工具面不挂载**：[`tool_mount_allowed`] 为注册函数的挂载
///   判据——未开启时 `computer_*` 工具不存在，模型侧 tool schema 亦不含；
/// - **未开启时动作零副作用**：[`check_action_allowed`] 在执行前检查，
///   拒绝时不触碰输入设备 / 感知源。
#[derive(Debug, Default)]
pub struct SessionEnablement {
    state: Mutex<EnableState>,
}

impl Default for EnableState {
    fn default() -> Self {
        EnableState::Disabled { reason: None }
    }
}

impl SessionEnablement {
    /// 新建会话级开启状态（新会话默认关闭）
    pub fn new() -> Self {
        Self::default()
    }

    /// 当前是否处于开启状态
    pub fn enabled(&self) -> bool {
        matches!(
            *self.state.lock().unwrap_or_else(|e| {
                tracing::error!(target: "computer", "开启状态锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            }),
            EnableState::Enabled
        )
    }

    /// 显式开启（已开启 → 幂等吸收，不报错——开启即承担责任）
    pub fn enable(&self) -> Result<(), EnablementError> {
        let mut state = self.state.lock().unwrap_or_else(|e| {
            tracing::error!(target: "computer", "开启状态锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        *state = EnableState::Enabled;
        Ok(())
    }

    /// 关闭（停止 / 会话结束回 Idle 时调用；原因登记供审计；
    /// 已关闭时重复调用仅覆盖原因，不报错）
    pub fn disable(&self, reason: impl Into<String>) {
        let mut state = self.state.lock().unwrap_or_else(|e| {
            tracing::error!(target: "computer", "开启状态锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        *state = EnableState::Disabled {
            reason: Some(reason.into()),
        };
    }

    /// 最近一次关闭原因（未关闭 / 从未开启时为 None）
    pub fn disabled_reason(&self) -> Option<String> {
        match &*self.state.lock().unwrap_or_else(|e| {
            tracing::error!(target: "computer", "开启状态锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        }) {
            EnableState::Disabled { reason } => reason.clone(),
            EnableState::Enabled => None,
        }
    }

    /// 引擎侧启动时从 session_meta 恢复（键 [COMPUTER_USE_ENABLED_KEY]）：
    /// `true` → 开启态；`false` → 关闭态。覆盖式恢复（幂等）。
    pub fn restore_from_session_meta(&self, enabled: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| {
            tracing::error!(target: "computer", "开启状态锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        *state = if enabled {
            EnableState::Enabled
        } else {
            EnableState::Disabled { reason: None }
        };
    }

    /// 当前状态 → session_meta 落盘值（引擎侧持久化时读取）
    pub fn persisted_value(&self) -> bool {
        self.enabled()
    }

    /// 动作准入判据（引擎侧动作执行器在执行前调用；未开启 →
    /// [EnablementError::NotEnabled]，零副作用）
    pub fn check_action_allowed(&self) -> Result<(), EnablementError> {
        if self.enabled() {
            Ok(())
        } else {
            Err(EnablementError::NotEnabled)
        }
    }

    /// 工具面挂载判据（注册函数判据：未开启时不注册 `computer_*` 工具，
    /// 模型侧 tool schema 亦不含）
    pub fn tool_mount_allowed(&self) -> bool {
        self.enabled()
    }
}

// ===== 密码框抑制登记（18 §3.3） =====

/// 密码框占位符（UIA 层对 PasswordBox / IsPassword 元素不输出实际字符，
/// 仅输出占位符；长度可记、内容不记）
pub const PASSWORD_PLACEHOLDER: &str = "<password>";

/// 名称 / 值字段脱敏占位符（键名模式命中 → 输出此占位符，不落原文）
pub const PASSWORD_REDACTION_PLACEHOLDER: &str = "<redacted>";

/// 键名模式库（18 §3.3：password / passwd / pwd / secret / token 命中即
/// 脱敏；`IsPassword` 为判定优先信号，不依赖键名猜测——本表是兜底第二信号）
pub const PASSWORD_KEYNAME_PATTERNS: &[&str] = &["password", "passwd", "pwd", "secret", "token"];

/// 键名模式命中判定（大小写不敏感子串匹配）：元素名称 / 值字段过本判定，
/// 命中 → 输出 [PASSWORD_REDACTION_PLACEHOLDER]，不落原文。
/// 注：UIA 层数据面抑制（18 §3.3）已实现；本函数供审计与工具层复用同一
/// 键名模式库做二次脱敏。
pub fn is_password_field_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    PASSWORD_KEYNAME_PATTERNS
        .iter()
        .any(|pattern| lower.contains(pattern))
}

/// 字段脱敏（键名模式命中 → [PASSWORD_REDACTION_PLACEHOLDER]；未命中 → 原文）
pub fn redact_password_field(name: &str) -> &str {
    if is_password_field_name(name) {
        PASSWORD_REDACTION_PLACEHOLDER
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 开启状态默认关闭（新会话默认关闭）
    #[test]
    fn enablement_defaults_disabled() {
        let e = SessionEnablement::new();
        assert!(!e.enabled());
        assert_eq!(e.check_action_allowed(), Err(EnablementError::NotEnabled));
    }

    /// 密码脱敏纯函数的基本方向（穷举面见 tests/security_privacy.rs）
    #[test]
    fn password_redact_basics() {
        assert!(is_password_field_name("Password"));
        assert!(!is_password_field_name("用户名"));
        assert_eq!(redact_password_field("pwd"), PASSWORD_REDACTION_PLACEHOLDER);
        assert_eq!(redact_password_field("标题"), "标题");
    }
}
