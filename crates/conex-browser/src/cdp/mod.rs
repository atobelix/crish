//! CDP 通道与事件总线子模块（维度 11）
//!
//! 职责边界：本子模块只提供「一条可靠长连接 + 一个有序事件面 + 一个全命令必经的
//! 发送闸门」；快照采集算法、输入注入语义、screencast 帧消费分别属维度 13/14/12，
//! 本模块只提供传输、分发与钩子，不做业务解释（11 文档 §1）。

pub mod bus;
pub mod client;
pub mod dialog;
pub mod domains;
pub mod error;
pub mod probe;
pub mod sender;
pub mod session_caps;
pub mod transport;
pub mod types;
pub mod version;

/// mock WS 服务端（仅测试用，agent-browser browser.rs:2627 先例）。
#[cfg(test)]
pub(crate) mod mock;
