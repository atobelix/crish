//! 契约测试（防回归）：dangerous 矩阵、schema 合法性、错误契约、能力位红线
//!
//! - dangerous 矩阵：交互 8 全 true，感知/导航/调试 15 全 false（17 §2.1）；
//! - schema 合法性：JSON schema 可解析、必需字段齐全、属性类型合法；
//! - 错误契约：无会话 → 每个工具 `tool.browser.not_ready`（结构与消息断言）；
//! - 急停契约：abort_token 触发 → `tool.browser.cancelled`（先于会话检查）；
//! - 默认拒绝面：upload 能力位未开 → `tool.browser.capability_disabled`
//!   （红线语义，任何模式 Deny，17 §2.3）。

mod common;

use agent_tools::context::create_mock_tool_context;
use common::{empty_config, mock_config, MockSession, ALL_TOOL_NAMES, DANGEROUS_TOOLS};
use conex_browser_tools::register_browser_tools;
use serde_json::Value;

fn registry_with(
    config: conex_browser_tools::BrowserToolsConfig,
) -> agent_tools::registry::ToolRegistry {
    let mut registry = agent_tools::registry::ToolRegistry::new();
    register_browser_tools(&mut registry, config).expect("注册应成功");
    registry
}

/// dangerous 矩阵断言（17 §2.1 分级表：交互 8 全 dangerous，其余 false）。
#[test]
fn dangerous_matrix_exact() {
    let registry = registry_with(empty_config());
    for name in ALL_TOOL_NAMES {
        let def = registry.get(name).expect("工具应注册").definition().clone();
        let expected = DANGEROUS_TOOLS.contains(&name);
        assert_eq!(
            def.dangerous, expected,
            "工具 {name} 危险分级应为 {expected}"
        );
        assert!(!def.fatal_on_error, "{name} fatalOnError 默认 false");
    }
}

/// schema 合法性：JSON 可解析、type=object、properties 为对象、
/// required 数组元素均存在于 properties、additionalProperties=false。
#[test]
fn every_tool_schema_is_valid() {
    let registry = registry_with(empty_config());
    for name in ALL_TOOL_NAMES {
        let def = registry.get(name).expect("工具应注册").definition().clone();
        assert_eq!(def.name, name, "definition.name 与注册键一致");
        let schema = def
            .input_schema
            .as_object()
            .unwrap_or_else(|| panic!("{name} input_schema 必须是 JSON 对象"));
        assert_eq!(
            schema.get("type").and_then(Value::as_str),
            Some("object"),
            "{name} schema type"
        );
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .unwrap_or_else(|| panic!("{name} 缺 properties 对象"));
        assert!(
            !schema
                .get("additionalProperties")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            "{name} additionalProperties 必须为 false"
        );
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required {
                let key = key
                    .as_str()
                    .unwrap_or_else(|| panic!("{name} required 元素须为字符串"));
                assert!(
                    properties.contains_key(key),
                    "{name} required 字段 {key} 必须存在于 properties"
                );
            }
        }
        for (key, spec) in properties {
            let spec = spec
                .as_object()
                .unwrap_or_else(|| panic!("{name}.{key} 属性规范须为对象"));
            let ty = spec
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{name}.{key} 缺 type"));
            assert!(
                matches!(ty, "string" | "number" | "boolean" | "array" | "object"),
                "{name}.{key} type 非法：{ty}"
            );
        }
    }
}

/// 工具名/定义一致性（Tool::name == definition().name，注册键一致）。
#[test]
fn name_definition_consistent() {
    let registry = registry_with(empty_config());
    for tool in registry.list() {
        assert_eq!(tool.name(), &tool.definition().name);
    }
}

/// 定义序列化面（provider 载荷 camelCase 形状）。
#[test]
fn definitions_serialize_for_provider() {
    let registry = registry_with(empty_config());
    let defs = registry.list_definitions();
    assert_eq!(defs.len(), 24); // 23 + browser_evaluate（P1-C2）
    for def in &defs {
        let v = serde_json::to_value(def).expect("可序列化");
        assert_eq!(v["name"], def.name.as_str());
        assert_eq!(v["inputSchema"]["type"], "object");
        assert_eq!(v["dangerous"], def.dangerous);
    }
}

/// 错误契约：无会话时每个工具（合法空参）返回 tool.browser.not_ready，
/// 错误码字符串与结构断言。
#[tokio::test]
async fn every_tool_not_ready_without_session() {
    let registry = registry_with(empty_config());
    let ctx = create_mock_tool_context();
    for name in ALL_TOOL_NAMES {
        let tool = registry.get(name).expect("工具应注册");
        let err = tool
            .execute(&ctx, serde_json::json!({}))
            .await
            .expect_err("无会话应报错");
        assert_eq!(err.code(), "tool.browser.not_ready", "{name}");
        // 结构：payload 出站面可序列化且码值正确
        let payload = err.to_error_payload(0);
        assert_eq!(payload.code, "tool.browser.not_ready", "{name} 载荷码值");
        assert!(!err.to_string().is_empty(), "{name} 消息非空");
    }
}

/// 急停契约：abort_token 触发 → cancelled（先于会话检查，17 §6.4 ①）。
#[tokio::test]
async fn aborted_context_returns_cancelled_before_session_check() {
    let registry = registry_with(empty_config());
    let ctx = create_mock_tool_context();
    ctx.abort_token.abort();
    let tool = registry.get("browser_get_url").expect("工具应注册");
    let err = tool
        .execute(&ctx, serde_json::json!({}))
        .await
        .expect_err("急停应报错");
    assert_eq!(err.code(), "tool.browser.cancelled");
}

/// 默认拒绝面：upload 能力位未开 → capability_disabled（红线语义，先于参数校验）。
#[tokio::test]
async fn upload_capability_disabled_is_hard_gate() {
    let mock = MockSession::new();
    let registry = registry_with(mock_config(&mock, false));
    let ctx = create_mock_tool_context();
    let tool = registry.get("browser_upload").expect("工具应注册");
    let err = tool
        .execute(&ctx, serde_json::json!({ "ref": 1, "files": ["a.txt"] }))
        .await
        .expect_err("能力位未开应 Deny");
    assert_eq!(err.code(), "tool.browser.capability_disabled");
    // 红线语义：任何参数（含空参）都直接 Deny，不落参数校验
    let err2 = tool
        .execute(&ctx, serde_json::json!({}))
        .await
        .expect_err("能力位未开空参也应 Deny");
    assert_eq!(err2.code(), "tool.browser.capability_disabled");
    // 无任何命令发出（零副作用）
    assert!(mock.calls().is_empty(), "Deny 面不得发出命令");
}

/// 能力位开启后 upload 进入正常路径（mock 成功路径在此验证参数透传）。
#[tokio::test]
async fn upload_capability_enabled_proceeds() {
    let mock = MockSession::new();
    let registry = registry_with(mock_config(&mock, true));
    let mut ctx = create_mock_tool_context();
    let dir = tempfile::tempdir().expect("临时目录");
    std::fs::write(dir.path().join("a.txt"), "x").expect("写文件");
    ctx.workspace_root = dir.path().to_path_buf();
    let tool = registry.get("browser_upload").expect("工具应注册");
    let out = tool
        .execute(&ctx, serde_json::json!({ "ref": 1, "files": ["a.txt"] }))
        .await
        .expect("能力位开启应执行");
    assert_eq!(out["ok"], true);
    assert_eq!(out["files"][0], "a.txt");
    mock.assert_recorded("primitive=Upload");
}

/// 未接线面：select_option 的 label/index → tool.browser.unwired。
#[tokio::test]
async fn select_option_label_index_unwired() {
    let mock = MockSession::new();
    let registry = registry_with(mock_config(&mock, true));
    let ctx = create_mock_tool_context();
    for args in [
        serde_json::json!({ "ref": 1, "label": "选项A" }),
        serde_json::json!({ "ref": 1, "index": 2 }),
    ] {
        let tool = registry.get("browser_select_option").expect("工具应注册");
        let err = tool.execute(&ctx, args).await.expect_err("未接线应报错");
        assert_eq!(err.code(), "tool.browser.unwired");
    }
}

/// 快照引用契约：无缓存快照/索引缺失的错误码由会话层语义承担——
/// mock 恒返回 Some，此处验证索引解析进入执行器（参数透传在 success_paths）。
#[tokio::test]
async fn click_resolves_element_and_returns_snapshot_version() {
    let mock = MockSession::new();
    let registry = registry_with(mock_config(&mock, true));
    let ctx = create_mock_tool_context();
    let tool = registry.get("browser_click").expect("工具应注册");
    let out = tool
        .execute(&ctx, serde_json::json!({ "ref": 5 }))
        .await
        .expect("mock 成功路径");
    assert_eq!(out["ok"], true);
    assert_eq!(out["snapshotVersion"], 7);
    mock.assert_recorded("element=Some(ElementRef { index: 5, backend_node_id: 42 })");
    mock.assert_recorded("primitive=Click { button: Left, count: 1 }");
}

/// 管线顺序：急停 → 会话就绪 → 参数解析。急停时非法参数也返回 cancelled。
#[tokio::test]
async fn pipeline_estop_precedes_arg_validation() {
    let mock = MockSession::new();
    let registry = registry_with(mock_config(&mock, true));
    let ctx = create_mock_tool_context();
    ctx.abort_token.abort();
    let tool = registry.get("browser_navigate").expect("工具应注册");
    let err = tool
        .execute(&ctx, serde_json::json!({}))
        .await
        .expect_err("急停优先");
    assert_eq!(err.code(), "tool.browser.cancelled");
}
