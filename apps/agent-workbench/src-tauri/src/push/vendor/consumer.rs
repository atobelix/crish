//! 厂商消费链路（R3-03 接线轮：`take_pending` → 厂商发送 → 结果分拣）
//!
//! 规格真源：D7 §9.2（VendorPushChannel 消费：离线 pending 由厂商发送器
//! 周期消费）+ M8 §2.3.4（发送适配层接口冻结）+ D7 §6.6（「发送失败只记录
//! + 审批类重推」——宁可待发不丢）。
//!
//! 链路形态：
//!
//! ```text
//! 周期消费（接线轮在 drain loop 调用 send_pending_batch）
//!   ├─ PushDispatcher::take_pending()           取走全部 pending（移出队列）
//!   ├─ DeviceResolver::resolve(device_key)      设备注册解析（push_devices 表）
//!   │    └─ 未登记 → 保留回队列（kept_pending）
//!   ├─ vendor_channel_for(platform)             平台 → 厂商通道（apns/hms）
//!   │    └─ 通道未装配（凭据缺失）→ 保留回队列（kept_pending，不崩溃）
//!   ├─ VendorPushChannel::send(notification)    真实发送
//!   │    ├─ Delivered            → 清空计数
//!   │    ├─ DeviceNotRegistered  → 清理计数（注册表清理接线轮接 push_devices 表）
//!   │    ├─ RateLimited/Retryable→ 保留回队列（重推阶梯兜底）
//!   │    ├─ FailedPermanent      → 丢弃（审计不重试）
//!   │    └─ Err                  → 保留回队列
//!   └─ PushDispatcher::requeue_pending(保留集)  未送达条目重新入队
//! ```
//!
//! ## 优雅降级（D7 §8.2 / §8.4）
//!
//! 厂商凭据未配置 = 通道不在装配列表中 → 该设备条目**保留回 pending**
//! （warn 日志），下一轮周期再试；任何路径不 panic、不丢队列（pending
//! 只在永久失败/设备失效时移除——审计语义）。
//!
//! ## 周期消费调度注记
//!
//! 本任务交付 [send_pending_batch] 纯消费函数；周期调用由装配轮在既有
//! drain 循环挂点（对齐 main.rs 500ms flush 先例——push/mod.rs 装配注记）。
//! 重试间隔由 [super::ladder_delay_or] 阶梯决策（R3-03a 已交付）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::super::intent::PayloadDigest;
use super::super::pusher::{PendingDelivery, PushDispatcher};
use super::super::{PushLevel, PushSeverity};
use super::{
    VendorDevice, VendorNotification, VendorPlatform, VendorPushChannel, VendorSendOutcome,
};

/// 设备注册解析（device_key → 厂商设备；生产接线 `push_devices` 表）
pub trait DeviceResolver: Send + Sync {
    /// 按设备键解析推送目标；未登记返回 `None`
    fn resolve(&self, device_key: &str) -> Option<VendorDevice>;
}

/// 内存设备注册解析器（测试 / 装配引导用；生产接线 SQLite
/// `push_devices` 表——D7 §8.2）
#[derive(Debug, Default)]
pub struct MemoryDeviceResolver {
    devices: Mutex<HashMap<String, VendorDevice>>,
}

impl MemoryDeviceResolver {
    /// 构造空解析器
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记设备（device_key → 厂商设备）
    pub fn register(&self, device_key: impl Into<String>, device: VendorDevice) {
        self.devices
            .lock()
            .expect("内存注册表锁")
            .insert(device_key.into(), device);
    }

    /// 移除设备（DeviceNotRegistered 清理语义的测试面）
    pub fn remove(&self, device_key: &str) {
        self.devices
            .lock()
            .expect("内存注册表锁")
            .remove(device_key);
    }
}

impl DeviceResolver for MemoryDeviceResolver {
    fn resolve(&self, device_key: &str) -> Option<VendorDevice> {
        self.devices
            .lock()
            .expect("内存注册表锁")
            .get(device_key)
            .cloned()
    }
}

/// 一批 pending 消费的结果报告（测试断言 / 审计用）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PendingBatchReport {
    /// 已送达（厂商受理）条数
    pub delivered: usize,
    /// 保留条数（设备未登记 / 厂商通道未装配（凭据缺失）→ 重新入队）
    pub kept_pending: usize,
    /// 可重试条数（限流/5xx/传输错误 → 重新入队，重推阶梯兜底）
    pub retryable: usize,
    /// 设备失效条数（DeviceNotRegistered → 注册表清理语义，移出队列）
    pub pruned: usize,
    /// 永久失败条数（参数/凭据问题 → 审计不重试，移出队列）
    pub permanent: usize,
}

impl PendingBatchReport {
    /// 空报告
    pub fn new() -> Self {
        Self::default()
    }
}

/// PushMessage severity → 推送级别（[PushLevel]；厂商优先级映射输入）
pub fn level_from_severity(severity: PushSeverity) -> PushLevel {
    match severity {
        PushSeverity::Critical => PushLevel::P0Critical,
        PushSeverity::Important => PushLevel::P1Important,
        PushSeverity::Normal => PushLevel::P2Collapsible,
    }
}

/// 从跳转目标参数提取主业务键（toolCallId/runId/subagentId/taskId/
/// timerId/cronId 白名单键；未命中回退去重键——跳转最小集，D7 §6.3）
fn biz_key_from_target(params: &serde_json::Value) -> Option<String> {
    [
        "toolCallId",
        "runId",
        "subagentId",
        "taskId",
        "timerId",
        "cronId",
    ]
    .into_iter()
    .find_map(|key| params.get(key).and_then(|v| v.as_str()).map(str::to_string))
}

/// 待发条目 → 厂商通知（[PushMessage] → [VendorNotification] 接线映射，
/// M8 §2.3.4 发送适配层；title/body 文案经 copy.rs 渲染进 PushMessage 后
/// 由 digest 桥接——[super::apns::apns_payload] 的 title←detail / body←digest
/// 方向正好还原为 alert.title=标题 / alert.body=正文）
pub fn notification_from_pending(
    delivery: &PendingDelivery,
    device: VendorDevice,
) -> VendorNotification {
    let message = &delivery.message;
    VendorNotification {
        device,
        level: level_from_severity(message.severity),
        dedupe_key: message.dedupe_key.clone(),
        collapse_key: message.collapse_key.clone(),
        channel_id: message.channel_id.clone(),
        digest: PayloadDigest {
            session_id: message.target.session_id.clone().unwrap_or_default(),
            biz_key: biz_key_from_target(&message.target.params)
                .unwrap_or_else(|| message.dedupe_key.clone()),
            digest: message.body.clone(),
            detail: message.title.clone(),
        },
    }
}

/// 平台 → 厂商通道 id（本任务装配集：ios → apns、android → hms；
/// 多厂商按注册表 vendor 列路由为接线轮扩展工作，D7 §8.2 `push_devices.vendor`）
fn vendor_id_for(platform: VendorPlatform) -> &'static str {
    match platform {
        VendorPlatform::Ios => "apns",
        VendorPlatform::Android => "hms",
    }
}

/// 在已装配通道列表中找平台对应通道（`None` = 未装配（凭据缺失））
fn vendor_channel_for<'a>(
    device: &VendorDevice,
    channels: &'a [Arc<dyn VendorPushChannel>],
) -> Option<&'a Arc<dyn VendorPushChannel>> {
    let wanted = vendor_id_for(device.platform);
    channels
        .iter()
        .find(|channel| channel.vendor_id() == wanted)
}

/// 周期消费一批 pending（[PushDispatcher::take_pending] → 厂商发送 →
/// 结果分拣；未送达条目经 [PushDispatcher::requeue_pending] 保留）
///
/// 装配注记：
/// - `resolver`：设备注册解析（生产接 `push_devices` 表）；
/// - `channels`：**已配置凭据的**厂商通道列表（凭据缺失的厂商不装配——
///   该平台设备条目保留回队列，warn 日志）；
/// - 返回 [PendingBatchReport]（送达/保留/重试/清理/永久计数，审计与测试用）。
pub async fn send_pending_batch(
    dispatcher: &PushDispatcher,
    resolver: &dyn DeviceResolver,
    channels: &[Arc<dyn VendorPushChannel>],
) -> PendingBatchReport {
    let deliveries = dispatcher.take_pending();
    let mut report = PendingBatchReport::new();
    let mut kept: Vec<PendingDelivery> = Vec::new();

    for delivery in deliveries {
        let Some(device) = resolver.resolve(&delivery.device_key) else {
            tracing::warn!(
                target: "push",
                device_key = %delivery.device_key,
                "pending 设备未登记注册表，保留待发"
            );
            report.kept_pending += 1;
            kept.push(delivery);
            continue;
        };
        let Some(channel) = vendor_channel_for(&device, channels) else {
            tracing::warn!(
                target: "push",
                device_key = %delivery.device_key,
                vendor = vendor_id_for(device.platform),
                "厂商通道未装配（凭据缺失），pending 保留"
            );
            report.kept_pending += 1;
            kept.push(delivery);
            continue;
        };

        let notification = notification_from_pending(&delivery, device);
        match channel.send(&notification).await {
            Ok(VendorSendOutcome::Delivered) => report.delivered += 1,
            Ok(VendorSendOutcome::DeviceNotRegistered) => {
                // D7 §6.4-3：设备 token 失效 → 注册表清理（接线轮接
                // push_devices 表）；本条移出队列
                tracing::warn!(
                    target: "push",
                    device_key = %delivery.device_key,
                    "设备 token 失效（DeviceNotRegistered），清理注册表语义"
                );
                report.pruned += 1;
            }
            Ok(
                outcome @ (VendorSendOutcome::RateLimited { .. }
                | VendorSendOutcome::FailedRetryable { .. }),
            ) => {
                // 限流/可重试 → 重推阶梯兜底（宁可待发不丢，D7 §6.6）
                tracing::warn!(
                    target: "push",
                    device_key = %delivery.device_key,
                    outcome = ?outcome,
                    "厂商发送可重试失败，保留回队列"
                );
                report.retryable += 1;
                kept.push(delivery);
            }
            Ok(VendorSendOutcome::FailedPermanent { reason }) => {
                // 永久失败 → 审计不重试（D7 §9.2 / M8 §2.2.3-4），移出队列
                tracing::warn!(
                    target: "push",
                    device_key = %delivery.device_key,
                    reason = %reason,
                    "厂商发送永久失败，审计不重试"
                );
                report.permanent += 1;
            }
            Err(error) => {
                // 构造/凭据层错误 → 保守保留（重推阶梯兜底）
                tracing::warn!(
                    target: "push",
                    device_key = %delivery.device_key,
                    error = ?error,
                    "厂商发送错误，保留回队列"
                );
                report.retryable += 1;
                kept.push(delivery);
            }
        }
    }

    if !kept.is_empty() {
        dispatcher.requeue_pending(kept);
    }
    report
}

#[cfg(test)]
mod tests {
    use super::super::VendorError;
    use super::*;
    use crate::push::pusher::{PushChannel, PushChannelError};
    use crate::push::schema::{message_from_decision, PushMessage};
    use crate::push::{
        engine::{DecisionOutcome, PushDecision},
        online::MemoryPresenceSource,
        scenes::SceneId,
    };
    use async_trait::async_trait;

    // ── 测试替身 ──

    /// 固定结果的厂商通道 mock（vendor_id 可设 apns/hms）
    struct FixedOutcomeChannel {
        vendor_id: &'static str,
        outcome: VendorSendOutcome,
    }

    #[async_trait]
    impl VendorPushChannel for FixedOutcomeChannel {
        fn vendor_id(&self) -> &'static str {
            self.vendor_id
        }

        async fn send(
            &self,
            notification: &VendorNotification,
        ) -> Result<VendorSendOutcome, VendorError> {
            assert!(
                !notification.device.push_token.is_empty(),
                "通知必带设备 token"
            );
            Ok(self.outcome.clone())
        }
    }

    fn channel(vendor_id: &'static str, outcome: VendorSendOutcome) -> Arc<dyn VendorPushChannel> {
        Arc::new(FixedOutcomeChannel { vendor_id, outcome })
    }

    /// 离线场景分发器（设备离线 → pending；空通道替身直推失败也会降级，
    /// 直接用 mark_pending 路径：presence 空 → 不推不标记，故注入离线设备）
    fn dispatcher_with_pending(device_keys: &[&str]) -> Arc<PushDispatcher> {
        let presence = Arc::new(MemoryPresenceSource::new());
        // 设备在线但通道必失败 → 降级 pending 的路径；简化：设备标记为
        // 离线（活动帧超 30s 窗口）
        let devices: Vec<_> = device_keys
            .iter()
            .map(|key| {
                crate::push::online::device_activity(*key, "测试设备", 1_784_078_400_000 - 60_000)
            })
            .collect();
        presence.set_devices(devices);
        let channel = Arc::new(FailingChannel);
        Arc::new(PushDispatcher::new(
            presence,
            channel as Arc<dyn PushChannel>,
        ))
    }

    /// 必失败直推通道（使 dispatch 走降级 pending 路径）
    struct FailingChannel;

    impl PushChannel for FailingChannel {
        fn send(&self, _: &str, _: &PushMessage) -> Result<(), PushChannelError> {
            Err(PushChannelError::SendFailed("测试：直推不可用".to_string()))
        }
    }

    /// 决策 → 分发（设备离线 → 标记 pending），返回消息 id
    fn push_and_mark(dispatcher: &PushDispatcher, device_key: &str) {
        let decision = PushDecision {
            deliver: true,
            scene: SceneId::RunFailed,
            level: SceneId::RunFailed.level(),
            severity: SceneId::RunFailed.level().severity(),
            dedupe_key: format!("run-terminal:{device_key}:failed"),
            payload: PayloadDigest {
                session_id: "s-7".to_string(),
                biz_key: device_key.to_string(),
                digest: Some("provider 401".to_string()),
                detail: Some("bash".to_string()),
            },
            outcome: DecisionOutcome::Delivered,
        };
        dispatcher.dispatch(&decision, 1_784_078_400_000);
    }

    fn ios_device(device_key: &str, token: &str) -> VendorDevice {
        VendorDevice::new(format!("dev-{device_key}"), token, VendorPlatform::Ios)
    }

    fn android_device(device_key: &str, token: &str) -> VendorDevice {
        VendorDevice::new(format!("dev-{device_key}"), token, VendorPlatform::Android)
    }

    // ── 用例 ──

    /// 全送达：pending 清空（delivered = 全部）
    #[tokio::test]
    async fn batch_delivers_and_empties_queue() {
        let dispatcher = dispatcher_with_pending(&["tok-ios", "tok-android"]);
        // 一次分发即逐设备标记 pending（dispatch 按 presence 全量扇出）
        push_and_mark(&dispatcher, "tok-ios");

        let resolver = MemoryDeviceResolver::new();
        resolver.register("tok-ios", ios_device("tok-ios", "apns-tok-1"));
        resolver.register("tok-android", android_device("tok-android", "hms-tok-1"));
        let channels = [
            channel("apns", VendorSendOutcome::Delivered),
            channel("hms", VendorSendOutcome::Delivered),
        ];

        let report = send_pending_batch(&dispatcher, &resolver, &channels).await;
        assert_eq!(report.delivered, 2);
        assert_eq!(report.kept_pending, 0);
        assert_eq!(report.retryable, 0);
        assert_eq!(dispatcher.pending_len(), 0, "全送达 → 队列清空");
    }

    /// 凭据缺失（通道未装配）：pending 保留 + kept_pending 计数
    #[tokio::test]
    async fn batch_keeps_pending_when_credentials_missing() {
        let dispatcher = dispatcher_with_pending(&["tok-ios"]);
        push_and_mark(&dispatcher, "tok-ios");
        let resolver = MemoryDeviceResolver::new();
        resolver.register("tok-ios", ios_device("tok-ios", "apns-tok-1"));

        let report = send_pending_batch(&dispatcher, &resolver, &[]).await;
        assert_eq!(report.kept_pending, 1, "无通道 → 保留");
        assert_eq!(report.delivered, 0);
        assert_eq!(dispatcher.pending_len(), 1, "保留回队列");

        // 装配后下一轮可送达
        let report = send_pending_batch(
            &dispatcher,
            &resolver,
            &[channel("apns", VendorSendOutcome::Delivered)],
        )
        .await;
        assert_eq!(report.delivered, 1);
        assert_eq!(dispatcher.pending_len(), 0);
    }

    /// 设备未登记注册表：pending 保留 + kept_pending 计数
    #[tokio::test]
    async fn batch_keeps_pending_when_device_unresolved() {
        let dispatcher = dispatcher_with_pending(&["ghost"]);
        push_and_mark(&dispatcher, "ghost");
        let resolver = MemoryDeviceResolver::new(); // 空注册表
        let channels = [channel("apns", VendorSendOutcome::Delivered)];

        let report = send_pending_batch(&dispatcher, &resolver, &channels).await;
        assert_eq!(report.kept_pending, 1);
        assert_eq!(dispatcher.pending_len(), 1, "未解析设备保留");
    }

    /// 可重试失败（限流）：保留回队列 + retryable 计数
    #[tokio::test]
    async fn batch_requeues_retryable_failures() {
        let dispatcher = dispatcher_with_pending(&["tok-ios"]);
        push_and_mark(&dispatcher, "tok-ios");
        let resolver = MemoryDeviceResolver::new();
        resolver.register("tok-ios", ios_device("tok-ios", "apns-tok-1"));
        let channels = [channel(
            "apns",
            VendorSendOutcome::RateLimited { retry_after: None },
        )];

        let report = send_pending_batch(&dispatcher, &resolver, &channels).await;
        assert_eq!(report.retryable, 1);
        assert_eq!(dispatcher.pending_len(), 1, "可重试 → 保留");

        // 下一轮送达（通道恢复正常）
        let report = send_pending_batch(
            &dispatcher,
            &resolver,
            &[channel("apns", VendorSendOutcome::Delivered)],
        )
        .await;
        assert_eq!(report.delivered, 1);
        assert_eq!(dispatcher.pending_len(), 0);
    }

    /// DeviceNotRegistered：移出队列（清理语义）+ pruned 计数
    #[tokio::test]
    async fn batch_prunes_unregistered_devices() {
        let dispatcher = dispatcher_with_pending(&["tok-ios"]);
        push_and_mark(&dispatcher, "tok-ios");
        let resolver = MemoryDeviceResolver::new();
        resolver.register("tok-ios", ios_device("tok-ios", "apns-tok-1"));
        let channels = [channel("apns", VendorSendOutcome::DeviceNotRegistered)];

        let report = send_pending_batch(&dispatcher, &resolver, &channels).await;
        assert_eq!(report.pruned, 1);
        assert_eq!(dispatcher.pending_len(), 0, "失效设备移出队列");
    }

    /// 永久失败：移出队列（审计不重试）+ permanent 计数
    #[tokio::test]
    async fn batch_drops_permanent_failures() {
        let dispatcher = dispatcher_with_pending(&["tok-ios"]);
        push_and_mark(&dispatcher, "tok-ios");
        let resolver = MemoryDeviceResolver::new();
        resolver.register("tok-ios", ios_device("tok-ios", "apns-tok-1"));
        let channels = [channel(
            "apns",
            VendorSendOutcome::FailedPermanent {
                reason: "BadDeviceToken".to_string(),
            },
        )];

        let report = send_pending_batch(&dispatcher, &resolver, &channels).await;
        assert_eq!(report.permanent, 1);
        assert_eq!(dispatcher.pending_len(), 0, "永久失败不重试");
    }

    /// 发送器错误（Err）：保守保留 + retryable 计数
    #[tokio::test]
    async fn batch_keeps_pending_on_channel_error() {
        struct ErrChannel;

        #[async_trait]
        impl VendorPushChannel for ErrChannel {
            fn vendor_id(&self) -> &'static str {
                "apns"
            }

            async fn send(&self, _: &VendorNotification) -> Result<VendorSendOutcome, VendorError> {
                Err(VendorError::Build("测试构造错误".to_string()))
            }
        }

        let dispatcher = dispatcher_with_pending(&["tok-ios"]);
        push_and_mark(&dispatcher, "tok-ios");
        let resolver = MemoryDeviceResolver::new();
        resolver.register("tok-ios", ios_device("tok-ios", "apns-tok-1"));

        let report = send_pending_batch(&dispatcher, &resolver, &[Arc::new(ErrChannel)]).await;
        assert_eq!(report.retryable, 1);
        assert_eq!(dispatcher.pending_len(), 1, "发送错误保守保留");
    }

    /// 混合结果：送达 + 保留 + 可重试 + 清理 + 永久各归其位
    #[tokio::test]
    async fn batch_mixed_outcomes_split_correctly() {
        let dispatcher = dispatcher_with_pending(&[
            "tok-delivered",
            "tok-missing-cred",
            "tok-retry",
            "tok-prune",
            "tok-permanent",
        ]);
        // 一次分发扇出 → 5 台设备各 1 条 pending
        push_and_mark(&dispatcher, "tok-delivered");

        let resolver = MemoryDeviceResolver::new();
        resolver.register("tok-delivered", ios_device("tok-delivered", "t1"));
        resolver.register("tok-missing-cred", android_device("tok-missing-cred", "t2"));
        resolver.register("tok-retry", ios_device("tok-retry", "t3"));
        resolver.register("tok-prune", ios_device("tok-prune", "t4"));
        resolver.register("tok-permanent", ios_device("tok-permanent", "t5"));

        // 本轮只装配 apns（hms 凭据缺失 → 未装配）：ios 全送达、
        // android（tok-missing-cred）保留回队列
        let channels = [channel("apns", VendorSendOutcome::Delivered)];

        let report = send_pending_batch(&dispatcher, &resolver, &channels).await;
        assert_eq!(report.delivered, 4);
        assert_eq!(report.kept_pending, 1);
        assert_eq!(dispatcher.pending_len(), 1, "仅未装配通道的条目保留");
        let kept = dispatcher.take_pending();
        assert_eq!(kept[0].device_key, "tok-missing-cred");

        // 逐条结果验证：重试/清理/永久各移出/保留语义
        for (key, outcome, expect_len) in [
            (
                "tok-retry",
                VendorSendOutcome::FailedRetryable { retry_after: None },
                1usize,
            ),
            ("tok-prune", VendorSendOutcome::DeviceNotRegistered, 0usize),
            (
                "tok-permanent",
                VendorSendOutcome::FailedPermanent {
                    reason: "x".to_string(),
                },
                0usize,
            ),
        ] {
            let dispatcher = dispatcher_with_pending(&[key]);
            push_and_mark(&dispatcher, key);
            let resolver = MemoryDeviceResolver::new();
            resolver.register(key, ios_device(key, "t"));
            let report =
                send_pending_batch(&dispatcher, &resolver, &[channel("apns", outcome.clone())])
                    .await;
            assert_eq!(dispatcher.pending_len(), expect_len, "结果 {outcome:?}");
            let _ = report;
        }
    }

    /// PushMessage → VendorNotification 映射（severity/文案/白名单/折叠键）
    #[test]
    fn notification_mapping_covers_message_fields() {
        let message = message_from_decision(
            &PushDecision {
                deliver: true,
                scene: SceneId::RunFailed,
                level: PushLevel::P0Critical,
                severity: PushSeverity::Critical,
                dedupe_key: "run-terminal:run-42:failed".to_string(),
                payload: PayloadDigest {
                    session_id: "s-7".to_string(),
                    biz_key: "run-42".to_string(),
                    digest: Some("provider 401".to_string()),
                    detail: None,
                },
                outcome: DecisionOutcome::Delivered,
            },
            "push-000001".to_string(),
            1,
            1_784_078_400_000,
        )
        .with_copy("任务运行失败", "provider 401");
        let delivery = PendingDelivery {
            device_key: "tok-1".to_string(),
            message,
            marked_at_ms: 1_784_078_400_000,
        };
        let notification = notification_from_pending(&delivery, ios_device("tok-1", "apns-tok-1"));
        assert_eq!(notification.device.device_id, "dev-tok-1");
        assert_eq!(notification.device.push_token, "apns-tok-1");
        assert_eq!(notification.device.platform, VendorPlatform::Ios);
        assert_eq!(notification.level, PushLevel::P0Critical, "P0 → critical");
        assert_eq!(notification.dedupe_key, "run-terminal:run-42:failed");
        assert_eq!(notification.collapse_key.as_deref(), Some("session:s-7"));
        assert_eq!(notification.channel_id, "run");
        // digest 桥接：标题 ← title、正文 ← body、sessionId/bizKey 白名单
        assert_eq!(notification.digest.detail.as_deref(), Some("任务运行失败"));
        assert_eq!(notification.digest.digest.as_deref(), Some("provider 401"));
        assert_eq!(notification.digest.session_id, "s-7");
        assert_eq!(
            notification.digest.biz_key, "run-42",
            "params.runId → bizKey"
        );
    }

    /// 映射回退：title/body 未渲染（copy.rs 未接线）→ 缺省标题 + 空正文
    #[test]
    fn notification_mapping_falls_back_without_copy() {
        let message = message_from_decision(
            &PushDecision {
                deliver: true,
                scene: SceneId::ApprovalRequested,
                level: PushLevel::P0Critical,
                severity: PushSeverity::Critical,
                dedupe_key: "approval-requested:tc-9f3a".to_string(),
                payload: PayloadDigest {
                    session_id: "s-7".to_string(),
                    biz_key: "tc-9f3a".to_string(),
                    digest: Some("执行部署脚本".to_string()),
                    detail: None,
                },
                outcome: DecisionOutcome::Delivered,
            },
            "push-1".to_string(),
            1,
            1_784_078_400_000,
        );
        let delivery = PendingDelivery {
            device_key: "tok-1".to_string(),
            message,
            marked_at_ms: 1_784_078_400_000,
        };
        let notification = notification_from_pending(&delivery, ios_device("tok-1", "t"));
        assert_eq!(
            notification.digest.detail, None,
            "title 未渲染 → detail None"
        );
        assert_eq!(notification.digest.digest, None);
        assert_eq!(
            notification.digest.biz_key, "tc-9f3a",
            "params.toolCallId → bizKey"
        );
        assert_eq!(notification.dedupe_key, "approval-requested:tc-9f3a");
    }

    /// severity → 级别映射全矩阵
    #[test]
    fn level_from_severity_matrix() {
        assert_eq!(
            level_from_severity(PushSeverity::Critical),
            PushLevel::P0Critical
        );
        assert_eq!(
            level_from_severity(PushSeverity::Important),
            PushLevel::P1Important
        );
        assert_eq!(
            level_from_severity(PushSeverity::Normal),
            PushLevel::P2Collapsible
        );
    }
}
