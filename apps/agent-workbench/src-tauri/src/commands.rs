use serde_json::{json, Value};
use std::collections::HashMap;

/// 安装更新 stub：当前仅返回成功，供前端闭环演示。
/// TODO: 接入真实更新下载/安装流程。
#[tauri::command]
pub(crate) async fn workbench_apply_update() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "ok": true }))
}

/// 桌面壳原生 HTTP：用于供应商 /models 与连通测试（无浏览器 CORS）
#[tauri::command]
pub(crate) async fn workbench_http_request(
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<Value, String> {
    let method = method.trim().to_uppercase();
    if method != "GET" && method != "POST" && method != "HEAD" {
        return Err(format!("unsupported method: {method}"));
    }
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("url must be http(s)".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

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
        format!("network: {e}")
    })?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    Ok(json!({
        "ok": status >= 200 && status < 300,
        "status": status,
        "body": text,
    }))
}
