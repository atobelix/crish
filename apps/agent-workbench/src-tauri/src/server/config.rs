//! 服务配置（D2 §5.1 / §6：端口 / 绑定模式 / 配对开关 / 令牌文件路径）
//!
//! - 默认端口 8765（CSP 已预留，`tauri.conf.json:29`）；8765 占用时顺序
//!   探测 8766..8775（[PORT_PROBE_COUNT] 个），首个可用端口生效；
//! - 默认绑定 `127.0.0.1`（loopback，无暴露面）；配对模式显式开启时
//!   绑定 `0.0.0.0`（仅 R1-07 配对流程接线后开放局域网）；
//! - 服务开关 [ServerConfig::multi_device_enabled]：默认关闭（D5 §2 D-01
//!   与 §10.3 红线 1——「multi_device.enabled=false 时无任何端口监听」），
//!   enabled=false 时**完全不 bind**（Loopback 也不监听，D5:948「服务关闭
//!   （不监听任何端口）」）；显式开启（multi_device_set_enabled 命令或
//!   配置面）后才启动监听；
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
    /// 多端服务总开关（D5 D-01 / 红线 1）：默认 false = 服务关闭，
    /// **完全不 bind**（Loopback 也不监听，netstat 无 876[5-9]）；显式
    /// 开启后按 bind_mode 监听（D5 §2 第 1 层服务开关）
    pub multi_device_enabled: bool,
    /// TLS 开关（D5 D-02a「远程网关只提供 wss」的配置面）：true = 监听
    /// **仅提供 wss**（自签证书 TLS 1.3/1.2，明文 ws:// 握手在 TLS 层拒绝，
    /// 不存在明文 ws 端点，D5 §2.1 降级保护）；false = 明文 HTTP/WS。
    ///
    /// 默认 false 的依据：既有测试与 loopback 联调面均为明文直连（D2
    /// L4-1 `curl http://127.0.0.1:8765`、D2 L2 `ws://127.0.0.1:0` 测试
    /// 口径），结构默认值保持兼容；**生产装配（main.rs restart_server）
    /// 按 D5 语义显式置 true**——「wss 强制 R1 即生效」（D2 §12.8 裁决修正
    /// 11）由装配层承担，而非结构默认值。
    pub tls_enabled: bool,
    /// TLS 证书目录（None = 默认 `config_dir()/multi-device/`，目录语义
    /// 见 multi_device/tls.rs；测试注入临时目录隔离真实配置目录）
    pub tls_cert_dir: Option<PathBuf>,
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
            // D-01：多端互通服务默认关闭，零默认暴露面——enabled=false
            // 时装配面不 bind 任何端口（红线 1「无任何端口监听」）
            multi_device_enabled: false,
            // TLS 默认关闭：既有明文测试与 loopback 联调面保持兼容；生产
            // 装配层显式开启（wss 强制，D5 D-02a / D2 §12.8 裁决修正 11）
            tls_enabled: false,
            tls_cert_dir: None,
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
        // D5 D-01 / 红线 1：服务默认关闭（enabled=false 时不 bind 任何端口）
        assert!(
            !config.multi_device_enabled,
            "多端服务默认必须关闭（零默认暴露面）"
        );
        // TLS 默认关闭（既有明文测试与 loopback 联调面兼容；生产装配层
        // 按 D5 D-02a 显式开启 wss 强制）
        assert!(!config.tls_enabled, "TLS 默认必须关闭");
        assert!(
            config.tls_cert_dir.is_none(),
            "证书目录默认跟随 config_dir()/multi-device/"
        );
        assert_eq!(config.bind_host(), LOOPBACK_HOST);
        assert_eq!(
            config
                .pairing_file_path
                .file_name()
                .and_then(|n| n.to_str()),
            Some(PAIRING_FILE_NAME)
        );
    }

    #[cfg(windows)]
    #[test]
    fn new_config_joins_pairing_file_in_dir() {
        let config = ServerConfig::new("C:\\test\\cfg");
        assert_eq!(
            config.pairing_file_path,
            PathBuf::from("C:\\test\\cfg\\pairing.json")
        );
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
