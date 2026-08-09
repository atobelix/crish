//! 成功路径与输入校验测试（mock 会话注入，参数透传 + 返回结构断言）
//!
//! 成功路径：每个工具经注入 mock 会话断言「参数透传 + 返回结构」；
//! 输入校验：缺参/类型错/越界/超长/恶意字符串 → 结构化 `tool.invalid_input`
//! （未知键 → invalid_input；上传越界 → tool.path_escape；未接线面 → unwired）。

mod common;

use agent_tools::context::{create_mock_tool_context, ToolContext};
use common::{mock_config, MockSession};
use conex_browser_tools::gate::{HostResolver, MvpDomainGate};
use conex_browser_tools::register_browser_tools;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::Arc;

/// 确定性解析器（评审 F10 接线后注入测试 harness）：任何主机名解析到公网
/// 地址——测试面不依赖 CI 真实 DNS（假域名 a.example/x.example 在真实
/// resolver 下解析失败，会因 fail-closed 被阻断，与门禁正确性无关）。
/// 门禁判定本身（scheme 门禁/IP 保留段/解析到内网段）在用例内全部生效。
struct AlwaysPublicResolver;

impl HostResolver for AlwaysPublicResolver {
    fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
        Ok(vec!["93.184.216.34".parse().expect("字面量 IP")])
    }
}

struct Harness {
    mock: Arc<MockSession>,
    ctx: ToolContext,
    registry: agent_tools::registry::ToolRegistry,
}

fn harness(upload_enabled: bool) -> Harness {
    let mock = MockSession::new();
    let mut registry = agent_tools::registry::ToolRegistry::new();
    let mut config = mock_config(&mock, upload_enabled);
    // 门禁注入确定性解析器（注入位：BrowserToolsConfig.gate，lib.rs:91）；
    // 空白名单 + 解析到公网 = 公共域名放行，保留段 IP 字面量仍阻断
    config.gate = Some(Arc::new(
        MvpDomainGate::with_resolver(&[], &[], Arc::new(AlwaysPublicResolver))
            .expect("门禁构造"),
    ));
    register_browser_tools(&mut registry, config).expect("注册成功");
    Harness {
        mock,
        ctx: create_mock_tool_context(),
        registry,
    }
}

impl Harness {
    async fn run(
        &self,
        name: &str,
        args: Value,
    ) -> Result<Value, agent_tools::definition::ToolError> {
        let tool = self.registry.get(name).expect("工具应注册");
        tool.execute(&self.ctx, args).await
    }

    async fn run_ok(&self, name: &str, args: Value) -> Value {
        self.run(name, args)
            .await
            .unwrap_or_else(|e| panic!("{name} 应成功：{e}"))
    }

    async fn run_err(&self, name: &str, args: Value) -> agent_tools::definition::ToolError {
        self.run(name, args).await.expect_err("应报错")
    }
}

// ── 导航 8 ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn navigate_passthrough_and_output() {
    let h = harness(true);
    let out = h
        .run_ok(
            "browser_navigate",
            json!({ "url": "https://example.com/page" }),
        )
        .await;
    assert_eq!(out["ok"], true);
    assert_eq!(
        out["url"], "https://a.example/after",
        "返回 targetInfo 实际 URL"
    );
    assert_eq!(out["title"], "标题A");
    assert_eq!(out["snapshotVersion"], 7);
    h.mock
        .assert_recorded("page:Page.navigate {\"url\":\"https://example.com/page\"}");
}

#[tokio::test]
async fn back_forward_reload_commands() {
    let h = harness(true);
    assert_eq!(
        h.run_ok("browser_back", json!({})).await["url"],
        "https://a.example/after"
    );
    h.mock.assert_recorded("page:Page.goBack");

    let h = harness(true);
    assert_eq!(
        h.run_ok("browser_forward", json!({})).await["url"],
        "https://a.example/after"
    );
    h.mock.assert_recorded("page:Page.goForward");

    let h = harness(true);
    let out = h
        .run_ok("browser_reload", json!({ "ignore_cache": true }))
        .await;
    assert_eq!(out["url"], "https://a.example/after");
    h.mock
        .assert_recorded("page:Page.reload {\"ignoreCache\":true}");
}

#[tokio::test]
async fn list_tabs_filters_pages_and_marks_active() {
    let h = harness(true);
    let out = h.run_ok("browser_list_tabs", json!({})).await;
    let tabs = out["tabs"].as_array().expect("tabs 数组");
    assert_eq!(tabs.len(), 2, "webview 目标被过滤");
    assert_eq!(tabs[0]["tabId"], "T1");
    assert_eq!(tabs[0]["active"], true, "活动标签标记");
    assert_eq!(tabs[1]["tabId"], "T2");
    assert_eq!(tabs[1]["active"], false);
}

#[tokio::test]
async fn new_tab_gate_and_create() {
    let h = harness(true);
    let out = h
        .run_ok("browser_new_tab", json!({ "url": "https://x.example/" }))
        .await;
    assert_eq!(out["tabId"], "T9");
    assert_eq!(out["url"], "https://x.example/");
    h.mock
        .assert_recorded("browser:Target.createTarget {\"url\":\"https://x.example/\"}");
}

#[tokio::test]
async fn close_and_switch_tab_by_seq() {
    let h = harness(true);
    let out = h.run_ok("browser_close_tab", json!({ "tab_id": 2 })).await;
    assert_eq!(out["closedTabId"], "T2");
    assert_eq!(out["remainingTabs"], 2);
    h.mock
        .assert_recorded("browser:Target.closeTarget {\"targetId\":\"T2\"}");

    let h = harness(true);
    let out = h.run_ok("browser_switch_tab", json!({ "tab_id": 1 })).await;
    assert_eq!(out["tabId"], "T1");
    assert_eq!(out["url"], "https://a.example/after");
    h.mock
        .assert_recorded("browser:Target.activateTarget {\"targetId\":\"T1\"}");
}

// ── 感知 5 ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn snapshot_output_shape() {
    let h = harness(true);
    let out = h.run_ok("browser_snapshot", json!({})).await;
    assert_eq!(out["ok"], true);
    assert_eq!(out["snapshotVersion"], 7);
    assert_eq!(out["tree"], "TREE_TEXT");
    assert_eq!(out["warnings"], json!([]));
    h.mock.assert_recorded("snapshot:capture tab=T1");
}

#[tokio::test]
async fn screenshot_format_and_full_page() {
    let h = harness(true);
    let out = h
        .run_ok(
            "browser_screenshot",
            json!({ "format": "jpeg", "full_page": true }),
        )
        .await;
    assert_eq!(out["mimeType"], "image/jpeg");
    assert_eq!(out["dataBase64"], "QUJD");
    h.mock.assert_recorded("page:Page.captureScreenshot {\"captureBeyondViewport\":true,\"format\":\"jpeg\",\"fromSurface\":true}");

    let h = harness(true);
    let out = h.run_ok("browser_screenshot", json!({})).await;
    assert_eq!(out["mimeType"], "image/png", "缺省 png");
}

#[tokio::test]
async fn wait_for_conditions_mapped() {
    let h = harness(true);
    let out = h
        .run_ok(
            "browser_wait_for",
            json!({ "condition": "text", "text": "你好" }),
        )
        .await;
    assert_eq!(out["matched"], true);
    h.mock.assert_recorded("wait:Text(\"你好\")");

    let h = harness(true);
    h.run_ok(
        "browser_wait_for",
        json!({ "condition": "element", "ref": 3 }),
    )
    .await;
    h.mock.assert_recorded("wait:Element { index: 3 }");

    let h = harness(true);
    h.run_ok(
        "browser_wait_for",
        json!({ "condition": "url", "url": "example" }),
    )
    .await;
    h.mock.assert_recorded("wait:Url { contains: \"example\" }");

    let h = harness(true);
    h.run_ok("browser_wait_for", json!({ "condition": "network_idle" }))
        .await;
    h.mock.assert_recorded("wait:NetworkIdle");
}

#[tokio::test]
async fn get_url_and_get_title() {
    let h = harness(true);
    let out = h.run_ok("browser_get_url", json!({})).await;
    assert_eq!(out["url"], "https://a.example/after");
    let out = h.run_ok("browser_get_title", json!({})).await;
    assert_eq!(out["title"], "标题A");
}

// ── 交互 8 ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn click_button_and_double() {
    let h = harness(true);
    h.run_ok(
        "browser_click",
        json!({ "ref": 3, "button": "right", "double_click": true }),
    )
    .await;
    h.mock
        .assert_recorded("primitive=Click { button: Right, count: 2 }");
    h.mock
        .assert_recorded("element=Some(ElementRef { index: 3, backend_node_id: 42 })");

    let h = harness(true);
    h.run_ok("browser_click", json!({ "ref": 0 })).await;
    h.mock
        .assert_recorded("primitive=Click { button: Left, count: 1 }");
}

#[tokio::test]
async fn type_text_and_submit() {
    let h = harness(true);
    h.run_ok(
        "browser_type",
        json!({ "ref": 1, "text": "你好 world", "submit_key": "Enter" }),
    )
    .await;
    h.mock
        .assert_recorded("primitive=Type { text: \"你好 world\", submit_key: Some(\"Enter\") }");
}

#[tokio::test]
async fn key_combo_joined() {
    let h = harness(true);
    h.run_ok("browser_key", json!({ "keys": ["Control", "A"] }))
        .await;
    h.mock
        .assert_recorded("primitive=Key { keys: \"Control+A\" }");

    let h = harness(true);
    h.run_ok("browser_key", json!({ "keys": ["Enter"] })).await;
    h.mock.assert_recorded("primitive=Key { keys: \"Enter\" }");
}

#[tokio::test]
async fn scroll_page_and_element() {
    let h = harness(true);
    h.run_ok(
        "browser_scroll",
        json!({ "direction": "down", "amount": 250 }),
    )
    .await;
    h.mock
        .assert_recorded("primitive=Scroll { dir: Down, amount: 250 }");
    h.mock.assert_recorded("element=None");

    let h = harness(true);
    h.run_ok(
        "browser_scroll",
        json!({ "ref": 2, "direction": "left", "amount": 100 }),
    )
    .await;
    h.mock
        .assert_recorded("element=Some(ElementRef { index: 2, backend_node_id: 42 })");
}

#[tokio::test]
async fn hover_and_drag() {
    let h = harness(true);
    let out = h.run_ok("browser_hover", json!({ "ref": 1 })).await;
    assert_eq!(out, json!({ "ok": true }), "hover 输出仅 {{ok}}");
    h.mock.assert_recorded("primitive=Hover");

    let h = harness(true);
    h.run_ok("browser_drag", json!({ "from_ref": 1, "to_ref": 2 }))
        .await;
    h.mock
        .assert_recorded("primitive=Drag { to: ElementRef { index: 2, backend_node_id: 42 } }");
}

#[tokio::test]
async fn select_option_value() {
    let h = harness(true);
    h.run_ok(
        "browser_select_option",
        json!({ "ref": 1, "value": "opt2" }),
    )
    .await;
    h.mock
        .assert_recorded("primitive=SelectOption { value: \"opt2\" }");
}

#[tokio::test]
async fn upload_workspace_path_resolved() {
    let h = harness(true);
    let mut ctx = create_mock_tool_context();
    let dir = tempfile::tempdir().expect("临时目录");
    std::fs::write(dir.path().join("a.txt"), "x").expect("写文件");
    std::fs::write(dir.path().join("b.txt"), "y").expect("写文件");
    ctx.workspace_root = dir.path().to_path_buf();
    let tool = h.registry.get("browser_upload").expect("工具应注册");
    let out = tool
        .execute(&ctx, json!({ "ref": 1, "files": ["a.txt", "b.txt"] }))
        .await
        .expect("上传应成功");
    assert_eq!(out["ok"], true);
    assert_eq!(out["files"], json!(["a.txt", "b.txt"]));
    h.mock.assert_recorded("primitive=Upload");
}

// ── 调试 2 ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn console_entries_with_filter() {
    let h = harness(true);
    let out = h
        .run_ok(
            "browser_console",
            json!({ "since_seq": 0, "level": "error" }),
        )
        .await;
    let entries = out["entries"].as_array().expect("entries 数组");
    assert_eq!(entries.len(), 1, "level 过滤生效");
    assert_eq!(entries[0]["text"], "boom");
    assert!(entries[0]["url"].is_null(), "url 字段 MVP 置 null");

    let h = harness(true);
    let out = h.run_ok("browser_console", json!({ "since_seq": 1 })).await;
    assert_eq!(
        out["entries"].as_array().unwrap().len(),
        1,
        "since_seq 增量"
    );
}

#[tokio::test]
async fn network_entries_shape() {
    let h = harness(true);
    let out = h.run_ok("browser_network", json!({})).await;
    let requests = out["requests"].as_array().expect("requests 数组");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["id"], "r1");
    assert_eq!(requests[0]["method"], "GET");
    assert!(requests[0]["status"].is_null(), "status MVP 置 null");
    assert!(requests[0]["size"].is_null(), "size MVP 置 null");
}

// ── 输入校验（缺参/类型错/越界/超长/恶意字符串）────────────────────────

#[tokio::test]
async fn invalid_inputs_are_structured() {
    let h = harness(true);
    // 导航：缺参/非 http scheme/未知键/超长 URL
    for args in [
        json!({}),
        json!({ "url": "javascript:alert(1)" }),
        json!({ "url": "ftp://x/" }),
        json!({ "url": "https://a.example/", "evil": 1 }),
        json!({ "url": format!("https://a.example/{}", "x".repeat(5000)) }),
    ] {
        let err = h.run_err("browser_navigate", args).await;
        assert_eq!(err.code(), "tool.invalid_input", "navigate 非法入参");
    }
    // 门禁拦截：内网 IP 字面量 → gate_blocked（非 invalid_input）；
    // 本机回环默认放行（§4.3 口径：127.0.0.0/8 本地测试页场景，评审 F10 修复
    // 后语义——旧断言「127.0.0.1 默认 gate_blocked」与放行语义冲突，已更新）
    let err = h
        .run_err("browser_navigate", json!({ "url": "http://10.0.0.5/" }))
        .await;
    assert_eq!(err.code(), "tool.browser.gate_blocked");
    let err = h
        .run_err("browser_new_tab", json!({ "url": "http://10.0.0.5/" }))
        .await;
    assert_eq!(err.code(), "tool.browser.gate_blocked");
    // 回环字面量默认放行：导航照常发出（与「内网 IP 阻断」形成行为对照）
    h.run_ok(
        "browser_navigate",
        json!({ "url": "http://127.0.0.1:8080/" }),
    )
    .await;
    h.mock
        .assert_recorded("page:Page.navigate {\"url\":\"http://127.0.0.1:8080/\"}");

    // 点击：缺 ref/负数/非法按钮/非法修饰键/类型错
    for args in [
        json!({}),
        json!({ "ref": -1 }),
        json!({ "ref": "1" }),
        json!({ "ref": 1, "button": "leftt" }),
        json!({ "ref": 1, "modifiers": ["pwn"] }),
        json!({ "ref": 1, "double_click": "yes" }),
        json!({ "ref": 1, "evil": 1 }),
    ] {
        let err = h.run_err("browser_click", args).await;
        assert_eq!(err.code(), "tool.invalid_input", "click 非法入参");
    }

    // type：缺参/超长/空文本无提交键/控制字符
    for args in [
        json!({ "ref": 1 }),
        json!({ "text": "x" }),
        json!({ "ref": 1, "text": "" }),
        json!({ "ref": 1, "text": format!("{}", "a".repeat(65_537)) }),
        json!({ "ref": 1, "text": "x", "submit_key": "En\u{0}ter" }),
        json!({ "ref": 1, "text": "x", "delay_ms": 20_000 }),
    ] {
        let err = h.run_err("browser_type", args).await;
        assert_eq!(err.code(), "tool.invalid_input", "type 非法入参");
    }

    // key：空数组/空元素/控制字符
    for args in [
        json!({ "keys": [] }),
        json!({ "keys": [""] }),
        json!({ "keys": ["a\u{1b}b"] }),
        json!({}),
    ] {
        let err = h.run_err("browser_key", args).await;
        assert_eq!(err.code(), "tool.invalid_input", "key 非法入参");
    }

    // scroll：非法方向/零/超长/缺参
    for args in [
        json!({ "direction": "diagonal", "amount": 10 }),
        json!({ "direction": "down", "amount": 0 }),
        json!({ "direction": "down", "amount": 2_000_000 }),
        json!({ "direction": "down" }),
        json!({ "amount": 10 }),
    ] {
        let err = h.run_err("browser_scroll", args).await;
        assert_eq!(err.code(), "tool.invalid_input", "scroll 非法入参");
    }

    // hover/drag：缺参
    assert_eq!(
        h.run_err("browser_hover", json!({})).await.code(),
        "tool.invalid_input"
    );
    assert_eq!(
        h.run_err("browser_drag", json!({ "from_ref": 1 }))
            .await
            .code(),
        "tool.invalid_input"
    );
    assert_eq!(
        h.run_err("browser_drag", json!({ "to_ref": 2 }))
            .await
            .code(),
        "tool.invalid_input"
    );

    // select_option：非单选/超长 value/控制字符
    for args in [
        json!({ "ref": 1 }),
        json!({ "ref": 1, "value": "a", "label": "b" }),
        json!({ "ref": 1, "value": format!("{}", "v".repeat(1025)) }),
        json!({ "ref": 1, "value": "a\u{0}b" }),
    ] {
        let err = h.run_err("browser_select_option", args).await;
        assert_eq!(err.code(), "tool.invalid_input", "select_option 非法入参");
    }

    // 标签序号：0/越界
    assert_eq!(
        h.run_err("browser_close_tab", json!({ "tab_id": 0 }))
            .await
            .code(),
        "tool.invalid_input"
    );
    assert_eq!(
        h.run_err("browser_close_tab", json!({ "tab_id": 99 }))
            .await
            .code(),
        "tool.invalid_input"
    );
    assert_eq!(
        h.run_err("browser_switch_tab", json!({ "tab_id": 99 }))
            .await
            .code(),
        "tool.invalid_input"
    );

    // 感知：预算越界/format 非法/条件非法
    for args in [
        json!({ "max_depth": 0 }),
        json!({ "max_depth": 999 }),
        json!({ "max_elements": 100_000 }),
        json!({ "max_text": 0 }),
    ] {
        assert_eq!(
            h.run_err("browser_snapshot", args).await.code(),
            "tool.invalid_input"
        );
    }
    assert_eq!(
        h.run_err("browser_screenshot", json!({ "format": "gif" }))
            .await
            .code(),
        "tool.invalid_input"
    );
    assert_eq!(
        h.run_err("browser_screenshot", json!({ "full_page": "x" }))
            .await
            .code(),
        "tool.invalid_input"
    );
    for args in [
        json!({ "condition": "css", "ref": 1 }),
        json!({ "condition": "element" }),
        json!({ "condition": "text" }),
        json!({ "condition": "element", "ref": 1, "timeout_ms": 0 }),
    ] {
        assert_eq!(
            h.run_err("browser_wait_for", args).await.code(),
            "tool.invalid_input",
            "wait_for 非法入参"
        );
    }

    // 调试：level 非法
    assert_eq!(
        h.run_err("browser_console", json!({ "level": "verbose" }))
            .await
            .code(),
        "tool.invalid_input"
    );
    assert_eq!(
        h.run_err("browser_network", json!({ "since_seq": "x" }))
            .await
            .code(),
        "tool.invalid_input"
    );

    // 通用：tab_id 0
    assert_eq!(
        h.run_err("browser_get_url", json!({ "tab_id": 0 }))
            .await
            .code(),
        "tool.invalid_input"
    );
    assert_eq!(
        h.run_err("browser_get_title", json!({ "tab_id": 0 }))
            .await
            .code(),
        "tool.invalid_input"
    );
}

/// 上传越界：工作区外路径 → tool.path_escape（17 §7.2）。
#[tokio::test]
async fn upload_outside_workspace_is_path_escape() {
    let h = harness(true);
    let mut ctx = create_mock_tool_context();
    let dir = tempfile::tempdir().expect("临时目录");
    let outside = dir.path().parent().unwrap().join("evil.txt");
    std::fs::write(&outside, "x").expect("写外部文件");
    ctx.workspace_root = dir.path().to_path_buf();
    let tool = h.registry.get("browser_upload").expect("工具应注册");
    let err = tool
        .execute(&ctx, json!({ "ref": 1, "files": ["../evil.txt"] }))
        .await
        .expect_err("越界应拒绝");
    assert_eq!(err.code(), "tool.path_escape");
    // 缺失文件 → invalid_input（14 §9.1 步骤 2 语义）
    let err = tool
        .execute(&ctx, json!({ "ref": 1, "files": ["nope.txt"] }))
        .await
        .expect_err("缺失文件应拒绝");
    assert_eq!(err.code(), "tool.invalid_input");
    // 空数组/超量
    let err = tool
        .execute(&ctx, json!({ "ref": 1, "files": [] }))
        .await
        .expect_err("空数组");
    assert_eq!(err.code(), "tool.invalid_input");
    let many: Vec<String> = (0..9).map(|i| format!("f{i}.txt")).collect();
    let err = tool
        .execute(&ctx, json!({ "ref": 1, "files": many }))
        .await
        .expect_err("超量");
    assert_eq!(err.code(), "tool.invalid_input");
}

/// 恶意字符串样本不产生执行面（R-5 纪律：文本经 JSON 序列化注入固定模板）。
#[tokio::test]
async fn malicious_strings_are_contained() {
    let h = harness(true);
    // 含 NUL/ESC 的文本被工具面护栏拦截（结构化 invalid_input，零命令）
    let err = h
        .run_err("browser_type", json!({ "ref": 1, "text": "x\u{0}y" }))
        .await;
    assert_eq!(err.code(), "tool.invalid_input");
    let err = h
        .run_err(
            "browser_wait_for",
            json!({ "condition": "text", "text": "x\u{1b}y" }),
        )
        .await;
    assert_eq!(err.code(), "tool.invalid_input");
    // 双引号/反斜杠等注入样本仅作为普通文本传入（固定模板注入面安全）
    h.run_ok(
        "browser_wait_for",
        json!({ "condition": "text", "text": "\"); alert(1); (\"\" )"} ),
    )
    .await;
    h.mock
        .assert_recorded("wait:Text(\"\\\"); alert(1); (\\\"\\\" )\")");
}
