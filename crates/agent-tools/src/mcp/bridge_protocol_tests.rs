//! bridge_protocol · 测试旁挂（SR-06a-6 拆分；经 `bridge_protocol.rs`
//! `#[path]` 接线，无孤儿）
//!
//! 全部既有测试原样迁移（零删除、零合并）：名称前缀与净化、工具列表
//! 适配回退、缺 name 协议违规、调用结果 text/structured 拼接与 isError
//! 映射、JSON-RPC 错误映射、默认调用超时。
//! 诚实边界：仅结构拆分，语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use super::*;
use serde_json::json;

#[test]
fn mcp_tool_name_prefixes_and_sanitizes() {
    let name_files = mcp_tool_name("files", "read");
    assert!(name_files.starts_with("mcp_files_"));
    assert!(name_files.ends_with("__read"));

    let name_server = mcp_tool_name("my.server", "read");
    assert!(name_server.starts_with("mcp_my_server_"));
    assert!(name_server.ends_with("__read"));

    assert_eq!(sanitize_id_part("ok-name_1"), "ok-name_1");
}

/// 命名空间哈希防碰撞测试（对齐 06A §5.1.2）
#[test]
fn test_mcp_tool_name_hashing_collision_free() {
    let name_dot = format_mcp_tool_name("my.server", "read");
    let name_under = format_mcp_tool_name("my_server", "read");
    assert_ne!(name_dot, name_under, "不同 server_id 绝对不能产生相同的名称");
    assert!(name_dot.starts_with("mcp_my_server_"));
    assert!(name_under.starts_with("mcp_my_server_"));
    assert!(name_dot.ends_with("__read"));
    assert!(name_under.ends_with("__read"));

    let name_dash = format_mcp_tool_name("test-mcp", "calc");
    let name_under2 = format_mcp_tool_name("test_mcp", "calc");
    assert_ne!(name_dash, name_under2, "test-mcp 与 test_mcp 绝对不碰撞");
}

#[test]
fn adapt_tool_list_builds_prefixed_defs() {
    let tools = vec![
        McpToolInfo {
            name: "read".to_string(),
            description: "读文件".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        // 缺 description / inputSchema：回退默认
        McpToolInfo {
            name: "write".to_string(),
            description: String::new(),
            input_schema: Value::Null,
        },
    ];
    let defs = adapt_tool_list("files", &tools);
    let expected_read_name = format_mcp_tool_name("files", "read");
    let expected_write_name = format_mcp_tool_name("files", "write");

    assert_eq!(defs.len(), 2);
    assert_eq!(defs[0].name, expected_read_name);
    assert_eq!(defs[0].description, "读文件");
    assert_eq!(
        defs[0].input_schema,
        json!({ "type": "object", "properties": {} })
    );
    assert_eq!(defs[1].name, expected_write_name);
    assert_eq!(
        defs[1].input_schema,
        json!({ "type": "object", "properties": {}, "additionalProperties": true })
    );
    assert!(!defs[0].dangerous);
    // 序列化 camelCase，可作为注册表工具列表载荷
    let value = serde_json::to_value(&defs[0]).unwrap();
    assert_eq!(value["name"], expected_read_name);
    assert_eq!(
        value["inputSchema"],
        json!({ "type": "object", "properties": {} })
    );
}

#[test]
fn parse_tool_info_requires_name() {
    let err = parse_tool_info(&json!({ "description": "无名字" })).unwrap_err();
    assert_eq!(err.code(), "mcp.protocol_violation");
    let info = parse_tool_info(&json!({ "name": "t" })).unwrap();
    assert_eq!(info.name, "t");
    assert!(info.description.is_empty());
    assert_eq!(
        info.input_schema,
        json!({ "type": "object", "properties": {}, "additionalProperties": true })
    );
}

#[test]
fn adapt_call_result_concats_text_and_structured() {
    let result = json!({
        "content": [
            { "type": "text", "text": "第一段" },
            { "type": "text", "text": "第二段" },
            { "type": "image", "data": "abc" }
        ],
        "structuredContent": { "sum": 3 },
        "isError": false
    });
    let out = adapt_call_result(&result, "mcp_s__add").unwrap();
    assert_eq!(out["text"], "第一段\n第二段");
    assert_eq!(out["json"], json!({ "sum": 3 }));
    assert_eq!(out["isError"], false);
    // content 原样透传
    assert_eq!(out["content"].as_array().unwrap().len(), 3);
}

#[test]
fn adapt_call_result_is_error_maps_to_execution_failed() {
    let result = json!({
        "content": [{ "type": "text", "text": "boom 失败" }],
        "isError": true
    });
    let err = adapt_call_result(&result, "mcp_s__boom").unwrap_err();
    assert_eq!(err.code(), "tool.execution_failed");
    assert!(err.to_string().contains("boom 失败"));
    // 无 text 时的兜底消息
    let err = adapt_call_result(&json!({ "isError": true }), "mcp_s__boom").unwrap_err();
    assert!(err.to_string().contains("isError=true"));
}

#[test]
fn adapt_call_result_empty_result_ok() {
    let out = adapt_call_result(&json!({}), "mcp_s__x").unwrap();
    assert!(out.get("text").is_none());
    assert!(out.is_object());
}

#[test]
fn response_result_maps_json_rpc_error() {
    let err = response_result(
        "s1",
        json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "方法不存在" } }),
    )
    .unwrap_err();
    assert_eq!(err.code(), "mcp.protocol_violation");
    assert!(err.to_string().contains("方法不存在"));

    let err = response_result("s1", json!({ "jsonrpc": "2.0", "id": 1 })).unwrap_err();
    assert_eq!(err.code(), "mcp.protocol_violation");

    let result = response_result(
        "s1",
        json!({ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }),
    )
    .unwrap();
    assert_eq!(result["ok"], true);
}

#[test]
fn default_call_timeout_is_30_seconds() {
    assert_eq!(DEFAULT_MCP_CALL_TIMEOUT, Duration::from_secs(30));
}
