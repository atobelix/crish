//! R3-02 推送装配适配层（bin 侧：桥接 lib push 契约与 bin server 类型）
//!
//! lib 目标（push 决策/直推契约）与 bin 目标（main.rs 装配面）的模块树
//! 分裂（lib.rs:1-22 注记）：`server`（WsRegistry）只存在于 bin；`push`
//! 只存在于 lib。本模块是 R3-02 接线轮的**跨层装配面**，承担两类桥接：
//!
//! 1. **在线判定数据源**：[crate::server::ws::WsRegistry] →
//!    [DevicePresenceSource]——连接快照（token_hash / label / 最近活动）
//!    → 设备活跃表；在线/离线由分发器经 `is_device_online` 纯函数过滤
//!    （push/online.rs 装配注记的接线轮交付）。
//! 2. **直推通道**：[WsPushChannel]——[PushChannel] 的 WS 实现：
//!    PushMessage → events.push 帧（schema::ws_push_body 载荷 + ws.rs
//!    outbound_frame 信封）→ 注册表按令牌哈希定位连接 → 出站通道投递
//!    （复用 R1 事件面 sender task 发送路径，M8 裁决修正 2）。
//!
//! 注：原「Emitter 双向适配」随 core_event_bridge 下沉 conex-run 合一为
//! 单一 trait——PushAwareEmitter 直接实现 [conex_run::core_event_bridge::
//! Emitter]（push/pusher.rs），TauriEmitter 同（tauri_emitter.rs），
//! 本模块的桥接 impl 随双副本一并删除。
//!
//! 装配（main.rs ⑥ 事件桥处）：presence/channel 均基于**同一共享
//! WsRegistry**（与配对协调器同一实例，main.rs ⑤b）——设备令牌哈希对齐
//! P0-3「每设备一主连接」语义（by_token 表主键 = mark_authenticated
//! 迁移后的真实令牌哈希）。
//!
//! ## 测试
//!
//! 本模块测试用**真实 WsRegistry**（注册连接 + 注入出站通道）验证适配与
//! 投递；信封内容级断言在 server/ws.rs 的 send_push_frame 测试（同一
//! 代码路径，Outbound 类型可见面）。

use std::sync::Arc;

use crish_agent_workbench::push::{
    device_activity, DeviceActivity, DevicePresenceSource, PushChannel, PushChannelError,
    PushMessage,
};

use crate::server::ws::WsRegistry;

/// WsRegistry → DevicePresenceSource（R3-02：连接快照 → 设备活跃表）
///
/// device_key = 连接令牌哈希（by_token 主键，对齐 P0-3「每设备一主连接」；
/// 配对升级连接在 mark_authenticated 迁移前为占位哈希——配对期极短，
/// 推送帧即使误达配对态连接也会被对端按未知 kind 宽容忽略，D3 §10.3）。
impl DevicePresenceSource for WsRegistry {
    fn connected_devices(&self) -> Vec<DeviceActivity> {
        self.device_activities()
            .into_iter()
            .map(|(token_hash, label, last_frame_at_ms)| {
                device_activity(token_hash, label, last_frame_at_ms)
            })
            .collect()
    }
}

/// 直推通道的 WS 实现（R3-02：PushMessage → events.push 帧 → 在线设备）
///
/// 链路：`schema::ws_push_body`（EventsPush 载荷，M8 裁决修正 2）→
/// `WsRegistry::send_push_frame`（outbound_frame 信封 + 出站通道投递）；
/// 无连接 / 缓冲满 → 错误返回，分发器降级标记 pending（D7 §6.6「宁可
/// 待发不丢」）。
pub struct WsPushChannel {
    registry: Arc<WsRegistry>,
}

impl WsPushChannel {
    /// 用共享连接注册表构造（main.rs 装配：与配对协调器同一实例）
    pub fn new(registry: Arc<WsRegistry>) -> Self {
        Self { registry }
    }
}

impl PushChannel for WsPushChannel {
    fn send(&self, device_key: &str, message: &PushMessage) -> Result<(), PushChannelError> {
        let body = serde_json::to_value(crish_agent_workbench::push::ws_push_body(message))
            .map_err(|e| {
                PushChannelError::SendFailed(format!("events.push 载荷序列化失败：{e}"))
            })?;
        match self.registry.send_push_frame(device_key, body) {
            Some(true) => Ok(()),
            Some(false) => Err(PushChannelError::SendFailed(
                "连接发送缓冲满（端级背压，降级 pending）".to_string(),
            )),
            None => Err(PushChannelError::NoConnection),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use tokio::sync::{mpsc, watch};

    use crish_agent_workbench::push::{DecisionOutcome, PayloadDigest, PushDecision, SceneId};

    use crate::server::ws::RegisterOutcome;

    /// 注册连接（watch 踢出信号 + 显式注册时刻）
    fn register_conn(registry: &WsRegistry, token_hash: &str, label: &str, now: u64) -> u64 {
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        match registry.register(token_hash, label, kill_tx, now) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        }
    }

    // ── DevicePresenceSource 适配（真实注册表快照 → 在线判定）──

    /// 真实注册表连接 → 设备活跃表（token_hash / label / 最近活动时刻）
    #[test]
    fn registry_connections_become_device_activities() {
        let registry = WsRegistry::new();
        register_conn(&registry, "tok-a", "手机 A", 1_000);
        register_conn(&registry, "tok-b", "手机 B", 2_000);

        let devices = registry.connected_devices();
        assert_eq!(devices.len(), 2, "注册表内全部设备在活跃表");
        let a = devices
            .iter()
            .find(|d| d.device_key == "tok-a")
            .expect("A 在活跃表");
        assert_eq!(a.label, "手机 A");
        assert_eq!(a.last_frame_at_ms, 1_000);
    }

    /// 在线判定两段式（快照 + 纯函数过滤）：30s 窗口内活动 = 在线，
    /// 超时 = 离线（分发侧与 push/online.rs 口径一致）
    #[test]
    fn registry_snapshot_filters_online_devices() {
        let registry = WsRegistry::new();
        let id_a = register_conn(&registry, "tok-a", "手机 A", 1_000);
        register_conn(&registry, "tok-b", "手机 B", 1_000);
        registry.touch(id_a, 60_000);

        // now = 61s：tok-a 1s 前活动（在线）；tok-b 60s 前活动（离线）
        let online: Vec<DeviceActivity> = registry
            .connected_devices()
            .into_iter()
            .filter(|d| {
                crish_agent_workbench::push::is_device_online(d.last_frame_at_ms, 61_000, 30_000)
            })
            .collect();
        assert_eq!(online.len(), 1, "仅在线设备命中");
        assert_eq!(online[0].device_key, "tok-a");
    }

    /// 连接关闭即从活跃表消失（R1-05 断线清理语义）
    #[test]
    fn disconnected_device_disappears_from_presence() {
        let registry = WsRegistry::new();
        let id = register_conn(&registry, "tok-a", "手机 A", 1_000);
        register_conn(&registry, "tok-b", "手机 B", 1_000);
        registry.unregister(id);
        let devices = registry.connected_devices();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_key, "tok-b");
    }

    // ── PushChannel WS 实现（mock 连接 → events.push 帧到达）──

    /// S4 run 失败决策 → PushMessage（schema 映射，与 schema.rs 测试同源）
    fn push_message() -> PushMessage {
        let decision = PushDecision {
            deliver: true,
            scene: SceneId::RunFailed,
            level: SceneId::RunFailed.level(),
            severity: SceneId::RunFailed.level().severity(),
            dedupe_key: "run-terminal:run-42:failed".to_string(),
            payload: PayloadDigest {
                session_id: "s-7".to_string(),
                biz_key: "run-42".to_string(),
                digest: Some("provider 401".to_string()),
                detail: None,
            },
            outcome: DecisionOutcome::Delivered,
        };
        crish_agent_workbench::push::message_from_decision(
            &decision,
            "push-000001".to_string(),
            1,
            1_784_078_400_000,
        )
    }

    /// mock 连接（注册 + 出站通道注入）→ send → 帧到达断言（同一
    /// sender task 消费队列；信封内容级断言在 ws.rs send_push_frame 测试）
    #[tokio::test]
    async fn ws_channel_delivers_frame_to_connected_device() {
        let registry = Arc::new(WsRegistry::new());
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let conn_id = match registry.register("tok-a", "手机 A", kill_tx, 1_000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        let (out_tx, mut out_rx) = mpsc::channel(4);
        registry.attach_outbound(conn_id, out_tx);

        let channel = WsPushChannel::new(Arc::clone(&registry));
        channel
            .send("tok-a", &push_message())
            .expect("在线设备直推必须成功");
        assert!(out_rx.recv().await.is_some(), "直推帧必须到达连接出站通道");
    }

    /// 无活动连接 → NoConnection（在线判定与连接生命周期竞态）
    #[tokio::test]
    async fn ws_channel_no_connection_reports_error() {
        let registry = Arc::new(WsRegistry::new());
        let channel = WsPushChannel::new(registry);
        let error = channel
            .send("tok-ghost", &push_message())
            .expect_err("无连接必须报错");
        assert_eq!(error, PushChannelError::NoConnection);
    }

    /// 出站缓冲满 → SendFailed（端级背压，分发器降级 pending）
    #[tokio::test]
    async fn ws_channel_buffer_full_reports_send_failed() {
        let registry = Arc::new(WsRegistry::new());
        let (kill_tx, _) = watch::channel::<Option<String>>(None);
        let conn_id = match registry.register("tok-a", "手机 A", kill_tx, 1_000) {
            RegisterOutcome::Registered(id) => id,
            _ => panic!("注册必须成功"),
        };
        // 容量 1：首帧占满缓冲 → 第二帧背压失败（接收端保持存活）
        let (out_tx, out_rx) = mpsc::channel(1);
        registry.attach_outbound(conn_id, out_tx);

        let channel = WsPushChannel::new(Arc::clone(&registry));
        channel
            .send("tok-a", &push_message())
            .expect("首帧应入缓冲");
        let error = channel
            .send("tok-a", &push_message())
            .expect_err("缓冲满必须报错");
        assert!(
            matches!(error, PushChannelError::SendFailed(_)),
            "背压错误：{error:?}"
        );
        let _ = out_rx;
    }
}
