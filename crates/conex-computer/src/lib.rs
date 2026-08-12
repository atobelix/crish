//! 电脑操作二期(S1 动作原语 + S2 坐标换算基础)门面与模块声明。
//!
//! 分层说明:
//! - [`coord`]:坐标换算纯函数(缩放目标选择 / API↔物理双向 / 边界校验),全平台可编译;
//! - [`action`]:动作原语与参数校验纯函数 + Windows 注入后端 `action::inject`;
//! - [`screen`]:布局表 / 多屏合成缩放编码纯函数 + Windows 截屏源 `ScreenCapture`;
//! - [`ComputerSession`](cfg(windows)):聚合注入后端 + 截屏源 + 缩放规格,
//!   对外提供「参数校验 → 坐标换算 → 注入」与「截屏感知」两个闭环(04 §2 S1/S2 范围)。
//!
//! 空间语义:截屏与注入共用同一布局表派生的 `ScaleSpec`(API 空间 = 缩放后合成图,
//! 物理空间 = 虚拟桌面像素),保证「截屏所见 = 注入所达」。
//! 会话生命周期(S3 互斥状态机 / S4 安全门槛)属后续阶段,本层不持有。

pub mod action;
pub mod activation;
pub mod coord;
pub mod desktop_capture;
pub mod window_gate;
pub mod perception;
pub mod screen;
pub mod security;

pub use action::{Action, ActionError, ClickCount, MouseButton, ScrollDirection};
pub use activation::{ActivationError, ActivationGate, CleanupAction, SessionMode};
pub use coord::{CoordError, Point, ScaleSpec};
pub use screen::{CapturedFrame, DesktopLayout, MonitorInfo};
pub use security::{
    Approval, ApprovalGate, ApprovalRequest, EmergencyStop, EnableSource, EnablementError,
    IdleTimeout, SessionEnablement, StopSource, StopRecord,
};

/// 会话级错误(动作校验 / 注入 / 截屏 / 初始化四类)。
///
/// 错误码语义对齐 04 §2.1 与 §4.4:`Action` 细分 `tool.computer.invalid_params`
/// 与 `tool.computer.coords_out_of_bounds`;设备面错误统一透传文本。
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// 动作参数校验失败(参数非法 / 坐标越界,由 `ActionError` 细分)
    #[error("动作校验失败: {0}")]
    Action(#[from] ActionError),
    /// 输入注入失败(设备面)
    #[error("输入注入失败: {0}")]
    Inject(String),
    /// 截屏失败(设备面)
    #[error("截屏失败: {0}")]
    Capture(String),
    /// 会话初始化失败(注入后端 / 截屏源 / 布局查询)
    #[error("会话初始化失败: {0}")]
    Init(String),
}

/// 动作执行结果(感知类动作返回数据,其余动作为 `Done`)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum ActionResult {
    /// 无返回值动作已执行完成
    Done,
    /// `cursor_position`:当前光标位置(API 空间,经物理→API 换算)
    CursorPosition(Point),
}

/// 电脑操作会话门面(Windows 首发):注入后端 + 截屏源 + 布局/缩放规格。
///
/// 动作派发统一走 [`dispatch`](Self::dispatch):
/// `Action::validate`(API 空间边界)→ `ScaleSpec` 换算到物理坐标(含物理回检钳制)
/// → 后端注入;`CursorPosition` 走物理→API 反向换算。
#[cfg(windows)]
pub struct ComputerSession {
    backend: action::inject::OsInputBackend,
    capture: screen::ScreenCapture,
    spec: ScaleSpec,
}

#[cfg(windows)]
impl ComputerSession {
    /// 初始化会话:
    /// 1. 置进程 DPI 感知(PER_MONITOR_AWARE_V2,18 §4.3;未感知时窗口/光标坐标被
    ///    系统 DPI 虚拟化,37 报告 1.3 已实测漂移);
    /// 2. 查询布局表并派生缩放规格(choose_target 选择档位);
    /// 3. 初始化注入后端与截屏源。
    pub fn new() -> Result<Self, SessionError> {
        set_process_dpi_aware();
        let backend = action::inject::OsInputBackend::new().map_err(SessionError::Init)?;
        let capture = screen::ScreenCapture::new().map_err(SessionError::Init)?;
        let spec = capture.layout().to_scale_spec();
        Ok(Self {
            backend,
            capture,
            spec,
        })
    }

    /// 当前布局表(显示器清单 / 虚拟桌面边界)
    pub fn layout(&self) -> &DesktopLayout {
        self.capture.layout()
    }

    /// 当前缩放规格(API 空间尺寸与换算因子;截屏后随布局刷新保持一致)
    pub fn scale_spec(&self) -> &ScaleSpec {
        &self.spec
    }

    /// 截屏感知:刷新布局(显示器热插拔自愈)→ 逐屏捕获 → 合成缩放 → PNG。
    /// 返回帧尺寸为 API 空间(缩放后),并同步刷新本会话的缩放规格。
    pub fn screenshot(&mut self) -> Result<CapturedFrame, SessionError> {
        let frame = self.capture.capture().map_err(SessionError::Capture)?;
        self.spec = self.capture.layout().to_scale_spec();
        Ok(frame)
    }

    /// 动作派发:「参数校验 → 坐标换算 → 注入」(04 §2.1 流程第 1-2 步)。
    ///
    /// - 坐标类动作(移动/点击/拖拽/滚动带坐标)先经 API 空间边界校验,
    ///   再换算为物理像素注入;
    /// - 带修饰键的点击/滚动按「修饰键 down → 动作 → 修饰键 up」包裹;
    /// - `CursorPosition` 返回物理光标经物理→API 换算的 API 空间值。
    pub fn dispatch(&mut self, action: &Action) -> Result<ActionResult, SessionError> {
        action.validate(&self.spec)?;
        match action {
            Action::Key { keys } => {
                self.backend.key(keys).map_err(SessionError::Inject)?;
            }
            Action::Type { text } => {
                self.backend.type_text(text).map_err(SessionError::Inject)?;
            }
            Action::MouseMove { coordinate } => {
                self.backend
                    .mouse_move(self.to_phys(*coordinate))
                    .map_err(SessionError::Inject)?;
            }
            Action::Click {
                button,
                count,
                coordinate,
                modifiers,
            } => {
                if let Some(c) = coordinate {
                    self.backend
                        .mouse_move(self.to_phys(*c))
                        .map_err(SessionError::Inject)?;
                }
                self.backend
                    .press_modifiers(modifiers)
                    .map_err(SessionError::Inject)?;
                self.backend
                    .click(*button, *count)
                    .map_err(SessionError::Inject)?;
                self.backend
                    .release_modifiers(modifiers)
                    .map_err(SessionError::Inject)?;
            }
            Action::MouseDown { button } => {
                self.backend
                    .mouse_button(*button, true)
                    .map_err(SessionError::Inject)?;
            }
            Action::MouseUp { button } => {
                self.backend
                    .mouse_button(*button, false)
                    .map_err(SessionError::Inject)?;
            }
            Action::Drag {
                start_coordinate,
                coordinate,
            } => {
                let from = self.to_phys(*start_coordinate);
                let to = self.to_phys(*coordinate);
                self.backend.drag(from, to).map_err(SessionError::Inject)?;
            }
            Action::Scroll {
                direction,
                amount,
                coordinate,
                modifiers,
            } => {
                if let Some(c) = coordinate {
                    self.backend
                        .mouse_move(self.to_phys(*c))
                        .map_err(SessionError::Inject)?;
                }
                self.backend
                    .press_modifiers(modifiers)
                    .map_err(SessionError::Inject)?;
                self.backend
                    .scroll(*direction, *amount)
                    .map_err(SessionError::Inject)?;
                self.backend
                    .release_modifiers(modifiers)
                    .map_err(SessionError::Inject)?;
            }
            Action::HoldKey {
                key,
                duration_secs,
            } => {
                self.backend
                    .hold_key(key, *duration_secs)
                    .map_err(SessionError::Inject)?;
            }
            Action::CursorPosition => {
                let phys = self
                    .backend
                    .cursor_physical()
                    .map_err(SessionError::Inject)?;
                return Ok(ActionResult::CursorPosition(self.spec.phys_to_api(phys)));
            }
        }
        Ok(ActionResult::Done)
    }

    /// API → 物理换算 + 物理空间回检钳制(04 §4.4 校验链第 2 层):
    /// 缩放舍入可能越界 1px,钳制到虚拟桌面边界内(调用方负责审计记录)。
    fn to_phys(&self, api: Point) -> Point {
        self.spec.clamp_phys(self.spec.api_to_phys(api))
    }
}

/// 置进程 DPI 感知(PER_MONITOR_AWARE_V2,18 §4.3):
/// 保证 GetCursorPos/SetCursorPos 走物理像素,不被系统按 96dpi 虚拟化。
///
/// 进程级设置仅一次生效:二次设置返回失败属正常(已感知),失败仅告警不阻断。
#[cfg(windows)]
#[allow(unsafe_code)]
fn set_process_dpi_aware() {
    use windows_sys::Win32::UI::HiDpi::{
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
    };
    let ok = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    if ok == 0 {
        tracing::warn!(
            error = %std::io::Error::last_os_error(),
            "SetProcessDpiAwarenessContext 失败(已感知或系统受限,坐标按物理像素处理)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_result_serde_roundtrip() {
        let r = ActionResult::CursorPosition(Point::new(683, 384));
        let json = serde_json::to_string(&r).expect("序列化失败");
        let back: ActionResult = serde_json::from_str(&json).expect("反序列化失败");
        assert_eq!(r, back);
        assert_eq!(
            serde_json::to_string(&ActionResult::Done).expect("序列化失败"),
            r#"{"result":"done"}"#
        );
    }

    #[test]
    fn session_error_display_aligns_error_codes() {
        // 错误文案带错误码语义(04 §2.1),供工具层映射
        let e = SessionError::Action(ActionError::InvalidParams("x".to_string()));
        assert!(e.to_string().contains("tool.computer.invalid_params"));
        let e = SessionError::Action(ActionError::CoordsOutOfBounds);
        assert!(e.to_string().contains("tool.computer.coords_out_of_bounds"));
    }
}
