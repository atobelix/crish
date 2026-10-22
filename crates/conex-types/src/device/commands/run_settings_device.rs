use serde::{Deserialize, Serialize};

use super::enums::{
    DeviceChannel, DeviceRole, DeviceType, PairState, PermissionMode, RunControlLevel,
    SetSettingsKey, SettingsConfirmAction, SettingsConfirmStatus,
};

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
