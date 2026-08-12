//! 共享层浏览器线适配器（05 文档 §3.4/§4.3/§5.2，纯加法）
//!
//! 三个适配器平行新增，不替换既有接线（frame_stream.rs/panel_input.rs 直连
//! `ScreencastSession`/`InputPipeline` 的现状不变，05 文档 §6.2 项 1）：
//! - [`screencast_source::CdpScreencastSource`]：`FrameSource`（包装 ScreencastSession）；
//! - [`cdp_input_backend::CdpInputBackend`]：`InputBackend`（方法序列映射 InputCmd 注入）；
//! - [`browser_target_gate::BrowserTargetGate`]：`ActionTargetGate`（委托既有 DomainGate）。

pub mod browser_target_gate;
pub mod cdp_input_backend;
pub mod screencast_source;
