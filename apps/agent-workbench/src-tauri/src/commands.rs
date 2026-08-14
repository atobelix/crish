use serde_json::{json, Value};
use std::collections::HashMap;

use crate::core_error::CoreError;

/// 安装更新 stub：当前仅返回成功，供前端闭环演示。
/// TODO: 接入真实更新下载/安装流程。
/// 错误协议（PS-04 T4.5 / F4 F1-02）：返回类型统一 `Result<Value, CoreError>`
/// （stub 无错误面，签名收敛保证前端按 {kind, detail} 协议消费）。
#[tauri::command]
pub(crate) async fn workbench_apply_update() -> Result<serde_json::Value, CoreError> {
    Ok(serde_json::json!({ "ok": true }))
}

/// 桌面壳原生 HTTP：用于供应商 /models 与连通测试（无浏览器 CORS）
///
/// 错误协议（PS-04 T4.5 / F4 F1-02）：参数校验类（method/url）→ InvalidInput；
/// 网络/客户端构建类 → Io（detail 保留操作名 + 底层消息）。
#[tauri::command]
pub(crate) async fn workbench_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<Value, CoreError> {
    let method = method.trim().to_uppercase();
    if method != "GET" && method != "POST" && method != "HEAD" {
        return Err(CoreError::InvalidInput(format!(
            "unsupported method: {method}"
        )));
    }
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(CoreError::InvalidInput("url must be http(s)".to_string()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| CoreError::Io(format!("http client build failed: {e}")))?;

    let mut req = match method.as_str() {
        "POST" => client.post(url),
        "HEAD" => client.head(url),
        _ => client.get(url),
    };

    if let Some(h) = headers {
        for (k, v) in h {
            // 禁止覆盖危险头
            let kl = k.to_ascii_lowercase();
            if kl == "host" || kl == "content-length" {
                continue;
            }
            req = req.header(k, v);
        }
    }
    if let Some(b) = body {
        if method == "POST" {
            req = req.body(b);
        }
    }

    let res = req.send().await.map_err(|e| {
        // 人话错误，避免前端误报「跨域」
        CoreError::Io(format!("network: {e}"))
    })?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    Ok(json!({
        "ok": (200..300).contains(&status),
        "status": status,
        "body": text,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core_error::CoreError;

    /// 协议断言：错误必须按 CoreError `{kind, detail}` 形状序列化。
    fn assert_core_error_kind<T: std::fmt::Debug>(
        result: Result<T, CoreError>,
        expected_kind: &str,
    ) {
        let err = result.expect_err("必须返回错误");
        let json = serde_json::to_value(&err).expect("错误必须可序列化");
        assert_eq!(
            json.get("kind").and_then(|v| v.as_str()),
            Some(expected_kind),
            "错误必须按 CoreError {{kind,detail}} 协议序列化（当前形态 {json}）"
        );
    }

    /// T4.5-R4（红 → 绿）：非法 method（参数校验类）→ `CoreError::InvalidInput`。
    #[tokio::test]
    async fn http_request_rejects_unsupported_method_with_core_error() {
        let result = workbench_http_request(
            "https://example.com/v1".to_string(),
            "DELETE".to_string(),
            None,
            None,
        )
        .await;
        assert_core_error_kind(result, "InvalidInput");
    }

    /// T4.5-R4（红 → 绿）：非 http(s) url（参数校验类）→ `CoreError::InvalidInput`。
    #[tokio::test]
    async fn http_request_rejects_non_http_url_with_core_error() {
        let result = workbench_http_request(
            "file:///etc/passwd".to_string(),
            "GET".to_string(),
            None,
            None,
        )
        .await;
        assert_core_error_kind(result, "InvalidInput");
    }

    /// T4.5-R5/R6（契约锁定）：`workbench_apply_update` 成功路径形状不变
    /// （`{ok: true}`）；签名收敛为 `Result<Value, CoreError>`（编译期断言
    /// 在修复提交随签名变更落地）。
    #[tokio::test]
    async fn apply_update_returns_ok_true_shape() {
        let res = workbench_apply_update().await.expect("stub 恒成功");
        assert_eq!(res["ok"], true, "update stub 返回形状不变");
    }
}
