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
