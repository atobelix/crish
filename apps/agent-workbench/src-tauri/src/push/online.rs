//! 设备在线判定（R3-02：WS 连接活跃度 → 在线/离线）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md` §4.5（在线状态机：
//!   心跳 10s、超时 30s 判 offline）与 §6.4（分发决策表：connected →
//!   仅 WS 直推；offline → 厂商通道）；
//! - `docs/multi-device/plans/M8-push-release.md` §3.2.1（分发决策：
//!   connected+active/background → WS 直推；offline → 厂商通道）。
//!
//! 设计：
//! - [is_device_online]：**在线判定纯函数**——最近活动时刻距今
//!   < 超时窗口 = 在线（时钟注入可测，D7 §4.5「心跳超时 30s」口径）；
//! - [DevicePresenceSource]：连接活跃度**数据源抽象**——R3 接线轮以
//!   `server::ws::WsRegistry` 适配实现（连接列表 / 设备令牌 / 最近活动）；
//! - 本模块不依赖 server 面（对齐 R3-01 模块纪律：仅 conex-types / serde /
//!   std，可在无 Tauri runtime 下编译与单测），WsRegistry 适配留装配接线轮。
//!
//! ## 装配注记（R3 接线轮）
//!
//! - `DevicePresenceSource` 的 WsRegistry 实现：`ws_registry.snapshot()`
//!   （ws.rs:404，label + last_frame_at_ms）已够判定输入；设备令牌哈希
//!   （对齐 P0-3「每设备一主连接」语义）需 ws.rs 在连接快照中补暴露
//!   token_hash（最小增量 ≤30 行，R3-02 任务书允许），或经
//!   `mark_authenticated` 迁移面取回——接线轮定夺，本任务只冻结接口。

use std::sync::Mutex;

/// 在线判定超时窗口（D7 §6.4：心跳 10s、超时 30s 判 offline）
pub const PRESENCE_TIMEOUT_MS: u64 = 30_000;

/// 设备在线判定纯函数（D7 §4.5 / §6.4）
///
/// 输入：最近收到客户端帧的时刻、当前时刻、超时窗口（ms）。
/// 判定：`now - last_frame < timeout` = 在线（严格小于：恰好超时即离线）。
/// 时钟回拨（now < last_frame）由 saturating_sub 收敛为在线——连接刚活动。
pub fn is_device_online(last_frame_at_ms: u64, now_ms: u64, timeout_ms: u64) -> bool {
    now_ms.saturating_sub(last_frame_at_ms) < timeout_ms
}

/// 设备活动快照（连接活跃度原始数据；在线判定由 [is_device_online] 承担）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceActivity {
    /// 设备标识（对齐 P0-3「每设备一主连接」：设备令牌哈希；接线轮由
    /// WsRegistry 连接条目提供）
    pub device_key: String,
    /// 设备名（配对签发时登记标签）
    pub label: String,
    /// 最近活动时刻（虚拟时钟 ms，对齐 ws.rs 的 touch 语义）
    pub last_frame_at_ms: u64,
}

/// 设备在线状态查询抽象（R3-02：ws_registry 连接活跃度）
///
/// 返回**连接注册表内全部设备**（含最近活动时刻）；在线判定由分发器
/// （[crate::push::pusher::PushDispatcher]）经 [is_device_online] 过滤。
/// 未配对 / 从未连接的设备不在注册表内（R3-03 厂商通道的注册表面，
/// 见 pusher.rs 模块文档）。
pub trait DevicePresenceSource: Send + Sync {
    /// 当前连接设备快照（连接关闭即不在列表；R1-05 断线清理语义）
    fn connected_devices(&self) -> Vec<DeviceActivity>;
}

/// 内存在线状态源（测试 / 缺省实现：固定设备表 + 活动时刻可注入）
#[derive(Debug, Default)]
pub struct MemoryPresenceSource {
    devices: Mutex<Vec<DeviceActivity>>,
}

impl MemoryPresenceSource {
    /// 新建空状态源
    pub fn new() -> Self {
        Self::default()
    }

    /// 替换全部设备表
    pub fn set_devices(&self, devices: Vec<DeviceActivity>) {
        if let Ok(mut table) = self.devices.lock() {
            *table = devices;
        }
    }

    /// 追加一台设备（重复 device_key 覆盖）
    pub fn add_device(&self, device: DeviceActivity) {
        if let Ok(mut table) = self.devices.lock() {
            if let Some(existing) = table.iter_mut().find(|d| d.device_key == device.device_key) {
                *existing = device;
            } else {
                table.push(device);
            }
        }
    }

    /// 更新设备最近活动时刻（对齐 ws.rs 的 touch 语义；不存在则忽略）
    pub fn touch(&self, device_key: &str, last_frame_at_ms: u64) {
        if let Ok(mut table) = self.devices.lock() {
            if let Some(existing) = table.iter_mut().find(|d| d.device_key == device_key) {
                existing.last_frame_at_ms = last_frame_at_ms;
            }
        }
    }
}

impl DevicePresenceSource for MemoryPresenceSource {
    fn connected_devices(&self) -> Vec<DeviceActivity> {
        match self.devices.lock() {
            Ok(table) => table.clone(),
            // 锁损坏属进程级异常：按无设备处理（fail-closed，宁可漏推不误推）
            Err(_) => Vec::new(),
        }
    }
}

/// 设备活动快照便捷构造
pub fn device_activity(
    device_key: impl Into<String>,
    label: impl Into<String>,
    last_frame_at_ms: u64,
) -> DeviceActivity {
    DeviceActivity {
        device_key: device_key.into(),
        label: label.into(),
        last_frame_at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 基准时刻：2026-08-09 12:00:00 UTC（与 engine.rs 测试基准同值）
    const T0: u64 = 1_786_276_800_000;

    /// 刚收到帧（在线判定核心语义：活动刷新即在线）
    #[test]
    fn recently_active_is_online() {
        assert!(is_device_online(T0, T0, PRESENCE_TIMEOUT_MS), "刚活动 = 在线");
        assert!(is_device_online(T0 - 1_000, T0, PRESENCE_TIMEOUT_MS), "1s 前活动 = 在线");
    }

    /// 超时边界：恰好超时窗口（30s）→ 离线（严格小于语义）
    #[test]
    fn exactly_at_timeout_is_offline() {
        assert!(
            !is_device_online(T0 - PRESENCE_TIMEOUT_MS, T0, PRESENCE_TIMEOUT_MS),
            "恰好 30s 无帧 = 离线（D7 §4.5 心跳超时判 offline）"
        );
        assert!(
            is_device_online(T0 - PRESENCE_TIMEOUT_MS + 1, T0, PRESENCE_TIMEOUT_MS),
            "30s - 1ms = 在线"
        );
    }

    /// 超时后离线；自定义窗口可注入（测试可控）
    #[test]
    fn stale_frame_is_offline() {
        assert!(!is_device_online(T0 - 60_000, T0, PRESENCE_TIMEOUT_MS), "60s 无帧 = 离线");
        assert!(!is_device_online(T0 - 10_000, T0, 5_000), "自定义窗口 5s：10s 前 = 离线");
    }

    /// 时钟回拨收敛为在线（saturating_sub 防下溢）
    #[test]
    fn clock_rewind_stays_online() {
        assert!(is_device_online(T0 + 60_000, T0, PRESENCE_TIMEOUT_MS), "时钟回拨不误判离线");
    }

    /// 内存状态源：追加 / 覆盖 / 触摸 / 替换
    #[test]
    fn memory_source_manages_devices() {
        let source = MemoryPresenceSource::new();
        source.add_device(device_activity("tok-a", "手机 A", T0));
        source.add_device(device_activity("tok-b", "手机 B", T0 - 60_000));

        let devices = source.connected_devices();
        assert_eq!(devices.len(), 2, "两台设备");

        // touch 刷新活动（离线设备转在线）
        source.touch("tok-b", T0 - 1_000);
        let devices = source.connected_devices();
        let b = devices.iter().find(|d| d.device_key == "tok-b").expect("B 在表内");
        assert_eq!(b.last_frame_at_ms, T0 - 1_000);

        // 重复 device_key 覆盖（每设备一主连接语义）
        source.add_device(device_activity("tok-b", "手机 B 改", T0));
        let devices = source.connected_devices();
        assert_eq!(devices.len(), 2, "覆盖不增行");

        // set_devices 整体替换
        source.set_devices(vec![device_activity("tok-c", "平板", T0)]);
        let devices = source.connected_devices();
        assert_eq!(devices.len(), 1, "整体替换生效");
        assert_eq!(devices[0].device_key, "tok-c");
    }

    /// 在线/离线过滤语义：分发侧按纯函数过滤（快照 + 判定两段式）
    #[test]
    fn filter_online_by_pure_function() {
        let source = MemoryPresenceSource::new();
        source.set_devices(vec![
            device_activity("online-1", "在线设备", T0 - 1_000),
            device_activity("offline-1", "离线设备", T0 - 60_000),
        ]);
        let online: Vec<DeviceActivity> = source
            .connected_devices()
            .into_iter()
            .filter(|d| is_device_online(d.last_frame_at_ms, T0, PRESENCE_TIMEOUT_MS))
            .collect();
        assert_eq!(online.len(), 1, "仅在线设备命中");
        assert_eq!(online[0].device_key, "online-1");
    }
}
