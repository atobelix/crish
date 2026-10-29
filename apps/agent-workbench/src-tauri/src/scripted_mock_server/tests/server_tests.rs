//! scripted mock server 自测（脚本消费 / 请求记录 / wire 正确性）。

use super::super::*;

use futures_util::StreamExt;
use serde_json::json;

/// 便捷构造一条 chat-completions content delta 帧(与 agent-provider
/// 测试域 `chat_ok_frames` 同 wire 格式)
fn content_frame(text: &str) -> String {
    json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]}).to_string()
}

/// POST JSON 请求(返回原始响应供断言)
async fn post(server: &ScriptedMockServer, path: &str) -> reqwest::Response {
    let client = reqwest::Client::new();
    client
        .post(server.base_url(path))
        .json(&json!({"messages": [{"role": "user", "content": "你好"}]}))
        .send()
        .await
        .expect("请求发送")
}

/// 增量收集响应体直至流结束或出错(断流断言用)
async fn drain_stream(response: reqwest::Response) -> (String, &'static str) {
    let mut received = String::new();
    let mut stream = response.bytes_stream();
    loop {
        match stream.next().await {
            Some(Ok(bytes)) => received.push_str(&String::from_utf8_lossy(&bytes)),
            Some(Err(_)) => return (received, "err"),
            None => return (received, "eof"),
        }
    }
}

/// 脚本按请求序号逐次消费 + 请求记录完整(method/path/头/体/响应状态)
#[tokio::test]
async fn script_consumes_steps_in_order_and_records_requests() {
    let server = ScriptedMockServer::start(vec![
        ScriptStep::status(500),
        ScriptStep::status(502),
        ScriptStep::sse_ok(vec!["a".to_string()]),
    ])
    .await;
    let r1 = post(&server, "/v1/chat/completions").await;
    assert_eq!(r1.status().as_u16(), 500, "第 1 次请求 → 脚本第 1 步(500)");
    let r2 = post(&server, "/v1/chat/completions").await;
    assert_eq!(r2.status().as_u16(), 502, "第 2 次请求 → 脚本第 2 步(502)");
    let r3 = post(&server, "/v1/chat/completions").await;
    assert_eq!(r3.status().as_u16(), 200, "第 3 次请求 → 脚本第 3 步(200)");

    let captured = server.wait_for(3).await;
    assert_eq!(captured.len(), 3, "三请求全部记录");
    assert_eq!(server.consumed(), 3, "脚本按请求序号消费 3 步");
    let statuses: Vec<u16> = captured.iter().map(|c| c.response_status).collect();
    assert_eq!(statuses, vec![500, 502, 200], "响应状态按脚本顺序记录");
    assert!(
        captured[0].path.starts_with("/v1/chat/completions"),
        "URL 路径记录"
    );
    assert_eq!(captured[0].method, "POST", "HTTP 方法记录");
    assert!(captured[0].body_contains("你好"), "请求体记录");
    assert_eq!(
        captured[0]
            .header("content-type")
            .map(str::to_lowercase)
            .as_deref(),
        Some("application/json"),
        "请求头记录(大小写不敏感查找)"
    );
}

/// 脚本耗尽后重复最后一项(幂等重试场景:[429, 200] = 第一次 429 后恒 200)
#[tokio::test]
async fn script_exhausted_repeats_last_step() {
    let server = ScriptedMockServer::start(vec![
        ScriptStep::rate_limit(1),
        ScriptStep::sse_ok(vec!["a".to_string()]),
    ])
    .await;
    let r1 = post(&server, "/s").await;
    assert_eq!(r1.status().as_u16(), 429, "第 1 次 → 429");
    let r2 = post(&server, "/s").await;
    assert_eq!(r2.status().as_u16(), 200, "第 2 次 → 200");
    let r3 = post(&server, "/s").await;
    assert_eq!(r3.status().as_u16(), 200, "耗尽后重复最后一项(200)");
    let r4 = post(&server, "/s").await;
    assert_eq!(r4.status().as_u16(), 200, "继续重复最后一项");
    assert_eq!(server.consumed(), 4, "含耗尽后的重复消费");
}

/// 429 步必须带 retry-after 头(客户端分类器读取面)
#[tokio::test]
async fn rate_limit_step_emits_retry_after_header() {
    let server = ScriptedMockServer::start(vec![ScriptStep::rate_limit(30)]).await;
    let response = post(&server, "/s").await;
    assert_eq!(response.status().as_u16(), 429);
    let retry_after = response
        .headers()
        .get("retry-after")
        .map(|v| v.to_str().expect("ASCII 头值").to_string());
    assert_eq!(
        retry_after.as_deref(),
        Some("30"),
        "429 必须带 retry-after 头"
    );
}

/// 正常流:全部帧按 SSE wire 格式(data: 前缀)发送 + 正常收尾
#[tokio::test]
async fn sse_ok_streams_all_frames_then_finishes() {
    let server = ScriptedMockServer::start(vec![ScriptStep::sse_ok(vec![
        content_frame("你好"),
        "[DONE]".to_string(),
    ])])
    .await;
    let response = post(&server, "/s").await;
    assert_eq!(response.status().as_u16(), 200);
    let (body, outcome) = drain_stream(response).await;
    assert_eq!(outcome, "eof", "正常流以 EOF 收尾(非截断错误)");
    assert!(body.contains("data: "), "帧按 SSE wire 格式 data: 前缀");
    assert!(body.contains("你好"), "正常流应含全部帧: {body}");
    assert!(body.contains("[DONE]"));
}

/// 发数据后断流:已产出帧内容保留,流以错误终止(chunked 截断 →
/// 客户端分类为 Network 的面)
#[tokio::test]
async fn sse_cut_keeps_partial_frames_then_truncates() {
    let server = ScriptedMockServer::start(vec![ScriptStep::sse_cut(
        vec![content_frame("半截"), "[DONE]".to_string()],
        1,
    )])
    .await;
    let response = post(&server, "/s").await;
    assert_eq!(response.status().as_u16(), 200, "断流前仍是 200+SSE 头");
    let (received, outcome) = drain_stream(response).await;
    assert!(received.contains("半截"), "已产出的帧内容保留: {received}");
    assert!(!received.contains("[DONE]"), "断流后的帧不出现");
    assert_eq!(
        outcome, "err",
        "chunked 未收尾 → 流以错误终止(Network 分类面)"
    );
}

/// 未产出断流:零帧数据即截断(客户端「未产出可重发」语义的 wire 面)
#[tokio::test]
async fn sse_cut_zero_keep_yields_no_data_before_truncation() {
    let server = ScriptedMockServer::start(vec![ScriptStep::sse_cut(
        vec![content_frame("不应出现")],
        0,
    )])
    .await;
    let response = post(&server, "/s").await;
    assert_eq!(response.status().as_u16(), 200);
    let (received, outcome) = drain_stream(response).await;
    assert!(!received.contains("不应出现"), "未产出断流:零帧数据");
    assert_eq!(outcome, "err", "仅 200+SSE 头后截断");
}
