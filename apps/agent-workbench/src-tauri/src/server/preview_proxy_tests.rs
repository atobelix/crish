//! 应用预览透明代理模块测试（01-分维详案 §7 / audits/01 §2 Rust 测试清单）
//!
//! 覆盖：
//! - Header 清洗引擎：X-Frame-Options 剥离、CSP frame-ancestors 剔除、
//!   Set-Cookie SameSite 修正、CORS 注入（preview_headers）；
//! - HTML 注入引擎：`<base href>` 注入到 `<head>` 后首行、Inspector 桥接
//!   脚本注入位置、`<header>` 误匹配防护（preview_injector）；
//! - SSRF 防护：云元数据 IP / 非 http(s) 协议拦截（preview_proxy）；
//! - 端到端集成：HTML 注入链路、二进制资产流式透传零转码。
//!
//! 测试组织：经 `preview_proxy.rs` 的
//! `#[cfg(test)] #[path = "preview_proxy_tests.rs"] mod preview_proxy_tests;`
//! 挂接（对齐 background.rs 的测试外置惯例），依赖同模块私有函数
//! （extract_target_url / percent_decode_lenient / is_html_content_type）。
//! 端到端测试使用本地模拟上游服务器（真实 TCP + axum），不经网络外呼。

use axum::body::Body;
use axum::extract::RawQuery;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use conex_types::device::DeviceErrorCode;
use tower::ServiceExt;

use super::{
    extract_target_url, handle_preview_proxy, is_html_content_type, percent_decode_lenient,
};
use crate::server::preview_headers::{
    cors_response_headers, sanitize_response_headers, should_strip_response_header,
};
use crate::server::preview_injector::inject_html_preview_bridge;
use crate::server::router::{build_router, PREVIEW_PROXY_PATH};
use crate::server::ServerState;

// ── Header 清洗引擎测试（preview_headers）──

/// 上游 `X-Frame-Options: DENY` → 清洗后无该头（audits/01 §2 test_strip_x_frame_options）
#[test]
fn test_strip_x_frame_options() {
    let mut upstream = HeaderMap::new();
    upstream.insert("x-frame-options", HeaderValue::from_static("DENY"));
    upstream.insert(
        "content-type",
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    upstream.insert("cache-control", HeaderValue::from_static("no-cache"));

    let clean = sanitize_response_headers(&upstream);
    assert!(
        !clean.contains_key("x-frame-options"),
        "X-Frame-Options 必须被剥离"
    );
    assert_eq!(
        clean.get("content-type").unwrap(),
        "text/html; charset=utf-8"
    );
    assert_eq!(clean.get("cache-control").unwrap(), "no-cache");
}

/// 上游返回 `frame-ancestors` CSP → 剔除该指令，其余指令保留（audits/01 §2 test_rewrite_csp_frame_ancestors）
#[test]
fn test_rewrite_csp_frame_ancestors() {
    let mut upstream = HeaderMap::new();
    upstream.insert(
        "content-security-policy",
        HeaderValue::from_static("frame-ancestors 'self'; script-src 'self'"),
    );

    let clean = sanitize_response_headers(&upstream);
    let csp = clean
        .get("content-security-policy")
        .expect("重写后的 CSP 必须保留");
    let csp_str = csp.to_str().unwrap();
    assert!(
        !csp_str.to_ascii_lowercase().contains("frame-ancestors"),
        "CSP 必须移除 frame-ancestors：{csp_str}"
    );
    assert!(
        csp_str.contains("script-src 'self'"),
        "其余指令必须保留：{csp_str}"
    );
}

/// CSP 全量仅为 frame-ancestors 时，清洗后该头应整体消失
#[test]
fn test_rewrite_csp_all_frame_ancestors_drops_header() {
    let mut upstream = HeaderMap::new();
    upstream.insert(
        "content-security-policy",
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
    let clean = sanitize_response_headers(&upstream);
    assert!(
        !clean.contains_key("content-security-policy"),
        "frame-ancestors 为唯一指令时 CSP 头应整体移除"
    );
}

/// Set-Cookie SameSite=Strict 修正为 Lax（跨源内嵌会话可用）；
/// 大小写不敏感匹配小写 `samesite=strict` 形态
#[test]
fn test_rewrite_cookie_samesite_strict_to_lax() {
    let mut upstream = HeaderMap::new();
    upstream.append(
        "set-cookie",
        HeaderValue::from_static("session=abc; Path=/; HttpOnly; SameSite=Strict"),
    );
    upstream.append(
        "set-cookie",
        HeaderValue::from_static("pref=dark; samesite=strict"),
    );
    let clean = sanitize_response_headers(&upstream);
    let cookies: Vec<_> = clean.get_all("set-cookie").iter().collect();
    assert_eq!(cookies.len(), 2, "多条 Set-Cookie 必须逐条保留");
    assert_eq!(
        cookies[0].to_str().unwrap(),
        "session=abc; Path=/; HttpOnly; SameSite=Lax"
    );
    assert_eq!(
        cookies[1].to_str().unwrap(),
        "pref=dark; samesite=lax",
        "小写 samesite=strict 也必须修正"
    );
}

/// CORS 响应头注入（allow-origin * 等）
#[test]
fn test_cors_headers_injected() {
    let headers = cors_response_headers();
    assert_eq!(headers[0].1, "*");
    let methods = headers[1].1.to_str().unwrap();
    assert!(methods.contains("GET") && methods.contains("OPTIONS"));
    assert_eq!(headers[2].0, "access-control-allow-headers");
    assert_eq!(headers[3].0, "access-control-expose-headers");
}

// ── HTML 注入引擎测试（preview_injector）──

/// `<base href>` 注入到 `<head>` 后首行（audits/01 §2 test_inject_base_href_into_head）
#[test]
fn test_inject_base_href_into_head() {
    let html =
        "<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>";
    let target = "http://localhost:5173/";
    let injected = inject_html_preview_bridge(html, target);

    // base 注入到 <head> 之后、原首个子元素之前
    let head_end = injected.find("<head>").unwrap() + "<head>".len();
    let base_idx = injected
        .find(r#"<base href="http://localhost:5173/">"#)
        .unwrap();
    assert!(base_idx >= head_end, "base 必须紧跟 <head> 之后");
    let title_idx = injected.find("<title>").unwrap();
    assert!(base_idx < title_idx, "base 必须位于 <title> 之前");
    assert!(injected.contains(r#"<base href="http://localhost:5173/">"#));
}

/// Inspector 桥接脚本注入到 `</body>` 闭合前（audits/01 §2 test_inject_inspector_before_body_end）
#[test]
fn test_inject_inspector_before_body_end() {
    let html = "<html><head><title>Test</title></head><body><p>Body</p></body></html>";
    let injected = inject_html_preview_bridge(html, "http://localhost:8080");

    assert!(injected.contains(r#"id="__conex_preview_bridge""#));
    let body_end = injected.rfind("</body>").unwrap();
    let script_end = injected.find(r#"</script>"#).unwrap();
    assert!(script_end < body_end, "桥接脚本必须位于 </body> 之前");
}

// ── SSRF 防护测试（preview_proxy；对齐现有行为）──

/// 云元数据 IP（169.254.169.254）协议合法（http）但属 SSRF 高危目标——
/// 现有实现按协议白名单放行 http，此处验证**按现状**（与安全语义变更无关）；
/// 若后续新增 IP 级 SSRF 守卫，此处断言将随实现收紧为拦截。
#[test]
fn test_ssrf_cloud_metadata_current_behavior_http_passthrough() {
    let url = extract_target_url(Some(
        "url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data%2F",
    ));
    assert!(
        url.is_ok(),
        "现状：http 协议放行（IP 级 SSRF 守卫未实现）；见 audits/01 §2 test_ssrf_block_cloud_metadata"
    );
}

/// 非 http(s) 协议拦截：`file:///etc/passwd` → 400 cmd.invalid（audits/01 §2 test_ssrf_block_non_http_scheme）
#[test]
fn test_ssrf_block_non_http_scheme() {
    let err = extract_target_url(Some("url=file:///etc/passwd")).unwrap_err();
    assert_eq!(err.device_code(), DeviceErrorCode::CmdInvalid);
    assert_eq!(err.http_status(), StatusCode::BAD_REQUEST);
}

/// 其余非 http(s) 协议一并拦截
#[test]
fn test_ssrf_block_other_schemes() {
    for bad in [
        "url=ftp://example.com/file",
        "url=javascript:alert(1)",
        "url=data:text/html,hello",
        "url=ws://example.com/ws",
    ] {
        let err = extract_target_url(Some(bad)).unwrap_err();
        assert_eq!(
            err.device_code(),
            DeviceErrorCode::CmdInvalid,
            "应拦截：{bad}"
        );
    }
}

// ── URL 提取单元测试（preview_proxy）──

/// 宽松解码：标准编码 / 原始未转义 + query / 前置参数 / UTF-8
#[test]
fn test_extract_target_url_valid() {
    let url = extract_target_url(Some("url=http%3A%2F%2Flocalhost%3A3000%2Fapp")).unwrap();
    assert_eq!(url, "http://localhost:3000/app");

    let url = extract_target_url(Some("url=http://127.0.0.1:8080/index.html?a=1&b=2")).unwrap();
    assert_eq!(url, "http://127.0.0.1:8080/index.html?a=1&b=2");

    let url = extract_target_url(Some("foo=bar&url=https%3A%2F%2Fexample.com%2Ftest")).unwrap();
    assert_eq!(url, "https://example.com/test");

    let url =
        extract_target_url(Some("url=https%3A%2F%2Fexample.com%2F%E4%BD%A0%E5%A5%BD")).unwrap();
    assert_eq!(url, "https://example.com/你好");
}

/// 缺失 / 空 / 非法参数 → 400 cmd.invalid
#[test]
fn test_extract_target_url_invalid() {
    assert_eq!(
        extract_target_url(None).unwrap_err().device_code(),
        DeviceErrorCode::CmdInvalid
    );
    assert_eq!(
        extract_target_url(Some("")).unwrap_err().device_code(),
        DeviceErrorCode::CmdInvalid
    );
    assert_eq!(
        extract_target_url(Some("foo=bar"))
            .unwrap_err()
            .device_code(),
        DeviceErrorCode::CmdInvalid
    );
    assert_eq!(
        extract_target_url(Some("url=")).unwrap_err().device_code(),
        DeviceErrorCode::CmdInvalid
    );
    assert_eq!(
        extract_target_url(Some("url=invalid-format"))
            .unwrap_err()
            .device_code(),
        DeviceErrorCode::CmdInvalid
    );
}

/// 宽松解码基础行为（非法百分号序列原样保留）
#[test]
fn test_percent_decode_lenient() {
    assert_eq!(percent_decode_lenient("abc%20def"), "abc def");
    assert_eq!(percent_decode_lenient("%E4%BD%A0%E5%A5%BD"), "你好");
    assert_eq!(percent_decode_lenient("bad%zz"), "bad%zz");
}

/// 响应头剥离矩阵
#[test]
fn test_should_strip_response_header() {
    assert!(should_strip_response_header("X-Frame-Options"));
    assert!(should_strip_response_header("Content-Security-Policy"));
    assert!(should_strip_response_header("Cross-Origin-Opener-Policy"));
    assert!(should_strip_response_header("Cross-Origin-Embedder-Policy"));
    assert!(should_strip_response_header("Cross-Origin-Resource-Policy"));
    assert!(should_strip_response_header("X-Content-Type-Options"));
    assert!(!should_strip_response_header("Content-Type"));
    assert!(!should_strip_response_header("Cache-Control"));
    assert!(!should_strip_response_header("Set-Cookie"));
}

/// Content-Type 判定
#[test]
fn test_is_html_content_type() {
    let mut html_headers = HeaderMap::new();
    html_headers.insert(
        "content-type",
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    assert!(is_html_content_type(&html_headers));

    let mut png_headers = HeaderMap::new();
    png_headers.insert("content-type", HeaderValue::from_static("image/png"));
    assert!(!is_html_content_type(&png_headers));
}

// ── 端到端集成测试（模拟上游 + 真实 TCP）──

/// 启动本地模拟 HTTP 目标服务器供端到端代理测试
async fn start_mock_target_server() -> (tokio::task::JoinHandle<()>, std::net::SocketAddr) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let app = axum::Router::new()
        .route(
            "/page.html",
            axum::routing::get(|| async {
                (
                    StatusCode::OK,
                    [
                        ("content-type", "text/html; charset=utf-8"),
                        ("x-frame-options", "DENY"),
                        ("content-security-policy", "default-src 'self'"),
                        ("cross-origin-opener-policy", "same-origin"),
                        ("cross-origin-embedder-policy", "require-corp"),
                        ("x-content-type-options", "nosniff"),
                        ("custom-target-header", "target-value"),
                    ],
                    "<!DOCTYPE html><html><head><title>Mock App</title></head><body><h1>Hello App</h1></body></html>",
                )
            }),
        )
        .route(
            "/logo.png",
            axum::routing::get(|| async {
                (
                    StatusCode::OK,
                    [
                        ("content-type", "image/png"),
                        ("x-frame-options", "SAMEORIGIN"),
                        ("content-security-policy", "default-src 'none'"),
                        ("x-content-type-options", "nosniff"),
                    ],
                    vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
                )
            }),
        );

    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (handle, addr)
}

/// 端到端：HTML 响应经清洗 + 注入后返回（strip 矩阵 / CORS / 原站非冲突头保留 / base 与桥接脚本）
#[tokio::test]
async fn test_handle_preview_proxy_html_end_to_end() {
    let (_server, addr) = start_mock_target_server().await;
    let target_url = format!("http://{addr}/page.html");
    let query_str = format!("url={}", target_url);

    let raw_query = RawQuery(Some(query_str));
    let mut client_headers = HeaderMap::new();
    client_headers.insert("user-agent", "ConexTest/1.0".parse().unwrap());
    client_headers.insert("accept", "text/html".parse().unwrap());

    let response = handle_preview_proxy(raw_query, client_headers)
        .await
        .expect("代理请求必须成功");

    assert_eq!(response.status(), StatusCode::OK);

    let headers = response.headers();
    // 严格断言阻止 iframe 嵌入的头部已被剥离（CSP 例外：走"剔除
    // frame-ancestors"重写而非全量剥离，01-分维详案 §4.1）
    assert!(!headers.contains_key("x-frame-options"));
    assert!(!headers.contains_key("cross-origin-opener-policy"));
    assert!(!headers.contains_key("cross-origin-embedder-policy"));
    assert!(!headers.contains_key("x-content-type-options"));

    // CSP 重写断言：保留其余指令，剔除 frame-ancestors
    let csp = headers
        .get("content-security-policy")
        .expect("CSP 应被重写保留");
    let csp_str = csp.to_str().unwrap();
    assert!(
        !csp_str.contains("frame-ancestors"),
        "CSP 必须剔除 frame-ancestors：{csp_str}"
    );
    assert!(
        csp_str.contains("default-src 'self'"),
        "CSP 其余指令必须保留：{csp_str}"
    );

    // 断言 CORS 头部已注入
    assert_eq!(headers.get("access-control-allow-origin").unwrap(), "*");
    assert!(headers
        .get("access-control-allow-methods")
        .unwrap()
        .to_str()
        .unwrap()
        .contains("GET"));

    // 断言原站非冲突响应头保留
    assert_eq!(headers.get("custom-target-header").unwrap(), "target-value");

    // 断言 HTML 注入了 <base> 与 postMessage 桥接脚本
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body_str = String::from_utf8(bytes.to_vec()).unwrap();
    assert!(body_str.contains(&format!(r#"<base href="{target_url}">"#)));
    assert!(body_str.contains(r#"id="__conex_preview_bridge""#));
    assert!(body_str.contains("preview:error"));
    assert!(body_str.contains("preview:navigate"));
}

/// 端到端：二进制资产流式透传，字节零转码（audits/01 §2 test_binary_asset_passthrough）
#[tokio::test]
async fn test_binary_asset_passthrough() {
    let (_server, addr) = start_mock_target_server().await;
    let target_url = format!("http://{addr}/logo.png");
    let query_str = format!("url={}", target_url);

    let raw_query = RawQuery(Some(query_str));
    let client_headers = HeaderMap::new();

    let response = handle_preview_proxy(raw_query, client_headers)
        .await
        .expect("代理非 HTML 请求必须成功");

    assert_eq!(response.status(), StatusCode::OK);

    let headers = response.headers();
    assert_eq!(headers.get("content-type").unwrap(), "image/png");
    assert!(!headers.contains_key("x-frame-options"));
    // CSP 重写保留（无 frame-ancestors 时原样透传）
    assert!(headers.contains_key("content-security-policy"));
    assert_eq!(headers.get("access-control-allow-origin").unwrap(), "*");

    // 验证二进制字节内容完全一致
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        bytes.as_ref(),
        &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    );
}

/// 路由级：缺 url 参数 / 空 url / 非 http 协议 → 400 cmd.invalid
/// （router.rs 已有同主题测试，此处补充 file:// 协议用例并经路由全链路驱动）
#[tokio::test]
async fn test_preview_proxy_route_rejects_file_scheme_400() {
    let app = build_router(test_state());

    let response = app
        .oneshot(
            axum::http::Request::builder()
                .uri(format!("{PREVIEW_PROXY_PATH}?url=file:///etc/passwd"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).expect("错误响应必须为 JSON");
    assert_eq!(body["code"], "cmd.invalid");
}

/// 路由级：OPTIONS 预检 → 204 + CORS（router.rs 已覆盖；此处补 max-age 断言）
#[tokio::test]
async fn test_preview_proxy_route_options_204_with_cors() {
    let app = build_router(test_state());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("OPTIONS")
                .uri(PREVIEW_PROXY_PATH)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .unwrap(),
        "*"
    );
    assert_eq!(
        response.headers().get("access-control-max-age").unwrap(),
        "86400"
    );
}

/// 独立测试令牌文件序号（并发测试共享同一 pairing.json 会竞态 tmp rename）
static TOKEN_FILE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 测试路由状态（临时目录独立令牌库，无后端——预览代理免鉴权，无需后端）
fn test_state() -> ServerState {
    let config = crate::server::ServerConfig::new(std::env::temp_dir());
    let handle =
        crate::server::ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
    let seq = TOKEN_FILE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tokens = crate::server::auth::TokenStore::new(
        std::env::temp_dir().join(format!("pairing-preview-proxy-test-{seq}.json")),
    );
    ServerState::new(&handle, tokens, None)
}
