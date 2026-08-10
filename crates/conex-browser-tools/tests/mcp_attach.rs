//! MCP attach 集成验证（R-12 / 17 §5.3，T-12 口径）
//!
//! 真实环境验证（`#[ignore]`：需要本机 Chrome + npx + 网络拉包，CI 默认不跑）：
//! 1. 启动受管实例（随机端口 + DevToolsActivePort 解析，维度 10 §5）；
//! 2. 经既有 MCP 桥 `register_plugin_server` + `McpServerConfig::new("browser-mcp", "npx")`
//!    `.with_args(["-y", "chrome-devtools-mcp", "--browserUrl", url])` 拉起外部浏览器类
//!    MCP（chrome-devtools-mcp 族）附加同一 CDP 端点；
//! 3. 断言工具枚举（`mcp_<server>__*` 命名空间隔离，17 §5.1）与只读面调用
//!    （take_snapshot / list_console_messages）。
//!
//! 运行：`cargo test -p conex-browser-tools --test mcp_attach -- --ignored --nocapture`
//! 环境变量：`CONEX_TEST_CHROME` 覆盖 Chrome 路径（缺省探测系统安装路径）。

use agent_tools::context::create_mock_tool_context;
use agent_tools::mcp::{register_plugin_server, McpClientBridge, McpServerConfig};
use agent_tools::registry::ToolRegistry;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// 探测 Chrome 可执行文件（CONEX_TEST_CHROME 优先，其次常见安装路径）。
fn find_chrome() -> PathBuf {
    if let Ok(p) = std::env::var("CONEX_TEST_CHROME") {
        if Path::new(&p).exists() {
            return PathBuf::from(p);
        }
    }
    let candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Chromium\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    for c in candidates {
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
    panic!("未找到 Chrome/Chromium（受管实例验证前置），请设置 CONEX_TEST_CHROME");
}

/// 启动受管实例（`--remote-debugging-port=0` 随机端口 + 全新 profile），
/// 轮询 DevToolsActivePort（维度 10 §5.2 语义），返回 (子进程, 端口)。
// G2 禁令豁免（clippy.toml disallowed-methods）：`#[ignore]` 验证专用辅助，
// spawn 仅拉起受管 Chrome 实例（固定启动参数，无用户自由参数），
// 调用方（mcp_attach_readonly_flow）保证 kill + wait 清理。
#[allow(clippy::disallowed_methods)]
fn spawn_managed_instance(chrome: &Path, profile: &Path) -> (Child, u16) {
    let mut child = Command::new(chrome)
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
                return (child, port);
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

/// Windows 下 `npx` 为 `npx.cmd`（PE 非可执行），Rust 直接 spawn("npx") 的行为探测：
/// 结论进验证报告（34-MCPattach验证.md），不影响本测试主路径（cmd /c 包裹）。
// G2 禁令豁免（clippy.toml disallowed-methods）：本测试为 `#[ignore]` 验证专用
// （CI 主链路不跑），spawn/output 参数为固定探测命令与探测路径、无用户自由参数，
// 进程生命周期受测试控制并清理——对齐既有豁免面「测试拉起验证子进程」精神，
// 不经命令门禁（探测对象即门禁目标本身）。
#[test]
#[ignore]
#[allow(clippy::disallowed_methods)]
fn probe_windows_npx_spawn_behavior() {
    let direct = Command::new("npx").arg("--version").output();
    println!(
        "[probe] Command::new(\"npx\") spawn：{:?}",
        direct
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .map_err(|e| e.kind())
    );
    let wrapped = Command::new("cmd")
        .args(["/c", "npx", "--version"])
        .output();
    println!(
        "[probe] Command::new(\"cmd\") /c npx spawn：{:?}",
        wrapped
            .as_ref()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .map_err(|e| e.kind())
    );
    // Windows 直接 spawn 失败 → 引擎侧接线须用 cmd /c 或 npx.cmd（登记接线点）
    if cfg!(windows) {
        assert!(
            direct.is_err(),
            "Windows 直接 spawn npx 预期失败（.cmd 非 PE），若此断言翻转说明环境变化，需重审接线点"
        );
    }
    assert!(
        wrapped.is_ok(),
        "cmd /c npx 应可用（McpServerConfig 接线形态）"
    );
}

/// 受管实例 + 外部浏览器类 MCP attach 全链路（T-12 口径）。
// G2 禁令豁免（clippy.toml disallowed-methods）：`#[ignore]` 验证专用测试，
// spawn 仅拉起受管 Chrome 实例（参数为固定启动参数，无用户自由参数），
// 进程在 finally 语义下 kill + wait 清理，不经命令门禁（受管实例由本测试
// 自建，非生产子进程面）。
#[tokio::test]
#[ignore]
#[allow(clippy::disallowed_methods)]
async fn mcp_attach_readonly_flow() {
    let chrome = find_chrome();
    let profile = tempfile::tempdir().expect("临时 profile 目录");
    let (mut chrome_child, port) = spawn_managed_instance(&chrome, profile.path());
    let result = async {
        // 与既有桥同构的接线形态：McpServerConfig::new("browser-mcp", "npx")
        //   .with_args(["-y", "chrome-devtools-mcp", "--browserUrl", url])
        // Windows：npx 为 .cmd，经 cmd /c 包裹（探测结论见 probe_windows_npx_spawn_behavior）
        let (command, mut args) = if cfg!(windows) {
            (
                String::from("cmd"),
                vec![String::from("/c"), String::from("npx")],
            )
        } else {
            (String::from("npx"), Vec::new())
        };
        args.extend([
            String::from("-y"),
            String::from("chrome-devtools-mcp"),
            String::from("--browserUrl"),
            format!("http://127.0.0.1:{port}"),
        ]);
        let config = McpServerConfig::new("browser-mcp", command).with_args(args);
        let bridge = McpClientBridge::new();
        let registry = ToolRegistry::new();
        let defs = register_plugin_server(&bridge, &registry, &config)
            .await
            .expect("经既有桥拉起 chrome-devtools-mcp 并枚举工具失败");

        // 工具枚举：命名空间隔离断言（mcp_<server>__*）
        assert!(
            defs.len() >= 20,
            "chrome-devtools-mcp 工具应 ≥20 个（实际 {}）",
            defs.len()
        );
        let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        println!("[mcp] 枚举 {} 个工具：{names:?}", names.len());
        for name in &names {
            assert!(
                name.starts_with("mcp_browser-mcp__"),
                "命名空间隔离：{name}"
            );
        }
        assert!(
            names.contains(&"mcp_browser-mcp__take_snapshot"),
            "只读快照工具应存在"
        );
        assert!(
            names.contains(&"mcp_browser-mcp__list_console_messages"),
            "只读控制台工具应存在"
        );
        assert!(
            names.contains(&"mcp_browser-mcp__evaluate_script"),
            "求值工具应存在（R-12 拒绝面由引擎侧能力集负责）"
        );
        assert!(
            names.contains(&"mcp_browser-mcp__click"),
            "交互工具应存在（R-12 审批面）"
        );

        // 只读面调用：take_snapshot（无入参缺省快照）
        let snapshot_tool = bridge
            .get_adapter("browser-mcp", "mcp_browser-mcp__take_snapshot")
            .expect("快照工具适配器");
        let ctx = create_mock_tool_context();
        let out = snapshot_tool
            .execute(&ctx, json!({}))
            .await
            .expect("take_snapshot 应执行成功（只读面）");
        let text = out.get("text").and_then(|v| v.as_str()).unwrap_or_default();
        println!(
            "[mcp] take_snapshot → {}",
            text.chars().take(120).collect::<String>()
        );
        assert!(
            text.contains("snapshot") || text.contains("uid"),
            "快照输出应含快照树（实际：{}）",
            text.chars().take(80).collect::<String>()
        );

        // 只读面调用：list_console_messages
        let console_tool = bridge
            .get_adapter("browser-mcp", "mcp_browser-mcp__list_console_messages")
            .expect("控制台工具适配器");
        let out = console_tool
            .execute(&ctx, json!({}))
            .await
            .expect("list_console_messages 应执行成功（只读面）");
        println!("[mcp] list_console_messages → {}", out);
        Ok::<(), Box<dyn std::error::Error>>(())
    }
    .await;

    // 清理：杀受管实例（受管生命周期语义，面板关闭即杀进程）
    let _ = chrome_child.kill();
    let _ = chrome_child.wait();
    profile.close().ok();
    result.expect("attach 验证链失败");
}
