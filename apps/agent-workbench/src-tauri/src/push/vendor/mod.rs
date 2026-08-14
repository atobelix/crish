//! 厂商推送通道接口层（R3-03 部分交付：协议级构造骨架，不真实发送）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md`（§9.2 `VendorPushChannel`
//!   trait / §8.1 凭据矩阵 / §3.3 S1 重推阶梯 / §6.3 敏感度白名单）；
//! - `docs/multi-device/plans/M8-push-release.md`（§2.2.3 APNs 直连实现要点 /
//!   §2.3.2 厂商通道总览 / §2.3.4 发送适配层接口冻结 / §3.4.4 审批重推阶梯）；
//! - `docs/multi-device/Z0-master-plan.md` §9.5（R3-03 任务包）与 §9.9（验收锚点）。
//!
//! ## 本任务范围（协议级构造，不真实发送）
//!
//! - [VendorPushChannel] trait 契约 + 凭据模型（[APNsCredentials] /
//!   [HMSCredentials]）+ 发送结果语义 [VendorSendOutcome]（重推阶梯输入）；
//! - [apns]：APNs 请求构造（HTTP/2 `POST /3/device/{token}` + `.p8` ES256
//!   JWT 签名头 + 载荷映射 + 响应解析）；
//! - [hms]：HMS 请求构造（AGC OAuth2 换 AT + `messages:send` 消息体 +
//!   响应解析）；
//! - 重推阶梯（D7 §3.3 S1：15min → 60min → 每小时 ×5 最多 5 次）的
//!   纯函数与 `retryAfter` 接口预留（[VendorSendOutcome::retry_after]）。
//!
//! **真实 HTTP 发送留接线轮**（R3-03 集成测试 / 装配轮）：本任务交付
//! 请求构造与响应解析的纯函数，`send` 实现内不发网络请求；接线轮注入
//! `reqwest` 客户端（workspace 已带 `http2` feature，M8 §2.2.3 要求 APNs
//! 走 HTTP/2）并装配凭据注入面（D7 §8.2：环境变量 / 密钥槽，不落明文）。
//!
//! ## 与本模块 R3-01/R3-02 的接缝
//!
//! - 输入契约：[crate::push::intent::PayloadDigest]（R3-01，本任务按任务书
//!   直映射）+ 级别/去重键/折叠键经 [VendorNotification] 携带；
//! - R3-02 [crate::push::schema::PushMessage]（D7 §6.2 schema v1）为接线轮
//!   的最终输入：`title/body` 文案渲染（push/copy.rs）与 `target` 白名单
//!   字段经接线轮映射进 [VendorNotification]（或扩展示字段），本层契约
//!   保持不变；
//! - R3-02 [crate::push::pusher::PendingDelivery] 的离线待发队列由接线轮
//!   消费后调 [VendorPushChannel::send]。
//!
//! ## 装配注记（真实发送接线轮）
//!
//! 1. **凭据注入面**：[APNsCredentials]（.p8 路径/keyId/teamId/bundleId/
//!    沙箱开关）、[HMSCredentials]（appId/appSecret/包名）——D7 §8.2 要求
//!    凭据走环境变量（`CRISH_PUSH_*`）或密钥槽，不进配置文件明文、不进 git；
//! 2. **APNs 连接池**：M8 §2.2.3 建议每 App 一连接池、JWT 每小时轮换
//!    （[apns::JwtEs256Signer] 的 `sign()` 注入时钟，轮换逻辑接线轮做）；
//! 3. **HMS token 缓存**：AT 有效期（`expires_in`）内复用，过期换发
//!    （[hms::parse_token_response] 已带 `expires_in_secs`）；
//! 4. **重推阶梯消费方**：[crate::push::approve]（SQLite 待发表扫描，
//!    D7 §9.3）驱动审批重推；本层 [next_retry_delay] 提供阶梯默认间隔，
//!    厂商 `retryAfter`（429 等）优先于阶梯默认值；
//! 5. **DeviceNotRegistered**：D7 §6.4-3 语义——注册表清理（R3 接线轮接
//!    `push_devices` 表）。
//!
//! ## 临时过渡允许
//!
//! 本模块接线前无调用点（继承 push/mod.rs 的 `#![allow(dead_code)]`），
//! 接线落地即由接线轮移除相关豁免。

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

use super::intent::PayloadDigest;
use super::PushLevel;

pub mod apns;
pub mod hms;

pub use apns::{
    apns_payload, build_apns_send_request, parse_apns_response, ApnsPayload, ApnsSendRequest,
    JwtEs256Signer, APNS_BODY_MAX_CHARS, APNS_DEFAULT_TITLE, APNS_TITLE_MAX_CHARS,
};
pub use hms::{
    build_hms_send_request, build_hms_token_request, parse_hms_send_response, parse_hms_token_response,
    HmsSendRequest, HmsToken, HmsTokenRequest, HMS_SEND_BASE_URL, HMS_SEND_SUCCESS_CODE,
    HMS_TOKEN_URL,
};

/// 设备平台（D7 §8.2 `push_devices.platform` 枚举子集）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VendorPlatform {
    /// iOS（APNs）
    Ios,
    /// 安卓（HMS/小米/vivo/OPPO/荣耀）
    Android,
}

impl VendorPlatform {
    /// wire 值（设备注册表 platform 列）
    pub fn as_str(&self) -> &'static str {
        match self {
            VendorPlatform::Ios => "ios",
            VendorPlatform::Android => "android",
        }
    }
}

/// 推送目标设备（发送寻址最小集；完整注册表字段见 D7 §8.2 `push_devices`）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorDevice {
    /// 设备注册 id（registry 主键）
    pub device_id: String,
    /// 厂商侧 device token（APNs token / HMS token）
    pub push_token: String,
    /// 设备平台（决定通道选择）
    pub platform: VendorPlatform,
}

/// 单条厂商推送通知（R3 装配轮的输入契约）
///
/// 由 R3-01 [crate::push::engine::PushDecision] / R3-02
/// [crate::push::schema::PushMessage] 组装；文案（title/body）在接线轮
/// 经 copy.rs 渲染后填入 [PayloadDigest] 的 `digest`/`detail`（本层映射
/// 直取这两个字段，见 [apns::apns_payload]）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VendorNotification {
    /// 目标设备（含厂商 token）
    pub device: VendorDevice,
    /// 推送级别（severity → 厂商优先级 / interruption-level 映射输入）
    pub level: PushLevel,
    /// 去重键（Android tag / iOS 幂等 / HMS tag，D7 §3.4.1）
    pub dedupe_key: String,
    /// 折叠键（iOS `thread-id` 分组；D7 §3.4.2）
    pub collapse_key: Option<String>,
    /// 通知渠道（approval/run/subagent/task/timer/security/summary，D7 §7.7）
    pub channel_id: &'static str,
    /// 载荷摘要（`digest` → 正文 / `detail` → 标题素材）
    pub digest: PayloadDigest,
}

impl VendorNotification {
    /// 构造辅助：从设备 + 决策面字段组装（测试与接线轮共用）
    pub fn new(
        device: VendorDevice,
        level: PushLevel,
        dedupe_key: impl Into<String>,
        collapse_key: Option<String>,
        channel_id: &'static str,
        digest: PayloadDigest,
    ) -> Self {
        Self {
            device,
            level,
            dedupe_key: dedupe_key.into(),
            collapse_key,
            channel_id,
            digest,
        }
    }
}

/// 厂商发送结果语义（统一各厂商返回；重推阶梯输入，D7 §9.2 + M8 §2.3.4 冻结）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VendorSendOutcome {
    /// 已受理（厂商异步投递：APNs 200 / HMS `80000000`）
    Delivered,
    /// 设备 token 失效 → 注册表清理（D7 §6.4-3；APNs 410 / HMS token 无效码）
    DeviceNotRegistered,
    /// 限流 → 按 `retry_after` 退避（厂商 `Retry-After` 头 / HMS 429）
    RateLimited {
        /// 厂商给出的重试间隔；`None` = 用重推阶梯默认间隔
        retry_after: Option<Duration>,
    },
    /// 可重试失败（5xx / 瞬时错误）→ 重推阶梯
    FailedRetryable {
        /// 厂商给出的重试间隔（可选）；`None` = 用重推阶梯默认间隔
        retry_after: Option<Duration>,
    },
    /// 永久失败（400/403 参数与凭据问题）→ 审计不重试
    FailedPermanent {
        /// 失败原因（供审计日志，不含凭据原文）
        reason: String,
    },
}

impl VendorSendOutcome {
    /// 是否进入重推阶梯（`retry_after` 接口预留；限流与可重试失败为真）
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            VendorSendOutcome::RateLimited { .. } | VendorSendOutcome::FailedRetryable { .. }
        )
    }

    /// 厂商给出的重试间隔（`retryAfter` 字段；`None` = 厂商未给出，
    /// 消费方回退 [next_retry_delay] 阶梯默认值）
    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            VendorSendOutcome::RateLimited { retry_after }
            | VendorSendOutcome::FailedRetryable { retry_after } => *retry_after,
            _ => None,
        }
    }

    /// 是否要求清理设备注册（DeviceNotRegistered 语义，D7 §6.4-3）
    pub fn should_prune_device(&self) -> bool {
        matches!(self, VendorSendOutcome::DeviceNotRegistered)
    }
}

/// 厂商通道错误（构造/凭据层；传输层错误由接线轮在真实发送时映射进
/// [VendorSendOutcome::FailedRetryable]，不新增变体即可承载）
#[derive(Debug, thiserror::Error)]
pub enum VendorError {
    /// 凭据问题（.p8 缺失/格式错、密钥无效等）
    #[error("厂商凭据无效：{0}")]
    Credential(String),
    /// 请求构造失败（参数缺失/序列化失败等）
    #[error("请求构造失败：{0}")]
    Build(String),
    /// 文件读写失败（.p8 加载等）
    #[error("文件读写失败：{path}")]
    Io {
        /// 文件路径
        path: String,
        /// 底层错误
        #[source]
        source: std::io::Error,
    },
    /// 签名/加密错误
    #[error("签名失败：{0}")]
    Crypto(String),
    /// 响应解析失败
    #[error("响应解析失败：{0}")]
    Parse(String),
}

/// APNs 凭据三件套（D7 §8.1：AuthKey(.p8) + KeyID + TeamID + BundleID）
///
/// 凭据注入面：接线轮从环境变量 / 密钥槽装配（D7 §8.2），不落配置明文。
#[derive(Debug, Clone)]
pub struct APNsCredentials {
    /// `.p8` AuthKey 文件路径（PKCS#8 PEM，ES256 私钥）
    pub auth_key_path: PathBuf,
    /// Key ID（JWT header `kid`）
    pub key_id: String,
    /// Team ID（JWT claims `iss`）
    pub team_id: String,
    /// App bundle id（`apns-topic` 头）
    pub bundle_id: String,
    /// 沙箱开关（`true` = api.sandbox.push.apple.com，D7 §8.3 环境隔离）
    pub sandbox: bool,
}

/// 厂商推送通道抽象（D7 §9.2 + M8 §2.3.4 接口冻结）
///
/// 每个厂商（apns/hms/xiaomi/vivo/oppo/honor）一个实现；上层（dispatcher /
/// 重推扫描）经 `dyn` 对象使用，不感知厂商差异。载荷映射（[PayloadDigest] →
/// 厂商字段）在实现内完成（见 [apns] / [hms]）。
#[async_trait]
pub trait VendorPushChannel: Send + Sync {
    /// 通道标识（hms/xiaomi/vivo/oppo/honor/apns，M8 §2.3.4）
    fn vendor_id(&self) -> &'static str;

    /// 发送单条推送 → 结果语义（重推阶梯输入）
    ///
    /// 本任务交付契约与各实现的**协议级构造**；真实 HTTP 发送由接线轮
    /// 注入 `reqwest` 客户端后在此落体（当前实现返回构造错误或
    /// 由接线轮替换为真实发送）。
    async fn send(
        &self,
        notification: &VendorNotification,
    ) -> Result<VendorSendOutcome, VendorError>;
}

/// HMS 凭据（D7 §5.2.3 / M8 §2.3.2：App ID + App Secret，OAuth2 换 AT）
#[derive(Debug, Clone)]
pub struct HMSCredentials {
    /// AGC App ID（OAuth2 `client_id`；发送端点路径段）
    pub app_id: String,
    /// AGC App Secret（OAuth2 `client_secret`，仅换 AT 用，不外泄）
    pub app_secret: String,
    /// AGC 应用包名（与移动端 agconnect-services.json 一致；发送校验用）
    pub package_name: String,
}

// ── 审批重推阶梯（D7 §3.3 S1 / M8 §3.4.4：15min → 60min → 每小时 ×5 最多 5 次）──

/// 重推阶梯间隔（第 1 次 +15min，第 2 次 +60min，之后每小时一次，最多 5 次）
///
/// 下标 = 已完成的重推次数（0 = 首次重推）。
pub const RETRY_LADDER_DELAYS: [Duration; 5] = [
    Duration::from_secs(15 * 60),
    Duration::from_secs(60 * 60),
    Duration::from_secs(60 * 60),
    Duration::from_secs(60 * 60),
    Duration::from_secs(60 * 60),
];

/// 重推阶梯默认间隔：第 `retry_count` 次重推应等待多久。
///
/// 消费方：[crate::push::approve] 的待发表扫描（R3 接线轮）；已重推 5 次
/// 后返回 `None`（阶梯封顶，停止重推）。
pub fn next_retry_delay(retry_count: u64) -> Option<Duration> {
    RETRY_LADDER_DELAYS.get(retry_count as usize).copied()
}

/// 重试间隔决策：厂商 `retry_after` 优先（429/5xx 带 Retry-After 头时），
/// 未给出则回退重推阶梯默认间隔（接口预留的 `retryAfter` 消费点）。
pub fn ladder_delay_or(retry_count: u64, vendor_retry_after: Option<Duration>) -> Option<Duration> {
    vendor_retry_after.or_else(|| next_retry_delay(retry_count))
}

#[cfg(test)]
mod tests {
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
        VendorDevice {
            device_id: "dev-1".to_string(),
            push_token: token.to_string(),
            platform: VendorPlatform::Ios,
        }
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
        let channel: std::sync::Arc<dyn VendorPushChannel> = std::sync::Arc::new(
            MockVendorChannel {
                vendor_id: "apns",
                outcome: VendorSendOutcome::Delivered,
            },
        );
        assert_eq!(channel.vendor_id(), "apns");
        let out = channel.send(&notification("tok-1")).await.expect("mock 不失败");
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
            let channel: std::sync::Arc<dyn VendorPushChannel> = std::sync::Arc::new(
                MockVendorChannel { vendor_id: "hms", outcome: outcome.clone() },
            );
            let out = channel.send(&notification("tok-2")).await.expect("mock 不失败");
            assert_eq!(out.is_retryable(), retryable, "is_retryable 语义：{outcome:?}");
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
}
