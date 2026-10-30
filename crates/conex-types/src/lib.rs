//! Conex 引擎领域模型：事件、消息、工具、会话、权限、错误与持久化行模型。
//!
//! 所有类型只经所属模块路径导入（如 `conex_types::events::AgentEvent`），
//! 根级不提供重导出。

pub mod attachment;
pub mod checkpoint;
pub mod context;
pub mod diff;
pub mod error;
pub mod events;
pub mod history;
pub mod impact;
pub mod ipc_error;
pub mod message;
pub mod permission;
pub mod response;
pub mod search;
pub mod session;
pub mod session_record;
pub mod timer;
pub mod tool;
pub mod transition;
