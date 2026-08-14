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
    assert_eq!(mcp_tool_name("files", "read"), "mcp_files__read");
    assert_eq!(mcp_tool_name("my.server", "read"), "mcp_my_server__read");
    assert_eq!(mcp_tool_name("a b.c!", "x-y"), "mcp_a_b_c___x-y");
    assert_eq!(sanitize_id_part("ok-name_1"), "ok-name_1");
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
    assert_eq!(defs.len(), 2);
    assert_eq!(defs[0].name, "mcp_files__read");
    assert_eq!(defs[0].description, "读文件");
    assert_eq!(defs[0].input_schema, json!({ "type": "object", "properties": {} }));
    assert_eq!(defs[1].name, "mcp_files__write");
    assert_eq!(
        defs[1].input_schema,
        json!({ "type": "object", "properties": {}, "additionalProperties": true })
    );
    assert!(!defs[0].dangerous);
    // 序列化 camelCase，可作为注册表工具列表载荷
    let value = serde_json::to_value(&defs[0]).unwrap();
    assert_eq!(value["name"], "mcp_files__read");
    assert_eq!(value["inputSchema"], json!({ "type": "object", "properties": {} }));
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

    let result = response_result("s1", json!({ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } }))
        .unwrap();
    assert_eq!(result["ok"], true);
}

#[test]
fn default_call_timeout_is_30_seconds() {
    assert_eq!(DEFAULT_MCP_CALL_TIMEOUT, Duration::from_secs(30));
}
