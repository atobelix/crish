//! 跨端命令消息类型（remote.* / result.*；M6 §4 + §10.6）
//!
//! - [CommandRequest]：命令请求 body（`kind = remote.<name>`，M6 §10.6.1
//!   信封：`{command, params, timeoutMs?}`）；参数类型 = 既有 Tauri 命令入参
//!   镜像（camelCase，跨端不新造第二套 DTO，M6 §2.4 原则 1）；
//! - [CommandResult]：统一响应（M6 §6.1 三态：success / error / partial）；
//! - 37 条命令的参数（`*Params`）与响应（`*Result`）按 M6 §10.6.2 JSON
//!   Schema 映射为 Rust 结构（必填 = 非 Option，可选 = Option + serde 缺省）；
//! - [COMMANDS]：37 条命令规格常量表（方向标注 + 白名单 B 面 + 幂等写标记）；
//!   写命令五条（approve/deny/writeFile/setSettings/pauseAutomation）走
//!   outbox + at-least-once（M6 §1.3）。

mod approval;
mod enums;
mod envelope;
mod fs_workspace;
mod run_settings_device;
mod session_run;
mod spec_table;

pub use approval::*;
pub use enums::*;
pub use envelope::*;
pub use fs_workspace::*;
pub use run_settings_device::*;
pub use session_run::*;
pub use spec_table::*;

#[cfg(test)]
mod tests;
