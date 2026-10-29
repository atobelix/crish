//! 厂商推送通道接口层（R3-03：协议级构造 + 真实发送接线）
//!
//! 规格真源：
//! - `docs/multi-device/plans/D7-push-notifications.md`（§9.2 `VendorPushChannel`
//!   trait / §8.1 凭据矩阵 / §3.3 S1 重推阶梯 / §6.3 敏感度白名单 / §8.2 凭据注入）；
//! - `docs/multi-device/plans/M8-push-release.md`（§2.2.3 APNs 直连实现要点 /
//!   §2.3.2 厂商通道总览 / §2.3.4 发送适配层接口冻结 / §3.4.4 审批重推阶梯）。
//!
//! ## 分层交付
//!
//! - **R3-03a（协议级构造）**：[VendorPushChannel] trait 契约 + 凭据模型 +
//!   [VendorSendOutcome] + [apns]（请求构造 / JWT 签发 / 响应解析）+ [hms]
//!   （token 请求 / 消息体 / 响应解析）+ 重推阶梯纯函数；
//! - **R3-03b（真实发送接线，本层）**：[apns_sender]（HTTP/2 直连 + JWT
//!   每小时轮换）+ [hms_sender]（OAuth2 换 AT + `expires_in` 缓存 + 鉴权
//!   失败换发重试一次）+ [credentials]（环境变量凭据注入面，D7 §8.2）+
//!   [consumer]（[crate::push::pusher::PushDispatcher::take_pending] →
//!   厂商发送 → 结果分拣的消费链路，未送达条目保留回队列）。
//!
//! ## 装配注记（接线轮消费面）
//!
//! 1. **凭据注入面**：[credentials::EnvCredentialsProvider]（`CRISH_PUSH_*`
//!    环境变量，D7 §8.2）→ [ApnsSender::from_env] / [HmsSender::from_env]
//!    装配；未配置 = 通道不装配（[consumer::send_pending_batch] 保留 pending
//!    + warn 日志，不崩溃）；
//! 2. **APNs 连接池**：reqwest Client 即连接池（M8 §2.2.3-5 每 App 一池），
//!    JWT 每小时轮换（[apns_sender::JwtRotation]，403 作废缓存强制重签）；
//! 3. **HMS token 缓存**：AT 按 `expires_in` 缓存复用（[hms_sender::HmsTokenCache]，
//!    留 60s 余量提前换发）；401/`80100002`/`80100003` 换发重试一次；
//! 4. **重推阶梯消费方**：[crate::push::approve]（SQLite 待发表扫描）驱动
//!    审批重推；本层 [next_retry_delay] 提供阶梯默认间隔，厂商 `retryAfter`
//!    （429 等）优先于阶梯默认值；[consumer] 将可重试失败保留回 pending
//!    （阶梯由周期消费的间隔调度消费，D7 §3.3）；
//! 5. **DeviceNotRegistered**：D7 §6.4-3 语义——[consumer] 计 pruned 并
//!    移出队列，注册表清理接线轮接 `push_devices` 表。
//!
//! ## 临时过渡允许
//!
//! 真实发送接线落地后，[VendorPushChannel] 已有实现（[ApnsSender]/[HmsSender]）
//! 与消费函数（[send_pending_batch]）；周期挂点（main.rs drain 循环）与
//! `push_devices` 表解析属装配轮，push/mod.rs 的 `#![allow(dead_code)]`
//! 保留至装配轮移除。

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;

use super::intent::PayloadDigest;
use super::PushLevel;

pub mod apns;
pub mod apns_sender;
pub mod consumer;
pub mod credentials;
pub mod hms;
pub mod hms_sender;

pub use apns_sender::ApnsSender;
pub use consumer::{send_pending_batch, DeviceResolver, MemoryDeviceResolver, PendingBatchReport};
pub use credentials::{CredentialsProvider, EnvCredentialsProvider};
pub use hms_sender::{HmsSender, HmsTokenCache};

/// 设备平台（D7 §8.2 `push_devices.platform` 枚举子集）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct VendorDevice {
    /// 设备注册 id（registry 主键）
    pub device_id: String,
    /// 厂商侧 device token（APNs token / HMS token）
    pub push_token: String,
    /// 设备平台（决定通道选择）
    pub platform: VendorPlatform,
    /// 设备偏好语言（如 "zh-CN", "en-US"，默认为 None 时走兜底语言）
    #[serde(default)]
    pub preferred_language: Option<String>,
}

impl VendorDevice {
    /// 构造新设备（缺省偏好语言为 None）
    pub fn new(
        device_id: impl Into<String>,
        push_token: impl Into<String>,
        platform: VendorPlatform,
    ) -> Self {
        Self {
            device_id: device_id.into(),
            push_token: push_token.into(),
            platform,
            preferred_language: None,
        }
    }

    /// 设置偏好语言（构建器风格）
    pub fn with_language(mut self, language: impl Into<String>) -> Self {
        self.preferred_language = Some(language.into());
        self
    }
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
    /// 通知渠道（approval/run/subagent/task/timer/security/summary，D7 §7.7；
    /// String 承载——R3-03b 接线轮从 [crate::push::schema::PushMessage] 直传）
    pub channel_id: String,
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
        channel_id: impl Into<String>,
        digest: PayloadDigest,
    ) -> Self {
        Self {
            device,
            level,
            dedupe_key: dedupe_key.into(),
            collapse_key,
            channel_id: channel_id.into(),
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

/// 厂商通道错误（构造/凭据/传输层；消费方语义见各变体）
#[derive(Debug, thiserror::Error)]
pub enum VendorError {
    /// 凭据问题（.p8 缺失/格式错、密钥无效等）
    #[error("厂商凭据无效：{0}")]
    Credential(String),
    /// 请求构造失败（参数缺失/序列化失败等）
    #[error("请求构造失败：{0}")]
    Build(String),
    /// 传输层失败（连接拒绝/超时/协议错；消费方映射为
    /// [VendorSendOutcome::FailedRetryable]——重推阶梯兜底，不新增
    /// 结果变体即可承载，见模块文档注记）
    #[error("传输失败：{0}")]
    Transport(String),
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
mod tests;

// ── 测试支撑：本地 mock HTTP 服务器（发送器测试共享）──

/// 测试支撑模块（仅编译期启用）：极简本地 HTTP 服务器，供
/// [apns_sender]/[hms_sender] 的真实发送测试断言请求形态与回放响应。
///
/// 实现：tokio TcpListener + 手写 HTTP/1.1 读写（无 hyper 依赖——仓库
/// 不为此引入新 dev-dependency，锁文件由并行阵营持有）；请求体按
/// `Content-Length` 读取；响应按路径片段路由 + 按调用次序脚本（最后一格
/// 重复使用）。
#[cfg(test)]
pub(crate) mod test_support {
    use std::net::SocketAddr;
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// 一次记录的请求（断言用）
    #[derive(Debug, Clone)]
    pub struct RequestRecord {
        /// HTTP 方法（POST）
        pub method: String,
        /// 请求路径（`/3/device/tok-1` 等）
        pub path: String,
        /// 头列表（原始大小写；查找用 [RequestRecord::header_value]）
        pub headers: Vec<(String, String)>,
        /// 请求体字节（form / JSON）
        pub body: Vec<u8>,
    }

    impl RequestRecord {
        /// 按头名取首值（大小写不敏感）
        pub fn header_value(&self, name: &str) -> Option<String> {
            self.headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.clone())
        }
    }

    /// 一条脚本化响应（按调用次序消费；最后一格重复）
    #[derive(Debug, Clone, Copy)]
    pub struct MockResponse {
        /// 状态行（`"200 OK"`）
        pub status: &'static str,
        /// 响应体
        pub body: &'static str,
        /// 额外响应头（`"retry-after"` 等）
        pub headers: &'static [(&'static str, &'static str)],
    }

    /// 路由：按路径片段匹配请求，按调用次序回放响应
    pub struct MockRoute {
        /// 路径匹配片段（`"/3/device/"`、`"/token"`、`"messages:send"`）
        pub path_frag: &'static str,
        /// 脚本化响应序列（按每路由调用计数）
        pub responses: &'static [MockResponse],
    }

    /// 运行的 mock 服务器句柄（测试持有；drop 时监听随 runtime 退出）
    pub struct MockServer {
        /// 监听地址（`127.0.0.1:<port>`）
        pub addr: SocketAddr,
        /// 收到的全部请求（按到达次序）
        pub requests: Arc<Mutex<Vec<RequestRecord>>>,
    }

    /// 启动 mock 服务器（常驻 accept 循环；测试结束时随 runtime 退出）
    pub async fn start_mock_server(routes: &'static [MockRoute]) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock 服务器绑定");
        let addr = listener.local_addr().expect("监听地址");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let records = Arc::clone(&requests);
        let mut counters = vec![0usize; routes.len()];
        tokio::spawn(async move {
            loop {
                let (mut stream, _) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    // 监听器随 runtime 退出被丢弃 → 正常结束
                    Err(_) => break,
                };
                let request = read_request(&mut stream).await;
                records.lock().expect("请求记录锁").push(request.clone());
                let route_index = routes
                    .iter()
                    .position(|route| request.path.contains(route.path_frag))
                    .unwrap_or_else(|| panic!("无匹配路由：{}", request.path));
                let step = counters[route_index].min(routes[route_index].responses.len() - 1);
                counters[route_index] += 1;
                let response = &routes[route_index].responses[step];
                write_response(&mut stream, response).await;
            }
        });
        MockServer { addr, requests }
    }

    /// 读取一个 HTTP 请求（请求行 + 头 + Content-Length 体）
    async fn read_request(stream: &mut TcpStream) -> RequestRecord {
        let mut buffer = Vec::new();
        // 头结束符位置（\r\n\r\n）；体可能同包到达
        loop {
            let mut chunk = [0u8; 2048];
            let n = stream.read(&mut chunk).await.expect("读请求");
            if n == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..n]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                break;
            }
        }
        let head_end = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("请求头结束符")
            + 4;
        let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
        let mut lines = head.lines();
        let request_line = lines.next().expect("请求行");
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or_default().to_string();
        let path = parts.next().unwrap_or_default().to_string();
        let headers: Vec<(String, String)> = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
            .collect();
        let content_length = headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.parse::<usize>().ok())
            .unwrap_or(0);
        let mut body = buffer[head_end..].to_vec();
        while body.len() < content_length {
            let mut chunk = [0u8; 2048];
            let n = stream.read(&mut chunk).await.expect("读请求体");
            if n == 0 {
                break;
            }
            body.extend_from_slice(&chunk[..n]);
        }
        body.truncate(content_length);
        RequestRecord {
            method,
            path,
            headers,
            body,
        }
    }

    /// 写固定响应（状态行 + 头 + Content-Length 体）
    async fn write_response(stream: &mut TcpStream, response: &MockResponse) {
        let mut text = format!("HTTP/1.1 {}\r\n", response.status);
        for (key, value) in response.headers {
            text.push_str(&format!("{key}: {value}\r\n"));
        }
        text.push_str(&format!(
            "Content-Length: {}\r\nconnection: close\r\n\r\n{}",
            response.body.len(),
            response.body
        ));
        stream.write_all(text.as_bytes()).await.expect("写响应");
        let _ = stream.flush().await;
    }

    /// mock 服务器自检：请求解析 + 脚本回放（同一路由两次调用返回
    /// 脚本第 1、2 格；无匹配路由 panic 防护）
    #[tokio::test]
    async fn mock_server_records_and_scripts_responses() {
        let mock = start_mock_server(&[MockRoute {
            path_frag: "/ping",
            responses: &[
                MockResponse {
                    status: "200 OK",
                    body: "one",
                    headers: &[],
                },
                MockResponse {
                    status: "202 Accepted",
                    body: "two",
                    headers: &[],
                },
            ],
        }])
        .await;

        let first: String = reqwest::Client::new()
            .post(format!("http://{}/ping", mock.addr))
            .body("req-1")
            .send()
            .await
            .expect("首请求")
            .text()
            .await
            .expect("首响应体");
        assert_eq!(first, "one");
        let second: String = reqwest::Client::new()
            .post(format!("http://{}/ping", mock.addr))
            .body("req-2")
            .send()
            .await
            .expect("次请求")
            .text()
            .await
            .expect("次响应体");
        assert_eq!(second, "two");

        let requests = mock.requests.lock().expect("请求记录锁");
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, "POST");
        assert_eq!(requests[0].path, "/ping");
        assert_eq!(requests[0].body, b"req-1");
        assert_eq!(
            requests[0].header_value("content-length").as_deref(),
            Some("5")
        );
    }

    /// 响应头透传（retry-after 场景面）
    #[tokio::test]
    async fn mock_server_forwards_response_headers() {
        let mock = start_mock_server(&[MockRoute {
            path_frag: "/limit",
            responses: &[MockResponse {
                status: "429 Too Many Requests",
                body: "",
                headers: &[("retry-after", "30")],
            }],
        }])
        .await;
        let response = reqwest::Client::new()
            .post(format!("http://{}/limit", mock.addr))
            .send()
            .await
            .expect("发送");
        assert_eq!(response.status().as_u16(), 429);
        assert_eq!(
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some("30")
        );
    }
}
