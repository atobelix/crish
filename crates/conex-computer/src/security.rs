//! 电脑操作二期安全门槛（S4：04 §4 全量落点——会话级显式开启 / 全动作审批 /
//! 三级急停 / 空闲挂起 / 密码框抑制登记）。
//!
//! 分层说明：
//! - [`SessionEnablement`]：会话级显式开启状态机（新会话默认关闭；未开启时
//!   工具面不挂载、动作准入拒绝——零副作用）；持久化经 session_meta 键
//!   [COMPUTER_USE_ENABLED_KEY]，读写接线由引擎侧完成（04 §4.1）；
//! - [`ApprovalGate`]：全动作审批状态机（Ask 逐次审批语义：一次一票、并发
//!   拒绝、急停后只接受拒绝裁决）；与 agent-tools 审批链（AskChannel /
//!   AskDecision）的对接点以注释登记（04 §4.2），引擎侧接线；
//! - [`EmergencyStop`]：三级急停（全局 / 热键 / 面板按钮共用一个急停旗，
//!   触发源与序号分源记录）；急停全局生效不区分会话（04 §4.3）；
//! - [`IdleTimeout`]：空闲挂起计时（无 AI 动作 / 无审批超时默认 120s 可配；
//!   注入时钟可测；挂起后恢复需重新显式开启，04 §4.4）；
//! - 密码框抑制：UIA 层数据面抑制（18 §3.3）已实现，本模块登记约束
//!   （占位符 / 键名模式 / 判定纯函数）供审计与工具层消费（04 §4.5）。
//!
//! ## 引擎接线点登记（本模块不接线，接线由引擎侧完成）
//!
//! | 面 | 本模块出口 | 引擎侧接线点 |
//! |---|---|---|
//! | 显式开启 | [`SessionEnablement`] / [`COMPUTER_USE_ENABLED_KEY`] | session_meta 落盘 `computer_use_enabled=true`（持久化范式对齐 conex-types/src/timer.rs:43 的 session_meta 键约定；开关范式对齐 BrowserToolsConfig.mcp_attach_allowed，conex-browser-tools/src/lib.rs:124）；S5 注册函数以 [`tool_mount_allowed`](SessionEnablement::tool_mount_allowed) 判据挂载 `computer_*` 工具族 |
//! | 全动作审批 | [`ApprovalGate`] | 17 个 `computer_*` 工具定义全 `dangerous=true`（agent-tools definition.rs:40）；审批载荷序列化后走既有 `ctx.ask` / AskChannel（agent-tools context.rs:68）；AskDecision::Allowed → [`Approval::Granted`]、Denied{reason} → [`Approval::Denied`]；审批等待期经 abort_token（context.rs:49）取消 |
//! | 三级急停 | [`EmergencyStop`] | 任意触发源置旗 → `abort_token.abort()`（context.rs:44，幂等）→ 在途注入按批次自查（type 分块间 / 拖拽分步间，S1）→ 感知源停止 → 会话回 Idle；热键 RegisterHotKey 默认 [`DEFAULT_ESTOP_HOTKEY`]，注册冲突检测 + 失败降级仅面板按钮（不静默） |
//! | 空闲挂起 | [`IdleTimeout`] | 挂起判定为真 → 自动挂起回 Idle（不等用户手动）；恢复需重新显式开启（[`SessionEnablement::enable`]） |
//! | 密码抑制 | 常量 + [`is_password_field_name`] | UIA 层已实现数据面抑制（18 §3.3）；审计与工具层以本模块判定纯函数做名称 / 值字段脱敏 |
//!
//! 全部类型与函数为纯逻辑（无设备调用、无引擎依赖），跨平台可编译，
//! 行为面由 tests/security_*.rs 穷举。

use crate::coord::Point;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ===== 通用：时钟抽象（空闲挂起计时 / 急停记录的时间源） =====

/// 时间源抽象：供空闲挂起计时做差值判定；测试注入 [`ManualClock`]
/// 确定性推进，生产默认 [`SystemClock`]。
pub trait Clock: Send + Sync + std::fmt::Debug {
    /// 当前时刻（单调时钟，仅用于差值比较，不做纪元换算）
    fn now(&self) -> Instant;
}

/// 系统时钟（生产默认：`std::time::Instant::now()`）
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

/// 手动时钟（测试注入：可确定性推进时间；也可供引擎调试面复用）
#[derive(Debug)]
pub struct ManualClock {
    now: Mutex<Instant>,
}

impl ManualClock {
    /// 新建手动时钟（从当前真实时刻起算）
    pub fn new() -> Self {
        Self {
            now: Mutex::new(Instant::now()),
        }
    }

    /// 推进时间（只增不减；溢出时按不推进兜底）
    pub fn advance(&self, duration: Duration) {
        let mut now = self.now.lock().expect("手动时钟锁损坏");
        *now = now
            .checked_add(duration)
            .expect("手动时钟推进溢出（测试时间跨度异常）");
    }
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Instant {
        *self.now.lock().expect("手动时钟锁损坏")
    }
}

// ===== 会话级显式开启（04 §4.1） =====

/// session_meta 键名：`computer_use_enabled`（04 §4.1 第 2 点落盘键；
/// 持久化范式对齐 conex-types/src/timer.rs:43 的 session_meta 键约定——
/// 键名登记在本常量，读写接线由引擎侧 session_meta 层完成）
pub const COMPUTER_USE_ENABLED_KEY: &str = "computer_use_enabled";

/// 显式开启来源（04 §4.1：开启只能由用户显式操作触发，Agent 无权自开——
/// 红线语义同 SensitiveCapabilities 的 mcp_attach_allowed 开关）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnableSource {
    /// 用户在设置面板点击「启用电脑操作」并经风险确认对话框确认
    User,
}

/// 开启状态机错误
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EnablementError {
    /// 会话未开启（新会话默认关闭，或已禁用 / 挂起）——工具面未挂载、
    /// 动作准入被拒（零副作用，不触碰输入设备）
    #[error("电脑操作未开启（新会话默认关闭，启用需用户显式操作）")]
    NotEnabled,
    /// 重复开启（状态机严格转换，重复开启不被静默吸收）
    #[error("电脑操作已在开启状态")]
    AlreadyEnabled,
}

/// 开启状态（内部登记）
#[derive(Debug, Clone, PartialEq, Eq)]
enum EnableState {
    /// 已开启（来源必为用户）
    Enabled { source: EnableSource },
    /// 已关闭（原因登记供审计；无原因 = 从未开启的默认态）
    Disabled { reason: Option<String> },
}

/// 会话级显式开启状态机（04 §4.1）。
///
/// 状态转换：
/// - `Disabled --enable(User)--> Enabled`（唯一合法转换；重复 enable 返回
///   [EnablementError::AlreadyEnabled]）；
/// - `Enabled --disable(reason)--> Disabled`（挂起 / 急停 / 会话结束回 Idle
///   时调用，原因登记；重复 disable 仅覆盖原因，不报错）；
/// - 恢复 = 重新 enable（挂起 / 急停 / 会话结束后的回 Idle 都不自动恢复，
///   04 §4.4「恢复需重新显式开启」）。
///
/// 安全语义：
/// - **未开启时工具面不挂载**：[`tool_mount_allowed`] 为 S5 注册函数的挂载
///   判据——未开启时 `computer_*` 工具不存在，模型侧 tool schema 亦不含
///   （04 §4.1 第 3 点）；
/// - **未开启时动作零副作用**：[`check_action_allowed`] 在审批**之前**检查
///   （04 §4.2 守卫检查点），拒绝时不触碰输入设备 / 感知源。
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
            *self.state.lock().expect("开启状态锁损坏"),
            EnableState::Enabled { .. }
        )
    }

    /// 显式开启（仅用户来源合法；已开启 → [EnablementError::AlreadyEnabled]，
    /// 严格状态机：重复开启不被静默吸收，调用方可见）
    pub fn enable(&self, source: EnableSource) -> Result<(), EnablementError> {
        let mut state = self.state.lock().expect("开启状态锁损坏");
        if matches!(*state, EnableState::Enabled { .. }) {
            return Err(EnablementError::AlreadyEnabled);
        }
        *state = EnableState::Enabled { source };
        Ok(())
    }

    /// 关闭（挂起 / 急停 / 会话结束回 Idle 时调用；原因登记供审计；
    /// 已关闭时重复调用仅覆盖原因，不报错）
    pub fn disable(&self, reason: impl Into<String>) {
        let mut state = self.state.lock().expect("开启状态锁损坏");
        *state = EnableState::Disabled {
            reason: Some(reason.into()),
        };
    }

    /// 最近一次关闭原因（未关闭 / 从未开启时为 None）
    pub fn disabled_reason(&self) -> Option<String> {
        match &*self.state.lock().expect("开启状态锁损坏") {
            EnableState::Disabled { reason } => reason.clone(),
            EnableState::Enabled { .. } => None,
        }
    }

    /// 引擎侧启动时从 session_meta 恢复（键 [COMPUTER_USE_ENABLED_KEY]）：
    /// `true` → 开启态（持久化只存布尔，来源恒为用户）；`false` → 关闭态。
    /// 覆盖式恢复（幂等）。
    pub fn restore_from_session_meta(&self, enabled: bool) {
        let mut state = self.state.lock().expect("开启状态锁损坏");
        *state = if enabled {
            EnableState::Enabled {
                source: EnableSource::User,
            }
        } else {
            EnableState::Disabled { reason: None }
        };
    }

    /// 当前状态 → session_meta 落盘值（引擎侧持久化时读取）
    pub fn persisted_value(&self) -> bool {
        self.enabled()
    }

    /// 动作准入判据（引擎侧动作执行器在审批**之前**调用；未开启 →
    /// [EnablementError::NotEnabled]，零副作用）
    pub fn check_action_allowed(&self) -> Result<(), EnablementError> {
        if self.enabled() {
            Ok(())
        } else {
            Err(EnablementError::NotEnabled)
        }
    }

    /// 工具面挂载判据（S5 注册函数判据：未开启时不注册 `computer_*` 工具，
    /// 模型侧 tool schema 亦不含，04 §4.1 第 3 点）
    pub fn tool_mount_allowed(&self) -> bool {
        self.enabled()
    }
}

// ===== 全动作审批（04 §4.2） =====

/// 审批裁决三态（Ask 逐次审批：一次一票）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Approval {
    /// 放行执行
    Granted,
    /// 拒绝执行（零注入——审批通过前不触碰输入设备）
    Denied { reason: String },
    /// 已发起、等待用户裁决（载荷见 [`ApprovalRequest`]；裁决经
    /// [`ApprovalGate::settle`] 注入收口）
    Pending { id: u64 },
}

/// 审批载荷（04 §4.2：动作名 + 参数摘要 + 目标窗口标题 + 物理坐标；
/// `type` 明文显示供用户确认——明文只出现在审批面，审计只落 sha256 哈希）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalRequest {
    /// 动作名（工具名，如 `computer_type` / `computer_click`）
    pub action: String,
    /// 参数摘要（`type` 载明文；其余动作摘要化）
    pub params_summary: String,
    /// 目标窗口标题（可空：桌面 / 全局动作）
    pub window_title: Option<String>,
    /// 目标物理坐标（可空：非坐标动作）
    pub position: Option<Point>,
}

impl ApprovalRequest {
    /// 构造审批载荷（动作名 + 参数摘要；窗口标题与坐标按需追加）
    pub fn new(action: impl Into<String>, params_summary: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            params_summary: params_summary.into(),
            window_title: None,
            position: None,
        }
    }
}

/// 审批状态机错误
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApprovalError {
    /// 急停生效中：禁止放行（急停后只接受拒绝裁决；审批等待期被急停取消，
    /// 04 §4.2 / §4.3）
    #[error("急停生效中，禁止放行审批")]
    Stopped,
    /// 裁决目标不存在（id 不匹配任何在途审批；或该审批已被裁决消费）
    #[error("审批不存在或已结束：{0}")]
    NoSuchApproval(u64),
    /// 该审批已裁决（一次一票，重复裁决拒绝）
    #[error("审批已裁决")]
    AlreadySettled,
    /// 裁决注入非法（[`Approval::Pending`] 不能作为裁决注入）
    #[error("裁决不能是 Pending")]
    InvalidVerdict,
}

/// 审批门状态（内部登记）
#[derive(Debug, Default)]
struct GateState {
    /// 在途审批（None = 无等待中的审批）
    in_flight: Option<(u64, ApprovalRequest)>,
    /// 最近一次完成裁决（审计与测试断言）
    last: Option<(u64, ApprovalRequest, Approval)>,
}

/// 全动作审批状态机（04 §4.2）。
///
/// ## Ask 逐次审批语义
/// 每次动作一票：`require_approval` 发起（返回 [Approval::Pending]），引擎侧
/// 把载荷送用户裁决后经 `settle` 收口；同一时刻至多一个在途审批（并发请求
/// 直接拒绝，防审批队列堆积）。
///
/// ## 与 agent-tools 审批链的对接点（引擎侧接线）
/// - 载荷序列化：把 [ApprovalRequest] 展开为工具名 + 参数 JSON，调用既有
///   `ctx.ask` / AskChannel::ask（agent-tools context.rs:68）——与浏览器线
///   交互类工具接线一致；
/// - 裁决映射：AskDecision::Allowed → [Approval::Granted]；
///   AskDecision::Denied{reason} → [Approval::Denied]；
/// - 审批等待期取消：等待期间 abort_token.is_aborted()（context.rs:49）
///   或急停旗置位 → 以 [Approval::Denied]（原因「急停 / 取消」）收口，
///   拒绝时零注入；
/// - 全部 17 个 `computer_*` 工具定义 `dangerous=true`（definition.rs:40），
///   默认拒绝型审批（审批弹窗默认焦点在「拒绝」，04 §4.2）。
#[derive(Debug)]
pub struct ApprovalGate {
    /// 急停旗（[`EmergencyStop`]；None = 未绑定，不感知急停）
    stop: Option<Arc<EmergencyStop>>,
    /// 审批序号（全局递增，裁决定位用）
    seq: AtomicU64,
    state: Mutex<GateState>,
}

impl ApprovalGate {
    /// 新建审批门（不绑定急停旗）
    pub fn new() -> Self {
        Self {
            stop: None,
            seq: AtomicU64::new(1),
            state: Mutex::new(GateState::default()),
        }
    }

    /// 绑定急停旗：急停生效后本门拒绝一切放行（竞态防线——急停与审批
    /// 竞速时一律以拒绝收口）
    pub fn with_stop(stop: Arc<EmergencyStop>) -> Self {
        Self {
            stop: Some(stop),
            seq: AtomicU64::new(1),
            state: Mutex::new(GateState::default()),
        }
    }

    /// 发起一次审批（Ask 逐次审批语义）。
    ///
    /// 返回：
    /// - [Approval::Pending]：已登记在途，等待 [`settle`](Self::settle)
    ///   注入裁决；
    /// - [Approval::Denied]：急停生效中（不发起，零副作用）或已有在途
    ///   审批（单次审批：并发请求拒绝，防队列堆积）。
    pub fn require_approval(&self, request: ApprovalRequest) -> Approval {
        if let Some(stop) = &self.stop {
            if stop.stopped() {
                return Approval::Denied {
                    reason: "急停生效中，拒绝发起审批（零注入）".into(),
                };
            }
        }
        let mut state = self.state.lock().expect("审批门锁损坏");
        if state.in_flight.is_some() {
            return Approval::Denied {
                reason: "已有在途审批，拒绝并发审批（逐次审批语义）".into(),
            };
        }
        let id = self.seq.fetch_add(1, Ordering::SeqCst);
        state.in_flight = Some((id, request));
        Approval::Pending { id }
    }

    /// 注入裁决（引擎侧收到用户裁决 / AskDecision 映射后调用）。
    ///
    /// 约束：
    /// - `verdict` 必须为 [Approval::Granted] 或 [Approval::Denied]
    ///   （Pending 不能作为裁决 → [ApprovalError::InvalidVerdict]）；
    /// - 急停生效中**只接受拒绝裁决**（放行被拒 → [ApprovalError::Stopped]，
    ///   急停后绝不触碰输入设备）；
    /// - id 必须匹配在途审批（→ [ApprovalError::NoSuchApproval]）；
    /// - 一次一票：已裁决后重复注入 → [ApprovalError::AlreadySettled]。
    pub fn settle(&self, id: u64, verdict: Approval) -> Result<Approval, ApprovalError> {
        if matches!(verdict, Approval::Pending { .. }) {
            return Err(ApprovalError::InvalidVerdict);
        }
        if self.stop.as_ref().is_some_and(|s| s.stopped()) && matches!(verdict, Approval::Granted)
        {
            return Err(ApprovalError::Stopped);
        }
        let mut state = self.state.lock().expect("审批门锁损坏");
        let Some((in_flight_id, request)) = state.in_flight.clone() else {
            return match &state.last {
                Some((last_id, _, _)) if *last_id == id => Err(ApprovalError::AlreadySettled),
                _ => Err(ApprovalError::NoSuchApproval(id)),
            };
        };
        if in_flight_id != id {
            return Err(ApprovalError::NoSuchApproval(id));
        }
        state.in_flight = None;
        state.last = Some((in_flight_id, request, verdict.clone()));
        Ok(verdict)
    }

    /// 在途审批（None = 无等待中的审批）
    pub fn pending(&self) -> Option<(u64, ApprovalRequest)> {
        self.state
            .lock()
            .expect("审批门锁损坏")
            .in_flight
            .clone()
    }

    /// 最近一次完成裁决（裁决 id + 载荷 + 结果）
    pub fn last_verdict(&self) -> Option<(u64, ApprovalRequest, Approval)> {
        self.state
            .lock()
            .expect("审批门锁损坏")
            .last
            .clone()
    }
}

impl Default for ApprovalGate {
    fn default() -> Self {
        Self::new()
    }
}

// ===== 三级急停（04 §4.3） =====

/// 桌面急停热键默认组合（`RegisterHotKey`；可配，04 §4.3 ②）
pub const DEFAULT_ESTOP_HOTKEY: &str = "Ctrl+Shift+F12";

/// 急停触发源（04 §4.3 三级）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopSource {
    /// ① 全局急停（复用既有全局急停设施；引擎侧接 AbortToken::abort）
    Global,
    /// ② 桌面热键急停（RegisterHotKey，默认 [DEFAULT_ESTOP_HOTKEY]；
    /// 注册冲突检测 + 失败降级仅面板按钮，不静默）
    Hotkey,
    /// ③ 面板急停按钮（常驻显眼位置）
    Panel,
}

/// 急停事件记录（触发源 + 全局序号，供审计「急停事件」登记与测试断言）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopRecord {
    /// 触发源
    pub source: StopSource,
    /// 触发序号（自 1 起全局递增，跨复位不归零）
    pub seq: u64,
}

/// 三级急停（04 §4.3）：三个触发源共用**同一个急停旗**，触发源以记录区分；
/// 急停全局生效不区分会话。
///
/// ## 引擎接线点登记
/// - `global_stop` / `hotkey_trigger` / `panel_stop` 任意一路触发 → 引擎侧
///   调用 `abort_token.abort()`（agent-tools context.rs:44，幂等）→ 在途
///   注入按批次自查（type 分块间 / 拖拽分步间）→ 感知源停止 → 会话回 Idle
///   → 清理完成后由引擎侧调 [`reset`](Self::reset) 清旗；
/// - 热键实现：`RegisterHotKey` 默认 [DEFAULT_ESTOP_HOTKEY]（可配），注册
///   冲突检测，失败弹提示并降级仅面板按钮（不静默）；
/// - 急停后**不自动恢复开启**：恢复需用户重新显式开启
///   （[`SessionEnablement::enable`]，04 §4.4）。
#[derive(Debug)]
pub struct EmergencyStop {
    /// 急停旗（同一旗，三源共用）
    stopped: AtomicBool,
    /// 急停事件记录（按触发先后追加，审计完整事件链）
    records: Mutex<Vec<StopRecord>>,
    /// 触发序号（自 1 起，跨复位不归零）
    seq: AtomicU64,
}

impl EmergencyStop {
    /// 新建急停旗（未触发）
    pub fn new() -> Self {
        Self {
            stopped: AtomicBool::new(false),
            records: Mutex::new(Vec::new()),
            seq: AtomicU64::new(1),
        }
    }

    /// ① 全局急停（复用既有全局急停设施）
    pub fn global_stop(&self) {
        self.trigger(StopSource::Global);
    }

    /// ② 桌面热键急停（RegisterHotKey，默认 [DEFAULT_ESTOP_HOTKEY]）
    pub fn hotkey_trigger(&self) {
        self.trigger(StopSource::Hotkey);
    }

    /// ③ 面板急停按钮（常驻显眼位置）
    pub fn panel_stop(&self) {
        self.trigger(StopSource::Panel);
    }

    /// 急停旗是否置位（在途注入批次自查 / 审批门 / 感知源停止的判据）
    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// 复位（急停 → 清理 → 回 Idle 后由引擎侧调用）：清旗 + 清记录。
    /// 注意：复位**不**恢复会话开启态——重新开启必须走
    /// [SessionEnablement::enable] 显式流程（04 §4.4）。
    pub fn reset(&self) {
        self.stopped.store(false, Ordering::SeqCst);
        self.records.lock().expect("急停记录锁损坏").clear();
    }

    /// 急停事件记录（按触发先后；重复触发也会追加——审计完整事件链）
    pub fn records(&self) -> Vec<StopRecord> {
        self.records.lock().expect("急停记录锁损坏").clone()
    }

    /// 触发总次数（含重复触发）
    pub fn trigger_count(&self) -> usize {
        self.records.lock().expect("急停记录锁损坏").len()
    }

    /// 统一触发入口：置同一急停旗（幂等）+ 追加触发源记录
    fn trigger(&self, source: StopSource) {
        self.stopped.store(true, Ordering::SeqCst);
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        self.records
            .lock()
            .expect("急停记录锁损坏")
            .push(StopRecord { source, seq });
    }
}

impl Default for EmergencyStop {
    fn default() -> Self {
        Self::new()
    }
}

// ===== 空闲挂起（04 §4.4） =====

/// 空闲挂起默认时长（04 §4.4：无 AI 动作 / 无审批超时默认 120s，可配）
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// 空闲挂起时长可配下限（1s；更短时长无意义，构造期拒绝）
pub const IDLE_TIMEOUT_MIN: Duration = Duration::from_secs(1);

/// 空闲挂起计时（04 §4.4）：桌面会话无 AI 动作 / 无审批超时 → 挂起判定为
/// 真，引擎侧自动挂起回 Idle（不等用户手动）；恢复需重新显式开启。
///
/// 语义：
/// - [`record_activity`](Self::record_activity)：引擎侧在「AI 动作执行完毕」
///   或「审批请求发起」时调用（两条件任一刷新空闲基线）；
/// - [`tick`](Self::tick)：周期挂起判定（引擎侧挂起检查循环调用；只判定
///   不消费——重复 tick 不刷新计时）；
/// - 初始计时从构造时刻起算（会话开启即开始计空闲）。
pub struct IdleTimeout {
    /// 空闲超时时长（≥ [IDLE_TIMEOUT_MIN]）
    duration: Duration,
    /// 时间源（测试注入 [`ManualClock`]）
    clock: Arc<dyn Clock>,
    /// 最近一次活动时刻（构造时刻 / 最近一次 record_activity）
    last_activity: Mutex<Instant>,
}

impl IdleTimeout {
    /// 构造（默认系统时钟）；时长必须 ≥ [IDLE_TIMEOUT_MIN]
    pub fn new(duration: Duration) -> Result<Self, IdleTimeoutError> {
        Self::with_clock(duration, Arc::new(SystemClock))
    }

    /// 构造（注入时钟，测试用 [`ManualClock`] 确定性推进）
    pub fn with_clock(duration: Duration, clock: Arc<dyn Clock>) -> Result<Self, IdleTimeoutError> {
        if duration < IDLE_TIMEOUT_MIN {
            return Err(IdleTimeoutError::InvalidDuration(duration));
        }
        let last_activity = Mutex::new(clock.now());
        Ok(Self {
            duration,
            clock,
            last_activity,
        })
    }

    /// 当前空闲超时时长
    pub fn duration(&self) -> Duration {
        self.duration
    }

    /// 活动刷新：AI 动作执行完毕 / 审批请求发起时重置空闲基线
    /// （04 §4.4 两个刷新条件）
    pub fn record_activity(&self) {
        *self.last_activity.lock().expect("空闲计时锁损坏") = self.clock.now();
    }

    /// 挂起判定：自上次活动（含构造时刻 / 最近一次 [`record_activity`]）
    /// 以来经过 ≥ 超时时长 → true（应挂起回 Idle）
    pub fn tick(&self) -> bool {
        let now = self.clock.now();
        let last = *self.last_activity.lock().expect("空闲计时锁损坏");
        now.duration_since(last) >= self.duration
    }

    /// 当前空闲时长（诊断 / 审计）
    pub fn idle_elapsed(&self) -> Duration {
        let now = self.clock.now();
        let last = *self.last_activity.lock().expect("空闲计时锁损坏");
        now.duration_since(last)
    }
}

impl std::fmt::Debug for IdleTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IdleTimeout")
            .field("duration", &self.duration)
            .field("clock", &self.clock)
            .field("idle_elapsed", &self.idle_elapsed())
            .finish()
    }
}

/// 空闲挂起构造错误
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdleTimeoutError {
    /// 时长低于下限（[IDLE_TIMEOUT_MIN]）
    #[error("空闲挂起时长必须 ≥ {IDLE_TIMEOUT_MIN:?}，收到 {0:?}")]
    InvalidDuration(Duration),
}

// ===== 密码框抑制登记（04 §4.5 / 18 §3.3） =====

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

    /// 手动时钟推进必须生效（测试注入自检）
    #[test]
    fn manual_clock_advance_works() {
        let clock = ManualClock::new();
        let t0 = clock.now();
        clock.advance(Duration::from_secs(5));
        let t1 = clock.now();
        assert!(t1 >= t0 + Duration::from_secs(5), "推进必须生效");
    }

    /// 系统时钟可读取当前时刻
    #[test]
    fn system_clock_provides_now() {
        let clock = SystemClock;
        let now = clock.now();
        assert!(
            now > Instant::now() - Duration::from_secs(60),
            "系统时钟应在近 60s 内"
        );
    }

    /// 开启状态默认关闭（新会话默认关闭，04 §4.1 第 2 点）
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
