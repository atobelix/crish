//! 跨端命令消息类型（remote.* / result.*；M6 §4 + §10.6）
//!
//! - [CommandRequest]：命令请求 body（`kind = remote.<name>`，M6 §10.6.1
//!   信封：`{command, params, timeoutMs?}`）；参数类型 = 既有 Tauri 命令入参
//!   镜像（camelCase，跨端不新造第二套 DTO，M6 §2.4 原则 1）；
//! - [CommandResult]：统一响应（M6 §6.1 三态：success / error / partial）；
//! - 37 条命令的参数（`*Params`）与响应（`*Result`）按 M6 §10.6.2 JSON
//!   Schema 映射为 Rust 结构（必填 = 非 Option，可选 = Option + serde 缺省）；
//! - [COMMANDS]：37 条命令规格常量表（方向标注 + 白名单 B 面 + 幂等写标记）；
//!   写命令五条（approve/deny/writeFile/setSettings/pauseAutomation）走
//!   outbox + at-least-once（M6 §1.3）。

use serde::{Deserialize, Serialize};

use crate::device::error::ErrorBody;
use crate::device::version::ManifestEntry;
use crate::events::ApprovalDecision;

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

/// 37 条命令规格（C01-C37；M6 §4 各域总表 + §10.6.2 对照表）
pub const COMMANDS: [CommandSpec; 37] = [
    // ── F1 监控域（10）──
    CommandSpec {
        name: "getStatus",
        tauri_command: "core_get_status",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "StatusQuery",
        result_type: "StatusResult",
    },
    CommandSpec {
        name: "getRunSnapshot",
        tauri_command: "core_get_run_snapshot",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "RunSnapshotParams",
        result_type: "RunSnapshotResult",
    },
    CommandSpec {
        name: "readSessionEvents",
        tauri_command: "core_read_session_events",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "EventPageParams",
        result_type: "EventPageResult",
    },
    CommandSpec {
        name: "readRunEvents",
        tauri_command: "core_read_run_events",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "RunEventsParams",
        result_type: "EventPageResult",
    },
    CommandSpec {
        name: "listSessions",
        tauri_command: "list_sessions",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ListSessionsParams",
        result_type: "ListSessionsResult",
    },
    CommandSpec {
        name: "listBackgroundTasks",
        tauri_command: "workbench_list_background_tasks",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ListTasksParams",
        result_type: "ListTasksResult",
    },
    CommandSpec {
        name: "getTaskOutput",
        tauri_command: "workbench_get_background_task_output",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "TaskOutputParams",
        result_type: "TaskOutputResult",
    },
    CommandSpec {
        name: "getFlowSnapshot",
        tauri_command: "get_flow_snapshot",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "FlowSnapshotParams",
        result_type: "FlowSnapshotResult",
    },
    CommandSpec {
        name: "listCommands",
        tauri_command: "core_list_commands",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ListCommandsParams",
        result_type: "ListCommandsResult",
    },
    CommandSpec {
        name: "getSearchIndex",
        tauri_command: "core_search_files",
        domain: CommandDomain::Monitor,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "SearchIndexParams",
        result_type: "SearchIndexResult",
    },
    // ── F2 审批域（5）──
    CommandSpec {
        name: "approve",
        tauri_command: "core_approve_tool",
        domain: CommandDomain::Approval,
        write: true,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ApproveParams",
        result_type: "ApproveResult",
    },
    CommandSpec {
        name: "deny",
        tauri_command: "core_deny_tool",
        domain: CommandDomain::Approval,
        write: true,
        direction: MessageDirection::MobileToDesktop,
        params_type: "DenyParams",
        result_type: "ApproveResult",
    },
    CommandSpec {
        name: "listPendingApprovals",
        tauri_command: "mobile_list_pending_approvals",
        domain: CommandDomain::Approval,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ListPendingApprovalsParams",
        result_type: "ListPendingApprovalsResult",
    },
    CommandSpec {
        name: "approvalHistory",
        tauri_command: "mobile_approval_sync_state",
        domain: CommandDomain::Approval,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ApprovalHistoryParams",
        result_type: "ApprovalHistoryResult",
    },
    CommandSpec {
        name: "checkCommand",
        tauri_command: "core_check_command",
        domain: CommandDomain::Approval,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "CheckCommandParams",
        result_type: "CheckCommandResult",
    },
    // ── F4 文件与资产域（8）──
    CommandSpec {
        name: "listDir",
        tauri_command: "workbench_list_directory",
        domain: CommandDomain::Files,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ListDirParams",
        result_type: "ListDirResult",
    },
    CommandSpec {
        name: "readFile",
        tauri_command: "workbench_read_file_content",
        domain: CommandDomain::Files,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ReadFileParams",
        result_type: "ReadFileResult",
    },
    CommandSpec {
        name: "writeFile",
        tauri_command: "workbench_write_file_content",
        domain: CommandDomain::Files,
        write: true,
        direction: MessageDirection::MobileToDesktop,
        params_type: "WriteFileParams",
        result_type: "WriteFileResult",
    },
    CommandSpec {
        name: "listWorkspaces",
        tauri_command: "workbench_list_workspaces",
        domain: CommandDomain::Files,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ListWorkspacesParams",
        result_type: "ListWorkspacesResult",
    },
    CommandSpec {
        name: "switchWorkspace",
        tauri_command: "workbench_open_workspace",
        domain: CommandDomain::Files,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "SwitchWorkspaceParams",
        result_type: "SwitchWorkspaceResult",
    },
    CommandSpec {
        name: "searchFiles",
        tauri_command: "mobile_search_files",
        domain: CommandDomain::Files,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "SearchFilesParams",
        result_type: "SearchFilesResult",
    },
    CommandSpec {
        name: "assetUrl",
        tauri_command: "mobile_asset_url",
        domain: CommandDomain::Files,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "AssetUrlParams",
        result_type: "AssetUrlResult",
    },
    CommandSpec {
        name: "fileStat",
        tauri_command: "file_stat",
        domain: CommandDomain::Files,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "FileStatParams",
        result_type: "FileStatResult",
    },
    // ── F5 会话与消息域（4）──
    CommandSpec {
        name: "runTask",
        tauri_command: "core_run_task",
        domain: CommandDomain::Sessions,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "RunTaskParams",
        result_type: "RunTaskResult",
    },
    CommandSpec {
        name: "runControl",
        tauri_command: "core_run_control",
        domain: CommandDomain::Sessions,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "RunControlParams",
        result_type: "RunControlResult",
    },
    CommandSpec {
        name: "cancelRun",
        tauri_command: "core_cancel_run",
        domain: CommandDomain::Sessions,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "CancelRunParams",
        result_type: "CancelRunResult",
    },
    CommandSpec {
        name: "searchSessions",
        tauri_command: "mobile_search_sessions",
        domain: CommandDomain::Sessions,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "SearchSessionsParams",
        result_type: "SearchSessionsResult",
    },
    // ── F6 设置与账户域（5）──
    CommandSpec {
        name: "getSettings",
        tauri_command: "config_get",
        domain: CommandDomain::Settings,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "GetSettingsParams",
        result_type: "GetSettingsResult",
    },
    CommandSpec {
        name: "setSettings",
        tauri_command: "config_update",
        domain: CommandDomain::Settings,
        write: true,
        direction: MessageDirection::MobileToDesktop,
        params_type: "SetSettingsParams",
        result_type: "SetSettingsResult",
    },
    CommandSpec {
        name: "settingsConfirm",
        tauri_command: "mobile_settings_confirm",
        domain: CommandDomain::Settings,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "SettingsConfirmParams",
        result_type: "SettingsConfirmResult",
    },
    CommandSpec {
        name: "pauseAutomation",
        tauri_command: "mobile_pause_automation",
        domain: CommandDomain::Settings,
        write: true,
        direction: MessageDirection::MobileToDesktop,
        params_type: "PauseAutomationParams",
        result_type: "PauseAutomationResult",
    },
    CommandSpec {
        name: "queryPresence",
        tauri_command: "device_presence_query",
        domain: CommandDomain::Settings,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "PresenceParams",
        result_type: "PresenceResult",
    },
    // ── 设备域（5；非 Tauri 命令面，由服务网关直接实现）──
    CommandSpec {
        name: "listDevices",
        tauri_command: "",
        domain: CommandDomain::Devices,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "ListDevicesParams",
        result_type: "ListDevicesResult",
    },
    CommandSpec {
        name: "renameDevice",
        tauri_command: "",
        domain: CommandDomain::Devices,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "RenameDeviceParams",
        result_type: "OkResult",
    },
    CommandSpec {
        name: "revokeDevice",
        tauri_command: "",
        domain: CommandDomain::Devices,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "RevokeDeviceParams",
        result_type: "OkResult",
    },
    CommandSpec {
        name: "getPairState",
        tauri_command: "",
        domain: CommandDomain::Devices,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "PairStateParams",
        result_type: "PairStateResult",
    },
    CommandSpec {
        name: "unlink",
        tauri_command: "",
        domain: CommandDomain::Devices,
        write: false,
        direction: MessageDirection::MobileToDesktop,
        params_type: "UnlinkParams",
        result_type: "UnlinkResult",
    },
];

/// 37 条命令 kind（wire 全量 `remote.<name>`）
pub const REMOTE_KINDS: [&str; 37] = [
    "remote.getStatus",
    "remote.getRunSnapshot",
    "remote.readSessionEvents",
    "remote.readRunEvents",
    "remote.listSessions",
    "remote.listBackgroundTasks",
    "remote.getTaskOutput",
    "remote.getFlowSnapshot",
    "remote.listCommands",
    "remote.getSearchIndex",
    "remote.approve",
    "remote.deny",
    "remote.listPendingApprovals",
    "remote.approvalHistory",
    "remote.checkCommand",
    "remote.listDir",
    "remote.readFile",
    "remote.writeFile",
    "remote.listWorkspaces",
    "remote.switchWorkspace",
    "remote.searchFiles",
    "remote.assetUrl",
    "remote.fileStat",
    "remote.runTask",
    "remote.runControl",
    "remote.cancelRun",
    "remote.searchSessions",
    "remote.getSettings",
    "remote.setSettings",
    "remote.settingsConfirm",
    "remote.pauseAutomation",
    "remote.queryPresence",
    "remote.listDevices",
    "remote.renameDevice",
    "remote.revokeDevice",
    "remote.getPairState",
    "remote.unlink",
];

/// 37 条响应 kind（wire 全量 `result.<name>`）
pub const RESULT_KINDS: [&str; 37] = [
    "result.getStatus",
    "result.getRunSnapshot",
    "result.readSessionEvents",
    "result.readRunEvents",
    "result.listSessions",
    "result.listBackgroundTasks",
    "result.getTaskOutput",
    "result.getFlowSnapshot",
    "result.listCommands",
    "result.getSearchIndex",
    "result.approve",
    "result.deny",
    "result.listPendingApprovals",
    "result.approvalHistory",
    "result.checkCommand",
    "result.listDir",
    "result.readFile",
    "result.writeFile",
    "result.listWorkspaces",
    "result.switchWorkspace",
    "result.searchFiles",
    "result.assetUrl",
    "result.fileStat",
    "result.runTask",
    "result.runControl",
    "result.cancelRun",
    "result.searchSessions",
    "result.getSettings",
    "result.setSettings",
    "result.settingsConfirm",
    "result.pauseAutomation",
    "result.queryPresence",
    "result.listDevices",
    "result.renameDevice",
    "result.revokeDevice",
    "result.getPairState",
    "result.unlink",
];

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

/// 权限模式（C24；wire kebab-case；full-access 移动端不可改，D3 §8.2）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// 询问（缺省）
    Ask,
    /// 计划
    Plan,
    /// 全权
    FullAccess,
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

// ── F1 监控域：参数与响应 ──

/// C01 参数（全可选；include 指定聚合项）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusQuery {
    /// 需要聚合的卡片项
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include: Option<Vec<StatusInclude>>,
}

/// C01 响应（裁剪自 CoreStatus；logDir 默认不下发）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    /// 核心状态已初始化
    pub initialized: bool,
    /// 应用版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// 引擎就绪
    pub engine_ready: bool,
    /// 数据库就绪
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_ready: Option<bool>,
    /// 搜索索引就绪
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_index_ready: Option<bool>,
    /// 压缩就绪
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction_ready: Option<bool>,
    /// provider 状态（hasApiKey/model/credentialMode）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_status: Option<serde_json::Value>,
    /// 日志级别
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,
    /// 环形诊断（≤20 条）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<serde_json::Value>>,
    /// 最近错误（仅透传 kind + detail）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<serde_json::Value>,
    /// 恢复状态
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restore: Option<serde_json::Value>,
    /// 后台任务摘要
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_tasks: Option<serde_json::Value>,
    /// 活跃 run 列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_runs: Option<Vec<serde_json::Value>>,
    /// 待审批列表
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_approvals: Option<Vec<serde_json::Value>>,
}

/// C02 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotParams {
    /// run id
    pub run_id: String,
    /// 会话 id（可选，供校验）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// C02 响应（snapshot = RunSnapshot 裁剪子集）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshotResult {
    /// run 快照（status/cursor/usage 等）
    pub snapshot: serde_json::Value,
}

/// C03 参数（同步面主查询；断线续传 events.resume 的 body 为本类型子集）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPageParams {
    /// 会话 id
    pub session_id: String,
    /// 开区间游标（缺省 0 = 从会话头拉取）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    /// 页大小（缺省 200，上限 1000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_events: Option<u32>,
    /// 分页方向（缺省 forward）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction: Option<PageDirection>,
}

/// C04 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventsParams {
    /// run id
    pub run_id: String,
    /// 会话 id（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 开区间游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    /// 页大小
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_events: Option<u32>,
}

/// C03/C04 响应（EventPage 契约；D3 §7.5）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPageResult {
    /// 裁剪后扁平事件 JSON 列表
    pub events: Vec<serde_json::Value>,
    /// 下一续传游标
    pub next_after_sequence: u64,
    /// 是否还有更多
    pub has_more: bool,
    /// 服务端该会话当前 max（游标推进判断）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_sequence: Option<u64>,
}

/// C05 参数
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsParams {
    /// 携带 ≤80 字符最后消息预览
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_last_message: Option<bool>,
}

/// C05 响应（索引条目 = SessionIndexEntry 原样）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSessionsResult {
    /// 会话索引条目（≤1000）
    pub sessions: Vec<crate::SessionIndexEntry>,
}

/// C06 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksParams {}

/// C06 响应（任务摘要；不携带输出内容）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksResult {
    /// 任务摘要列表（含已结束任务）
    pub tasks: Vec<serde_json::Value>,
}

/// C07 参数（任务输出补取）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputParams {
    /// 任务 id
    pub task_id: String,
    /// 行数上限（缺省 200，上限 1000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u32>,
    /// 从第 N 行继续取
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_line: Option<u64>,
}

/// C07 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskOutputResult {
    /// 输出行（单行 ≤5000 字符）
    pub lines: Vec<String>,
    /// 是否截断
    pub truncated: bool,
    /// 累计行数
    pub line_count: u64,
    /// 下一行游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_after_line: Option<u64>,
    /// 是否还有更多
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
}

/// C08 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshotParams {
    /// 会话 id
    pub session_id: String,
}

/// C08 响应（flow = 子代理 DAG 概览；完整消息树不下发）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSnapshotResult {
    /// 流程快照（flowDeclaration/flowState/agents 行投影）
    pub flow: serde_json::Value,
}

/// C09 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommandsParams {}

/// C09 响应（能力发现；manifest 原样透传）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListCommandsResult {
    /// 命令清单契约版本（semver）
    pub contract_version: String,
    /// 命令条目
    pub commands: Vec<ManifestEntry>,
}

/// C10 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexParams {}

/// C10 响应（仅索引就绪状态；全文搜索不暴露）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexResult {
    /// 索引就绪
    pub ready: bool,
    /// 索引状态（totalFiles/lastBuiltAt 等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<serde_json::Value>,
}

// ── F2 审批域：参数与响应 ──

/// C11 参数（decision 恒 approved；协议面不提供 decision 字段）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveParams {
    /// 工具调用 id（真键）
    pub tool_call_id: String,
    /// run id（校验辅助，缺省按待审批集合反查）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// C12 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DenyParams {
    /// 工具调用 id（真键）
    pub tool_call_id: String,
    /// run id（校验辅助）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// 拒绝原因（≤256 字符；缺省 "user denied"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// C11/C12 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResult {
    /// 是否成功
    pub ok: bool,
    /// 工具调用 id
    pub tool_call_id: String,
    /// 决策规范值（approved/denied/expired）
    pub decision: ApprovalDecision,
}

/// C13 参数（待办对账）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPendingApprovalsParams {
    /// 只返回该水位之后新出现的待办（增量对账）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
}

/// 待办条目（C13 响应元素；parameters 全量不下发，仅 paramKeys）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApproval {
    /// 审批请求 id
    pub request_id: String,
    /// 工具调用 id
    pub tool_call_id: String,
    /// 工具名
    pub tool_name: String,
    /// 摘要
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 工作目录
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 会话 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// run id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// 请求方 run 归属（None = 主 agent）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_run_id: Option<String>,
    /// 申请理由
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 仲裁方
    pub arbiter: Arbiter,
    /// 请求时刻（epoch ms）
    pub requested_at: u64,
    /// 过期时刻（epoch ms）
    pub expires_at: u64,
    /// 危险级别（1|2；桌面按 F2 §2.2 表推导）
    pub danger_level: u8,
    /// 参数键名列表（parameters 全量不下发）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub param_keys: Option<Vec<String>>,
}

/// C13 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListPendingApprovalsResult {
    /// 待办列表
    pub approvals: Vec<PendingApproval>,
    /// 服务端当前水位
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_sequence: Option<u64>,
}

/// C14 参数（审批历史补拉）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalHistoryParams {
    /// 会话 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 水位游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_sequence: Option<u64>,
    /// 条数上限（缺省 100，上限 500）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// 审批历史条目（approval-resolved 事件白名单投影）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalHistoryItem {
    /// 事件序列号
    pub sequence: u64,
    /// 工具调用 id
    pub tool_call_id: String,
    /// 工具名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// 决策
    pub decision: ApprovalDecision,
    /// 原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 决策渠道
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<ApprovalChannel>,
    /// 决策时刻（epoch ms）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
    /// 会话 id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// run id
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

/// C14 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalHistoryResult {
    /// 历史条目
    pub items: Vec<ApprovalHistoryItem>,
    /// 下一游标
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_after_sequence: Option<u64>,
    /// 是否还有更多
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
}

/// C15 参数（审批前置预览；只读判定，不是安全判定）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCommandParams {
    /// 命令名（如 shell:write）
    pub command: String,
    /// 参数包
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// C15 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCommandResult {
    /// 预检决策
    pub decision: CheckDecision,
    /// 原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// ── F4 文件与资产域：参数与响应 ──

/// C16 参数（path 相对路径或空串 = 工作区根）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirParams {
    /// 相对路径（缺省/空串 = 工作区根）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 工作区根（缺省 = 当前活动根）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

/// 目录条目（C16 响应元素）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryItem {
    /// 条目名
    pub name: String,
    /// 是否目录
    pub is_dir: bool,
    /// 字节大小（目录为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// 修改时间（字符串透传）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

/// C16 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirResult {
    /// 目录条目（桌面保证排序：目录优先 + 字母序）
    pub entries: Vec<DirectoryItem>,
}

/// C17 参数（分块读文件）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileParams {
    /// 相对路径
    pub path: String,
    /// 工作区根
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// 行数上限（缺省 400，硬顶 5000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u32>,
    /// 起始行（0 基）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
}

/// C17 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    /// 文件内容（≤1MB）
    pub content: String,
    /// 文件总行数
    pub line_count: u64,
    /// 是否截断
    pub truncated: bool,
    /// 敏感文件标记（移动端渲染横幅且不缓存）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
}

/// C18 参数（受控写文件；本域唯一写命令）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileParams {
    /// 相对路径
    pub path: String,
    /// 文件内容（≤1MB）
    pub content: String,
    /// 覆盖已存在文件（缺省 false；file.exists → 确认后重发）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
    /// 工作区根
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

/// C18 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResult {
    /// 是否成功
    pub ok: bool,
    /// 写入路径
    pub path: String,
}

/// C19 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspacesParams {}

/// 工作区条目（C19 响应元素）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    /// 根路径
    pub root: String,
    /// 名称
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 是否活动根
    pub active: bool,
    /// 是否可达（canonicalize 探测）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable: Option<bool>,
}

/// C19 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspacesResult {
    /// 工作区列表
    pub workspaces: Vec<WorkspaceEntry>,
}

/// C20 参数（切换活动根；需在 recent 授权列表内）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWorkspaceParams {
    /// 目标根路径
    pub path: String,
}

/// C20 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWorkspaceResult {
    /// 是否成功
    pub ok: bool,
    /// 当前活动根
    pub active_root: String,
}

/// C21 参数（递归文件名搜索）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesParams {
    /// 查询词（1-256 字符）
    pub query: String,
    /// 搜索根（相对路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// 结果上限（缺省 100，桌面端钳制）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u32>,
}

/// 文件搜索命中（C21 响应元素；只返回 relPath + kind + size）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchHit {
    /// 相对路径
    pub rel_path: String,
    /// 文件类别（text 等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 字节大小
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// C21 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesResult {
    /// 命中列表
    pub results: Vec<FileSearchHit>,
}

/// C22 参数（资源 URL）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUrlParams {
    /// 相对路径（仅已授权根内）
    pub path: String,
    /// 资源类别
    pub kind: AssetKind,
}

/// C22 响应（令牌 10 分钟有效；URL 只在内存态）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUrlResult {
    /// 资源 URL（HTTP 代理形态，带短期令牌）
    pub url: String,
    /// 过期时刻（epoch ms）
    pub expires_at: u64,
}

/// C23 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatParams {
    /// 相对路径
    pub path: String,
    /// 工作区根
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

/// C23 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatResult {
    /// 字节大小
    pub size: u64,
    /// 修改时间（字符串透传）
    pub modified: String,
    /// 只读标记
    pub readonly: bool,
    /// 文件类别（text 等）
    pub kind: String,
}

// ── F5 会话与消息域：参数与响应 ──

/// C24 参数（发起 run；P2 能力位 runTask 默认关闭）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskParams {
    /// 会话 id（缺省 = 桌面新建会话）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 提示内容（1-262144 字符；超限走流上传 promptRef）
    pub prompt: String,
    /// prompt 超限时经流上传的引用（M6 §7.4）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_ref: Option<String>,
    /// 调度模式
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// 工作目录
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 权限模式（缺省 ask；full-access 移动端不可改）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// 历史（移动端一般省略；桌面 SessionHistoryCache 兜底）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<serde_json::Value>>,
    /// 用户消息本地乐观 id（幂等键：同 id 重发返回同一 runId）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
}

/// C24 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskResult {
    /// 桌面生成的 run id
    pub run_id: String,
    /// 会话 id
    pub session_id: String,
}

/// C25 参数（L0-L3 run 控制）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunControlParams {
    /// 控制级别
    pub level: RunControlLevel,
    /// run id
    pub run_id: String,
    /// 会话 id
    pub session_id: String,
    /// 原因（≤256 字符）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 载荷（soft_inject: {text}；continue: {message?}）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

/// C25 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunControlResult {
    /// 是否成功
    pub ok: bool,
}

/// C26 参数（取消 run；终态拒绝幂等）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunParams {
    /// run id
    pub run_id: String,
    /// 原因（≤256 字符）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// C26 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunResult {
    /// 是否成功
    pub ok: bool,
    /// run id
    pub run_id: String,
}

/// C27 参数（服务端会话搜索；P2 预留）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSessionsParams {
    /// 查询词（1-128 字符）
    pub query: String,
    /// 结果上限（缺省 50）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// 会话搜索命中（C27 响应元素）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    /// 会话 id
    pub session_id: String,
    /// 会话标题
    pub title: String,
    /// 命中次数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hit_count: Option<u64>,
    /// 摘要片段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
}

/// C27 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSessionsResult {
    /// 命中列表
    pub results: Vec<SessionSearchHit>,
}

// ── F6 设置与账户域：参数与响应 ──

/// C28 参数（设置镜像拉取；keys 白名单子集）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSettingsParams {
    /// 键白名单子集（越出白名单 → cmd.denied）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
}

/// C28 响应（脱敏快照；apiKey 恒空串 + last4）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetSettingsResult {
    /// 脱敏设置快照
    pub settings: serde_json::Value,
}

/// C29 参数（非安全设置变更；键白名单恒三键）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSettingsParams {
    /// 设置键（白名单：responseStyle/enableAnalytics/enableCrashTelemetry）
    pub key: SetSettingsKey,
    /// 值（string/boolean）
    pub value: serde_json::Value,
}

/// C29 响应（两态：直接生效 / 需桌面确认）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSettingsResult {
    /// 请求被接受
    pub ok: bool,
    /// 是否直接生效
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<bool>,
    /// 是否进入待确认队列
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    /// 桌面确认请求 id（pending=true 时）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_request_id: Option<String>,
}

/// C30 参数（桌面确认请求管理）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsConfirmParams {
    /// 确认请求 id
    pub confirm_request_id: String,
    /// 动作（withdraw/query）
    pub action: SettingsConfirmAction,
}

/// C30 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsConfirmResult {
    /// 当前状态
    pub status: SettingsConfirmStatus,
    /// 原因（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// C31 参数（临时暂停自动执行；不改变持久化配置）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseAutomationParams {
    /// 暂停时长（秒；缺省 3600，上限 86400）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<u32>,
}

/// C31 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseAutomationResult {
    /// 是否成功
    pub ok: bool,
    /// 恢复时刻（epoch ms；重复暂停刷新该值）
    pub paused_until: u64,
}

/// C32 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceParams {}

/// C32 响应（双因素「桌面在场」信号源）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceResult {
    /// 桌面是否在线
    pub desktop_online: bool,
    /// 最近用户交互时刻（epoch ms）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_interaction_at: Option<u64>,
    /// 引擎版本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<String>,
}

// ── 设备域：参数与响应 ──

/// C33 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDevicesParams {}

/// 设备条目（C33 响应元素；deviceId 前端短显）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    /// 设备 id
    pub device_id: String,
    /// 设备名
    pub name: String,
    /// 设备类型
    #[serde(rename = "type")]
    pub device_type: DeviceType,
    /// 角色
    pub role: DeviceRole,
    /// 连接通道
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<DeviceChannel>,
    /// 是否在线
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub online: Option<bool>,
    /// 最近活跃时刻
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_active_at: Option<u64>,
    /// 配对时刻（ISO8601）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_at: Option<String>,
    /// 配对失效标记（桌面重装后）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_reauth: Option<bool>,
}

/// C33 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDevicesResult {
    /// 设备列表
    pub devices: Vec<DeviceEntry>,
}

/// C34 参数（重命名设备）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameDeviceParams {
    /// 设备 id
    pub device_id: String,
    /// 新名称（≤64 字符）
    pub name: String,
}

/// C35 参数（撤销设备）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokeDeviceParams {
    /// 设备 id（被撤销设备令牌立即失效）
    pub device_id: String,
}

/// 通用 ok 响应（C34/C35；schema 同 UnlinkResult）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResult {
    /// 是否成功
    pub ok: bool,
}

/// C36 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStateParams {}

/// C36 响应（配对状态查询；配对页多端一致性核对）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStateResult {
    /// 配对状态
    pub state: PairState,
    /// 桌面 id（配对完成后）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_id: Option<String>,
}

/// C37 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkParams {}

/// C37 响应（解除本设备配对）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlinkResult {
    /// 是否成功
    pub ok: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::error::DeviceErrorCode;

    #[test]
    fn command_request_roundtrip_camel_case() {
        let req = CommandRequest::with_typed_params(
            "approve",
            &ApproveParams {
                tool_call_id: "tc-9".into(),
                run_id: Some("r-01".into()),
            },
        )
        .with_timeout(30_000);
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["command"], "approve");
        assert_eq!(json["params"]["toolCallId"], "tc-9");
        assert_eq!(json["params"]["runId"], "r-01");
        assert_eq!(json["timeoutMs"], 30_000);
        let back: CommandRequest =
            serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn command_result_three_states() {
        let ok = CommandResult::success(
            "m-1",
            serde_json::json!({ "ok": true, "toolCallId": "tc-9" }),
        );
        let json = serde_json::to_value(&ok).unwrap();
        assert_eq!(json["reqMsgId"], "m-1");
        assert_eq!(json["ok"], true);
        assert_eq!(json["result"]["toolCallId"], "tc-9");
        assert!(json.get("partial").is_none());
        assert!(json.get("error").is_none());

        let err = CommandResult::failure(
            "m-2",
            ErrorBody::new(DeviceErrorCode::CmdApprovalMismatch, "已处理"),
        );
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["code"], "cmd.approval_mismatch");
        assert!(json.get("result").is_none());

        let part = CommandResult::partial("m-3", serde_json::json!({ "accepted": 2 }));
        let json = serde_json::to_value(&part).unwrap();
        assert_eq!(json["partial"], true);

        let back: CommandResult =
            serde_json::from_str(&serde_json::to_string(&ok).unwrap()).unwrap();
        assert_eq!(ok, back);
    }

    #[test]
    fn approve_params_example_parse() {
        // M6 §4.2.1 示例：{"toolCallId":"tc-9","runId":"r-01"}
        let params: ApproveParams =
            serde_json::from_str(r#"{"toolCallId":"tc-9","runId":"r-01"}"#).unwrap();
        assert_eq!(params.tool_call_id, "tc-9");
        assert_eq!(params.run_id.as_deref(), Some("r-01"));
        // runId 缺省容错
        let minimal: ApproveParams = serde_json::from_str(r#"{"toolCallId":"tc-9"}"#).unwrap();
        assert_eq!(minimal.run_id, None);
    }

    #[test]
    fn deny_params_reason() {
        let params: DenyParams =
            serde_json::from_str(r#"{"toolCallId":"tc-9","runId":"r-01","reason":"风险过高"}"#)
                .unwrap();
        assert_eq!(params.reason.as_deref(), Some("风险过高"));
    }

    #[test]
    fn run_task_params_example_parse() {
        // M6 §4.4.1 示例
        let params: RunTaskParams = serde_json::from_str(
            r#"{"sessionId":"s-abc","prompt":"帮我修登录页 bug","permissionMode":"ask","clientMessageId":"msg-01HZ"}"#,
        )
        .unwrap();
        assert_eq!(params.session_id.as_deref(), Some("s-abc"));
        assert_eq!(params.prompt, "帮我修登录页 bug");
        assert_eq!(params.permission_mode, Some(PermissionMode::Ask));
        assert_eq!(params.client_message_id.as_deref(), Some("msg-01HZ"));
        assert_eq!(params.history, None);
    }

    #[test]
    fn event_page_result_example_parse() {
        // M6 §4.1.3 响应示例
        let result: EventPageResult = serde_json::from_str(
            r#"{"events":[{"type":"approval-requested","sequence":130}],"nextAfterSequence":130,"hasMore":true,"latestSequence":135}"#,
        )
        .unwrap();
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.next_after_sequence, 130);
        assert!(result.has_more);
        assert_eq!(result.latest_sequence, Some(135));
    }

    #[test]
    fn pending_approval_example_parse() {
        // M6 §4.2.2 C13 响应元素
        let approval: PendingApproval = serde_json::from_str(
            r#"{"requestId":"req-01","toolCallId":"tc-9","toolName":"shell:write","summary":"npm test 需要执行权限","cwd":"C:\\Software\\conex","sessionId":"s-abc","runId":"r-01","requesterRunId":null,"reason":null,"arbiter":"user","requestedAt":1754700000000,"expiresAt":1754700120000,"dangerLevel":1}"#,
        )
        .unwrap();
        assert_eq!(approval.tool_call_id, "tc-9");
        assert_eq!(approval.arbiter, Arbiter::User);
        assert_eq!(approval.danger_level, 1);
        assert_eq!(approval.requester_run_id, None);
    }

    #[test]
    fn enum_wire_values() {
        assert_eq!(
            serde_json::to_string(&CheckDecision::RequiresApproval).unwrap(),
            "\"requires-approval\""
        );
        assert_eq!(
            serde_json::to_string(&RunControlLevel::CooperativeStop).unwrap(),
            "\"cooperative_stop\""
        );
        assert_eq!(
            serde_json::to_string(&PermissionMode::FullAccess).unwrap(),
            "\"full-access\""
        );
        assert_eq!(
            serde_json::to_string(&PairState::Handshaking).unwrap(),
            "\"handshaking\""
        );
        assert_eq!(
            serde_json::to_string(&DeviceType::Phone).unwrap(),
            "\"phone\""
        );
        assert_eq!(
            serde_json::to_string(&SetSettingsKey::ResponseStyle).unwrap(),
            "\"responseStyle\""
        );
        assert_eq!(
            serde_json::to_string(&Arbiter::MainAgent).unwrap(),
            "\"main-agent\""
        );
        assert_eq!(
            serde_json::to_string(&PageDirection::Backward).unwrap(),
            "\"backward\""
        );
        assert_eq!(
            serde_json::to_string(&ApprovalChannel::Mobile).unwrap(),
            "\"mobile\""
        );
        assert_eq!(
            serde_json::to_string(&SettingsConfirmStatus::Withdrawn).unwrap(),
            "\"withdrawn\""
        );
    }

    #[test]
    fn command_spec_table_counts() {
        assert_eq!(COMMANDS.len(), 37);
        // 全部请求方向 M→D
        for spec in COMMANDS {
            assert_eq!(spec.direction, MessageDirection::MobileToDesktop);
        }
        // 写命令五条（M6 §1.3：approve/deny/writeFile/setSettings/pauseAutomation）
        let writes: Vec<&CommandSpec> = COMMANDS.iter().filter(|s| s.write).collect();
        assert_eq!(writes.len(), 5);
        let write_names: Vec<&str> = writes.iter().map(|s| s.name).collect();
        assert_eq!(
            write_names,
            [
                "approve",
                "deny",
                "writeFile",
                "setSettings",
                "pauseAutomation"
            ]
        );
        // 域分布：10 + 5 + 8 + 4 + 5 + 5
        let domains: Vec<CommandDomain> = COMMANDS.iter().map(|s| s.domain).collect();
        for d in [
            CommandDomain::Monitor,
            CommandDomain::Approval,
            CommandDomain::Files,
            CommandDomain::Sessions,
            CommandDomain::Settings,
            CommandDomain::Devices,
        ] {
            assert_eq!(
                domains.iter().filter(|&&x| x == d).count(),
                match d {
                    CommandDomain::Monitor => 10,
                    CommandDomain::Approval => 5,
                    CommandDomain::Files => 8,
                    CommandDomain::Sessions => 4,
                    CommandDomain::Settings => 5,
                    CommandDomain::Devices => 5,
                }
            );
        }
        // 命令名唯一
        let names: std::collections::HashSet<&str> = COMMANDS.iter().map(|s| s.name).collect();
        assert_eq!(names.len(), 37);
    }

    #[test]
    fn remote_and_result_kinds_lock_spec_table() {
        assert_eq!(REMOTE_KINDS.len(), 37);
        assert_eq!(RESULT_KINDS.len(), 37);
        for (i, spec) in COMMANDS.iter().enumerate() {
            assert_eq!(REMOTE_KINDS[i], format!("remote.{}", spec.name));
            assert_eq!(RESULT_KINDS[i], format!("result.{}", spec.name));
        }
        let unique: std::collections::HashSet<&str> = REMOTE_KINDS
            .iter()
            .chain(RESULT_KINDS.iter())
            .copied()
            .collect();
        assert_eq!(unique.len(), 74);
    }

    #[test]
    fn device_entry_type_rename() {
        let entry = DeviceEntry {
            device_id: "7f0a".into(),
            name: "我的 iPhone".into(),
            device_type: DeviceType::Phone,
            role: DeviceRole::This,
            channel: Some(DeviceChannel::Lan),
            online: Some(true),
            last_active_at: Some(1754700000000),
            paired_at: Some("2026-08-01T08:00:00Z".into()),
            needs_reauth: Some(false),
        };
        let json = serde_json::to_value(&entry).unwrap();
        // Rust 关键字 type 经 rename 为 `type`
        assert_eq!(json["type"], "phone");
        assert_eq!(json["deviceId"], "7f0a");
        assert_eq!(json["channel"], "lan");
        assert_eq!(json["needsReauth"], false);
        let back: DeviceEntry =
            serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
        assert_eq!(entry, back);
    }

    #[test]
    fn settings_result_two_states() {
        let direct: SetSettingsResult =
            serde_json::from_str(r#"{"ok":true,"applied":true}"#).unwrap();
        assert_eq!(direct.pending, None);
        let pending: SetSettingsResult = serde_json::from_str(
            r#"{"ok":true,"applied":false,"pending":true,"confirmRequestId":"cf-01HZ"}"#,
        )
        .unwrap();
        assert_eq!(pending.confirm_request_id.as_deref(), Some("cf-01HZ"));
    }
}
