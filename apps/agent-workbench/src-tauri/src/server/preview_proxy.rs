//! 应用预览透明代理服务（REST /v1/preview/proxy）
//!
//! 功能职责：
//! 1. 提供免鉴权的前端应用预览透明反向代理，解决 iframe 跨域限制与安全策略阻断问题；
//! 2. 解析查询参数 `url`（支持宽松百分号编码解码），若参数缺失或非法返回 `400 cmd.invalid`；
//! 3. 使用 `reqwest` 抓取目标 URL，透传客户端非冲突请求头（如 User-Agent、Accept、Cookie 等）；
//! 4. 处理响应头：委托 `preview_headers` 清洗重写（剥离阻止 iframe 嵌入的头部
//!    与逐跳头部、CSP 剔除 frame-ancestors、Set-Cookie SameSite 修正、CORS 注入）；
//! 5. 处理响应体：
//!    - 若 Content-Type 包含 `text/html`：委托 `preview_injector` 在 `<head>` 处注入
//!      `<base href="[target_url]">`（自动校准相对路径）并注入轻量 postMessage 桥接脚本；
//!    - 若非 HTML（CSS/JS/图片/字体/媒体等）：以流式字节（Body stream）直接返回。
//!
//! 模块划分（01-分维详案 §6）：本文件仅保留核心代理 Handler 与请求流转控制；
//! Header 清洗引擎见 `preview_headers.rs`，HTML 注入引擎见 `preview_injector.rs`，
//! 测试见 `preview_proxy_tests.rs`。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;

use axum::body::Body;
use axum::extract::RawQuery;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use conex_types::device::DeviceErrorCode;

use crate::server::ServerError;
use crate::server::preview_headers::{cors_response_headers, sanitize_response_headers};
use crate::server::preview_injector::inject_html_preview_bridge;

/// 全局复用的 HTTP 客户端实例
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 获取或初始化 HTTP 客户端
fn get_http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// GET /v1/preview/proxy：应用预览透明代理处理入口
pub async fn handle_preview_proxy(
    RawQuery(raw_query): RawQuery,
    client_headers: HeaderMap,
) -> Result<Response, ServerError> {
    let target_url = extract_target_url(raw_query.as_deref())?;

    let client = get_http_client();
    let mut req_builder = client.get(&target_url);

    // 透传客户端非冲突请求头
    for (name, value) in &client_headers {
        let name_str = name.as_str();
        if is_hop_by_hop_or_forbidden_client_header(name_str) {
            continue;
        }
        if let Ok(header_name) = reqwest::header::HeaderName::from_bytes(name.as_ref()) {
            if let Ok(header_val) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
                req_builder = req_builder.header(header_name, header_val);
            }
        }
    }

    let resp = req_builder.send().await.map_err(|err| {
        tracing::warn!(target: "preview_proxy", %target_url, "代理请求目标 URL 失败: {err}");
        ServerError::protocol(
            DeviceErrorCode::Internal,
            format!("代理抓取目标 URL 失败: {err}"),
        )
    })?;

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::OK);
    let resp_headers = resp.headers().clone();
    let is_html = is_html_content_type(&resp_headers);

    if is_html {
        // HTML 响应：读取文本，注入 <base> 与 postMessage 桥接脚本
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ServerError::internal(format!("读取目标响应体失败: {e}")))?;

        let html_text = String::from_utf8_lossy(&bytes);
        let modified_html = inject_html_preview_bridge(&html_text, &target_url);
        let modified_bytes = modified_html.into_bytes();

        let mut builder = Response::builder().status(status);

        // 清洗响应头（剥离 iframe 阻断头 / CSP 重写 / Set-Cookie 修正）；
        // HTML 分支额外剔除 content-length 与 content-encoding（注入后长度已变）
        for (name, val) in &sanitize_response_headers(&resp_headers) {
            let name_str = name.as_str();
            if name_str.eq_ignore_ascii_case("content-length")
                || name_str.eq_ignore_ascii_case("content-encoding")
            {
                continue;
            }
            if let Ok(header_name) = HeaderName::from_bytes(name.as_ref()) {
                if let Ok(header_val) = HeaderValue::from_bytes(val.as_bytes()) {
                    builder = builder.header(header_name, header_val);
                }
            }
        }

        // 注入新的 Content-Length 与 CORS 头
        builder = builder.header("content-length", modified_bytes.len().to_string());
        for (name, val) in cors_response_headers() {
            builder = builder.header(name, val);
        }

        builder
            .body(Body::from(modified_bytes))
            .map_err(|e| ServerError::internal(format!("构建 HTML 代理响应失败: {e}")))
    } else {
        // 非 HTML 响应（图片/CSS/JS/字体等）：以流式字节返回
        let stream = resp.bytes_stream();
        let body = Body::from_stream(stream);
        let mut builder = Response::builder().status(status);

        for (name, val) in &sanitize_response_headers(&resp_headers) {
            if let Ok(header_name) = HeaderName::from_bytes(name.as_ref()) {
                if let Ok(header_val) = HeaderValue::from_bytes(val.as_bytes()) {
                    builder = builder.header(header_name, header_val);
                }
            }
        }

        // 注入 CORS 头
        for (name, val) in cors_response_headers() {
            builder = builder.header(name, val);
        }

        builder
            .body(body)
            .map_err(|e| ServerError::internal(format!("构建流式代理响应失败: {e}")))
    }
}

/// OPTIONS /v1/preview/proxy：CORS 预检响应
pub async fn handle_preview_proxy_options() -> Response {
    let mut builder = Response::builder().status(StatusCode::NO_CONTENT);
    for (name, val) in crate::server::preview_headers::cors_preflight_headers() {
        builder = builder.header(name, val);
    }
    builder
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::NO_CONTENT.into_response())
}

/// 从原始查询串中提取目标 URL 并宽松解码
pub fn extract_target_url(raw: Option<&str>) -> Result<String, ServerError> {
    let raw = raw.ok_or_else(|| {
        ServerError::protocol(DeviceErrorCode::CmdInvalid, "缺少必填查询参数 url")
    })?;

    if raw.is_empty() {
        return Err(ServerError::protocol(
            DeviceErrorCode::CmdInvalid,
            "缺少必填查询参数 url",
        ));
    }

    // 寻找 url= 参数（优先前缀匹配，支持未完全转义的内嵌 query）
    let target_raw = if let Some(stripped) = raw.strip_prefix("url=") {
        stripped
    } else if let Some(idx) = raw.find("&url=") {
        &raw[idx + 5..]
    } else {
        let mut found = None;
        for part in raw.split('&') {
            if let Some(val) = part.strip_prefix("url=") {
                found = Some(val);
                break;
            }
        }
        found.ok_or_else(|| {
            ServerError::protocol(DeviceErrorCode::CmdInvalid, "缺少必填查询参数 url")
        })?
    };

    if target_raw.is_empty() {
        return Err(ServerError::protocol(
            DeviceErrorCode::CmdInvalid,
            "查询参数 url 不能为空",
        ));
    }

    let decoded = percent_decode_lenient(target_raw);
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        return Err(ServerError::protocol(
            DeviceErrorCode::CmdInvalid,
            "查询参数 url 不能为空",
        ));
    }

    let parsed = url::Url::parse(trimmed).map_err(|e| {
        ServerError::protocol(
            DeviceErrorCode::CmdInvalid,
            format!("目标 URL 格式非法: {e}"),
        )
    })?;

    validate_target_url_security(&parsed, is_development_mode())?;

    Ok(trimmed.to_string())
}

/// 判断当前是否处于开发模式（允许预览回环地址）
pub fn is_development_mode() -> bool {
    // 环境变量显式覆盖（优先判断）
    if let Ok(val) = std::env::var("CONEX_PREVIEW_ALLOW_LOOPBACK") {
        return val == "1" || val.eq_ignore_ascii_case("true");
    }
    if let Ok(env) = std::env::var("CONEX_ENV") {
        if env.eq_ignore_ascii_case("development") {
            return true;
        }
        if env.eq_ignore_ascii_case("production") {
            return false;
        }
    }
    if let Ok(env) = std::env::var("NODE_ENV") {
        if env.eq_ignore_ascii_case("development") {
            return true;
        }
        if env.eq_ignore_ascii_case("production") {
            return false;
        }
    }
    // 默认在 debug profile 构建下启用
    cfg!(debug_assertions)
}

/// 校验目标 URL 是否符合安全要求（SSRF 防护与协议限制）
pub fn validate_target_url_security(
    parsed: &url::Url,
    allow_loopback: bool,
) -> Result<(), ServerError> {
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(ServerError::protocol(
            DeviceErrorCode::CmdInvalid,
            format!("不支持的 URL 协议 '{scheme}'，仅支持 http 或 https"),
        ));
    }

    validate_host_and_ip(parsed, allow_loopback)
}

/// 验证 IPv4 地址安全性
fn validate_ipv4(ip: Ipv4Addr, allow_loopback: bool) -> Result<(), &'static str> {
    let octets = ip.octets();

    // 1. 云实例元数据与链路本地 (169.254.0.0/16, 含 169.254.169.254)
    if octets[0] == 169 && octets[1] == 254 {
        return Err("云实例元数据与链路本地地址禁止访问 (169.254.0.0/16)");
    }

    // 2. 全零 / 当前网络 (0.0.0.0/8)
    if octets[0] == 0 {
        return Err("全零与当前网络地址禁止访问 (0.0.0.0/8)");
    }

    // 3. 广播地址 (255.255.255.255)
    if ip.is_broadcast() {
        return Err("广播地址禁止访问 (255.255.255.255)");
    }

    // 4. 多播地址 (224.0.0.0/4)
    if ip.is_multicast() {
        return Err("多播地址禁止访问 (224.0.0.0/4)");
    }

    // 5. 回环地址 (127.0.0.0/8)
    if ip.is_loopback() && !allow_loopback {
        return Err("非开发模式下禁止访问本地回环地址 (127.0.0.0/8)");
    }

    Ok(())
}

/// 验证 IPv6 地址安全性
fn validate_ipv6(ip: Ipv6Addr, allow_loopback: bool) -> Result<(), &'static str> {
    // 检查是否为 IPv4 映射或 IPv4 兼容地址
    let segments = ip.segments();
    let is_ipv4_mapped = matches!(segments, [0, 0, 0, 0, 0, 0xffff, _, _]);
    let is_ipv4_compat =
        matches!(segments, [0, 0, 0, 0, 0, 0, _, _]) && !ip.is_unspecified() && !ip.is_loopback();
    if is_ipv4_mapped || is_ipv4_compat {
        let oct = ip.octets();
        let v4 = Ipv4Addr::new(oct[12], oct[13], oct[14], oct[15]);
        return validate_ipv4(v4, allow_loopback);
    }

    // 1. 全零未指定 (::)
    if ip.is_unspecified() {
        return Err("IPv6 未指定地址禁止访问 (::)");
    }

    // 2. 链路本地 (fe80::/10)
    if (segments[0] & 0xffc0) == 0xfe80 {
        return Err("IPv6 链路本地地址禁止访问 (fe80::/10)");
    }

    // 3. 唯一本地地址 / ULA (fd00::/8 及 fc00::/7)
    if (segments[0] & 0xfe00) == 0xfc00 {
        return Err("IPv6 唯一本地地址禁止访问 (fd00::/8)");
    }

    // 4. 多播 (ff00::/8)
    if ip.is_multicast() {
        return Err("IPv6 多播地址禁止访问 (ff00::/8)");
    }

    // 5. 回环地址 (::1)
    if ip.is_loopback() && !allow_loopback {
        return Err("非开发模式下禁止访问本地回环地址 (::1)");
    }

    Ok(())
}

/// 验证 URL 目标主机与 IP 地址
fn validate_host_and_ip(parsed: &url::Url, allow_loopback: bool) -> Result<(), ServerError> {
    let host = parsed.host().ok_or_else(|| {
        tracing::warn!(target: "preview_proxy", "SSRF 保护拦截：目标 URL 缺少主机名");
        ServerError::protocol(DeviceErrorCode::CmdInvalid, "目标 URL 缺少有效的主机名")
    })?;

    let host_str = parsed.host_str().unwrap_or_default();

    match host {
        url::Host::Ipv4(v4) => {
            if let Err(reason) = validate_ipv4(v4, allow_loopback) {
                tracing::warn!(
                    target: "preview_proxy",
                    host = %host_str,
                    reason = %reason,
                    "SSRF 保护拦截：不允许访问受限 IP 地址"
                );
                return Err(ServerError::protocol(
                    DeviceErrorCode::CmdInvalid,
                    format!("SSRF 保护拦截：不允许访问受限地址 '{host_str}': {reason}"),
                ));
            }
        }
        url::Host::Ipv6(v6) => {
            if let Err(reason) = validate_ipv6(v6, allow_loopback) {
                tracing::warn!(
                    target: "preview_proxy",
                    host = %host_str,
                    reason = %reason,
                    "SSRF 保护拦截：不允许访问受限 IP 地址"
                );
                return Err(ServerError::protocol(
                    DeviceErrorCode::CmdInvalid,
                    format!("SSRF 保护拦截：不允许访问受限地址 '{host_str}': {reason}"),
                ));
            }
        }
        url::Host::Domain(domain) => {
            // 若 domain 可以解析为 IP（如特殊格式 IP 字符串）
            if let Ok(ip) = domain.parse::<IpAddr>() {
                let res = match ip {
                    IpAddr::V4(v4) => validate_ipv4(v4, allow_loopback),
                    IpAddr::V6(v6) => validate_ipv6(v6, allow_loopback),
                };
                if let Err(reason) = res {
                    tracing::warn!(
                        target: "preview_proxy",
                        host = %host_str,
                        reason = %reason,
                        "SSRF 保护拦截：不允许访问受限 IP 地址"
                    );
                    return Err(ServerError::protocol(
                        DeviceErrorCode::CmdInvalid,
                        format!("SSRF 保护拦截：不允许访问受限地址 '{host_str}': {reason}"),
                    ));
                }
            }

            let normalized = domain.trim_end_matches('.').to_ascii_lowercase();

            // 1. 云实例元数据域名 (metadata.google.internal)
            if normalized == "metadata.google.internal"
                || normalized.ends_with(".metadata.google.internal")
            {
                let reason = "云实例元数据域名禁止访问 (metadata.google.internal)";
                tracing::warn!(
                    target: "preview_proxy",
                    host = %host_str,
                    reason = %reason,
                    "SSRF 保护拦截：不允许访问云元数据域名"
                );
                return Err(ServerError::protocol(
                    DeviceErrorCode::CmdInvalid,
                    format!("SSRF 保护拦截：不允许访问受限域名 '{host_str}': {reason}"),
                ));
            }

            // 2. 本地回环域名 (localhost)
            if (normalized == "localhost" || normalized.ends_with(".localhost")) && !allow_loopback
            {
                let reason = "非开发模式下禁止访问本地回环域名 (localhost)";
                tracing::warn!(
                    target: "preview_proxy",
                    host = %host_str,
                    reason = %reason,
                    "SSRF 保护拦截：不允许访问本地回环域名"
                );
                return Err(ServerError::protocol(
                    DeviceErrorCode::CmdInvalid,
                    format!("SSRF 保护拦截：不允许访问受限域名 '{host_str}': {reason}"),
                ));
            }
        }
    }

    Ok(())
}

/// 宽松百分号解码（容错非标准序列与已解码文本）
pub fn percent_decode_lenient(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = hex_digit(bytes[i + 1]);
            let lo = hex_digit(bytes[i + 2]);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 十六进制字符转数字
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// 判定是否属于客户端逐跳或冲突请求头
fn is_hop_by_hop_or_forbidden_client_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "host"
            | "connection"
            | "upgrade"
            | "keep-alive"
            | "proxy-connection"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "content-length"
            | "sec-websocket-key"
            | "sec-websocket-version"
            | "sec-websocket-extensions"
    )
}

/// 判断 Content-Type 是否为 HTML
pub fn is_html_content_type(headers: &reqwest::header::HeaderMap) -> bool {
    if let Some(ct) = headers.get(reqwest::header::CONTENT_TYPE) {
        if let Ok(ct_str) = ct.to_str() {
            let lower = ct_str.to_ascii_lowercase();
            return lower.contains("text/html") || lower.contains("application/xhtml+xml");
        }
    }
    false
}

#[cfg(test)]
#[path = "preview_proxy_tests.rs"]
mod preview_proxy_tests;
