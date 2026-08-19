// SR-06d · 拆分 · ≠ EL：recovery.rs 逻辑域拆模 2/3 —— 阶梯 2 steering /
// 阶梯 3 fork / 阶梯 4 上报（原 recovery.rs 338-621 区间原样迁入，公开面
// 经 recovery.rs `pub use` 重导出，语义零改动）。

use conex_types::error::ProviderErrorKind;
use serde::{Deserialize, Serialize};

use super::RECOVER_GROUP_PREFIX;
use crate::steering_queue::SteeringInputEntry;

/// 阶梯 2 通知（落库 `recover_notifications`；pending 位重启后仍入队）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNotification {
    /// 子代理 id
    pub subagent_id: String,
    /// 子代理 run id
    pub subagent_run_id: String,
    /// 操作指纹（报表聚合依据）
    pub fingerprint: String,
    /// provider 错误分类（阶梯 2 steering 文案承载具体 kind，AI 可区分
    /// rate-limit/server-error/timeout/network 决策因子；None = 旧数据/未知，
    /// 序列化缺省省略——向后兼容，旧库 `recover_notifications` 反序列化
    /// 自动置 None，文本降级不含 kind）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<ProviderErrorKind>,
    /// 阶梯 1 已重试次数
    pub retries: u32,
    /// 剩余状态（上行时的 run 状态摘要）
    pub remaining_status: String,
    /// 是否仍未处理（acknowledge 置 false；重启只重排 pending 条目）
    pub pending: bool,
    /// 创建时间（epoch ms）
    pub created_at_ms: u64,
}

/// 阶梯 2 steering 分组名（`recovery-<run_id>`，replaceOrEnqueue 去重）
pub fn steering_group_id(subagent_run_id: &str) -> String {
    format!("{RECOVER_GROUP_PREFIX}{subagent_run_id}")
}

/// provider 错误分类 → 中文人读标签（steering 文案 kind 段用；与
/// stream_error.rs kind_str 的 wire 名互补——wire 名走事件面，人读名进对话）
fn kind_label(kind: ProviderErrorKind) -> &'static str {
    match kind {
        ProviderErrorKind::Aborted => "中止",
        ProviderErrorKind::PayloadTooLarge => "请求体过大",
        ProviderErrorKind::GatewayChallenge => "网关质询",
        ProviderErrorKind::Auth => "认证",
        ProviderErrorKind::Quota => "配额",
        ProviderErrorKind::EndpointUnavailable => "端点不可用",
        ProviderErrorKind::ContextLengthExceeded => "上下文超长",
        ProviderErrorKind::InvalidRequest => "无效请求",
        ProviderErrorKind::RateLimit => "限速",
        ProviderErrorKind::ServerError => "服务端",
        ProviderErrorKind::Timeout => "超时",
        ProviderErrorKind::Network => "网络",
        ProviderErrorKind::Unknown => "未知",
    }
}

/// 阶梯 2 steering 条目文案（哪个 run、错误分类、已重试次数、剩余状态，
/// 以及主 agent 三决策路径指引：接管继续 / 重派（resume_subagent）/
/// 关闭重来（kill_subagent 后重派）——对齐 final/00 §3.5 三决策路径）。
///
/// kind 段：`error_kind` 为 Some 时输出「网络类错误(Network)」形式；
/// None（旧数据/未知）降级为空段，不出现 kind 信息。
pub fn steering_text(notification: &RecoveryNotification) -> String {
    let kind_section = notification
        .error_kind
        .map(|kind| format!("{}类错误({kind:?})", kind_label(kind)))
        .unwrap_or_default();
    format!(
        "子代理 {}（run {}）停摆：{}重试预算已耗尽（已重试 {} 次，状态 {}）。\
         请决策：接管继续 / 重派（resume_subagent）/ 关闭重来（kill_subagent 后重派）。",
        notification.subagent_id,
        notification.subagent_run_id,
        kind_section,
        notification.retries,
        notification.remaining_status
    )
}

/// 构造阶梯 2 steering 条目（is_steering 受保护位 + 分组去重）
pub fn build_steering_entry(notification: &RecoveryNotification) -> SteeringInputEntry {
    SteeringInputEntry {
        id: format!(
            "recovery-{}-{}",
            notification.subagent_run_id, notification.created_at_ms
        ),
        text: steering_text(notification),
        attachments: Vec::new(),
        enqueued_at: notification.created_at_ms,
        group_id: Some(steering_group_id(&notification.subagent_run_id)),
        is_steering: true,
    }
}

/// fork 上下文继承模式（B6 收敛：`Summarized` 已删除，历史库 `summarized` 经 `alias` 兼容为 `Verbatim`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkContextMode {
    /// 注入内容 ≤ 会话窗口 80% 且同窗口：字节级继承（Verbatim，B6 收敛后超窗/超占比亦走此路径）
    #[serde(alias = "summarized")]
    Verbatim,
    /// 无注入内容：全新上下文
    New,
}

impl ForkContextMode {
    /// wire 名（snake_case，落 ForkRecord / subagent_path_json 扩展位）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Verbatim => "verbatim",
            Self::New => "new",
        }
    }
}

/// fork 上下文继承判定（B6 收敛：仅 `Verbatim`/`New` 两态，`Summarized` 已删除；超窗/超占比统一走 `Verbatim`）。
/// - 注入内容为空（0 字节）→ [ForkContextMode::New]（全新）；
/// - 其余（同窗口/超窗、≤80%/超占比）→ [ForkContextMode::Verbatim]（字节级继承，单路径）。
pub fn decide_fork_context(
    started_at_ms: i64,
    now_ms: i64,
    inject_bytes: u64,
    window_bytes: u64,
) -> ForkContextMode {
    if inject_bytes == 0 {
        return ForkContextMode::New;
    }
    // B6 收敛：`Summarized` 已删除，历史超窗/超占比路径统一收敛为 `Verbatim`（`alias` 保证旧库 `summarized` 反序列化兼容）。
    let _ = (started_at_ms, now_ms, window_bytes);
    ForkContextMode::Verbatim
}

/// 阶梯 3 fork 记录（落库 `recover_forks`，幂等与报表依据）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRecord {
    /// 操作指纹
    pub fingerprint: String,
    /// 子代理 id
    pub subagent_id: String,
    /// 原 run id（置 failed 的 run）
    pub from_run_id: String,
    /// 原 run 的会话树叶子 id（fork 起点）
    pub from_leaf_id: String,
    /// 新 run id（fork 分支承接同一目标）
    pub new_run_id: String,
    /// 新 run 的会话树叶子 id
    pub new_leaf_id: String,
    /// fork 三态上下文继承模式
    pub context_mode: ForkContextMode,
    /// 创建时间（epoch ms）
    pub created_at_ms: u64,
}

/// fork 节点载荷（挂到会话树新叶子的 payload）
pub fn fork_node_payload(record: &ForkRecord, task: &str) -> serde_json::Value {
    serde_json::json!({
        "kind": "recovery-fork",
        "fromRunId": record.from_run_id,
        "fromLeafId": record.from_leaf_id,
        "task": task,
        "contextMode": record.context_mode.as_str(),
    })
}

/// 恢复阶梯标识（wire 名：ladder-1..ladder-4）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryLadder {
    /// 阶梯 1：引擎内自动重试
    Ladder1AutoRetry,
    /// 阶梯 2：主 agent 激活（steering 软注入）
    Ladder2MainAgent,
    /// 阶梯 3：重分配 / fork
    Ladder3Fork,
    /// 阶梯 4：上报用户
    Ladder4User,
}

impl RecoveryLadder {
    /// wire 名
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ladder1AutoRetry => "ladder-1",
            Self::Ladder2MainAgent => "ladder-2",
            Self::Ladder3Fork => "ladder-3",
            Self::Ladder4User => "ladder-4",
        }
    }
}

/// 单次尝试记录（阶梯 4 上报的「试过什么」明细）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    /// 所在阶梯
    pub ladder: RecoveryLadder,
    /// 尝试时间（epoch ms）
    pub at_ms: u64,
    /// 结构化详情
    pub detail: String,
}

/// 阶梯 4 用户上报（卡在哪一步、试过什么、建议怎么办）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserReport {
    /// 子代理 id
    pub subagent_id: String,
    /// 当前 run id
    pub subagent_run_id: String,
    /// 停摆时间（epoch ms）
    pub stuck_at_ms: u64,
    /// 各阶梯尝试记录
    pub attempts: Vec<AttemptRecord>,
    /// 建议怎么办（固定指引文案）
    pub suggestion: String,
}

/// 构造阶梯 4 上报（从持久化的阶梯 2 通知与阶梯 3 fork 记录聚合同指纹
/// 尝试明细，附加本次阶梯 1 上行记录）
pub fn build_user_report(
    subagent_id: &str,
    subagent_run_id: &str,
    stuck_at_ms: u64,
    fingerprint: &str,
    notifications: &[RecoveryNotification],
    forks: &[ForkRecord],
    retries: u32,
) -> UserReport {
    let mut attempts = Vec::new();
    for notification in notifications
        .iter()
        .filter(|n| n.fingerprint == fingerprint)
    {
        attempts.push(AttemptRecord {
            ladder: RecoveryLadder::Ladder2MainAgent,
            at_ms: notification.created_at_ms,
            detail: format!(
                "已重试 {} 次后通知主 agent 激活（run {}，状态 {}）",
                notification.retries, notification.subagent_run_id, notification.remaining_status
            ),
        });
    }
    for fork in forks.iter().filter(|f| f.fingerprint == fingerprint) {
        attempts.push(AttemptRecord {
            ladder: RecoveryLadder::Ladder3Fork,
            at_ms: fork.created_at_ms,
            detail: format!(
                "fork 重分配：{} → {}（上下文 {} 继承）",
                fork.from_run_id,
                fork.new_run_id,
                fork.context_mode.as_str()
            ),
        });
    }
    attempts.push(AttemptRecord {
        ladder: RecoveryLadder::Ladder1AutoRetry,
        at_ms: stuck_at_ms,
        detail: format!("瞬态错误自动重试 {retries} 次后预算耗尽"),
    });
    let suggestion = format!(
        "子代理 {} 停摆（run {}）：阶梯 1 自动重试与阶梯 2 主 agent 激活均未恢复，\
         阶梯 3 fork 重分配已达上限或仍失败。请检查 provider 网络与配额后人工决策：\
         继续重试 / 降低要求 / 取消该任务。",
        subagent_id, subagent_run_id
    );
    UserReport {
        subagent_id: subagent_id.to_string(),
        subagent_run_id: subagent_run_id.to_string(),
        stuck_at_ms,
        attempts,
        suggestion,
    }
}
