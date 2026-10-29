//! server 测试共享基建（server/mod.rs 拆分）。

use super::super::*;

/// 测试配置（临时目录令牌路径 + 指定端口；port=0 = 系统分配）
pub(super) fn temp_config(port: u16) -> ServerConfig {
    let mut config = ServerConfig::new(std::env::temp_dir());
    config.port = port;
    config
}
