//! fs_commands 命令面测试：读 / 写 / 列目录守卫与错误协议。
// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

mod error_protocol;
mod list;
mod read;
mod support;
mod write;
