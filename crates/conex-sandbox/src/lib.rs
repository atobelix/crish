//! 命令安全分类。唯一入口是 assess。

mod assess;
mod classify;
pub mod gatekeeper;
mod lex;
pub mod powershell;
pub mod verdict;

pub use assess::{assess, Assessment, Segment};
pub use classify::{ApprovalReason, CommandClass};
