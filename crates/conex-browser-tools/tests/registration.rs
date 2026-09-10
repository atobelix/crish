//! 注册面测试（维度 17 T-1 口径 + MCP 命名空间隔离）
//!
//! 断言：注册数精确 23（与实现清单一致）、名称唯一、重注册幂等跳过、
//! 预注册同名跳过、MCP 命名空间共存、门禁配置非法拒绝。

mod common;

use agent_tools::definition::{Tool, ToolDefinition};
use agent_tools::registry::ToolRegistry;
use async_trait::async_trait;
use common::{empty_config, mock_config, MockSession, ALL_TOOL_NAMES};
use conex_browser_tools::register_browser_tools;
use serde_json::json;
use std::sync::Arc;

/// 注册面辅助：空会话配置注册并返回注册表。
fn registry_with(config: conex_browser_tools::BrowserToolsConfig) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    register_browser_tools(&mut registry, config).expect("注册应成功");
    registry
}

/// 注册数精确断言 + 名称清单一致（17 T-1：26 全量 → 当前子集 24）。
#[test]
fn registration_count_and_names_exact() {
    let registry = registry_with(empty_config());
    assert_eq!(
        registry.len(),
        24,
        "工具族应恰好注册 24 个（23 + browser_evaluate，P1-C2）"
    );
    let mut names: Vec<String> = registry
        .list()
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    names.sort();
    let mut expected: Vec<String> = ALL_TOOL_NAMES.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(names, expected, "注册清单必须与实现清单逐项一致");
}

/// 重复注册幂等跳过（17 §1.4）：第二次注册不报冲突、注册数不变。
#[test]
fn registration_twice_is_idempotent() {
    let mut registry = ToolRegistry::new();
    register_browser_tools(&mut registry, empty_config()).expect("首次注册成功");
    register_browser_tools(&mut registry, empty_config()).expect("重复注册应幂等跳过");
    assert_eq!(registry.len(), 24);
    // 无 tool.version_conflict 报错（同名已存在时跳过而非冲突）
    let err = register_browser_tools(&mut registry, empty_config());
    assert!(err.is_ok());
}

/// 预注册同名工具（MCP/引擎预注册场景）：browser_* 同名跳过，不破坏既有工具。
#[test]
fn registration_skips_pre_registered_same_name() {
    let mut registry = ToolRegistry::new();
    registry
        .register_runtime(Arc::new(FakeTool::new("browser_navigate")))
        .expect("预注册");
    register_browser_tools(&mut registry, empty_config()).expect("注册应成功（同名跳过）");
    assert_eq!(
        registry.len(),
        24,
        "预注册同名被跳过，注册数保持 24（23 + evaluate）"
    );
    // 既有工具未被覆盖
    let pre = registry.get("browser_navigate").expect("可查得");
    assert_eq!(pre.definition().description, "预注册替身");
}

/// MCP 命名空间共存（17 §5.1）：mcp_<server>__* 与 browser_* 同注册表无冲突。
#[test]
fn mcp_namespace_coexists_with_browser_tools() {
    let mut registry = ToolRegistry::new();
    registry
        .register_runtime(Arc::new(FakeTool::new("mcp_demo__search")))
        .expect("MCP 工具注册");
    register_browser_tools(&mut registry, empty_config()).expect("浏览器工具注册");
    assert_eq!(registry.len(), 25, "两族工具共存（24 + 1 MCP）");
    assert!(registry.has("mcp_demo__search"));
    assert!(registry.has("browser_navigate"));
    // 模型可见面：list_definitions 含两族且名称无歧义
    let defs = registry.list_definitions();
    assert!(defs.iter().any(|d| d.name == "mcp_demo__search"));
    assert!(defs.iter().any(|d| d.name == "browser_navigate"));
}

/// 名称唯一性 + 全部工具名以 browser_ 前缀开头（命名空间隔离纪律）。
#[test]
fn all_tool_names_unique_and_namespaced() {
    let registry = registry_with(mock_config(&MockSession::new(), true));
    let names: Vec<String> = registry
        .list()
        .iter()
        .map(|t| t.name().to_string())
        .collect();
    let unique: std::collections::HashSet<&String> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "名称必须唯一");
    for name in &names {
        assert!(name.starts_with("browser_"), "命名空间隔离：{name}");
    }
}

/// 门禁配置非法（TLD 通配等）→ 注册期结构化错误（配置校验期报错，17 §4.2）；
/// 白/黑名单同源校验（P0-2 配置入口：domain_allowlist/domain_blocklist）。
#[test]
fn registration_rejects_invalid_gate_patterns() {
    let mut registry = ToolRegistry::new();
    let config = conex_browser_tools::BrowserToolsConfig {
        domain_allowlist: vec!["example.*".to_string()],
        ..empty_config()
    };
    let err = register_browser_tools(&mut registry, config).expect_err("非法模式应拒绝");
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("门禁配置"));
    assert_eq!(registry.len(), 0, "注册失败不得留下半成品工具");
    // 黑名单同源校验（非法模式同样拒绝）
    let mut registry = ToolRegistry::new();
    let config = conex_browser_tools::BrowserToolsConfig {
        domain_blocklist: vec!["*x.example".to_string()],
        ..empty_config()
    };
    let err = register_browser_tools(&mut registry, config).expect_err("黑名单非法模式应拒绝");
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("门禁配置"));
    assert_eq!(registry.len(), 0, "注册失败不得留下半成品工具");
    // 合法模式（子域通配/IP 字面量）放行
    let mut registry = ToolRegistry::new();
    let config = conex_browser_tools::BrowserToolsConfig {
        domain_allowlist: vec!["*.corp.example".to_string(), "127.0.0.1".to_string()],
        ..empty_config()
    };
    register_browser_tools(&mut registry, config).expect("合法模式应注册成功");
    assert_eq!(registry.len(), 24);
}

/// 显式注入门禁优先于 MVP 内置门禁（引擎侧正式实现替换路径）。
#[test]
fn explicit_gate_overrides_builtin() {
    let mut registry = ToolRegistry::new();
    let gate: std::sync::Arc<dyn conex_browser::action::gate::DomainGate> =
        std::sync::Arc::new(AllowGate);
    let config = conex_browser_tools::BrowserToolsConfig {
        gate: Some(gate),
        ..empty_config()
    };
    register_browser_tools(&mut registry, config).expect("显式门禁注入");
    assert_eq!(registry.len(), 24);
}

/// P0-2 默认空列表（R-7 语义：全允许限公共互联网）——注册不受影响；
/// 缺省兜底为正式门禁默认策略：保留段 IP 字面量确定性拒绝（零 DNS，
/// 命令零注入），证明兜底门禁真实生效而非放行替身。
#[tokio::test]
async fn default_empty_lists_register_and_deny_reserved() {
    let mock = MockSession::new();
    let registry = registry_with(mock_config(&mock, true));
    assert_eq!(registry.len(), 24, "默认空配置注册不受影响");
    let ctx = agent_tools::context::create_mock_tool_context();
    let err = registry
        .get("browser_navigate")
        .unwrap()
        .execute(&ctx, json!({ "url": "http://10.0.0.1/" }))
        .await
        .expect_err("保留段字面量应拒绝");
    assert_eq!(err.code(), "tool.browser.gate_blocked", "错误码：{err}");
    assert!(
        err.to_string().contains("保留"),
        "拒绝原因应说明保留段：{err}"
    );
    assert!(
        !mock.calls().iter().any(|c| c.contains("Page.navigate")),
        "拒绝时命令零注入"
    );
}

/// P0-2 白名单非空 = 硬化模式（17 §4.1）：名单外 Deny（零命令注入）；
/// 名单内显式信任跳过解析校验（确定性放行，不依赖 CI DNS）。
/// 经 browser_navigate 全链路（注册面构造 → 导航检查点）验证。
#[tokio::test]
async fn allowlist_hardening_via_config() {
    let mock = MockSession::new();
    let mut config = mock_config(&mock, true);
    config.domain_allowlist = vec!["a.example".to_string()];
    let registry = registry_with(config);
    let ctx = agent_tools::context::create_mock_tool_context();
    let tool = registry.get("browser_navigate").unwrap();
    // 名单外：gate_blocked（硬化模式白名单外 Deny）
    let err = tool
        .execute(&ctx, json!({ "url": "https://b.example/x" }))
        .await
        .expect_err("白名单外应拒绝");
    assert_eq!(err.code(), "tool.browser.gate_blocked", "错误码：{err}");
    assert!(
        !mock.calls().iter().any(|c| c.contains("Page.navigate")),
        "名单外拒绝时命令零注入"
    );
    // 名单内（根域条目含任意子域，R-7）：显式信任跳过解析，确定性放行
    let out = tool
        .execute(&ctx, json!({ "url": "https://a.example/after" }))
        .await
        .expect("白名单内导航应成功（显式信任，零 DNS）");
    assert_eq!(out["url"], "https://a.example/after");
    let navigates = mock
        .calls()
        .iter()
        .filter(|c| c.contains("Page.navigate"))
        .count();
    assert_eq!(navigates, 1, "仅白名单内注入一次导航命令");
}

/// P0-2 黑名单不可豁免（17 §4.2，R-7 定死）：同在白名单内的域名仍 Deny，
/// 黑名单优先于白名单。
#[tokio::test]
async fn blocklist_never_exemptable_via_config() {
    let mock = MockSession::new();
    let mut config = mock_config(&mock, true);
    config.domain_allowlist = vec!["a.example".to_string()];
    config.domain_blocklist = vec!["a.example".to_string()];
    let registry = registry_with(config);
    let ctx = agent_tools::context::create_mock_tool_context();
    let err = registry
        .get("browser_navigate")
        .unwrap()
        .execute(&ctx, json!({ "url": "https://a.example/after" }))
        .await
        .expect_err("黑名单命中不可豁免（含白名单内）");
    assert_eq!(err.code(), "tool.browser.gate_blocked", "错误码：{err}");
    assert!(
        !mock.calls().iter().any(|c| c.contains("Page.navigate")),
        "黑名单拒绝时命令零注入"
    );
}

/// 既有 MvpDomainGate 权线不回退（05 文档方案 A 注入优先）：调用方/引擎
/// 显式注入 MvpDomainGate 实例仍优先于配置列表（config.gate 注入位不变），
/// 注入面行为与配置入口落地前一致。
#[tokio::test]
async fn injected_mvp_gate_still_takes_priority() {
    let mock = MockSession::new();
    let mut config = mock_config(&mock, true);
    // 注入 Mvp 门禁（白名单 a.example）；配置列表与之不一致——注入优先，
    // 配置列表被忽略（若配置生效，a.example 将因列表不含而被拒）
    config.gate = Some(std::sync::Arc::new(
        conex_browser_tools::gate::MvpDomainGate::new(&["a.example".to_string()], &[])
            .expect("Mvp 门禁构造"),
    ));
    config.domain_allowlist = vec!["never.example".to_string()];
    let registry = registry_with(config);
    let ctx = agent_tools::context::create_mock_tool_context();
    let out = registry
        .get("browser_navigate")
        .unwrap()
        .execute(&ctx, json!({ "url": "https://a.example/after" }))
        .await
        .expect("注入门禁白名单命中应放行（注入优先）");
    assert_eq!(out["url"], "https://a.example/after");
}

/// 注册后工具可执行闭环（最小面：not_ready 在空会话下结构化返回）。
#[tokio::test]
async fn registered_tools_execute_not_ready_without_session() {
    let registry = registry_with(empty_config());
    let ctx = agent_tools::context::create_mock_tool_context();
    for name in ALL_TOOL_NAMES {
        let tool = registry.get(name).expect("工具应注册");
        let err = tool
            .execute(&ctx, json!({}))
            .await
            .expect_err("无会话应报错");
        assert_eq!(
            err.code(),
            "tool.browser.not_ready",
            "{name} 无会话应返回 not_ready"
        );
    }
}

/// 简易工具替身（注册面冲突/共存测试用）。
struct FakeTool {
    def: ToolDefinition,
}

impl FakeTool {
    fn new(name: &str) -> Self {
        FakeTool {
            def: ToolDefinition {
                name: name.to_string(),
                description: "预注册替身".to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for FakeTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(
        &self,
        _ctx: &agent_tools::context::ToolContext,
        _args: serde_json::Value,
    ) -> Result<serde_json::Value, agent_tools::definition::ToolError> {
        Ok(json!({ "ok": true }))
    }
}

/// 全放行门禁（显式注入测试用）。
struct AllowGate;

impl conex_browser::action::gate::DomainGate for AllowGate {
    fn check(&self, _url: &str) -> Result<(), conex_browser::action::gate::GateDenial> {
        Ok(())
    }
}
