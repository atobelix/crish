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
            .unwrap_or_else(|e| e.into_inner())
            .insert(device_key.into(), device);
    }

    /// 移除设备（DeviceNotRegistered 清理语义的测试面）
    pub fn remove(&self, device_key: &str) {
        self.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(device_key);
    }
}

impl DeviceResolver for MemoryDeviceResolver {
    fn resolve(&self, device_key: &str) -> Option<VendorDevice> {
        self.devices
            .lock()
            .unwrap_or_else(|e| e.into_inner())
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
mod tests;
