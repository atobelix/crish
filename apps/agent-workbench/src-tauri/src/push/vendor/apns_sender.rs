//! APNs 真实发送器（R3-03 接线轮：HTTP/2 直连 + JWT 每小时轮换）
//!
//! 规格真源：M8 §2.2.3（APNs 直连实现要点）+ D7 §8.2（凭据注入面）。
//! 承接 [super::apns]（R3-03a 协议级构造：请求构造 / JWT 签发 / 响应解析）
//! 的产物做真实网络发送：
//!
//! - 通道形态：HTTP/2 `POST /3/device/{token}`（reqwest workspace 依赖
//!   已带 `http2` feature；TLS 握手经 ALPN 协商 h2——[build_apns_send_request]
//!   产出的 https URL 直发，连接池由 reqwest Client 持有，对齐 M8 §2.2.3-5
//!   每 App 一连接池）；
//! - 认证：`.p8` ES256 JWT（[super::apns::JwtEs256Signer]），缓存签发时刻
//!   与 token，按年龄**每小时轮换**（[JwtRotation]，轮换边界留 60s 余量
//!   防时钟漂移）；403（无效 token）时主动作废缓存强制重签（M8 §2.2.3-4
//!   「403 无效 token（凭据轮换）」）；
//! - 结果映射：复用 [super::apns::parse_apns_response]（200/410/429/4xx/5xx）；
//!   传输层错误（连接拒绝/超时）按 vendor 层注记映射为
//!   [super::VendorSendOutcome::FailedRetryable]（重推阶梯兜底）；
//! - 凭据：经 [super::credentials] 注入（环境变量），未配置 = 通道不装配
//!   （[ApnsSender::from_env] 返回 None，pending 保留——优雅降级）。

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;

use super::apns::{
    build_apns_send_request_at, parse_apns_response, APNS_JWT_TTL_SECS, APNS_PROD_HOST,
    APNS_SANDBOX_HOST, JwtEs256Signer,
};
use super::credentials::{CredentialsProvider, EnvCredentialsProvider};
use super::{
    APNsCredentials, VendorError, VendorNotification, VendorPushChannel, VendorSendOutcome,
};

/// JWT 轮换余量（签发后不足 TTL 差此秒数即轮换；防时钟漂移导致
/// 中途过期——APNs 对过期 token 回 403/401）
pub const APNS_JWT_ROTATE_LEEWAY_SECS: u64 = 60;
/// 单请求超时（周期消费循环不被挂起网络拖死；APNs 正常响应在秒级）
pub const APNS_SEND_TIMEOUT_SECS: u64 = 10;

/// JWT 轮换缓存（纯结构：签发时刻 + token；轮换决策 = 纯函数）
#[derive(Debug, Clone)]
pub struct JwtRotation {
    /// 签发时刻（UNIX 秒；JWT claims `iat`）
    issued_at_secs: u64,
    /// 缓存 JWT（`<header>.<claims>.<signature>`）
    token: String,
}

impl JwtRotation {
    /// 记录一次签发
    pub fn new(issued_at_secs: u64, token: String) -> Self {
        Self {
            issued_at_secs,
            token,
        }
    }

    /// 缓存是否仍可用（签发后未满 `TTL - 余量` → 复用，否则轮换）
    pub fn fresh(&self, now_secs: u64) -> bool {
        now_secs.saturating_sub(self.issued_at_secs) < APNS_JWT_TTL_SECS - APNS_JWT_ROTATE_LEEWAY_SECS
    }

    /// 缓存 JWT
    pub fn token(&self) -> &str {
        &self.token
    }

    /// 签发时刻（测试与诊断）
    pub fn issued_at_secs(&self) -> u64 {
        self.issued_at_secs
    }
}

/// APNs 真实发送器（[VendorPushChannel] 的 APNs 实现）
///
/// 构造即加载 `.p8` 签名器（同步文件读——装配期一次，非发送热路径）；
/// [send]（trait 面）用墙钟，测试用 [send_at] 注入时刻验证轮换。
pub struct ApnsSender {
    /// 凭据快照（.p8 路径/keyId/teamId/bundleId/沙箱开关）
    credentials: APNsCredentials,
    /// ES256 签名器（R3-03a 交付）
    signer: JwtEs256Signer,
    /// reqwest 客户端（装配方注入；生产 = rustls + http2 协商）
    http: reqwest::Client,
    /// 发送基址（生产 = `https://api.push.apple.com`；测试注入本地端点）
    base_url: String,
    /// JWT 轮换缓存（Mutex 保护并发 send；锁内无 await）
    jwt: Mutex<Option<JwtRotation>>,
}

impl ApnsSender {
    /// 用凭据 + 客户端构造（加载 `.p8` 失败返回 [VendorError::Credential]/[VendorError::Io]）
    pub fn new(http: reqwest::Client, credentials: APNsCredentials) -> Result<Self, VendorError> {
        let signer = JwtEs256Signer::load(
            &credentials.auth_key_path,
            &credentials.key_id,
            &credentials.team_id,
        )?;
        let host = if credentials.sandbox {
            APNS_SANDBOX_HOST
        } else {
            APNS_PROD_HOST
        };
        Ok(Self {
            credentials,
            signer,
            http,
            base_url: format!("https://{host}"),
            jwt: Mutex::new(None),
        })
    }

    /// 从环境变量凭据构造（D7 §8.2）；未配置（变量缺失）→ `None`，
    /// 配置了但 `.p8` 加载失败 → `Some(Err)`
    pub fn from_env(http: reqwest::Client) -> Option<Result<Self, VendorError>> {
        Self::from_provider(http, &EnvCredentialsProvider)
    }

    /// 从任意凭据提供者构造（装配注入面；`None` = 未配置 → 通道不装配）
    pub fn from_provider(
        http: reqwest::Client,
        provider: &dyn CredentialsProvider,
    ) -> Option<Result<Self, VendorError>> {
        provider.apns().map(|credentials| Self::new(http, credentials))
    }

    /// 注入发送基址（测试用：本地 mock HTTP 端点；生产走 [new]/[from_env]）
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    /// 带时刻发送（轮换判定用 `now_secs`；测试注入，生产 [send] 走墙钟）
    pub async fn send_at(
        &self,
        notification: &VendorNotification,
        now_secs: u64,
    ) -> Result<VendorSendOutcome, VendorError> {
        let jwt = self.fresh_jwt(now_secs)?;
        let request = build_apns_send_request_at(&self.credentials, notification, &jwt, &self.base_url)?;

        let mut builder = self
            .http
            .post(&request.url)
            .header(reqwest::header::AUTHORIZATION, &request.authorization)
            .header("apns-push-type", request.apns_push_type)
            .header("apns-priority", request.apns_priority.to_string())
            .header("apns-topic", &request.apns_topic)
            .timeout(Duration::from_secs(APNS_SEND_TIMEOUT_SECS));
        if let Some(collapse_id) = &request.apns_collapse_id {
            builder = builder.header("apns-collapse-id", collapse_id);
        }
        let request = builder.body(request.body);

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                // 传输层错误（连接拒绝/超时/协议错）→ 可重试（vendor 层
                // 注记：传输错误映射进 FailedRetryable，不新增 VendorError 变体）
                tracing::warn!(target: "push", vendor = "apns", error = %error, "APNs 传输失败，按可重试处理");
                return Ok(VendorSendOutcome::FailedRetryable { retry_after: None });
            }
        };
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let body = response.text().await.unwrap_or_default();
        let outcome = parse_apns_response(status, Some(&body), retry_after.as_deref());

        // 403 = 无效 token（M8 §2.2.3-4：凭据轮换）→ 作废缓存强制重签
        if status == 403 {
            if let Ok(mut cached) = self.jwt.lock() {
                *cached = None;
            }
            tracing::warn!(target: "push", "APNs 403 无效 JWT，作废缓存下次重签");
        }
        Ok(outcome)
    }

    /// 取新鲜 JWT（缓存有效复用；否则重签 + 记时刻；锁内无 await）
    fn fresh_jwt(&self, now_secs: u64) -> Result<String, VendorError> {
        let mut cached = self.jwt.lock().map_err(|_| {
            VendorError::Crypto("APNs JWT 缓存锁损坏".to_string())
        })?;
        if let Some(rotation) = cached.as_ref() {
            if rotation.fresh(now_secs) {
                return Ok(rotation.token().to_string());
            }
            tracing::debug!(target: "push", "APNs JWT 到期轮换（签发于 {}s）", rotation.issued_at_secs());
        }
        let token = self.signer.sign(now_secs)?;
        *cached = Some(JwtRotation::new(now_secs, token.clone()));
        Ok(token)
    }
}

#[async_trait]
impl VendorPushChannel for ApnsSender {
    fn vendor_id(&self) -> &'static str {
        "apns"
    }

    /// 发送（trait 面：墙钟秒）
    async fn send(
        &self,
        notification: &VendorNotification,
    ) -> Result<VendorSendOutcome, VendorError> {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        self.send_at(notification, now_secs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::intent::PayloadDigest;
    use crate::push::PushLevel;
    use crate::push::vendor::test_support::{start_mock_server, MockResponse, MockRoute};
    use crate::push::vendor::{VendorDevice, VendorPlatform};

    const KEY_ID: &str = "ABC123DEFG";
    const TEAM_ID: &str = "TEAMID42";

    /// 生成测试 .p8（PKCS#8 P-256 PEM，与 apns.rs 测试同法）→ 构造发送器
    fn sender_with_p8() -> (ApnsSender, tempfile::TempDir) {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(
            &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
            &rng,
        )
        .expect("生成测试密钥");
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(pkcs8.as_ref())
        );
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("AuthKey.p8");
        std::fs::write(&path, pem).expect("写 .p8");
        let credentials = APNsCredentials {
            auth_key_path: path,
            key_id: KEY_ID.to_string(),
            team_id: TEAM_ID.to_string(),
            bundle_id: "com.crish.mobile".to_string(),
            sandbox: false,
        };
        let sender = ApnsSender::new(reqwest::Client::new(), credentials).expect("构造发送器");
        (sender, dir)
    }

    /// 指向本地 mock 端点（plain HTTP；发送器 base_url 注入）
    fn sender_against(addr: std::net::SocketAddr) -> ApnsSender {
        let (sender, _dir) = sender_with_p8();
        sender.with_base_url(format!("http://{addr}"))
    }

    fn notification(token: &str) -> VendorNotification {
        VendorNotification::new(
            VendorDevice {
                device_id: "dev-1".to_string(),
                push_token: token.to_string(),
                platform: VendorPlatform::Ios,
            },
            PushLevel::P0Critical,
            "approval-requested:tc-9f3a",
            Some("session:s-7".to_string()),
            "approval".to_string(),
            PayloadDigest {
                session_id: "s-7".to_string(),
                biz_key: "tc-9f3a".to_string(),
                digest: Some("执行部署脚本".to_string()),
                detail: Some("bash".to_string()),
            },
        )
    }

    /// JWT 轮换纯函数边界：TTL - 余量前复用，之后轮换
    #[test]
    fn jwt_rotation_fresh_boundary() {
        let rotation = JwtRotation::new(1_000, "jwt-1".to_string());
        assert_eq!(rotation.token(), "jwt-1");
        assert_eq!(rotation.issued_at_secs(), 1_000);
        assert!(
            rotation.fresh(1_000 + APNS_JWT_TTL_SECS - APNS_JWT_ROTATE_LEEWAY_SECS - 1),
            "余量前有效"
        );
        assert!(
            !rotation.fresh(1_000 + APNS_JWT_TTL_SECS - APNS_JWT_ROTATE_LEEWAY_SECS),
            "到期边界轮换"
        );
        assert!(!rotation.fresh(1_000 + APNS_JWT_TTL_SECS));
    }

    /// 真实发送：200 → Delivered；mock 服务器断言方法/路径/头/体完整
    #[tokio::test]
    async fn send_delivered_with_full_headers() {
        let mock = start_mock_server(&[MockRoute {
            path_frag: "/3/device/",
            responses: &[MockResponse {
                status: "200 OK",
                body: "",
                headers: &[],
            }],
        }])
        .await;
        let sender = sender_against(mock.addr);

        let outcome = sender.send_at(&notification("tok-1"), 1_786_214_400).await.expect("发送");
        assert_eq!(outcome, VendorSendOutcome::Delivered);

        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/3/device/tok-1");
        let header = |name: &str| -> Option<String> {
            request
                .headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.clone())
        };
        let authorization = header("authorization").expect("authorization 头");
        assert!(authorization.starts_with("bearer "), "bearer 前缀：{authorization}");
        let jwt = authorization.trim_start_matches("bearer ");
        assert_eq!(jwt.split('.').count(), 3, "JWT 三段结构");
        assert_eq!(header("apns-push-type").as_deref(), Some("alert"));
        assert_eq!(header("apns-priority").as_deref(), Some("10"));
        assert_eq!(header("apns-topic").as_deref(), Some("com.crish.mobile"));
        assert_eq!(header("apns-collapse-id").as_deref(), Some("session:s-7"));

        // 请求体 = APNs 载荷（aps.alert 映射 + crish 白名单）
        let body: serde_json::Value = serde_json::from_slice(&request.body).expect("body JSON");
        assert_eq!(body["aps"]["alert"]["title"], "bash");
        assert_eq!(body["aps"]["alert"]["body"], "执行部署脚本");
        assert_eq!(body["aps"]["thread-id"], "session:s-7");
        assert_eq!(body["crish"]["sessionId"], "s-7");
        assert_eq!(body["crish"]["bizKey"], "tc-9f3a");
    }

    /// JWT 每小时轮换：同 now 复用同一 JWT；跨 TTL 重签（iat 变化）
    #[tokio::test]
    async fn jwt_rotates_after_ttl() {
        let mock = start_mock_server(&[MockRoute {
            path_frag: "/3/device/",
            responses: &[
                MockResponse { status: "200 OK", body: "", headers: &[] },
                MockResponse { status: "200 OK", body: "", headers: &[] },
            ],
        }])
        .await;
        let sender = sender_against(mock.addr);
        let t0 = 1_786_214_400;

        sender.send_at(&notification("tok-a"), t0).await.expect("首次发送");
        sender.send_at(&notification("tok-b"), t0).await.expect("同刻复用");
        assert_eq!(mock.requests.lock().unwrap().len(), 2, "两连发");
        let first = mock.requests.lock().unwrap()[0]
            .header_value("authorization")
            .expect("首请求 auth 头");
        let second = mock.requests.lock().unwrap()[1]
            .header_value("authorization")
            .expect("次请求 auth 头");
        assert_eq!(first, second, "TTL 内复用同一 JWT");

        // 跨过 TTL → 重签（JWT iat 变化 → 签名段变化，auth 头不同）
        sender.send_at(&notification("tok-c"), t0 + APNS_JWT_TTL_SECS).await.expect("轮换发送");
        let rotated = mock.requests.lock().unwrap()[2]
            .header_value("authorization")
            .expect("轮换后 auth 头");
        assert_ne!(rotated, first, "到期后必须重签");

        // 轮换后仍可复用（第四个请求回落到缓存 JWT）
        sender.send_at(&notification("tok-d"), t0 + APNS_JWT_TTL_SECS + 1).await.expect("复用发送");
        let reused = mock.requests.lock().unwrap()[3]
            .header_value("authorization")
            .expect("复用 auth 头");
        assert_eq!(reused, rotated, "轮换后新 JWT 缓存复用");
    }

    /// 403 → 作废缓存：下一次发送强制重签（M8 §2.2.3-4 凭据轮换语义）
    #[tokio::test]
    async fn invalid_token_403_forces_resign() {
        let mock = start_mock_server(&[MockRoute {
            path_frag: "/3/device/",
            responses: &[
                MockResponse {
                    status: "403 Forbidden",
                    body: r#"{"reason":"ExpiredProviderToken"}"#,
                    headers: &[],
                },
                MockResponse { status: "200 OK", body: "", headers: &[] },
            ],
        }])
        .await;
        let sender = sender_against(mock.addr);
        let t0 = 1_786_214_400;

        let outcome = sender.send_at(&notification("tok-1"), t0).await.expect("403 发送");
        assert!(matches!(outcome, VendorSendOutcome::FailedPermanent { .. }), "403 = 永久失败");

        // 同一时刻再发 → 缓存已作废 → 重签（JWT 不同）
        sender.send_at(&notification("tok-2"), t0).await.expect("重签发送");
        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let first = requests[0].header_value("authorization").expect("403 请求");
        let second = requests[1].header_value("authorization").expect("重签请求");
        assert_ne!(first, second, "403 后必须重签");
    }

    /// 410 → DeviceNotRegistered（注册表清理语义）
    #[tokio::test]
    async fn send_maps_410_to_not_registered() {
        let mock = start_mock_server(&[MockRoute {
            path_frag: "/3/device/",
            responses: &[MockResponse {
                status: "410 Gone",
                body: r#"{"reason":"Unregistered"}"#,
                headers: &[],
            }],
        }])
        .await;
        let sender = sender_against(mock.addr);
        let outcome = sender.send_at(&notification("tok-1"), 1_786_214_400).await.expect("发送");
        assert_eq!(outcome, VendorSendOutcome::DeviceNotRegistered);
    }

    /// 429 → RateLimited（Retry-After 头透传）
    #[tokio::test]
    async fn send_maps_429_with_retry_after() {
        let mock = start_mock_server(&[MockRoute {
            path_frag: "/3/device/",
            responses: &[MockResponse {
                status: "429 Too Many Requests",
                body: "",
                headers: &[("retry-after", "30")],
            }],
        }])
        .await;
        let sender = sender_against(mock.addr);
        let outcome = sender.send_at(&notification("tok-1"), 1_786_214_400).await.expect("发送");
        assert_eq!(
            outcome,
            VendorSendOutcome::RateLimited {
                retry_after: Some(Duration::from_secs(30))
            }
        );
    }

    /// 传输错误（连接拒绝）→ FailedRetryable（重推阶梯兜底，不崩溃）
    #[tokio::test]
    async fn transport_error_maps_to_retryable() {
        // 绑定后立即释放 → 端口无人监听 → 连接拒绝
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("绑定");
        let addr = listener.local_addr().expect("地址");
        drop(listener);
        let sender = sender_against(addr);
        let outcome = sender.send_at(&notification("tok-1"), 1_786_214_400).await.expect("不抛错");
        assert_eq!(
            outcome,
            VendorSendOutcome::FailedRetryable { retry_after: None }
        );
    }

    /// 凭据缺失（未配置环境变量）→ from_env 返回 None（通道不装配）
    #[test]
    fn from_env_returns_none_without_credentials() {
        // 进程环境变量由并行测试共享，不做 set_var；用空提供者模拟缺失
        let provider = crate::push::vendor::credentials::MapCredentialsProvider::default();
        assert!(
            ApnsSender::from_provider(reqwest::Client::new(), &provider).is_none(),
            "未配置凭据 → 不装配（pending 保留的降级面）"
        );
    }
}
