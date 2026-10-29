//! 账户远程设备身份：稳定设备 id 与展示名。

use std::fs;

/// 稳定账户设备 id（首次生成后落到 config 目录；失败时退化为进程内 UUID，
/// 不阻断启动）。
pub fn stable_device_id() -> String {
    let dir = crate::server::config::resolve_config_dir();
    let path = dir.join("account-device-id");
    if let Ok(value) = fs::read_to_string(&path) {
        let value = value.trim();
        if !value.is_empty() {
            return value.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(&path, &id);
    id
}

/// 设备展示名（Windows 计算机名 / Unix hostname；空值兜底）。
pub fn device_name() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let name = name.trim();
    if name.is_empty() {
        "Crish Desktop".to_string()
    } else {
        name.chars().take(80).collect()
    }
}

/// 账号登录设备展示名：主机名 + 平台（账号中心 deviceName 上限 64 字符）。
pub fn device_display_name() -> String {
    let platform = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    };
    let name = format!("{} · {platform}", device_name());
    name.chars().take(64).collect()
}
