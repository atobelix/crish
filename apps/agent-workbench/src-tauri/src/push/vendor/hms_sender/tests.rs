//! HMS 供应商测试（hms_sender.rs 拆分）：AT 缓存 / 换发重试 / 响应映射。

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
        VendorDevice::new("dev-9", token, VendorPlatform::Android),
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
