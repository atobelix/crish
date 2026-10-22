use super::*;

/// 控制台面：consoleAPICalled 全级别映射 + 参数拼接（JSON 序列化语义）；
/// exceptionThrown / pageError。
#[test]
fn bus_table_console_domain() {
    let level_cases = [
        ("debug", ConsoleLevel::Debug),
        ("info", ConsoleLevel::Info),
        ("warning", ConsoleLevel::Warn),
        ("error", ConsoleLevel::Error),
        ("assert", ConsoleLevel::Error),
        ("log", ConsoleLevel::Log),
        ("未知级别", ConsoleLevel::Log),
    ];
    for (call_type, level) in level_cases {
        let got = classify(&raw(
            "Runtime.consoleAPICalled",
            json!({ "type": call_type, "args": [ { "type": "string", "value": "你好" } ] }),
            Some("S1"),
        ))
        .unwrap_or_else(|_| panic!("consoleAPICalled({call_type}) 应转译"));
        // value 经 Value::to_string() 序列化 → 字符串带 JSON 引号
        assert_eq!(
            got,
            BrowserEvent::Console {
                session: "S1".to_string(),
                level,
                text: "\"你好\"".to_string(),
                url: None,
                line: None,
            },
            "type={call_type}"
        );
    }
    // 多参数空格拼接 + 无 value 时回退 description
    let got = classify(&raw(
        "Runtime.consoleAPICalled",
        json!({
            "type": "log",
            "args": [
                { "type": "string", "value": "a" },
                { "type": "number", "value": 42 },
                { "type": "object", "description": "Object{len:2}" }
            ]
        }),
        Some("S1"),
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::Console {
            session: "S1".to_string(),
            level: ConsoleLevel::Log,
            text: "\"a\" 42 Object{len:2}".to_string(),
            url: None,
            line: None,
        }
    );
    // G-11：consoleAPICalled 带 stackTrace → 取 callFrames[0] 的 url/lineNumber
    let got = classify(
        &raw(
            "Runtime.consoleAPICalled",
            json!({
                "type": "log",
                "args": [ { "type": "string", "value": "带栈" } ],
                "stackTrace": {
                    "callFrames": [
                        { "functionName": "inner", "url": "https://e.com/app.js", "lineNumber": 12, "columnNumber": 3, "scriptId": "1" },
                        { "functionName": "outer", "url": "https://e.com/app.js", "lineNumber": 20, "columnNumber": 1, "scriptId": "1" }
                    ]
                }
            }),
            Some("S1"),
        ),
    )
    .unwrap();
    match got {
        BrowserEvent::Console { url, line, .. } => {
            assert_eq!(url.as_deref(), Some("https://e.com/app.js"), "取栈顶帧 url");
            assert_eq!(line, Some(12), "取栈顶帧 lineNumber（0-based 原值）");
        }
        other => panic!("应为 Console，实际 {other:?}"),
    }
    // G-11：stackTrace 缺失/空 callFrames → url/line 均 None
    for params in [
        json!({ "type": "log", "args": [ { "type": "string", "value": "x" } ] }),
        json!({ "type": "log", "args": [ { "type": "string", "value": "x" } ], "stackTrace": { "callFrames": [] } }),
    ] {
        let got = classify(&raw("Runtime.consoleAPICalled", params, Some("S1"))).unwrap();
        assert!(
            matches!(
                got,
                BrowserEvent::Console {
                    url: None,
                    line: None,
                    ..
                }
            ),
            "缺省路径必须 None"
        );
    }
    // G-11：exceptionThrown → exceptionDetails.url/lineNumber 提取（0-based 原值）
    let got = classify(
        &raw(
            "Runtime.exceptionThrown",
            json!({ "timestamp": 1.0, "exceptionDetails": { "text": "ReferenceError: x", "url": "https://e.com/app.js", "lineNumber": 7, "columnNumber": 0 } }),
            Some("S1"),
        ),
    )
    .unwrap();
    match got {
        BrowserEvent::PageError { url, line, .. } => {
            assert_eq!(
                url.as_deref(),
                Some("https://e.com/app.js"),
                "exceptionDetails.url"
            );
            assert_eq!(line, Some(7), "exceptionDetails.lineNumber");
        }
        other => panic!("应为 PageError，实际 {other:?}"),
    }
    // G-11：exceptionDetails 无 url/lineNumber（eval/内建）→ None
    let got = classify(&raw(
        "Runtime.exceptionThrown",
        json!({ "timestamp": 1.0, "exceptionDetails": { "text": "TypeError: y" } }),
        Some("S1"),
    ))
    .unwrap();
    assert!(
        matches!(
            got,
            BrowserEvent::PageError {
                url: None,
                line: None,
                ..
            }
        ),
        "缺省路径必须 None"
    );
    // G-11：pageError → entry.url/lineNumber 提取
    let got = classify(
        &raw(
            "Page.pageError",
            json!({ "entry": { "source": "javascript", "level": "error", "text": "TypeError: z", "url": "https://e.com/other.js", "lineNumber": 3, "timestamp": 1.0 } }),
            Some("S1"),
        ),
    )
    .unwrap();
    match got {
        BrowserEvent::PageError { url, line, .. } => {
            assert_eq!(url.as_deref(), Some("https://e.com/other.js"), "entry.url");
            assert_eq!(line, Some(3), "entry.lineNumber");
        }
        other => panic!("应为 PageError，实际 {other:?}"),
    }
}

/// 网络面：requestWillBeSent / responseReceived / loadingFinished /
/// loadingFailed / requestFailed。
#[test]
fn bus_table_network_domain() {
    let got = classify(
        &raw(
            "Network.requestWillBeSent",
            json!({ "requestId": "r1", "request": { "url": "https://cdn.example/x.js", "method": "GET" } }),
            None,
        ),
    )
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::NetworkRequest {
            request_id: "r1".to_string(),
            url: "https://cdn.example/x.js".to_string(),
            method: "GET".to_string(),
            status: None
        }
    );
    // G-11：responseReceived → NetworkRequest 补 status（response.status）
    let got = classify(
        &raw(
            "Network.responseReceived",
            json!({
                "requestId": "r1",
                "type": "Script",
                "response": { "url": "https://cdn.example/x.js", "status": 200, "statusText": "OK", "mimeType": "application/javascript" }
            }),
            None,
        ),
    )
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::NetworkRequest {
            request_id: "r1".to_string(),
            url: "https://cdn.example/x.js".to_string(),
            method: String::new(),
            status: Some(200)
        }
    );
    // G-11：responseReceived 缺 status/url → None/空串（宽容解析）
    let got = classify(&raw(
        "Network.responseReceived",
        json!({ "requestId": "r3", "response": {} }),
        None,
    ))
    .unwrap();
    assert!(
        matches!(got, BrowserEvent::NetworkRequest { request_id: ref id, url: ref u, status: None, .. } if id == "r3" && u.is_empty()),
        "缺省路径必须 None/空串"
    );
    // 三终止事件 → NetworkDone（ok 语义：仅 loadingFinished 为 true）
    let got = classify(&raw(
        "Network.loadingFinished",
        json!({ "requestId": "r1" }),
        None,
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::NetworkDone {
            request_id: "r1".to_string(),
            ok: true,
            size: None
        }
    );
    // G-11：loadingFinished → size = encodedDataLength（整数形态）
    let got = classify(&raw(
        "Network.loadingFinished",
        json!({ "requestId": "r1", "encodedDataLength": 12345 }),
        None,
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::NetworkDone {
            request_id: "r1".to_string(),
            ok: true,
            size: Some(12345)
        }
    );
    // G-11：encodedDataLength 浮点形态（CDP number 实际形态）也提取
    let got = classify(&raw(
        "Network.loadingFinished",
        json!({ "requestId": "r1", "encodedDataLength": 12345.0 }),
        None,
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::NetworkDone {
            request_id: "r1".to_string(),
            ok: true,
            size: Some(12345)
        }
    );
    // G-11：encodedDataLength 缺失 → size None
    let got = classify(&raw(
        "Network.loadingFinished",
        json!({ "requestId": "r1" }),
        None,
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::NetworkDone {
            request_id: "r1".to_string(),
            ok: true,
            size: None
        }
    );
    for method in ["Network.loadingFailed", "Network.requestFailed"] {
        let got = classify(&raw(method, json!({ "requestId": "r2" }), None)).unwrap();
        assert_eq!(
            got,
            BrowserEvent::NetworkDone {
                request_id: "r2".to_string(),
                ok: false,
                size: None
            },
            "{method}"
        );
    }
    // requestId 缺省 → 空串兜底（宽容解析）
    let got = classify(&raw(
        "Network.loadingFailed",
        json!({ "errorText": "net::ERR_ABORTED" }),
        None,
    ))
    .unwrap();
    assert_eq!(
        got,
        BrowserEvent::NetworkDone {
            request_id: String::new(),
            ok: false,
            size: None
        }
    );
}

/// R-3 补齐面：fileChooserOpened → FileChooserOpened（上传触发）。
#[test]
fn bus_table_file_chooser() {
    let got = classify(&raw(
        "Page.fileChooserOpened",
        json!({ "frameId": "F1", "mode": "selectMultiple", "backendNodeId": 77 }),
        Some("S1"),
    ))
    .expect("fileChooserOpened 应转译");
    assert_eq!(
        got,
        BrowserEvent::FileChooserOpened {
            session: "S1".to_string(),
            frame: "F1".to_string(),
            backend_node_id: 77
        }
    );
}

/// 忽略面全表：screencast 双事件 / 执行环境三事件 / 未知方法 / 解析失败。
#[test]
fn bus_table_ignored_events() {
    for method in [
        "Page.screencastFrame",
        "Page.screencastVisibilityChanged",
        "Runtime.executionContextCreated",
        "Runtime.executionContextDestroyed",
        "Runtime.executionContextsCleared",
    ] {
        assert!(
            classify(&raw(method, json!({}), None)).is_err(),
            "{method} 必须记忽略（不炸事件泵）"
        );
    }
    assert!(
        classify(&raw("Nope.nope", json!({}), None)).is_err(),
        "未知事件宽容忽略"
    );
    // 已知方法但参数残缺 → Ignored（宽容解析，不 panic）
    assert!(
        classify(&raw("Target.targetCreated", json!({}), None)).is_err(),
        "参数解析失败应忽略"
    );
    assert!(
        classify(&raw("Page.frameNavigated", json!({}), None)).is_err(),
        "frameNavigated 缺参应忽略"
    );
    assert!(
        classify(&raw(
            "Runtime.consoleAPICalled",
            json!({ "type": "log" }),
            None
        ))
        .is_err(),
        "consoleAPICalled 缺 args 应忽略"
    );
}
