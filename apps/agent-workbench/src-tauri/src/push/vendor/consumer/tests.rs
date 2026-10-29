//! vendor consumer 测试（consumer.rs 拆分）：离线批发送与通知映射。

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
            send_pending_batch(&dispatcher, &resolver, &[channel("apns", outcome.clone())]).await;
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
