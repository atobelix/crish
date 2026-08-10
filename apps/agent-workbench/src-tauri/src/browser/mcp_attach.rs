//! MCP attach 消费接线（34-MCPattach验证.md §5.2 E-1/E-2/E-4，R-12）
//!
//! 本模块是「外部浏览器类 MCP（chrome-devtools-mcp 族）经 `--browserUrl`
//! 附加受管实例 CDP 端点」的 **browser 域消费面**（引擎侧 MCP 桥所在
//! 的 agent-tools 与会话装配所在 engine.rs 均为并行域，本任务只登记接线点，
//! 消费代码落在本模块与 [super::BrowserSlot]）。
//!
//! ## E-1 端点暴露守卫（消费 `BrowserToolsConfig.mcp_attach_allowed`）
//! - 会话级开关默认关闭（R-12 安全默认，34 §5.1）；关闭时**端点信息零暴露**
//!   ——[attach_exposure_decision] 结构化拒绝 `tool.browser.capability_disabled`
//!   （红线语义：未显式授权不向任何外部 MCP 暴露受管端点，任何进程状态下
//!   都不返回端点）；
//! - 开启且受管实例就绪时返回 [McpAttachEndpoint]：`--browserUrl` 注入形态
//!   `http://127.0.0.1:<port>`（34 §5.2 E-1）+ 自研客户端同端点 ws 串；
//! - 开关装配面：`BrowserSlot::with_mcp_attach_allowed`（默认 false）。
//!
//! ## E-2 spawn 分派（Windows `cmd /c npx` 硬约束）
//! 34 §4.2 实测：Windows 下 `npx` 是 `npx.cmd`（非 PE 可执行），
//! `Command::new("npx")` spawn 返回 NotFound；必须 `cmd /c npx` 分派。
//! MCP 桥 spawn（agent-tools `mcp/bridge.rs` `McpServerSession::spawn`，
//! 并行域）直接 `Command::new(&config.command)`——桥不改动，本模块在
//! **配置面**完成分派：Windows → `command="cmd"` + args
//! `["/c","npx",…]`；非 Windows → `command="npx"`（[mcp_npx_spawn] /
//! [mcp_attach_server_config]）。
//!
//! ## E-4 工具注册（既有桥，零改动）
//! 已读桥 API 确认参数注入面：`McpServerConfig` 含 `command/args/env`
//! （servers.rs）与 `register_plugin_server`（mcp/mod.rs）→ 桥 `start`
//! （bridge.rs spawn 处 `Command::new(command).args(&args).envs(&env)`）
//! ——browserUrl 型 server 是纯 `--browserUrl` 参数注入，桥无需改动；
//! 引擎侧消费入口 `Engine::register_plugin_mcp_server(config)`
//! （engine.rs，并行域）即该注入面的承载。
//! 验证方法（34 §3.3 实测背书）：`cargo test -p conex-browser-tools --test
//! mcp_attach -- --ignored`——需本机 Chrome + npx + 网络；断言受管实例
//! attach 握手、29 工具枚举、`mcp_<server>__*` 命名空间隔离、只读工具
//! 经 adapter 执行。

use agent_tools::definition::ToolError;
use agent_tools::mcp::McpServerConfig;
use conex_browser::CdpEndpoint;
use conex_browser_tools::codes::{TOOL_BROWSER_CAPABILITY_DISABLED, TOOL_BROWSER_NOT_READY};
use std::fmt;

/// attach 型 MCP 端点暴露载荷（E-1 注入形态）。
///
/// 端口与 ws_path 为 DevToolsActivePort 双层不透明 token（34 §4.1），
/// Debug 输出按 10 §7.3 硬要求脱敏（端口与 path 不落日志）。
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct McpAttachEndpoint {
    /// DevToolsActivePort 随机端口（双层不透明 token 之一）。
    pub port: u16,
    /// `--browserUrl` 注入形态：`http://127.0.0.1:<port>`（34 §5.2 E-1）。
    pub browser_url: String,
    /// 自研客户端同端点连接串（`ws://127.0.0.1:<port>/<ws_path>`）。
    pub ws_url: String,
}

impl fmt::Debug for McpAttachEndpoint {
    /// Debug 输出脱敏（对齐 CdpEndpoint：端口与 path 不落日志，10 §7.3）。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("McpAttachEndpoint { <redacted> }")
    }
}

/// 端点暴露守卫判定（E-1 消费面；纯函数，测试注入开关 × 端点双态）。
///
/// 判定序：**开关先行**——关闭即拒绝（零暴露，端点存在与否都不返回，
/// R-12 红线：未显式授权不向外部 MCP 暴露受管端点信息，34 §5.2 E-1）；
/// 开关开启 + 无端点 → 结构化 `tool.browser.not_ready`（未启动/恢复期）；
/// 开关开启 + 有端点 → 放行注入形态载荷。
pub(crate) fn attach_exposure_decision(
    allowed: bool,
    endpoint: Option<&CdpEndpoint>,
) -> Result<McpAttachEndpoint, ToolError> {
    if !allowed {
        return Err(ToolError::new(
            TOOL_BROWSER_CAPABILITY_DISABLED,
            "MCP attach 未开启（会话级开关默认关闭）：不向外部 MCP 暴露受管浏览器端点",
        ));
    }
    let Some(ep) = endpoint else {
        return Err(ToolError::new(
            TOOL_BROWSER_NOT_READY,
            "浏览器端点不可用（未启动/恢复期），attach 端点注入暂不可用",
        ));
    };
    Ok(McpAttachEndpoint {
        port: ep.port,
        browser_url: format!("http://127.0.0.1:{}", ep.port),
        ws_url: ep.url(),
    })
}

/// npx spawn 分派（E-2，34 §4.2 实测硬约束）。
///
/// Windows：`cmd /c <program> <args…>`（npx 是 npx.cmd，非 PE 可执行，
/// `Command::new("npx")` spawn → NotFound）；非 Windows：`<program> <args…>`
/// 直连。`windows` 为平台注入面——调用方传 `cfg!(windows)`；测试注入假平台
/// 与假 program（fake-npx）验证 `cmd /c` 分派形态，不依赖本机 npx。
#[allow(dead_code)] // E-2 接线登记：engine.rs spawn 配置面消费（34 §5.2 E-2），接线后移除
pub(crate) fn mcp_npx_spawn(windows: bool, program: &str, args: &[&str]) -> (String, Vec<String>) {
    if windows {
        let mut all = Vec::with_capacity(args.len() + 2);
        all.push("/c".to_string());
        all.push(program.to_string());
        all.extend(args.iter().map(|s| s.to_string()));
        ("cmd".to_string(), all)
    } else {
        (
            program.to_string(),
            args.iter().map(|s| s.to_string()).collect(),
        )
    }
}

/// 构建 attach 型浏览器类 MCP server 的启动配置（E-1/E-2 注入形态：
/// `--browserUrl <url>` 写入 args；Windows 经 `cmd /c` 分派，34 §3.3 实测
/// 形态：`McpServerConfig::new("browser-mcp", "cmd").with_args(["/c", "npx",
/// "-y", "chrome-devtools-mcp", "--browserUrl", url])`）。
///
/// 包名：**`chrome-devtools-mcp`**（34 §2 包名发现：官方现包名，旧
/// `@google/chrome-devtools-mcp` 在 npm registry 已 404，勿用）。
#[allow(dead_code)] // E-1/E-2 接线登记：engine.rs MCP spawn 面消费（34 §5.2 E-1/E-2），接线后移除
pub(crate) fn mcp_attach_server_config(
    server_id: &str,
    browser_url: &str,
    windows: bool,
) -> McpServerConfig {
    let (command, args) = mcp_npx_spawn(
        windows,
        "npx",
        &["-y", "chrome-devtools-mcp", "--browserUrl", browser_url],
    );
    McpServerConfig::new(server_id, command).with_args(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 样例端点（DevToolsActivePort 形态：随机端口 + per-session UUID 路径）。
    fn sample_endpoint() -> CdpEndpoint {
        CdpEndpoint {
            port: 41352,
            ws_path: "/devtools/browser/ff54f1af-df6f-4b6f-af93-80ee9fc926fa".to_string(),
        }
    }

    /// R-12 守卫：开关关闭（默认）→ 结构化拒绝 `tool.browser.capability_disabled`
    /// （**端点零暴露**：即使运行中端点存在也不返回——未显式授权不向外部
    /// MCP 暴露受管端点信息，34 §5.2 E-1）。
    #[test]
    fn guard_default_off_denies_even_with_endpoint() {
        let err = attach_exposure_decision(false, Some(&sample_endpoint())).unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_CAPABILITY_DISABLED);
        let err = attach_exposure_decision(false, None).unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_CAPABILITY_DISABLED);
    }

    /// 守卫放行面：开关开 + 端点存在 → 注入形态载荷（browserUrl 端口一致、
    /// ws 串同源）；开关开 + 无端点 → 结构化 `tool.browser.not_ready`。
    #[test]
    fn guard_allowed_exposes_endpoint_when_ready() {
        let ep = attach_exposure_decision(true, Some(&sample_endpoint())).expect("开启且就绪应放行");
        assert_eq!(ep.port, 41352);
        assert_eq!(ep.browser_url, "http://127.0.0.1:41352");
        assert_eq!(
            ep.ws_url,
            "ws://127.0.0.1:41352/devtools/browser/ff54f1af-df6f-4b6f-af93-80ee9fc926fa"
        );
        let err = attach_exposure_decision(true, None).unwrap_err();
        assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
    }

    /// E-2 Windows 分派：npx 必须经 `cmd /c`（34 §4.2 实测：Windows 直接
    /// `spawn("npx")` → NotFound）；注入假 npx（fake-npx）验证 `cmd /c`
    /// 分派形态——不依赖本机 npx，任意平台可测。
    #[test]
    fn windows_dispatch_wraps_with_cmd_c() {
        let (command, args) = mcp_npx_spawn(true, "npx", &["-y", "pkg"]);
        assert_eq!(command, "cmd");
        assert_eq!(
            args,
            ["/c", "npx", "-y", "pkg"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
        let (command, args) = mcp_npx_spawn(true, "fake-npx", &["--flag"]);
        assert_eq!(command, "cmd");
        assert_eq!(
            args,
            ["/c", "fake-npx", "--flag"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
    }

    /// E-2 非 Windows：npx 直连（无 cmd 包装）。
    #[test]
    fn non_windows_dispatch_uses_program_directly() {
        let (command, args) = mcp_npx_spawn(false, "npx", &["-y", "pkg"]);
        assert_eq!(command, "npx");
        assert_eq!(
            args,
            ["-y", "pkg"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
    }

    /// E-1/E-2 注入形态：browserUrl 型 server 配置（Windows `cmd /c` +
    /// 包名 `chrome-devtools-mcp` + `--browserUrl`；非 Windows npx 直连），
    /// 且配置面合法（`validate` 通过——桥可直接消费，E-4 零改动背书）。
    #[test]
    fn attach_server_config_injects_browser_url() {
        let url = "http://127.0.0.1:41352";
        let win = mcp_attach_server_config("browser-mcp", url, true);
        assert_eq!(win.server_id, "browser-mcp");
        assert_eq!(win.command, "cmd");
        assert_eq!(
            win.args,
            ["/c", "npx", "-y", "chrome-devtools-mcp", "--browserUrl", url]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
        win.validate().expect("Windows 形态配置应合法");
        let unix = mcp_attach_server_config("browser-mcp", url, false);
        assert_eq!(unix.command, "npx");
        assert_eq!(
            unix.args,
            ["-y", "chrome-devtools-mcp", "--browserUrl", url]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
        unix.validate().expect("非 Windows 形态配置应合法");
    }

    /// 载荷 Debug 脱敏（10 §7.3 硬要求：端口与 path 不落日志）。
    #[test]
    fn endpoint_debug_is_redacted() {
        let ep = attach_exposure_decision(true, Some(&sample_endpoint())).expect("放行");
        let dbg = format!("{ep:?}");
        assert_eq!(dbg, "McpAttachEndpoint { <redacted> }");
        assert!(!dbg.contains("41352"), "Debug 不得含端口");
        assert!(!dbg.contains("devtools"), "Debug 不得含 ws_path");
    }
}
