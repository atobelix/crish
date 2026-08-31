//! 应用预览响应头清洗与重写引擎（透明代理管道第二段）
//!
//! 职责：把上游响应头转换为适合 iframe 内嵌的安全 HeaderMap——
//! 1. 剥离一切阻止 iframe 嵌入的头部（X-Frame-Options、CSP、
//!    COOP/COEP/CORP、X-Content-Type-Options 等）与逐跳头部；
//! 2. CSP 智能重写：仅剔除 `frame-ancestors` 指令，其余指令原样保留
//!    （不做全量剥离，避免破坏目标站点自身的其余安全语义）；
//! 3. Set-Cookie 修正：`SameSite=Strict` → `SameSite=Lax`，保证跨源内嵌
//!    会话可用；
//! 4. 注入跨域 CORS 宽容头（Access-Control-Allow-Origin: * 等）。
//!
//! 纯函数无副作用，便于独立单元测试。CSP 内 Set-Cookie 重写仅作用于
//! 单条响应头（上游多 Set-Cookie 时由 [sanitize_response_headers] 逐条
//! append）。

use axum::http::{HeaderMap, HeaderName, HeaderValue};

/// 判定是否应剥离阻止 iframe 嵌入的响应头及逐跳头部
///
/// 剥离矩阵（与 01-分维详案 §4.1 / 00-总方案 §5 安全防护对齐）：
/// - iframe 阻断面：X-Frame-Options / Content-Security-Policy（含
///   report-only） / COOP / COEP / CORP / X-Content-Type-Options；
/// - 逐跳面：Connection / Keep-Alive / Transfer-Encoding（代理不可透传）。
pub fn should_strip_response_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "x-frame-options"
            | "content-security-policy"
            | "content-security-policy-report-only"
            | "cross-origin-opener-policy"
            | "cross-origin-embedder-policy"
            | "cross-origin-resource-policy"
            | "x-content-type-options"
            | "connection"
            | "keep-alive"
            | "transfer-encoding"
    )
}

/// 清洗上游响应头，生成适合 iframe 渲染的安全响应头集合
///
/// - 剔除 [should_strip_response_header] 命中的头部；
/// - CSP 走 [rewrite_csp]（剔除 `frame-ancestors`，保留其余指令；若重写后
///   为空则整体移除）；
/// - Set-Cookie 走 [rewrite_cookie]（SameSite 修正）；
/// - 其余头部原样保留（Content-Type / Cache-Control / 自定义头等）。
///
/// 注意：调用方按需**追加** CORS 注入头（[cors_response_headers] 等），
/// 本函数只做"清洗 + 重写"，不决定 HTML / 非 HTML 分支是否附加 CORS。
pub fn sanitize_response_headers(upstream_headers: &HeaderMap) -> HeaderMap {
    let mut clean = HeaderMap::new();
    for (name, value) in upstream_headers.iter() {
        let key = name.as_str().to_ascii_lowercase();
        // 取值失败（非 UTF-8 / 超长）则直接丢弃该头，避免污染下游
        let Ok(value_str) = value.to_str() else {
            continue;
        };
        match key.as_str() {
            // CSP 智能重写：先于剥离判定处理（剥离矩阵含
            // content-security-policy，但本引擎对其走"剔除 frame-ancestors"
            // 而非全量剥离，01-分维详案 §4.1）
            "content-security-policy" => {
                let rewritten = rewrite_csp(value_str);
                if !rewritten.is_empty() {
                    if let Ok(val) = HeaderValue::from_str(&rewritten) {
                        clean.insert(name.clone(), val);
                    }
                }
            }
            "set-cookie" => {
                if let Ok(rewritten) = HeaderValue::from_str(&rewrite_cookie(value_str)) {
                    clean.append(name.clone(), rewritten);
                }
            }
            _ => {
                if should_strip_response_header(&key) {
                    continue;
                }
                clean.insert(name.clone(), value.clone());
            }
        }
    }
    clean
}

/// 移除 CSP 中的 `frame-ancestors` 指令（其余指令原样保留并重排连接）
pub fn rewrite_csp(csp: &str) -> String {
    csp.split(';')
        .map(str::trim)
        .filter(|directive| {
            let lower = directive.to_lowercase();
            !lower.starts_with("frame-ancestors")
        })
        .filter(|directive| !directive.is_empty())
        .collect::<Vec<&str>>()
        .join("; ")
}

/// 修正 Cookie 的 SameSite 属性：`SameSite=Strict` → `SameSite=Lax`
///
/// 原因：iframe 跨源内嵌属于"非同源上下文"，SameSite=Strict Cookie 无法
/// 随请求发送，导致目标站点会话失效；Lax 在顶层导航内嵌上下文仍可携带。
/// 大小写不敏感匹配（上游可能输出 `samesite=strict` 小写形式），替换保留
/// 原大小写风格。
pub fn rewrite_cookie(cookie: &str) -> String {
    if cookie.to_ascii_lowercase().contains("samesite=strict") {
        cookie
            .replace("SameSite=Strict", "SameSite=Lax")
            .replace("samesite=strict", "samesite=lax")
    } else {
        cookie.to_string()
    }
}

/// CORS 响应头（代理统一注入，供前端读取代理资产与 iframe 通信）
pub fn cors_response_headers() -> [(HeaderName, HeaderValue); 4] {
    [
        (
            HeaderName::from_static("access-control-allow-origin"),
            HeaderValue::from_static("*"),
        ),
        (
            HeaderName::from_static("access-control-allow-methods"),
            HeaderValue::from_static("GET, HEAD, OPTIONS"),
        ),
        (
            HeaderName::from_static("access-control-allow-headers"),
            HeaderValue::from_static("*"),
        ),
        (
            HeaderName::from_static("access-control-expose-headers"),
            HeaderValue::from_static("*"),
        ),
    ]
}

/// OPTIONS 预检响应的 CORS 头（含 max-age 缓存，无需 expose-headers）
pub fn cors_preflight_headers() -> [(HeaderName, HeaderValue); 4] {
    [
        (
            HeaderName::from_static("access-control-allow-origin"),
            HeaderValue::from_static("*"),
        ),
        (
            HeaderName::from_static("access-control-allow-methods"),
            HeaderValue::from_static("GET, HEAD, OPTIONS"),
        ),
        (
            HeaderName::from_static("access-control-allow-headers"),
            HeaderValue::from_static("*"),
        ),
        (
            HeaderName::from_static("access-control-max-age"),
            HeaderValue::from_static("86400"),
        ),
    ]
}
