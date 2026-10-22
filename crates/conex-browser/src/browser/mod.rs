//! 进程管理子模块（维度 10）：BrowserManager 主调度 + 状态机接线
//!
//! 本模块只负责「把浏览器进程可靠地拉起来、管住、收掉」（10 文档 §1 职责边界）；
//! CDP 协议收发由维度 11（cdp/ 子模块）承载，本模块仅提供两个衔接点：
//!
//! 1. `CdpEndpoint`（端口 + WS path）——启动成功后供维度 11 建连（`connect_session` 助手）；
//! 2. `ProcessEvent` 事件流——状态迁移广播（面板与工具层消费）。
//!
//! 模块映射（10 文档 `process/` 布局 ↔ 本目录）：
//!
//! ```text
//! browser/
//! ├── mod.rs         # 状态机 + 主调度（↔ process/mod.rs）
//! ├── state.rs       # BrowserState/StateMachine（§6 迁移表）
//! ├── discover.rs    # 二进制发现与选择（↔ process/discover.rs）
//! ├── cft.rs         # CfT 下载/解压/缓存（↔ process/cft.rs）
//! ├── args.rs        # 启动参数构建（↔ process/args.rs）
//! ├── profile.rs     # profile 目录管理（↔ process/profile.rs）
//! ├── active_port.rs # DevToolsActivePort 轮询/解析（↔ process/active_port.rs）
//! ├── nav_stack.rs   # 导航栈（↔ process/nav_stack.rs）
//! ├── endpoint.rs    # SessionToken + CdpEndpoint 重导出（↔ process/endpoint.rs）
//! ├── events.rs      # ProcessEvent（↔ events.rs）
//! └── platform/      # ProcessTreeKiller / 平台路径表（↔ process/platform/）
//! ```
//!
//! 锁纪律（31-security-baseline B8，评审 21-L2）：`Inner` 使用 std Mutex 且
//! **绝不跨 await 持锁**（持锁区间仅同步状态迁移）；锁中毒恢复式处理，
//! 不 expect/unwrap；端点/令牌只在进程内结构体流转，不进日志/事件（§7.3）。

pub mod active_port;
pub mod args;
pub mod cft;
pub mod discover;
pub mod endpoint;
pub mod events;
pub mod nav_stack;
pub mod platform;
pub mod profile;
pub mod state;

use crate::browser::active_port::{wait_active_port, StderrRing};
use crate::browser::args::{build_args, ArgInputs, EngineMode};
use crate::browser::cft::DownloadOpts;
use crate::browser::discover::{
    resolve_backend, BackendOverride, BackendResolution, CandidateProbe, ResolveOptions,
};
use crate::browser::endpoint::{CdpEndpoint, SessionToken};
use crate::browser::events::ProcessEvent;
use crate::browser::nav_stack::NavStack;
use crate::browser::platform::{new_killer, spawn_command, ProcessTreeKiller};
use crate::browser::profile::{
    browser_root, create_ephemeral, data_root, managed_root, remove_ephemeral,
    remove_stale_active_port, sanitize_profile_name, sessions_root, sweep_orphans, ImportReport,
    LockState,
};
use crate::browser::state::{
    BrowserState, CrashBudget, CrashReason, StateEvent, StateMachine, Transition,
};
use crate::cdp::transport::ExpectedBrowser;
use async_trait::async_trait;
use futures_util::FutureExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, oneshot, watch};

/// 孤儿清扫阈值（§4.4：sessions/ 下 mtime 超 24h）。
const ORPHAN_AGE: Duration = Duration::from_secs(24 * 3600);

/// G-9：Browser.close 发送超时上界（浏览器关闭 WS/响应缺失时不等待命令默认
/// 超时；超时即视为发送失败，走既有 wait_or_kill → 杀树兜底）。
const BROWSER_CLOSE_SEND_TIMEOUT: Duration = Duration::from_secs(2);

mod launch_types;
mod manager;
mod manager_launch;
mod manager_stop;
mod process_util;

#[cfg(test)]
use launch_types::DriverPanicPoint;
pub use launch_types::{
    BrowserStatus, LaunchConfig, LaunchReport, LaunchTuning, ProcessError, ProfileSpec, StopReason,
    StopReport,
};
use launch_types::{Inner, ManagedProcess};
pub use manager::{BrowserCloseSender, BrowserManager};
use process_util::{classify_exit, kill_tree_and_reap, kill_tree_logged, panic_message};

#[cfg(test)]
mod tests;
