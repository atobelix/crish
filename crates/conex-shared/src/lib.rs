//! 共享抽象层（电脑操作二期 S6 前置，05 文档定稿）。
//!
//! 本 crate 为叶子纯抽象面：帧源（[`frame::FrameSource`]/[`frame::FrameStream`]）、
//! 输入后端（[`input::InputBackend`]）、动作目标门禁（[`gate::ActionTargetGate`]）
//! 三组 trait 与共享类型。
//!
//! 约束（05 文档 §3/§7）：不携带 tokio 运行时、不携带设备代码；
//! 运行时与设备实现由消费侧（conex-browser / conex-computer）各自提供，
//! 共享抽象不反向依赖任何实现侧。
//!
//! 本任务范围（05 文档落地清单第 1 步）：frame/input/gate 三模块 + 契约单测。
//! 遗留登记：
//! - `coord.rs`（ScaleSpec/choose_target 从 conex-computer 提升）与
//!   `layout.rs`（MonitorInfo/DesktopLayout）待 S6 后续任务并入
//!   （避免与 conex-computer/src/coord.rs 现有声明冲突）；
//! - 浏览器侧适配器（CdpScreencastSource/CdpInputBackend/BrowserTargetGate，
//!   落地清单第 6 步）与桌面侧实现（OsInputBackend 对齐/DesktopCaptureSource/
//!   WindowTargetGate，落地清单第 3-5 步）同为后续任务。

pub mod frame;
pub mod gate;
pub mod input;

pub use frame::{
    Frame, FrameFormat, FramePolicy, FrameRate, FrameSource, FrameSourceError, FrameSourceStatus,
    FrameStream,
};
pub use gate::{ActionTarget, ActionTargetGate, TargetDenial, TargetDenialKind};
pub use input::{
    ClickCount, InputBackend, InputBackendError, KeyName, MouseButton, PhysicalPoint,
    ScrollDirection,
};

#[cfg(test)]
pub(crate) mod test_support;
