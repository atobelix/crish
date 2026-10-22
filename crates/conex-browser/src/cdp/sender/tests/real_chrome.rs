use super::*;
use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;
use tokio_tungstenite::tungstenite::protocol::Message;

// ---------- 真实 Chrome 探针（39-E3 真实验证，`#[ignore]`） ----------
// 运行：`cargo test -p conex-browser --lib cdp::sender::tests::real_chrome::real_chrome_attach_proxy_intercepts_like_mcp -- --ignored --nocapture`
// 环境变量：`CONEX_TEST_CHROME` 覆盖 Chrome 路径（缺省探测系统安装路径）。

type TestWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 探测 Chrome 可执行文件（CONEX_TEST_CHROME 优先，其次常见安装路径）。
fn find_chrome() -> PathBuf {
    if let Ok(p) = std::env::var("CONEX_TEST_CHROME") {
        if Path::new(&p).exists() {
            return PathBuf::from(p);
        }
    }
    for c in [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ] {
        if Path::new(c).exists() {
            return PathBuf::from(c);
        }
    }
    for c in [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ] {
        if Path::new(c).exists() {
            return PathBuf::from(c);
        }
    }
    panic!("未找到 Chrome/Chromium（真实探针前置），请设置 CONEX_TEST_CHROME");
}

/// 启动受管实例（`--remote-debugging-port=0` 随机端口 + 全新 profile），
/// 轮询 DevToolsActivePort（维度 10 §5.2 语义），返回 (子进程, 端口, ws_path)。
// G2 禁令豁免（clippy.toml disallowed-methods）：`#[ignore]` 验证专用辅助，
// spawn 仅拉起受管 Chrome 实例（固定启动参数，无用户自由参数），
// 调用方保证 kill + wait 清理——对齐 mcp_attach.rs 既有豁免先例。
#[allow(clippy::disallowed_methods)]
fn spawn_managed_instance(chrome: &Path, profile: &Path) -> (std::process::Child, u16, String) {
    let mut child = std::process::Command::new(chrome)
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("about:blank")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("拉起 Chrome 失败");

    let port_file = profile.join("DevToolsActivePort");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(status) = child.try_wait() {
            if status.is_some() {
                panic!("Chrome 提前退出（受管实例启动失败）");
            }
        }
        if let Ok(lines) = std::fs::read_to_string(&port_file) {
            let parts: Vec<&str> = lines
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect();
            if parts.len() >= 2 {
                let port: u16 = parts[0]
                    .parse()
                    .unwrap_or_else(|_| panic!("DevToolsActivePort 端口非法：{}", parts[0]));
                return (child, port, parts[1].to_string());
            }
        }
        if Instant::now() >= deadline {
            panic!(
                "等待 DevToolsActivePort 超时（30s）：{}",
                port_file.display()
            );
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/// 经给定 WS 连接发送一条 CDP 命令并等待对应响应（事件帧自动跳过）。
async fn cdp_call(
    ws: &mut TestWs,
    id: u64,
    method: &str,
    params: Value,
    session: Option<&str>,
) -> Value {
    let mut frame = json!({ "id": id, "method": method, "params": params });
    if let Some(s) = session {
        frame["sessionId"] = Value::String(s.to_string());
    }
    ws.send(Message::Text(frame.to_string().into()))
        .await
        .expect("命令发送失败");
    loop {
        let resp = ws.next().await.expect("读响应失败").expect("帧错误");
        if let Message::Text(t) = resp {
            let v: Value = serde_json::from_str(&t).expect("响应解析失败");
            if v.get("id").is_some() {
                return v;
            }
            // 事件帧（无 id）：跳过
        }
    }
}

/// data: URL 载荷编码（非保留字符一律 %XX；页面自打日志/自发 fetch 注入源）。
fn data_url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b','
            | b':'
            | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 真实 Chrome 探针（39-E3）：模拟外部 MCP attach 双路径断言 R-12 拦截语义。
/// - **路径 A（接线前现状）**：外部 WS 直连受管实例 CDP 端点——`Runtime.evaluate`
///   成功（34 §4.3 实测结论复现：MCP 自身/直连路径无任何拦截）；
/// - **路径 B（接线后）**：外部 WS 经引擎侧 attach 会话面（[AttachCdpProxy]）——
///   求值/输入注入 capability_disabled 拒绝；会话建立 + 快照/截图/console/
///   network 只读面真实放行；console/network 白名单事件真实透传。
// G2 禁令豁免（clippy.toml disallowed-methods）：`#[ignore]` 验证专用测试，
// spawn 仅拉起受管 Chrome 实例（参数固定，无用户自由参数），进程在 finally
// 语义下 kill + wait 清理——对齐 mcp_attach.rs 既有豁免先例。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
#[allow(clippy::disallowed_methods)]
async fn real_chrome_attach_proxy_intercepts_like_mcp() {
    let chrome = find_chrome();
    let profile = tempfile::tempdir().expect("临时 profile 目录");
    let (mut child, port, ws_path) = spawn_managed_instance(&chrome, profile.path());
    let result = async {
        let endpoint = crate::cdp::transport::CdpEndpoint { port, ws_path };
        println!("[39] 受管实例 CDP 端点就绪（端口即令牌）");

        // ===== 路径 A：直连受管实例端点（接线前现状）——拦截不生效 =====
        let (mut direct, _) = tokio_tungstenite::connect_async(endpoint.url())
            .await
            .expect("外部 WS 直连建连失败");
        let targets = cdp_call(&mut direct, 1, "Target.getTargets", json!({}), None).await;
        assert!(targets.get("error").is_none(), "直连 getTargets 应成功：{targets}");
        let target_id = targets["result"]["targetInfos"][0]["targetId"]
            .as_str()
            .expect("应枚举到页面 target")
            .to_string();
        let attached = cdp_call(
            &mut direct,
            2,
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )
        .await;
        assert!(attached.get("error").is_none(), "直连 attachToTarget 应成功");
        let direct_session = attached["result"]["sessionId"]
            .as_str()
            .expect("直连应取得 sessionId")
            .to_string();
        let eval_direct = cdp_call(
            &mut direct,
            3,
            "Runtime.evaluate",
            json!({ "expression": "1+1" }),
            Some(&direct_session),
        )
        .await;
        assert!(
            eval_direct.get("error").is_none(),
            "直连路径 evaluate 应成功（接线前现状：拦截不生效），实际 {eval_direct}"
        );
        println!("[39] 路径 A（直连）evaluate 成功——接线前拦截缺口复现");

        // 直连导航到自打日志页面（console/network 事件注入源）
        let page_html = r#"<script>setInterval(()=>{console.log('probe-39');fetch('http://127.0.0.1:9/x').catch(()=>{})},500)</script>"#;
        let data_url = format!("data:text/html,{}", data_url_encode(page_html));
        let nav = cdp_call(
            &mut direct,
            4,
            "Page.navigate",
            json!({ "url": data_url }),
            Some(&direct_session),
        )
        .await;
        assert!(nav.get("error").is_none(), "直连导航应成功：{nav}");
        drop(direct);

        // ===== 路径 B：经引擎侧 attach 会话面（接线后）——拦截生效 =====
        let client = Arc::new(
            CdpClient::connect(&endpoint.url())
                .await
                .expect("引擎 client 建连失败"),
        );
        let hooks = Arc::new(RecordingHooks::new(true));
        hooks.set_caps(ReadonlyCaps::mcp_attach_default());
        let channel: Arc<dyn CommandChannel> = client.clone();
        let sender = Arc::new(CommandSender::new(channel, hooks));
        let proxy = AttachCdpProxy::bind(
            sender,
            Arc::new(ReadonlyCaps::mcp_attach_default()),
            client.subscribe(),
        )
        .await
        .expect("attach 会话面挂载失败");

        let (mut ext, _) = tokio_tungstenite::connect_async(proxy.ws_url())
            .await
            .expect("外部 WS 连会话面失败");

        // 会话建立面：getTargets + attachToTarget 真实放行（只读面可达性必需）
        let targets = cdp_call(&mut ext, 10, "Target.getTargets", json!({}), None).await;
        assert!(
            targets.get("error").is_none(),
            "会话建立面 getTargets 应放行：{targets}"
        );
        let target_id = targets["result"]["targetInfos"]
            .as_array()
            .expect("targetInfos 应为数组")
            .iter()
            .find(|t| t["type"] == "page")
            .and_then(|t| t["targetId"].as_str())
            .expect("应找到页面 target")
            .to_string();
        let attached = cdp_call(
            &mut ext,
            11,
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
            None,
        )
        .await;
        assert!(
            attached.get("error").is_none(),
            "会话建立面 attachToTarget 应放行：{attached}"
        );
        let session = attached["result"]["sessionId"]
            .as_str()
            .expect("会话面应取得 sessionId")
            .to_string();

        // 拒绝面（evaluate_script / 输入注入）→ capability_disabled 语义
        let eval_blocked = cdp_call(
            &mut ext,
            12,
            "Runtime.evaluate",
            json!({ "expression": "1+1" }),
            Some(&session),
        )
        .await;
        let eval_err = eval_blocked["error"]["message"]
            .as_str()
            .expect("evaluate 应被拒绝");
        assert!(
            eval_err.contains("capability_disabled"),
            "经会话面 evaluate 应 capability_disabled，实际 {eval_blocked}"
        );
        let input_blocked = cdp_call(
            &mut ext,
            13,
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": 1, "y": 1, "button": "left", "clickCount": 1 }),
            Some(&session),
        )
        .await;
        assert!(
            input_blocked["error"]["message"]
                .as_str()
                .expect("Input 应被拒绝")
                .contains("capability_disabled"),
            "经会话面 Input 注入应 capability_disabled，实际 {input_blocked}"
        );
        println!("[39] 路径 B（会话面）evaluate/Input 注入被拒（capability_disabled）");

        // 只读面真实放行：快照 / 截图 / console / network
        let snap = cdp_call(
            &mut ext,
            14,
            "DOMSnapshot.captureSnapshot",
            json!({ "computedStyles": ["color"] }),
            Some(&session),
        )
        .await;
        assert!(
            snap.get("error").is_none(),
            "快照只读面应真实放行：{snap}"
        );
        let shot = cdp_call(
            &mut ext,
            15,
            "Page.captureScreenshot",
            json!({ "format": "png" }),
            Some(&session),
        )
        .await;
        assert!(
            shot.get("error").is_none(),
            "截图只读面应真实放行：{shot}"
        );
        assert!(
            shot["result"]["data"].as_str().unwrap_or_default().len() > 100,
            "截图应返回真实 base64 数据"
        );
        let console_on = cdp_call(
            &mut ext,
            16,
            "Runtime.enable",
            json!({}),
            Some(&session),
        )
        .await;
        assert!(
            console_on.get("error").is_none(),
            "console 面 enable 应真实放行：{console_on}"
        );
        let network_on = cdp_call(
            &mut ext,
            17,
            "Network.enable",
            json!({}),
            Some(&session),
        )
        .await;
        assert!(
            network_on.get("error").is_none(),
            "network 面 enable 应真实放行：{network_on}"
        );
        println!("[39] 路径 B（会话面）快照/截图/console/network 只读面全部放行");

        // 事件透传面：页面自打日志 + 自发 fetch → consoleAPICalled /
        // Network.requestWillBeSent 白名单事件经会话面到达外部客户端
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut got_console = false;
        let mut got_network = false;
        while Instant::now() < deadline {
            let resp = tokio::time::timeout(
                Duration::from_millis(500),
                ext.next(),
            )
            .await
            .expect("等待白名单事件超时");
            if let Some(Ok(Message::Text(t))) = resp {
                let v: Value = serde_json::from_str(&t).expect("事件解析失败");
                match v["method"].as_str() {
                    Some("Runtime.consoleAPICalled") => got_console = true,
                    Some("Network.requestWillBeSent") => got_network = true,
                    Some(m) => {
                        panic!("非白名单事件透传到会话面：{m}（fail-closed 被破坏）")
                    }
                    None => {}
                }
            }
            if got_console && got_network {
                break;
            }
        }
        assert!(
            got_console,
            "consoleAPICalled 应经会话面透传（页面自打日志）"
        );
        assert!(
            got_network,
            "Network.requestWillBeSent 应经会话面透传（页面自发 fetch）"
        );
        println!("[39] 路径 B（会话面）console/network 白名单事件真实透传");

        proxy.shutdown().await;
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;

    // 清理：杀受管实例（受管生命周期语义，面板关闭即杀进程）
    let _ = child.kill();
    let _ = child.wait();
    profile.close().ok();
    result.expect("真实 Chrome 探针失败");
}
