//! 动作层数据类型：错误分类与错误、成功载荷、元素引用/元数据、快照存储契约、
//! 原语与请求、执行器配置。

use super::{
    EvaluateRequest, ACTION_TOTAL_TIMEOUT, CONNECTION_WAIT, FILE_CHOOSER_WAIT, MAX_ATTEMPTS,
    NOT_INTERACTIVE_WAIT_MS, RETRY_DELAY_MS, SCROLL_RETRIES, TYPE_CHUNK_DELAY_MS, TYPE_CHUNK_SIZE,
};
use crate::cdp::version::{Stale, TabId};
use async_trait::async_trait;
use serde_json::Value;
use std::time::Duration;

/// 动作错误分类（§2.1 全表；R-9 扩展 ConnectionLost/TargetRestarting）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionErrorKind {
    /// snapshotVersion 不匹配（重连/崩溃重启 VersionReset 后旧版本一律 Stale，U-2）
    VersionInvalid,
    /// backendNodeId 无法解析/box 获取失败
    NodeStale,
    /// "Target closed" 等：标签页/目标销毁
    TargetClosed,
    /// 执行上下文销毁/帧分离（导航竞态）
    ContextGone,
    /// CDP 连接断开（11 §3.2 CdpError::ConnectionLost，R-9）
    ConnectionLost,
    /// 浏览器进程启动中/崩溃重启中（维度 10 Launching/Crashed，R-9）
    TargetRestarting,
    /// 元素隐藏/禁用/被遮挡（box 校验不过）
    NotInteractive,
    /// 原语级超时（click 15s 等）/ 总预算超时
    Timeout,
    /// 域名门禁拒绝（含 IP 阻断）
    GateDenied,
    /// 审批未通过（由维度 17 直接拦截，原语层兜底）
    ApprovalDenied,
    /// 入参非法（索引越界、路径不存在等）
    InvalidInput,
    /// 目标不可支持（如跨域 iframe 元素未启用，二期启用）
    Unsupported,
    /// 用户接管/令牌吊销（不计入重试额度，R-8）
    Aborted,
}

/// 动作执行错误（§2.1）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionError {
    pub kind: ActionErrorKind,
    pub message: String,
    /// 第几次派发尝试（1 起）
    pub attempt: u8,
    /// 关联 CDP 错误原文（有则填，供审计/排查）
    pub cdp_raw: Option<String>,
    /// NodeStale 重试耗尽升级（T-10）：附「继续/中止」升级提示，接口点维度 17 §2.2
    pub escalate: bool,
}

impl ActionError {
    pub fn new(kind: ActionErrorKind, message: impl Into<String>) -> Self {
        ActionError {
            kind,
            message: message.into(),
            attempt: 1,
            cdp_raw: None,
            escalate: false,
        }
    }

    pub fn with_attempt(mut self, attempt: u32) -> Self {
        self.attempt = attempt.clamp(1, u8::MAX as u32) as u8;
        self
    }

    pub fn with_cdp_raw(mut self, raw: impl Into<String>) -> Self {
        self.cdp_raw = Some(raw.into());
        self
    }
}

impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:?} (attempt {}): {}",
            self.kind, self.attempt, self.message
        )?;
        if let Some(raw) = &self.cdp_raw {
            write!(f, " [cdp: {raw}]")?;
        }
        Ok(())
    }
}

/// 动作成功载荷（§2.1）。
#[derive(Debug, Clone, PartialEq)]
pub struct ActionSuccess {
    /// 动作后页面是否发生导航（由当前/动作后 URL 对比判定，§5.4）
    pub navigated: bool,
    /// 动作后最新 URL（导航时非空）
    pub url_after: Option<String>,
    /// 动作后是否应推进快照（引擎判定；导航/版本推进时 true）
    pub page_changed: bool,
    /// 附加数据（select 结果、上传文件数等）
    pub payload: Option<Value>,
}

/// 快照元素引用（工具面从快照带入：只给索引 + 索引解析出的 backendNodeId）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementRef {
    /// 快照中的 [N] 索引
    pub index: usize,
    /// 由快照索引解析获得（维度 13 提供，本模块执行时携带）
    pub backend_node_id: i64,
}

/// 快照元素元数据（14 §5.2 `element_by_index` 契约的消费面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementMeta {
    pub backend_node_id: i64,
    /// 密码输入标记（维度 13 快照元数据；回读只比对长度不比对明文，§4.4）
    pub is_password: bool,
}

/// 快照存储契约（14 §5.2；R-1 per-tab 签名，底层复用维度 11/13 门面）。
///
/// 真实实现 `ops::BrowserSnapshotStore` 包装 `BrowserSession`/`SnapshotManager`；
/// 测试用确定性 mock（mocks.rs）。
#[async_trait]
pub trait SnapshotStore: Send + Sync {
    /// 标签页独立版本号（11 §5.4 VersionTracker）。
    fn snapshot_version(&self, tab_id: &TabId) -> u64;
    /// 校验动作携带版本（版本不匹配/epoch 变化/+1000 跳变一律 Stale，U-2）。
    fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale>;
    /// 重快照（预算受限，维度 13 定参），返回新版本号。
    async fn take_snapshot(&self, tab_id: &TabId) -> Result<u64, ActionError>;
    /// 指定版本快照内按索引解析元素元数据（None = 索引不存在 → InvalidInput 致命）。
    fn element_by_index(&self, tab_id: &TabId, version: u64, index: usize) -> Option<ElementMeta>;
    /// 动作执行成功后推进版本（R-1：AI 动作即时 +1）。
    fn note_action_done(&self, tab_id: &TabId);
}

/// 鼠标按键（click 原语，§2.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

/// 滚动方向（scroll 原语，§2.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDir {
    Up,
    Down,
    Left,
    Right,
}

/// 动作原语（§2.3 全表；evaluate 接口引用维度 17 §3）。
#[derive(Debug, Clone, PartialEq)]
pub enum Primitive {
    /// click（左/右/双击）：`count` 仅允许 1|2
    Click { button: MouseButton, count: u8 },
    /// hover
    Hover,
    /// drag（from = 请求元素，to = 目标元素）
    Drag { to: ElementRef },
    /// type（分块 + 节流 + 回读校验，§4）；submit_key 为键名（如 "Enter"）
    Type {
        text: String,
        submit_key: Option<String>,
    },
    /// key 组合键（"Control+A" 格式，§4.3）
    Key { keys: String },
    /// scroll（页面级：无元素；元素级：请求携带 element）
    Scroll { dir: ScrollDir, amount: i32 },
    /// focus（无坐标路径）
    Focus,
    /// select_option（设 value + 触发 change/input + 回读校验）
    SelectOption { value: String },
    /// upload（上传执行链，§9）
    Upload { path: PathBufLike },
    /// evaluate（受限求值引用维度 17 §3，MVP 未接线）
    Evaluate(EvaluateRequest),
}

/// 上传路径（PathBuf 包装，保持 Primitive 可 PartialEq）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathBufLike(pub std::path::PathBuf);

/// 动作请求（§2.2）。
#[derive(Debug, Clone, PartialEq)]
pub struct ActionRequest {
    /// R-1：per-tab 版本校验维度
    pub tab_id: TabId,
    /// 动作携带的快照版本（工具面从快照带入）
    pub snapshot_version: u64,
    /// 快照索引（元素类原语必填；key/页面滚动不填）
    pub element: Option<ElementRef>,
    pub primitive: Primitive,
}

/// 执行器配置（超时/重试参数，全部可注入供测试）。
#[derive(Debug, Clone)]
pub struct ActionOptions {
    /// 重试总上限（计入额度，R-8）
    pub max_attempts: u32,
    /// 单动作总预算（T-9）
    pub total_timeout: Duration,
    /// type 分块大小（§4.1）
    pub type_chunk_size: usize,
    /// type 块间节流（§4.1）
    pub type_chunk_delay: Duration,
    /// NotInteractive 等待可见轮询上限（§5.1，≤2s）
    pub not_interactive_wait_ms: u32,
    /// 导航竞态/目标关闭延迟（§5.4，300ms）
    pub retry_delay: Duration,
    /// ConnectionLost 恢复等待上限（R-9）
    pub connection_wait: Duration,
    /// 文件选择器事件等待上限（§9.1 4b，≤3s）
    pub file_chooser_wait: Duration,
    /// 滚动容器重取 box 循环上限（§3.2，最多 2 次）
    pub scroll_retries: u32,
}

impl Default for ActionOptions {
    fn default() -> Self {
        ActionOptions {
            max_attempts: MAX_ATTEMPTS,
            total_timeout: ACTION_TOTAL_TIMEOUT,
            type_chunk_size: TYPE_CHUNK_SIZE,
            type_chunk_delay: Duration::from_millis(TYPE_CHUNK_DELAY_MS),
            not_interactive_wait_ms: NOT_INTERACTIVE_WAIT_MS,
            retry_delay: Duration::from_millis(RETRY_DELAY_MS),
            connection_wait: CONNECTION_WAIT,
            file_chooser_wait: FILE_CHOOSER_WAIT,
            scroll_retries: SCROLL_RETRIES,
        }
    }
}
