//! HMS 真实发送器（R3-03 接线轮：OAuth2 换 AT + 缓存 + messages:send）
//!
//! 规格真源：D7 §5.2（HMS Push：OAuth2 AT 换发 + `messages:send`）+
//! M8 §2.3.2（服务端 REST 面：401/80100002 换发 AT 重试一次）。
//! 承接 [super::hms]（R3-03a 协议级构造：token 请求 / 消息体 / 响应解析）：
//!
//! - **换 AT**：`POST /oauth2/v3/token`（client credentials 表单）；
//!   [HmsTokenCache] 按 `expires_in` 缓存复用（纯函数判定，留 60s 余量
//!   提前换发）；
//! - **发送**：`POST /v1/{appId}/messages:send`（Bearer AT + 消息体）；
//! - **鉴权失败重试一次**：HTTP 401 或响应码 `80100002`/`80100003`
//!   （AT 无效/过期）→ 作废缓存换发 AT 重发一次（M8 §2.3.2 语义；
//!   其余鉴权码如 `80100013` appId 不存在 → 不重试，永久失败）；
//! - 传输层错误映射 [super::VendorSendOutcome::FailedRetryable]（重推阶梯兜底）。

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;

use super::credentials::{CredentialsProvider, EnvCredentialsProvider};
use super::hms::{
    build_hms_send_request_at, build_hms_token_request_at, parse_hms_send_response,
    parse_hms_token_response, HmsToken, HMS_SEND_BASE_URL, HMS_TOKEN_URL,
};
use super::{
    HMSCredentials, VendorError, VendorNotification, VendorPushChannel, VendorSendOutcome,
};

/// AT 提前换发余量（到期前此秒数即换发；防边界竞态与时钟漂移）
pub const HMS_TOKEN_REFRESH_MARGIN_SECS: u64 = 60;
/// 单请求超时（换 AT / 发送共用；周期消费循环不被挂起网络拖死）
pub const HMS_SEND_TIMEOUT_SECS: u64 = 10;

/// AT 缓存条目（获取时刻 + token；有效性判定 = 纯函数）
#[derive(Debug, Clone)]
pub struct HmsTokenCache {
    /// 获取时刻（UNIX 秒）
    fetched_at_secs: u64,
    /// token + 有效期（`expires_in` 秒）
    token: HmsToken,
}

impl HmsTokenCache {
    /// 记录一次换发
    pub fn new(fetched_at_secs: u64, token: HmsToken) -> Self {
        Self {
            fetched_at_secs,
            token,
        }
    }

    /// 缓存是否仍有效（已用时长 + 余量 < 有效期 → 复用，否则换发）
    pub fn fresh(&self, now_secs: u64) -> bool {
        now_secs.saturating_sub(self.fetched_at_secs) + HMS_TOKEN_REFRESH_MARGIN_SECS
            < self.token.expires_in_secs
    }

    /// 缓存 AT
    pub fn access_token(&self) -> &str {
        &self.token.access_token
    }

    /// 获取时刻（测试与诊断）
    pub fn fetched_at_secs(&self) -> u64 {
        self.fetched_at_secs
    }
}

/// HMS 发送响应是否属「AT 失效类鉴权失败」（换发 AT 后重试一次可救）。
///
/// 纯函数：HTTP 401 或响应码 `80100002`（AT 无效）/`80100003`（AT 过期）
/// → true；`80100013`（appId 不存在，换 AT 无济于事）等 → false。
pub fn hms_auth_failure(status: u16, body: &str) -> bool {
    if status == 401 {
        return true;
    }
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("code")
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    matches!(code.as_str(), "80100002" | "80100003")
}

/// HMS 真实发送器（[VendorPushChannel] 的 HMS 实现）
///
/// 缓存经 Mutex 保护（锁内无 await）；并发换发竞态幂等（token 端点
/// 换发本身无副作用，重复一次无害）。[send]（trait 面）用墙钟，
/// 测试用 [send_at] 注入时刻验证缓存与换发。
pub struct HmsSender {
    /// 凭据快照（appId/appSecret/包名）
    credentials: HMSCredentials,
    /// reqwest 客户端（装配方注入）
    http: reqwest::Client,
    /// token 端点 URL（生产 = [HMS_TOKEN_URL]；测试注入本地端点）
    token_url: String,
    /// 发送基址（生产 = [HMS_SEND_BASE_URL]；测试注入本地端点）
    send_base_url: String,
    /// AT 缓存（`None` = 未换发/已作废）
    cache: Mutex<Option<HmsTokenCache>>,
}

impl HmsSender {
    /// 用凭据 + 客户端构造
    pub fn new(http: reqwest::Client, credentials: HMSCredentials) -> Self {
        Self {
            credentials,
            http,
            token_url: HMS_TOKEN_URL.to_string(),
            send_base_url: HMS_SEND_BASE_URL.to_string(),
            cache: Mutex::new(None),
        }
    }

    /// 从环境变量凭据构造（D7 §8.2）；未配置（变量缺失）→ `None`
    pub fn from_env(http: reqwest::Client) -> Option<Self> {
        Self::from_provider(http, &EnvCredentialsProvider)
    }

    /// 从任意凭据提供者构造（装配注入面；`None` = 未配置 → 通道不装配）
    pub fn from_provider(
        http: reqwest::Client,
        provider: &dyn CredentialsProvider,
    ) -> Option<Self> {
        provider
            .hms()
            .map(|credentials| Self::new(http, credentials))
    }

    /// 注入 token 端点 URL（测试用：本地 mock；生产走 [new]/[from_env]）
    pub fn with_token_url(mut self, url: impl Into<String>) -> Self {
        self.token_url = url.into();
        self
    }

    /// 注入发送基址（测试用：本地 mock；生产走 [new]/[from_env]）
    pub fn with_send_base_url(mut self, url: impl Into<String>) -> Self {
        self.send_base_url = url.into();
        self
    }

    /// 带时刻发送（缓存/换发判定用 `now_secs`；测试注入，生产 [send] 走墙钟）
    pub async fn send_at(
        &self,
        notification: &VendorNotification,
        now_secs: u64,
    ) -> Result<VendorSendOutcome, VendorError> {
        let access_token = match self.ensure_token(now_secs).await {
            Ok(token) => token,
            // 传输层失败 → 可重试（重推阶梯兜底，不崩溃）
            Err(VendorError::Transport(error)) => {
                tracing::warn!(target: "push", vendor = "hms", error = %error, "HMS token 换发传输失败，按可重试处理");
                return Ok(VendorSendOutcome::FailedRetryable { retry_after: None });
            }
            Err(error) => return Err(error),
        };
        let (outcome, status, body) = self.send_with_token(notification, &access_token).await?;
        if hms_auth_failure(status, &body) {
            // M8 §2.3.2：AT 失效 → 作废缓存 → 换发 → 重试一次
            tracing::warn!(target: "push", status, "HMS 鉴权失败（AT 失效），换发后重试一次");
            if let Ok(mut cache) = self.cache.lock() {
                *cache = None;
            }
            let fresh_token = match self.ensure_token(now_secs).await {
                Ok(token) => token,
                Err(VendorError::Transport(error)) => {
                    tracing::warn!(target: "push", vendor = "hms", error = %error, "HMS 重试换发传输失败，按可重试处理");
                    return Ok(VendorSendOutcome::FailedRetryable { retry_after: None });
                }
                Err(error) => return Err(error),
            };
            let (outcome, _, _) = self.send_with_token(notification, &fresh_token).await?;
            return Ok(outcome);
        }
        Ok(outcome)
    }

    /// 换 AT（缓存有效复用；否则 POST token 端点 → 解析 → 缓存）
    async fn ensure_token(&self, now_secs: u64) -> Result<String, VendorError> {
        {
            let cache = self
                .cache
                .lock()
                .map_err(|_| VendorError::Crypto("HMS AT 缓存锁损坏".to_string()))?;
            if let Some(cached) = cache.as_ref() {
                if cached.fresh(now_secs) {
                    return Ok(cached.access_token().to_string());
                }
                tracing::debug!(target: "push", "HMS AT 到期换发（获取于 {}s）", cached.fetched_at_secs());
            }
        } // 锁在此释放；网络请求不持锁（并发重复换发幂等无害）
        let request = build_hms_token_request_at(&self.credentials, &self.token_url);
        let response = self
            .http
            .post(&request.url)
            .header(reqwest::header::CONTENT_TYPE, request.content_type)
            .body(request.body)
            .timeout(Duration::from_secs(HMS_SEND_TIMEOUT_SECS))
            .send()
            .await
            .map_err(|error| VendorError::Transport(format!("HMS token 端点不可达：{error}")))?;
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(VendorError::Parse(format!(
                "HMS token 端点返回 HTTP {status}：{body}"
            )));
        }
        let token = parse_hms_token_response(&body)?;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| VendorError::Crypto("HMS AT 缓存锁损坏".to_string()))?;
        *cache = Some(HmsTokenCache::new(now_secs, token.clone()));
        Ok(token.access_token)
    }

    /// 单次发送（消息体构造 → POST → 响应解析；返回原始 status/body 供
    /// 鉴权失败判定）
    async fn send_with_token(
        &self,
        notification: &VendorNotification,
        access_token: &str,
    ) -> Result<(VendorSendOutcome, u16, String), VendorError> {
        let request = build_hms_send_request_at(
            &self.credentials,
            access_token,
            notification,
            &self.send_base_url,
        )?;
        let response = match self
            .http
            .post(&request.url)
            .header(reqwest::header::AUTHORIZATION, &request.authorization)
            .json(&request.body)
            .timeout(Duration::from_secs(HMS_SEND_TIMEOUT_SECS))
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(target: "push", vendor = "hms", error = %error, "HMS 发送传输失败，按可重试处理");
                return Ok((
                    VendorSendOutcome::FailedRetryable { retry_after: None },
                    0,
                    String::new(),
                ));
            }
        };
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let outcome = parse_hms_send_response(status, &body);
        Ok((outcome, status, body))
    }
}

#[async_trait]
impl VendorPushChannel for HmsSender {
    fn vendor_id(&self) -> &'static str {
        "hms"
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
    use crate::push::vendor::test_support::{start_mock_server, MockResponse, MockRoute};
    use crate::push::vendor::{VendorDevice, VendorPlatform};
    use crate::push::PushLevel;

    fn credentials() -> HMSCredentials {
        HMSCredentials {
            app_id: "100123456".to_string(),
            app_secret: "secret-abc".to_string(),
            package_name: "com.crish.mobile".to_string(),
        }
    }

    fn notification(token: &str) -> VendorNotification {
        VendorNotification::new(
            VendorDevice {
                device_id: "dev-9".to_string(),
                push_token: token.to_string(),
                platform: VendorPlatform::Android,
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

    /// token 响应脚本（默认 3600s 有效期）
    const TOKEN_OK: MockResponse = MockResponse {
        status: "200 OK",
        body: r#"{"access_token":"at-1","expires_in":3600,"token_type":"Bearer"}"#,
        headers: &[("content-type", "application/json")],
    };

    /// 发送成功响应（`80000000`）
    const SEND_OK: MockResponse = MockResponse {
        status: "200 OK",
        body: r#"{"code":"80000000","msg":"Success","requestId":"r1"}"#,
        headers: &[("content-type", "application/json")],
    };

    /// 指向本地 mock（token 端点 /messages:send 双路由）的发送器
    fn sender_against(addr: std::net::SocketAddr) -> HmsSender {
        let sender = HmsSender::new(reqwest::Client::new(), credentials());
        sender
            .with_token_url(format!("http://{addr}/token"))
            .with_send_base_url(format!("http://{addr}"))
    }

    /// 记录断言辅助：按请求路径过滤（token 端点 vs messages:send）
    fn requests_by_path<'a>(
        requests: &'a [crate::push::vendor::test_support::RequestRecord],
        frag: &'a str,
    ) -> Vec<&'a crate::push::vendor::test_support::RequestRecord> {
        requests
            .iter()
            .filter(|request| request.path.contains(frag))
            .collect()
    }

    /// AT 缓存纯函数边界：有效期 - 余量前复用，之后换发
    #[test]
    fn token_cache_fresh_boundary() {
        let token = HmsToken {
            access_token: "at-1".to_string(),
            expires_in_secs: 3600,
        };
        let cache = HmsTokenCache::new(1_000, token);
        assert_eq!(cache.access_token(), "at-1");
        assert_eq!(cache.fetched_at_secs(), 1_000);
        let boundary = 1_000 + 3600 - HMS_TOKEN_REFRESH_MARGIN_SECS;
        assert!(cache.fresh(boundary - 1), "余量前有效");
        assert!(!cache.fresh(boundary), "到期边界换发");
        assert!(!cache.fresh(1_000 + 3600));
    }

    /// 鉴权失败判定纯函数：401 / 80100002 / 80100003 → true；其余 → false
    #[test]
    fn auth_failure_detection_matrix() {
        assert!(hms_auth_failure(401, ""));
        assert!(hms_auth_failure(200, r#"{"code":"80100002"}"#));
        assert!(hms_auth_failure(200, r#"{"code":"80100003"}"#));
        assert!(
            !hms_auth_failure(200, r#"{"code":"80100013"}"#),
            "appId 不存在，换 AT 无济于事"
        );
        assert!(!hms_auth_failure(200, r#"{"code":"80000000"}"#));
        assert!(!hms_auth_failure(200, "not json"));
    }

    /// 全链路：换 AT → 发送 → Delivered；AT 缓存命中（第二次发送不再换发）
    #[tokio::test]
    async fn send_exchanges_token_once_and_caches() {
        let mock = start_mock_server(&[
            MockRoute {
                path_frag: "/token",
                responses: &[TOKEN_OK],
            },
            MockRoute {
                path_frag: "messages:send",
                responses: &[SEND_OK, SEND_OK],
            },
        ])
        .await;
        let sender = sender_against(mock.addr);
        let t0 = 1_786_214_400;

        let outcome = sender
            .send_at(&notification("hms-tok-1"), t0)
            .await
            .expect("首次发送");
        assert_eq!(outcome, VendorSendOutcome::Delivered);

        // 第一次发送：token 请求（表单含凭据）+ 发送请求（Bearer AT）
        {
            let requests = mock.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            let token_requests = requests_by_path(&requests, "/token");
            assert_eq!(token_requests.len(), 1);
            let body = String::from_utf8_lossy(&token_requests[0].body).to_string();
            assert!(body.contains("grant_type=client_credentials"));
            assert!(body.contains("client_id=100123456"));
            assert!(body.contains("client_secret=secret-abc"));
            let send_requests = requests_by_path(&requests, "messages:send");
            assert_eq!(send_requests.len(), 1);
            assert_eq!(
                send_requests[0].header_value("authorization").as_deref(),
                Some("Bearer at-1")
            );
            let body: serde_json::Value =
                serde_json::from_slice(&send_requests[0].body).expect("消息体 JSON");
            assert_eq!(body["message"]["token"][0], "hms-tok-1");
            assert_eq!(body["message"]["android"]["urgency"], "HIGH");
        }

        // 同一时刻第二次发送：AT 缓存命中 → 不再请求 token 端点
        let outcome = sender
            .send_at(&notification("hms-tok-2"), t0)
            .await
            .expect("复用发送");
        assert_eq!(outcome, VendorSendOutcome::Delivered);
        let requests = mock.requests.lock().unwrap();
        assert_eq!(
            requests_by_path(&requests, "/token").len(),
            1,
            "缓存命中不再换发"
        );
        assert_eq!(requests_by_path(&requests, "messages:send").len(), 2);
    }

    /// AT 到期 → 换发后再发送（token 端点第二次被调用）
    #[tokio::test]
    async fn token_refreshes_after_expiry() {
        let mock = start_mock_server(&[
            MockRoute {
                path_frag: "/token",
                responses: &[TOKEN_OK, TOKEN_OK],
            },
            MockRoute {
                path_frag: "messages:send",
                responses: &[SEND_OK, SEND_OK],
            },
        ])
        .await;
        let sender = sender_against(mock.addr);
        let t0 = 1_786_214_400;

        sender
            .send_at(&notification("hms-tok-1"), t0)
            .await
            .expect("首次发送");
        // 跨过有效期 → 换发
        sender
            .send_at(&notification("hms-tok-2"), t0 + 3600)
            .await
            .expect("换发后发送");
        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests_by_path(&requests, "/token").len(), 2, "到期换发");
        assert_eq!(requests_by_path(&requests, "messages:send").len(), 2);
    }

    /// AT 失效（401）→ 换发 → 重试一次 → Delivered（M8 §2.3.2）
    #[tokio::test]
    async fn auth_failure_refreshes_and_retries_once() {
        let mock = start_mock_server(&[
            MockRoute {
                path_frag: "/token",
                responses: &[TOKEN_OK, TOKEN_OK],
            },
            MockRoute {
                path_frag: "messages:send",
                responses: &[
                    MockResponse {
                        status: "401 Unauthorized",
                        body: "",
                        headers: &[],
                    },
                    SEND_OK,
                ],
            },
        ])
        .await;
        let sender = sender_against(mock.addr);

        let outcome = sender
            .send_at(&notification("hms-tok-1"), 1_786_214_400)
            .await
            .expect("发送");
        assert_eq!(outcome, VendorSendOutcome::Delivered, "换发后重试成功");
        let requests = mock.requests.lock().unwrap();
        assert_eq!(
            requests_by_path(&requests, "/token").len(),
            2,
            "换发两次 AT"
        );
        assert_eq!(
            requests_by_path(&requests, "messages:send").len(),
            2,
            "发送 + 重试一次"
        );
    }

    /// 响应码 80100002（AT 无效）→ 换发重试（HTTP 层 401 同语义的另一形态）
    #[tokio::test]
    async fn auth_code_invalid_token_retries() {
        let mock = start_mock_server(&[
            MockRoute {
                path_frag: "/token",
                responses: &[TOKEN_OK, TOKEN_OK],
            },
            MockRoute {
                path_frag: "messages:send",
                responses: &[
                    MockResponse {
                        status: "200 OK",
                        body: r#"{"code":"80100002","msg":"Auth failed","requestId":"r3"}"#,
                        headers: &[],
                    },
                    SEND_OK,
                ],
            },
        ])
        .await;
        let sender = sender_against(mock.addr);
        let outcome = sender
            .send_at(&notification("hms-tok-1"), 1_786_214_400)
            .await
            .expect("发送");
        assert_eq!(
            outcome,
            VendorSendOutcome::Delivered,
            "80100002 → 换发重试成功"
        );
    }

    /// token 无效码 → DeviceNotRegistered（注册表清理语义）
    #[tokio::test]
    async fn send_maps_invalid_token_to_not_registered() {
        let mock = start_mock_server(&[
            MockRoute {
                path_frag: "/token",
                responses: &[TOKEN_OK],
            },
            MockRoute {
                path_frag: "messages:send",
                responses: &[MockResponse {
                    status: "200 OK",
                    body: r#"{"code":"80300010","msg":"Invalid token","requestId":"r2"}"#,
                    headers: &[],
                }],
            },
        ])
        .await;
        let sender = sender_against(mock.addr);
        let outcome = sender
            .send_at(&notification("hms-tok-1"), 1_786_214_400)
            .await
            .expect("发送");
        assert_eq!(outcome, VendorSendOutcome::DeviceNotRegistered);
    }

    /// 429 → RateLimited（重推阶梯退避输入）
    #[tokio::test]
    async fn send_maps_429_to_rate_limited() {
        let mock = start_mock_server(&[
            MockRoute {
                path_frag: "/token",
                responses: &[TOKEN_OK],
            },
            MockRoute {
                path_frag: "messages:send",
                responses: &[MockResponse {
                    status: "429 Too Many Requests",
                    body: "",
                    headers: &[],
                }],
            },
        ])
        .await;
        let sender = sender_against(mock.addr);
        let outcome = sender
            .send_at(&notification("hms-tok-1"), 1_786_214_400)
            .await
            .expect("发送");
        assert_eq!(
            outcome,
            VendorSendOutcome::RateLimited { retry_after: None }
        );
    }

    /// 传输错误（连接拒绝）→ FailedRetryable（重推阶梯兜底，不崩溃）
    #[tokio::test]
    async fn transport_error_maps_to_retryable() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定");
        let addr = listener.local_addr().expect("地址");
        drop(listener);
        let sender = sender_against(addr);
        let outcome = sender
            .send_at(&notification("hms-tok-1"), 1_786_214_400)
            .await
            .expect("不抛错");
        assert_eq!(
            outcome,
            VendorSendOutcome::FailedRetryable { retry_after: None }
        );
    }

    /// 凭据缺失（未配置环境变量）→ from_env 返回 None（通道不装配）
    #[test]
    fn from_env_returns_none_without_credentials() {
        let provider = crate::push::vendor::credentials::MapCredentialsProvider::default();
        assert!(
            HmsSender::from_provider(reqwest::Client::new(), &provider).is_none(),
            "未配置凭据 → 不装配（pending 保留的降级面）"
        );
    }
}
