//! 事件总线数据类型：DOM/生命周期/控制台/版本推进子类、标签页摘要、对话框信息、
//! 帧块、强类型事件 BrowserEvent 与分类忽略 Ignored。

use crate::cdp::domains::TargetInfo;
use serde_json::Value;

/// DOM 变更子类（§5.4 合并推进的输入枚举）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomChangeKind {
    DocumentUpdated,
    ChildNodeInserted,
    ChildNodeRemoved,
    CharacterDataModified,
    AttributeModified,
    AttributeRemoved,
    SetChildNodes,
    /// frameAttached（iframe 增删，归入 DOM 合并窗口，§5.4 #4）
    FrameAttached,
    /// frameDetached
    FrameDetached,
}

/// 生命周期事件子类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleKind {
    DomContent,
    Load,
}

/// 控制台级别（由 consoleAPICalled.type 映射）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleLevel {
    Debug,
    Info,
    Log,
    Warn,
    Error,
}

/// 版本推进原因（§5.4 判定清单 + R-1 显式推进行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionReason {
    /// 全量导航（frameNavigated 主 frame）
    Navigation,
    /// SPA pushState/hash 导航
    SpaNavigation,
    /// DOM 变更（200ms 合并窗口）
    DomChange,
    /// iframe 生命周期/导航（归入 DOM 窗口）
    IframeLifecycle,
    /// 对话框出现/关闭（恒推进，宁多勿漏）
    Dialog,
    /// 用户输入注入（面板转发，显式 bump）
    InputInjected,
    /// AI 动作执行成功（显式 bump）
    ActionDone,
    /// 活动标签关闭
    TargetDestroyed,
    /// 重连恢复/崩溃重启（全部标签 +1000，global_epoch+1）
    Reconnected,
    /// 版本跟踪器自身 Lagged 重对齐（U-2）
    LaggedResync,
}

/// 标签页摘要（TargetsReconciled 载荷，维度 10 导航栈对账）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TabSummary {
    pub target_id: String,
    pub session: String,
    pub url: String,
    pub title: String,
}

/// 对话框信息（§7.1 上抛载荷）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogInfo {
    pub session: String,
    pub dialog_type: String,
    pub message: String,
    pub url: String,
    pub default_prompt: Option<String>,
}

/// 帧块（screencast 专用通道载荷；JPEG 已解码为原始字节）。
#[derive(Debug, Clone)]
pub struct FrameChunk {
    pub data: Vec<u8>,
    /// 信封会话（事件路由面：帧事件送达的会话）。
    pub session: String,
    /// ack 会话（`Page.screencastFrameAck` 的 params.sessionId）：
    /// 取帧内 `params.sessionId` 的**原始 JSON 形态**（Chrome 151 实测为数字
    /// 如 `1`，旧协议为字符串——ack 参数须与事件原始形态一致，类型敏感，
    /// 形态不一致会被 Chrome 拒绝（Invalid parameters）→ ack 失败 → 帧流
    /// 停滞）；缺省回退信封 session（向后兼容，P1-A 遗留 1/2）。
    pub ack_session: Value,
    pub frame: u64,
    pub timestamp_ms: u64,
    pub device_width: u32,
    pub device_height: u32,
}

/// 强类型事件（§5.1 全表）。消费者不直接碰 `serde_json::Value`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserEvent {
    // —— 连接面 ——
    ConnectionLost {
        attempt: u32,
    },
    /// epoch = global_epoch（R-1 跨标签失效语义）；维度 12 据此重启帧通道（R-9-3）
    ConnectionRestored {
        elapsed_ms: u64,
        epoch: u64,
    },
    // —— 导航面 ——
    /// frameStartedNavigating
    NavigationStarted {
        session: String,
        frame: String,
        url: String,
    },
    /// frameNavigated（main = 主 frame）
    Navigated {
        session: String,
        frame: String,
        url: String,
        main: bool,
    },
    /// SPA pushState/hash
    NavigatedWithinDocument {
        session: String,
        frame: String,
        url: String,
    },
    /// domContent/loadEventFired
    Lifecycle {
        session: String,
        frame: String,
        kind: LifecycleKind,
    },
    // —— 目标/会话面 ——
    TargetCreated(TargetInfo),
    TargetDestroyed {
        target_id: String,
    },
    TargetInfoChanged(TargetInfo),
    SessionAttached {
        target_id: String,
        session: String,
    },
    // —— 内容变更面 ——
    DomChanged {
        session: String,
        kind: DomChangeKind,
    },
    // —— 对话框/弹窗面 ——
    DialogOpened(DialogInfo),
    DialogClosed {
        session: String,
        accepted: bool,
    },
    /// window.open 收口请求（§7.2，域名门禁裁决后 allow/deny）
    WindowOpenRequested {
        url: String,
        session: String,
    },
    // —— 脚本/控制台面 ——
    /// url/line：来源脚本 URL 与行号（G-11 补齐；consoleAPICalled 取
    /// stackTrace.callFrames[0]、pageError 取 entry，缺省 None）
    Console {
        session: String,
        level: ConsoleLevel,
        text: String,
        url: Option<String>,
        line: Option<u64>,
    },
    /// url/line：来源脚本 URL 与行号（G-11 补齐；exceptionThrown 取
    /// exceptionDetails、pageError 取 entry，缺省 None）
    PageError {
        session: String,
        text: String,
        url: Option<String>,
        line: Option<u64>,
    },
    // —— 网络面（维度 17 门禁/审计消费）——
    /// status：HTTP 状态码（G-11 补齐；requestWillBeSent 时为 None，由
    /// responseReceived 转译提供）
    NetworkRequest {
        request_id: String,
        url: String,
        method: String,
        status: Option<u16>,
    },
    /// size：响应体编码后字节数（G-11 补齐；loadingFinished 取
    /// encodedDataLength，失败类终止事件为 None）
    NetworkDone {
        request_id: String,
        ok: bool,
        size: Option<u64>,
    },
    // —— 版本面（R-1 per-tab）——
    VersionAdvanced {
        tab_id: String,
        from: u64,
        to: u64,
        reason: VersionReason,
    },
    /// 重连/崩溃重启：global_epoch+1，全部标签版本失效
    VersionReset {
        epoch: u64,
        reason: VersionReason,
    },
    // —— 标签页列表（重连对账）——
    TargetsReconciled {
        tabs: Vec<TabSummary>,
    },
    /// R-3 补齐：fileChooserOpened（维度 14 上传触发）
    FileChooserOpened {
        session: String,
        frame: String,
        backend_node_id: i64,
    },
}

/// 分类忽略（含原因；未知 method 记 debug 忽略，宽容解析）。
#[derive(Debug, Clone)]
pub struct Ignored(pub String);
