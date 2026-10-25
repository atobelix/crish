//! CDP 交互抽象（PageOps）与真实浏览器实现（维度 14 消费面）
//!
//! - `PageOps`：动作层全部 CDP 交互的 trait 抽象——真实实现 `BrowserPageOps`
//!   （经统一发送层 `BrowserSession`）与确定性测试 mock（mocks.rs）共用同一执行器；
//! - `BrowserPageOps`：`BrowserSession` 包装（缺省绑定当前活动标签；P1 经
//!   `with_session` 绑定具体标签会话——per-tab 动作路由，动作入口按 tab_id 解析）；
//! - `BrowserSnapshotStore`：`SnapshotStore` 契约的真实实现（维度 11/13 门面，
//!   R-1 per-tab 签名；会话解析经注入闭包，P1 提供 `session_for_tab` 辅助）；
//! - `Delay`：延迟注入抽象（真实 tokio sleep / 测试记录型），重试延迟与 type 节流共用。
//!
//! 错误映射：`CdpError` → `ActionError` 按维度 14 §5.1 表（TargetClosed/ContextGone/
//! NodeStale/ConnectionLost/Aborted/Timeout/NotReady 各归其类，R-9）；M4 修正：
//! Internal/Serialize 归 Unsupported（Fatal 不重试）——内部错误重试不会自愈。

mod error;
mod isolated_world;
mod network;
mod page_ops;
mod snapshot_store;
mod traits;
mod upload_wait;

#[cfg(test)]
mod tests;

pub use self::isolated_world::CRISH_READ_INJECTION;
pub use self::network::NetworkCounter;
pub use self::page_ops::BrowserPageOps;
pub use self::snapshot_store::{
    session_for_active, session_for_tab, BrowserSnapshotStore, SessionResolver,
};
pub use self::traits::{Delay, PageOps, TokioDelay};
