//! 服务配置（D2 §5.1 / §6：端口 / 绑定模式 / 配对开关 / 令牌文件路径）
//!
//! - 默认端口 8765（CSP 已预留，`tauri.conf.json:29`）；8765 占用时顺序
//!   探测 8766..8775（[PORT_PROBE_COUNT] 个），首个可用端口生效；
//! - 默认绑定 `127.0.0.1`（loopback 恒监听，无暴露面）；配对模式显式
//!   开启时绑定 `0.0.0.0`（仅 R1-07 配对流程接线后开放局域网）；
//! - 令牌文件 `config_dir()/pairing.json`；config_dir 解析语义复用
//!   `config/persistence.rs:39-51`（CRISH_WORKBENCH_CONFIG_DIR 优先 →
//!   APPDATA/Crish/AgentWorkbench → 临时目录兜底）；
//! - server.json 持久化（实际生效端口 / 配对开关落盘）归 R1-07。

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use serde::Serialize;

/// 默认监听端口（CSP 预留；D2 §5.1 / ADR-05）
pub const DEFAULT_PORT: u16 = 8765;
/// 端口探测范围（8765..=8775 共 11 个；D2 §5.1）
pub const PORT_PROBE_COUNT: u16 = 11;
/// loopback 绑定主机（默认）
// R1-02 备注：R1-07 配对模式重绑消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
pub const LOOPBACK_HOST: &str = "127.0.0.1";
/// 局域网绑定主机（配对模式开放；D2 §5.1）
// R1-02 备注：R1-07 配对模式重绑消费——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
pub const LAN_HOST: &str = "0.0.0.0";
/// 令牌文件（D2 §7.3：config_dir()/pairing.json）
pub const PAIRING_FILE_NAME: &str = "pairing.json";

/// 绑定模式（/v1/info 的 bindMode wire 值）
// R1-02 备注：Lan 变体由 R1-07 配对模式构造——dead_code 静音
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BindMode {
    /// 仅本机回环（默认；随应用启动恒监听）
    Loopback,
    /// 局域网开放（配对模式显式开启）
    Lan,
}

/// 服务配置（骨架期结构；server.json 读写与配对开关接线归 R1-07）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    /// 请求端口（0 = 系统分配临时端口，测试用）
    pub port: u16,
    /// 绑定模式
    pub bind_mode: BindMode,
    /// 配对模式是否开启（真实开关接线归 R1-07）
    pub pairing_enabled: bool,
    /// 令牌文件路径（SHA-256 哈希落盘；D2 §7.3）
    pub pairing_file_path: PathBuf,
}

impl ServerConfig {
    /// 以指定配置目录构造默认配置（测试 / 显式目录）
    pub fn new(config_dir: impl Into<PathBuf>) -> Self {
        Self {
            port: DEFAULT_PORT,
            bind_mode: BindMode::Loopback,
            pairing_enabled: false,
            pairing_file_path: config_dir.into().join(PAIRING_FILE_NAME),
        }
    }

    /// 绑定主机（按模式）
    // R1-02 备注：R1-07 重绑消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn bind_host(&self) -> &'static str {
        match self.bind_mode {
            BindMode::Loopback => LOOPBACK_HOST,
            BindMode::Lan => LAN_HOST,
        }
    }

    /// 绑定地址（host + 当前端口）
    // R1-02 备注：R1-07 重绑消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn bind_addr(&self) -> SocketAddr {
        self.bind_addr_for_port(self.port)
    }

    /// 绑定地址（host + 指定端口；探测循环逐端口调用）
    pub fn bind_addr_for_port(&self, port: u16) -> SocketAddr {
        match self.bind_mode {
            BindMode::Loopback => SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            BindMode::Lan => SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)),
        }
    }

    /// 探测端口序列：默认 [DEFAULT_PORT, DEFAULT_PORT+PORT_PROBE_COUNT)；
    /// port=0 时为 [0]（系统分配，仅测试）
    pub fn probe_ports(&self) -> Vec<u16> {
        if self.port == 0 {
            return vec![0];
        }
        (self.port..self.port.saturating_add(PORT_PROBE_COUNT)).collect()
    }
}

impl Default for ServerConfig {
    /// 默认配置（配置目录 = [resolve_config_dir]）
    fn default() -> Self {
        Self::new(resolve_config_dir())
    }
}

/// 配置目录解析（语义复用 `config/persistence.rs:39-51`：env 覆盖 →
/// APPDATA/Crish/AgentWorkbench → 临时目录兜底）
pub fn resolve_config_dir() -> PathBuf {
    if let Ok(path) = std::env::var("CRISH_WORKBENCH_CONFIG_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let trimmed = appdata.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("Crish").join("AgentWorkbench");
        }
    }
    std::env::temp_dir().join("crish-agent-workbench")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_values() {
        let config = ServerConfig::default();
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(config.bind_mode, BindMode::Loopback);
        assert!(!config.pairing_enabled);
        assert_eq!(config.bind_host(), LOOPBACK_HOST);
        assert_eq!(
            config.pairing_file_path.file_name().and_then(|n| n.to_str()),
            Some(PAIRING_FILE_NAME)
        );
    }

    #[test]
    fn new_config_joins_pairing_file_in_dir() {
        let config = ServerConfig::new("C:\\test\\cfg");
        assert_eq!(config.pairing_file_path, PathBuf::from("C:\\test\\cfg\\pairing.json"));
    }

    #[test]
    fn bind_host_and_addr_follow_mode() {
        let mut config = ServerConfig::new(std::env::temp_dir());
        assert_eq!(
            config.bind_addr(),
            SocketAddr::from((Ipv4Addr::LOCALHOST, DEFAULT_PORT))
        );
        config.bind_mode = BindMode::Lan;
        assert_eq!(config.bind_host(), LAN_HOST);
        assert_eq!(
            config.bind_addr_for_port(9000),
            SocketAddr::from((Ipv4Addr::UNSPECIFIED, 9000))
        );
    }

    #[test]
    fn probe_ports_default_range_and_zero() {
        let config = ServerConfig::new(std::env::temp_dir());
        let ports = config.probe_ports();
        assert_eq!(ports.len(), PORT_PROBE_COUNT as usize);
        assert_eq!(ports.first(), Some(&DEFAULT_PORT));
        assert_eq!(ports.last(), Some(&(DEFAULT_PORT + PORT_PROBE_COUNT - 1)));
        // port=0 → 仅 [0]（系统分配）
        let mut zero = config.clone();
        zero.port = 0;
        assert_eq!(zero.probe_ports(), vec![0]);
    }

    #[test]
    fn resolve_config_dir_prefers_env_override() {
        // 记录并清理原值，测试后恢复
        let previous = std::env::var("CRISH_WORKBENCH_CONFIG_DIR").ok();
        std::env::remove_var("CRISH_WORKBENCH_CONFIG_DIR");
        let previous_appdata = std::env::var("APPDATA").ok();
        std::env::remove_var("APPDATA");

        // env 优先
        std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", "D:\\md-cfg");
        assert_eq!(resolve_config_dir(), PathBuf::from("D:\\md-cfg"));
        // 空白 env 值回退
        std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", "   ");
        assert_eq!(
            resolve_config_dir(),
            std::env::temp_dir().join("crish-agent-workbench")
        );
        // 兜底：临时目录
        std::env::remove_var("CRISH_WORKBENCH_CONFIG_DIR");
        assert_eq!(
            resolve_config_dir(),
            std::env::temp_dir().join("crish-agent-workbench")
        );

        if let Some(value) = previous {
            std::env::set_var("CRISH_WORKBENCH_CONFIG_DIR", value);
        } else {
            std::env::remove_var("CRISH_WORKBENCH_CONFIG_DIR");
        }
        if let Some(value) = previous_appdata {
            std::env::set_var("APPDATA", value);
        } else {
            std::env::remove_var("APPDATA");
        }
    }
}
