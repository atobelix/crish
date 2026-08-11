//! 多端互通配对命令面（R1-07 四件套：pair_start / pair_status /
//! pair_cancel / list_devices；R1-08 撤销/改名；R1-09 网络环境检测；
//! R1-11 服务开关 multi_device_set_enabled）。
//!
//! 实现面直调 [server::pairing::PairingCoordinator]（经 Tauri state 注入，
//! Arc 形态托管——与服务装配面共用同一实例）；配对完成后令牌签发、
//! 撤销全链（WS 踢出 + REST 401）均由协调器负责。

use std::sync::Arc;

use tauri::State;

use crate::multi_device_network::NetworkEnvInfo;
use crate::server::pairing::{DeviceInfo, PairStartResult, PairStatus, PairingCoordinator};
use crate::MultiDeviceService;

/// 激活配对：生成 CXN 码 → 开启局域网监听 → 返回码/二维码/防火墙提示。
///
/// 服务开关门控（D5 D-01 / 红线 1）：`multi_device_set_enabled(false)`
/// 时服务未启动（不监听任何端口），配对监听无从谈起——fail-closed 拒绝
/// 并提示先开启服务（避免「二维码内嵌地址但无监听」的失效状态）。
#[tauri::command]
pub fn multi_device_pair_start(
    service: State<'_, Arc<MultiDeviceService>>,
    coordinator: State<'_, Arc<PairingCoordinator>>,
) -> Result<PairStartResult, String> {
    if !service.enabled() {
        return Err(
            "多端服务未开启（multi_device.enabled=false），请先开启多端服务（multi_device_set_enabled(true)）"
                .to_string(),
        );
    }
    let now = crate::server::now_ms();
    coordinator
        .start_pairing(now)
        .map_err(|e| e.device_code().as_str().to_string())
}

/// 配对状态快照（状态机/剩余时间/失败次数/令牌数；服务开关语义衔接：
/// enabled 关闭时服务无监听，本命令仍如实反映配对状态机）。
#[tauri::command]
pub fn multi_device_pair_status(coordinator: State<'_, Arc<PairingCoordinator>>) -> PairStatus {
    let now = crate::server::now_ms();
    coordinator.status(now)
}

/// 取消配对：状态机重置 → 恢复回环监听。
#[tauri::command]
pub fn multi_device_pair_cancel(coordinator: State<'_, Arc<PairingCoordinator>>) {
    coordinator.cancel_pairing();
}

/// 已配对设备列表（哈希截断展示）。
#[tauri::command]
pub fn multi_device_list_devices(coordinator: State<'_, Arc<PairingCoordinator>>) -> Vec<DeviceInfo> {
    coordinator.list_devices()
}

/// 撤销指定设备（令牌失效 → 落盘 → WS 踢出；R1-08 设备管理页消费）。
#[tauri::command]
pub fn multi_device_revoke_device(
    coordinator: State<'_, Arc<PairingCoordinator>>,
    hash: String,
) -> Result<bool, String> {
    if hash.len() != 64 {
        return Err("无效的令牌哈希".to_string());
    }
    Ok(coordinator.revoke_device(&hash))
}

/// 重命名设备标签（R1-08 设备管理页改名消费）。
#[tauri::command]
pub fn multi_device_rename_device(
    coordinator: State<'_, Arc<PairingCoordinator>>,
    hash: String,
    new_label: String,
) -> Result<bool, String> {
    if hash.len() != 64 {
        return Err("无效的令牌哈希".to_string());
    }
    let label = new_label.trim();
    if label.is_empty() || label.chars().count() > 40 {
        return Err("标签需为 1-40 字符".to_string());
    }
    Ok(coordinator.rename_device(&hash, label))
}

/// 网络环境检测（R1-09 G-4）：网络配置文件类别（公用/专用/域，注册表
/// NetworkList\Profiles）+ 可直连 IP 列表 + 引导文案（防火墙/AP 隔离）。
#[tauri::command]
pub fn multi_device_network_info() -> NetworkEnvInfo {
    crate::multi_device_network::network_env_info()
}

/// 多端服务总开关（R1-11 G-1 / D5 D-01 红线 1）：控制服务本身启停——
/// true = 绑定监听（按当前配对态 Loopback/Lan）；false = 停服，**不
/// bind 任何端口**（netstat 876[5-9] 无监听）。开启后经
/// [multi_device_pair_start] 进入配对模式（重绑 Lan）。
#[tauri::command]
pub async fn multi_device_set_enabled(
    service: State<'_, Arc<MultiDeviceService>>,
    enabled: bool,
) -> Result<(), String> {
    service.set_enabled(enabled).await
}
