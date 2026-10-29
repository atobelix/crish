//! 账户远程接入（host 侧）。
//!
//! - 中继票据与账号在线设备查询（`proxy.flowbit.me:8443`）；
//! - 本机 loopback 网关（独立于局域网服务，仅 127.0.0.1）；
//! - 中继 host 连接 + 手机帧 ↔ 本地协议桥接。
//!
//! 运行时只依赖公开中继与账号中心身份面；不依赖 Tailscale。

mod bridge;
pub(crate) mod client;
pub(crate) mod device;
mod service;

pub use service::start_remote_service;
