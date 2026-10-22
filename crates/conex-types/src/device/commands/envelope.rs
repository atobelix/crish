use serde::{Deserialize, Serialize};

use crate::device::error::ErrorBody;

// ── 命令请求 / 响应信封（M6 §10.6.1）──

/// 命令请求 body（kind = `remote.<name>`；M6 §10.6.1 CommandRequest）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRequest {
    /// 命令名（协议后缀，如 getStatus/approve/readFile）
    pub command: String,
    /// 命令参数（各命令 `*Params`；camelCase）
    pub params: serde_json::Value,
    /// 请求超时（毫秒，1000-120000，缺省 30000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
}

impl CommandRequest {
    /// 构造命令请求（参数以 Value 承载）
    pub fn new(command: impl Into<String>, params: serde_json::Value) -> Self {
        Self {
            command: command.into(),
            params,
            timeout_ms: None,
        }
    }

    /// 以类型化参数构造（任意 Serialize 结构 → params JSON）
    pub fn with_typed_params<T: Serialize>(command: impl Into<String>, params: &T) -> Self {
        let params = serde_json::to_value(params).expect("类型化命令参数必须可序列化为 JSON");
        Self::new(command, params)
    }

    /// 设置请求超时（毫秒，1000-120000）
    pub fn with_timeout(mut self, timeout_ms: u32) -> Self {
        self.timeout_ms = Some(timeout_ms);
        self
    }
}

/// 统一命令响应（kind = `result.<name>`；M6 §6.1 三态信封）
///
/// - success：`{reqMsgId, ok: true, result}`；
/// - error：`{reqMsgId, ok: false, error: ErrorBody}`；
/// - partial：`{reqMsgId, ok: true, partial: true, result}`（仅批量类命令，
///   本协议 v1 仅「批量审批」场景预留）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    /// 被响应请求的 msgId（请求-响应关联键）
    pub req_msg_id: String,
    /// 是否成功
    pub ok: bool,
    /// 部分成功标记（批量命令）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<bool>,
    /// 命令返回 JSON（各命令 `*Result`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// 失败载荷（ok=false 时）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl CommandResult {
    /// 成功响应
    pub fn success(req_msg_id: impl Into<String>, result: serde_json::Value) -> Self {
        Self {
            req_msg_id: req_msg_id.into(),
            ok: true,
            partial: None,
            result: Some(result),
            error: None,
        }
    }

    /// 失败响应
    pub fn failure(req_msg_id: impl Into<String>, error: ErrorBody) -> Self {
        Self {
            req_msg_id: req_msg_id.into(),
            ok: false,
            partial: None,
            result: None,
            error: Some(error),
        }
    }

    /// 部分成功响应（批量命令）
    pub fn partial(req_msg_id: impl Into<String>, result: serde_json::Value) -> Self {
        Self {
            req_msg_id: req_msg_id.into(),
            ok: true,
            partial: Some(true),
            result: Some(result),
            error: None,
        }
    }
}

// ── 命令规格常量表（37 条；方向标注 + 白名单 B 面）──

/// 命令方向标注（请求方向；响应恒为反向）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageDirection {
    /// 移动端 → 桌面（命令发起方）
    MobileToDesktop,
    /// 桌面 → 移动端
    DesktopToMobile,
}

/// 命令功能域（M6 §4 分域）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandDomain {
    /// F1 状态查询域（全只读）
    Monitor,
    /// F2 审批域（唯一跨端写域）
    Approval,
    /// F4 文件与资产域
    Files,
    /// F5 会话与消息域
    Sessions,
    /// F6 设置与账户域
    Settings,
    /// 设备域
    Devices,
}

/// 命令规格（白名单三重约束的 B 面；M6 §12.2 注册表 commands 表同构）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandSpec {
    /// 协议命令名（kind 后缀，如 getStatus）
    pub name: &'static str,
    /// 对应 Tauri 命令（空串 = 服务网关直接实现，非命令面映射）
    pub tauri_command: &'static str,
    /// 功能域
    pub domain: CommandDomain,
    /// 是否写命令（五条 outbox 写命令 = true；M6 §1.3）
    pub write: bool,
    /// 请求方向
    pub direction: MessageDirection,
    /// 参数 schema 名（M6 §10.6.2）
    pub params_type: &'static str,
    /// 响应 schema 名（M6 §10.6.2）
    pub result_type: &'static str,
}
