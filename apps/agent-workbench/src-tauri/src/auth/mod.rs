pub mod auth_daemon;
pub mod client;
pub mod credential_store;

// 仅重导出命令面（auth_commands）实际使用的类型；bin crate 会把未引用的
// pub use 判为 unused import。
pub use auth_daemon::{AuthManager, SessionSnapshot};
pub use client::{CloudDeviceItem, UserProfile};
