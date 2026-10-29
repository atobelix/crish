//! vendor 契约与重推阶梯测试（vendor/mod.rs 拆分）。

use super::*;

/// 契约 mock：实现 [VendorPushChannel] 的最小替身（trait 契约测试）
#[derive(Debug)]
struct MockVendorChannel {
    vendor_id: &'static str,
    outcome: VendorSendOutcome,
}

#[async_trait]
impl VendorPushChannel for MockVendorChannel {
    fn vendor_id(&self) -> &'static str {
        self.vendor_id
    }

    async fn send(
        &self,
        notification: &VendorNotification,
    ) -> Result<VendorSendOutcome, VendorError> {
        // 契约断言：通知必带非空设备 token（trait 层的输入护栏）
        assert!(!notification.device.push_token.is_empty());
        Ok(self.outcome.clone())
    }
}

fn device(token: &str) -> VendorDevice {
    VendorDevice::new("dev-1", token, VendorPlatform::Ios)
}

fn notification(token: &str) -> VendorNotification {
    VendorNotification::new(
        device(token),
        PushLevel::P0Critical,
        "approval-requested:tc-1",
        Some("session:s-7".to_string()),
        "approval",
        PayloadDigest {
            session_id: "s-7".to_string(),
            biz_key: "tc-1".to_string(),
            digest: Some("执行部署脚本".to_string()),
            detail: Some("bash".to_string()),
        },
    )
}

/// 异步块内的 trait 方法调用（经 `dyn` 对象验证 object-safety）
#[tokio::test]
async fn trait_contract_mock_passes_outcome_through() {
    let channel: std::sync::Arc<dyn VendorPushChannel> = std::sync::Arc::new(MockVendorChannel {
        vendor_id: "apns",
        outcome: VendorSendOutcome::Delivered,
    });
    assert_eq!(channel.vendor_id(), "apns");
    let out = channel
        .send(&notification("tok-1"))
        .await
        .expect("mock 不失败");
    assert_eq!(out, VendorSendOutcome::Delivered);
}

/// `dyn` 对象 + 各结果语义透传（重推阶梯输入面形状）
#[tokio::test]
async fn trait_contract_mock_outcome_semantics() {
    let cases = vec![
        (
            VendorSendOutcome::RateLimited {
                retry_after: Some(Duration::from_secs(30)),
            },
            true,
        ),
        (
            VendorSendOutcome::FailedRetryable { retry_after: None },
            true,
        ),
        (
            VendorSendOutcome::FailedPermanent {
                reason: "BadDeviceToken".to_string(),
            },
            false,
        ),
        (VendorSendOutcome::DeviceNotRegistered, false),
    ];
    for (outcome, retryable) in cases {
        let channel: std::sync::Arc<dyn VendorPushChannel> =
            std::sync::Arc::new(MockVendorChannel {
                vendor_id: "hms",
                outcome: outcome.clone(),
            });
        let out = channel
            .send(&notification("tok-2"))
            .await
            .expect("mock 不失败");
        assert_eq!(
            out.is_retryable(),
            retryable,
            "is_retryable 语义：{outcome:?}"
        );
    }
}

/// 结果语义辅助：retry_after 接口预留 + DeviceNotRegistered 清理语义
#[test]
fn outcome_retry_after_and_prune_semantics() {
    let limited = VendorSendOutcome::RateLimited {
        retry_after: Some(Duration::from_secs(60)),
    };
    assert_eq!(limited.retry_after(), Some(Duration::from_secs(60)));
    assert!(!limited.should_prune_device());

    let retryable = VendorSendOutcome::FailedRetryable { retry_after: None };
    assert_eq!(retryable.retry_after(), None);
    assert!(retryable.is_retryable());

    let unregistered = VendorSendOutcome::DeviceNotRegistered;
    assert!(unregistered.should_prune_device());
    assert!(!unregistered.is_retryable());

    let permanent = VendorSendOutcome::FailedPermanent {
        reason: "x".to_string(),
    };
    assert_eq!(permanent.retry_after(), None);
    assert!(!permanent.is_retryable());
}

/// 重推阶梯：15min → 60min → 每小时 ×5，5 次后封顶停止
#[test]
fn retry_ladder_sequence_and_cap() {
    assert_eq!(next_retry_delay(0), Some(Duration::from_secs(15 * 60)));
    for count in 1..=4 {
        assert_eq!(
            next_retry_delay(count),
            Some(Duration::from_secs(60 * 60)),
            "第 {count} 次重推间隔"
        );
    }
    assert_eq!(next_retry_delay(5), None, "5 次后停止重推");
    assert_eq!(next_retry_delay(99), None, "越界安全");
}

/// 厂商 retryAfter 优先于阶梯默认值；缺失时回退阶梯
#[test]
fn ladder_or_vendor_hint_precedence() {
    let vendor_hint = Some(Duration::from_secs(30));
    assert_eq!(ladder_delay_or(0, vendor_hint), vendor_hint, "厂商提示优先");
    assert_eq!(
        ladder_delay_or(0, None),
        Some(Duration::from_secs(15 * 60)),
        "无厂商提示 → 阶梯默认"
    );
    assert_eq!(ladder_delay_or(5, None), None, "阶梯封顶仍生效");
}

/// 通知构造辅助 + 平台 wire 值
#[test]
fn notification_builder_and_platform() {
    let n = notification("tok-3");
    assert_eq!(n.device.push_token, "tok-3");
    assert_eq!(n.collapse_key.as_deref(), Some("session:s-7"));
    assert_eq!(n.channel_id, "approval");
    assert_eq!(VendorPlatform::Ios.as_str(), "ios");
    assert_eq!(VendorPlatform::Android.as_str(), "android");
}
