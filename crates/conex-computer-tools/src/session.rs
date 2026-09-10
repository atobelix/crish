//! 会话访问抽象与真实会话适配（06 文档 §4.1 + 遗留③ RealComputerSession）。
//!
//! - [`ComputerOps`]：computer_* 工具与电脑操作会话的唯一交互面（对齐浏览器线
//!   `SessionOps` 范式，04 §3 项 4）；测试注入 mock 替身，引擎注入
//!   [`RealComputerSession`]；
//! - [`RealComputerSession`]（cfg(windows)）：包装 `conex-computer::ComputerSession`
//!   （Windows 实装：注入后端 + 截屏源 + 缩放规格）与 `perception::UiaPerception`
//!   （UIA 感知面），仅消费 pub 接口；感知版本号（18 §5 项 7）在输入动作 /
//!   截屏 / 快照成功后推进；
//! - 非 Windows 降级（cfg(not(windows))）：`readiness` 恒返回 Err（unwired 语义，
//!   `tool.computer.not_ready`），dispatch/screenshot/snapshot 返回对应能力错误
//!   ——工具面经守卫①（会话未注入）与失败映射自然收敛，不产生半真半假的动作。
//!
//! ## 动作前检查器（06 遗留⑥，05 文档 §5.2）
//! 门禁挂在 [`RealComputerSession::dispatch`] 内（守卫⑥语义）：每次注入前经
//! `UiaPerception` 解析当前活动窗口标题，构造 `ActionTarget::Window` 过
//! `conex_shared::gate::ActionTargetGate`——拒绝以 [`SessionError::Gate`] 返回，
//! 工具层映射 `tool.computer.elevated_window`（06 §5：白名单 / 提权统一码）。
//! 默认注入空白名单 `WindowTargetGate`（04 §4 项 6：空白名单默认放行，提权
//! 探测对仅标题目标跳过）；引擎侧经 [`RealComputerSession::with_gate`] 注入
//! 白名单配置。窗口进程名（提权探测的第二输入）UIA 感知面暂不提供，登记为
//! 遗留接线项（需感知面暴露窗口进程解析）。
//!
//! ## 感知版本号（18 §5 项 7）
//! `perception_version` 读取内部递增计数器：dispatch（输入动作）/ screenshot
//! （截屏）/ snapshot（UIA 树变化）成功后 `+1`；失败不推进（模型重试后仍以
//! 旧版本号对齐感知）。display_count 默认 1，Windows 实装覆盖为布局表显示器数
//! （screenshot/cursor_position 返回形状 `displayNumber` 消费面）。

use async_trait::async_trait;
use conex_computer::perception::{PerceptionError, PerceptionSnapshot, PerceptionSource};
use conex_computer::{Action, ActionResult, CapturedFrame, SessionError};
use conex_shared::gate::{ActionTarget, ActionTargetGate};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 电脑操作会话操作抽象（computer_* 工具与 ComputerSession 的唯一交互面）。
///
/// 方法契约（06 文档 §4.1）：
/// - [`readiness`](Self::readiness)：Err(原因) = 工具层应返回
///   `tool.computer.not_ready`（会话未初始化/恢复期 gating）；
/// - [`dispatch`](Self::dispatch)：动作派发闭环（参数校验 → 坐标换算 →
///   注入，04 §2.1 流程第 1-2 步；急停批次自查在会话内）；
/// - [`screenshot`](Self::screenshot)：缩放后全桌面合成帧（zoom region
///   裁剪为工具层纯后处理，不占会话面）；
/// - [`snapshot`](Self::snapshot)：UIA 结构化快照（数据面抑制已内置：
///   密码框占位 `<password>` / 键名脱敏，18 §3.3）；
/// - [`perception_version`](Self::perception_version)：感知版本号（截屏/
///   布局重建/UIA 树变化/输入动作后推进，18 §5 项 7 替换面）；
/// - [`display_count`](Self::display_count)：当前显示器数量（screenshot /
///   cursor_position 返回形状 `displayNumber` 消费面；默认 1 = 单屏，真实
///   会话覆盖为布局表显示器数——06 文档 §2.2 返回形状实施轮契约）。
#[async_trait]
pub trait ComputerOps: Send + Sync {
    /// 就绪检查：Err(原因) = 工具层应返回 `tool.computer.not_ready`
    fn readiness(&self) -> Result<(), String>;
    /// 动作派发（参数校验 → 坐标换算 → 注入）
    async fn dispatch(&self, action: &Action) -> Result<ActionResult, SessionError>;
    /// 截屏感知（缩放后合成帧）
    async fn screenshot(&self) -> Result<CapturedFrame, SessionError>;
    /// UIA 结构化快照（数据面抑制后产物）
    async fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError>;
    /// 感知版本号（校验路径复用；动作后推进）
    fn perception_version(&self) -> u64;
    /// 当前显示器数量（默认 1 单屏；真实会话覆盖为布局表显示器数）
    fn display_count(&self) -> u64 {
        1
    }
}

// ===== 真实会话适配（Windows 实装） =====

/// UIA 感知源守卫包装。
///
/// `UiaPerception` 的 COM 句柄（windows-core `IUnknown` 的 `NonNull`）未被
/// 库面标记 `Send + Sync`，但感知源以 MTA（`COINIT_MULTITHREADED`）初始化
/// （perception.rs:332）——MTA 下 `IUIAutomation` 接口可跨线程调用，
/// `Send + Sync` 语义成立（异步运行时线程迁移安全），unsafe impl 有充分依据。
struct PerceptionGuard(conex_computer::perception::UiaPerception);

// SAFETY: UiaPerception 经 COINIT_MULTITHREADED 初始化（MTA），COM 对象
// 可跨线程调用；内部无可变状态面，跨线程共享安全。
#[allow(unsafe_code)]
unsafe impl Send for PerceptionGuard {}

// SAFETY: 同上——MTA COM 对象跨线程调用安全（多线程 runtime 线程迁移场景）。
#[allow(unsafe_code)]
unsafe impl Sync for PerceptionGuard {}

// Clone：UiaPerception 内部 COM 接口（IUIAutomation / IUIAutomationTreeWalker）
// 经 windows crate 的 Clone（IUnknown::AddRef）实现引用计数共享——1C-7 需要
// 在 spawn_blocking 闭包前克隆 perception 以在阻塞线程执行 gate_check。
#[cfg(windows)]
impl Clone for PerceptionGuard {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

/// 真实电脑操作会话：`ComputerSession`（Windows 实装）+ `UiaPerception`
/// （感知面）+ 动作前检查器 + 感知版本号（06 文档 遗留③）。
///
/// 仅消费 conex-computer 的 pub 接口；`dispatch`/`screenshot` 为同步设备面
/// （type 长文本注入可阻塞数秒），经 `spawn_blocking` 移出异步运行时执行。
#[cfg(windows)]
pub struct RealComputerSession {
    /// Windows 实装会话（注入后端 + 截屏源 + 缩放规格；Mutex 适配 &self 异步面）
    inner: Arc<Mutex<conex_computer::ComputerSession>>,
    /// UIA 结构化感知源（活动窗口快照 / 命中检测；守卫包装 MTA COM 语义）
    perception: PerceptionGuard,
    /// 动作前检查器（05 文档 §5.2；默认空白名单 WindowTargetGate）
    gate: Arc<dyn ActionTargetGate>,
    /// 感知版本号（dispatch/screenshot/snapshot 成功后推进）
    version: AtomicU64,
}

#[cfg(windows)]
impl RealComputerSession {
    /// 初始化真实会话：
    /// 1. `ComputerSession::new`（置 DPI 感知 + 布局查询 + 注入后端/截屏源）；
    /// 2. `UiaPerception::new`（COM + CUIAutomation + TreeWalker）；
    /// 3. 默认动作前检查器 = 空白名单 `WindowTargetGate`（默认放行 +
    ///    提权探测；04 §4 项 6）。
    ///
    /// 任一设备面初始化失败 → Err（会话未就绪，工具面 `tool.computer.not_ready`；
    /// 失败原因在 readiness 中可读）。
    pub fn new() -> Result<Self, String> {
        let session = conex_computer::ComputerSession::new().map_err(|e| e.to_string())?;
        let perception =
            conex_computer::perception::UiaPerception::new().map_err(|e| e.to_string())?;
        let gate = Arc::new(conex_computer::window_gate::WindowTargetGate::new(
            Vec::new(),
        ));
        Ok(Self {
            inner: Arc::new(Mutex::new(session)),
            perception: PerceptionGuard(perception),
            gate,
            version: AtomicU64::new(0),
        })
    }

    /// 注入自定义动作前检查器（引擎侧白名单窗口配置；06 遗留⑥ 接线面）。
    pub fn with_gate(mut self, gate: Arc<dyn ActionTargetGate>) -> Self {
        self.gate = gate;
        self
    }
}

/// 动作前检查器纯逻辑（1C-7 提取）：接收 perception + gate，与 `self`
/// 解耦，使 `spawn_blocking` 闭包可在克隆的 perception/gate 上执行而无需借用
/// `&self`（async dispatch 不能把 `&self` 移入阻塞闭包）。
#[cfg(windows)]
fn gate_check_inner(
    perception: &PerceptionGuard,
    gate: &Arc<dyn ActionTargetGate>,
) -> Result<(), SessionError> {
    let mut target = conex_computer::window_gate::resolve_foreground_target();
    if let ActionTarget::Window { ref mut title, .. } = target {
        if *title == "未知窗口" || *title == "无标题窗口" || title.is_empty() {
            if let Some(name) = perception.0.focused_element_name() {
                if !name.is_empty() {
                    *title = name;
                }
            }
        }
    }
    gate.check(&target).map_err(SessionError::Gate)
}

#[cfg(windows)]
#[async_trait]
impl ComputerOps for RealComputerSession {
    fn readiness(&self) -> Result<(), String> {
        Ok(())
    }

    async fn dispatch(&self, action: &Action) -> Result<ActionResult, SessionError> {
        // 动作前检查器（06 文档 §4.2 守卫⑥：白名单/提权 → elevated_window）
        // 1C-7：gate_check 含 Win32 API（resolve_foreground_target）+ UIA
        // COM 调用（focused_element_name），移入 spawn_blocking 避免阻塞
        // tokio worker 线程。gate / perception 经 Arc clone 在闭包内执行。
        let inner = self.inner.clone();
        let action = action.clone();
        let gate = self.gate.clone();
        let perception = self.perception.clone();
        let result = tokio::task::spawn_blocking(move || {
            // 1C-7：gate_check（Win32 API + UIA COM 调用）在阻塞线程执行
            gate_check_inner(&perception, &gate)?;
            let mut session = inner.lock().expect("电脑会话锁损坏");
            session.dispatch(&action)
        })
        .await
        .map_err(|e| SessionError::Init(format!("派发任务失败: {e}")))??;
        // 输入动作成功 → 感知版本号推进（18 §5 项 7；失败不推进）
        self.version.fetch_add(1, Ordering::SeqCst);
        Ok(result)
    }

    async fn screenshot(&self) -> Result<CapturedFrame, SessionError> {
        let inner = self.inner.clone();
        let frame = tokio::task::spawn_blocking(move || {
            let mut session = inner.lock().expect("电脑会话锁损坏");
            session.screenshot()
        })
        .await
        .map_err(|e| SessionError::Init(format!("截屏任务失败: {e}")))??;
        self.version.fetch_add(1, Ordering::SeqCst);
        Ok(frame)
    }

    async fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError> {
        let snap = self.perception.0.snapshot()?;
        self.version.fetch_add(1, Ordering::SeqCst);
        Ok(snap)
    }

    fn perception_version(&self) -> u64 {
        self.version.load(Ordering::SeqCst)
    }

    fn display_count(&self) -> u64 {
        self.inner
            .lock()
            .expect("电脑会话锁损坏")
            .layout()
            .monitors
            .len() as u64
    }
}

// ===== 非 Windows 降级（unwired 语义，06 遗留⑦ 降级接线点） =====

/// 非 Windows 平台的降级会话（电脑操作 Windows 首发，04 文档 §2 范围）。
///
/// 降级语义：`readiness` 恒 Err（工具面 `tool.computer.not_ready` 对齐 R-9
/// gating），dispatch/screenshot/snapshot 返回能力错误（工具层按
/// `tool.computer.execution_failed` / 感知失败映射透出）——工具面不产生
/// 半真半假的动作，模型侧可感知不可用。能力探测（UIA×视觉 4 格矩阵，
/// 06 文档 §4.3）为注册期遗留接线项。
#[cfg(not(windows))]
pub struct RealComputerSession;

#[cfg(not(windows))]
impl RealComputerSession {
    /// 构造降级会话（占位；无设备面初始化）
    pub fn new() -> Result<Self, String> {
        Ok(Self)
    }
}

#[cfg(not(windows))]
#[async_trait]
impl ComputerOps for RealComputerSession {
    fn readiness(&self) -> Result<(), String> {
        Err("电脑操作仅支持 Windows（非 Windows 平台降级）".to_string())
    }

    async fn dispatch(&self, _action: &Action) -> Result<ActionResult, SessionError> {
        Err(SessionError::Init(
            "电脑操作仅支持 Windows（非 Windows 平台降级）".to_string(),
        ))
    }

    async fn screenshot(&self) -> Result<CapturedFrame, SessionError> {
        Err(SessionError::Capture(
            "截屏仅支持 Windows（非 Windows 平台降级）".to_string(),
        ))
    }

    async fn snapshot(&self) -> Result<PerceptionSnapshot, PerceptionError> {
        Err(PerceptionError::Init(
            "UIA 快照仅支持 Windows（非 Windows 平台降级）".to_string(),
        ))
    }

    fn perception_version(&self) -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RealComputerSession 可装箱为 `Arc<dyn ComputerOps>`（工具面注入契约；
    /// 构造真实会话需设备面，构造路径由引擎装配轮验证——遗留登记）。
    #[test]
    fn real_computer_session_fits_computer_ops_trait() {
        fn assert_computer_ops<T: ComputerOps>() {}
        assert_computer_ops::<RealComputerSession>();
    }

    /// 非 Windows 降级：readiness 恒 Err（`tool.computer.not_ready` 语义，
    /// 守卫① 未注入/降级 gating 的自然收敛）。
    #[cfg(not(windows))]
    #[test]
    fn non_windows_degrades_to_not_ready() {
        let session = RealComputerSession::new().expect("降级会话可构造");
        let err = session.readiness().expect_err("非 Windows 必须不可就绪");
        assert!(err.contains("Windows"), "降级原因应指明平台限制: {err}");
    }
}
