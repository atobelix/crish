//! request/build_gemini.rs 测试旁挂（战役 R2 · T2.1b；SR-06e · 经 #[path] 接线，非直接 mod）
//!
//! 验收断言覆盖：
//! 1. mock 请求 → 请求体断言：contents 角色映射 / systemInstruction /
//!    functionCall+functionResponse 配对 / maxOutputTokens / thinking_level（思考启用）
//! 2. 头断言：x-goog-api-key 存在 + content-type
//! 3. 思考关闭（Off）时请求体不含 thinking 相关键
//! 4. tools → functionDeclarations + toolConfig；同工具名去重

use super::*;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::SystemPromptWireMode;
use conex_types::tool::ToolOutput;
use serde_json::json;
use std::sync::Arc;

// ── 测试构造 ──

fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text {
        text: text.to_string(),
    }
}

fn message(role: AgentMessageRole, id: &str, blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    AgentMessage {
        id: id.to_string(),
        role,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks,
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn user_msg(text: &str) -> AgentMessage {
    message(AgentMessageRole::User, "u1", vec![text_block(text)])
}

fn assistant_text(text: &str) -> AgentMessage {
    message(AgentMessageRole::Assistant, "a1", vec![text_block(text)])
}

fn assistant_tool_call(name: &str, args: Value) -> AgentMessage {
    message(
        AgentMessageRole::Assistant,
        "a2",
        vec![AgentMessageBlock::ToolCall(ToolCallBlock {
            id: "call_1".to_string(),
            tool_name: name.to_string(),
            input: args,
        })],
    )
}

fn tool_result(name: &str, call_id: &str, output: &str) -> AgentMessage {
    message(
        AgentMessageRole::Tool,
        "t1",
        vec![AgentMessageBlock::ToolResult {
            tool_call_id: call_id.to_string(),
            tool_name: name.to_string(),
            output: ToolOutput::text(output.to_string()),
            is_error: false,
        }],
    )
}

fn g_tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: format!("工具 {name}"),
        input_schema: json!({ "type": "object" }),
    }
}

fn context_for(messages: &[Arc<AgentMessage>]) -> RequestBuildContext<'_> {
    RequestBuildContext {
        system_prompt: None,
        messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    }
}

// ── 验收 1a：contents 角色映射（user → user；assistant → model）──

#[test]
fn contents_role_mapping_user_and_model() {
    let messages: Vec<Arc<AgentMessage>> =
        vec![Arc::new(user_msg("你好")), Arc::new(assistant_text("世界"))];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    let contents = body["contents"].as_array().expect("contents 数组");
    assert_eq!(contents.len(), 2);
    assert_eq!(contents[0]["role"], "user");
    assert_eq!(contents[0]["parts"][0]["text"], "你好");
    assert_eq!(contents[1]["role"], "model", "assistant → model 角色映射");
    assert_eq!(contents[1]["parts"][0]["text"], "世界");
}

// ── 验收 1b：systemInstruction ──

#[test]
fn system_instruction_from_global_prompt() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("你好"))];
    let context = RequestBuildContext {
        system_prompt: Some("  系统提示  ".to_string()),
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context);
    assert_eq!(body["systemInstruction"]["parts"][0]["text"], "系统提示");
    // 注意 systemInstruction 不入 contents（禁复用 chat 轨形状）
    let contents = body["contents"].as_array().expect("contents 数组");
    assert_eq!(contents.len(), 1);
    assert_eq!(contents[0]["role"], "user");
}

#[test]
fn system_instruction_falls_back_to_context_system_message() {
    let sys = message(
        AgentMessageRole::System,
        "s1",
        vec![text_block("上下文系统说明")],
    );
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(sys), Arc::new(user_msg("你好"))];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    assert_eq!(
        body["systemInstruction"]["parts"][0]["text"],
        "上下文系统说明"
    );
    // system 消息不入 contents
    let contents = body["contents"].as_array().expect("contents 数组");
    assert_eq!(contents.len(), 1);
    assert_eq!(contents[0]["role"], "user");
}

// ── 验收 1c：functionCall / functionResponse 配对 ──

#[test]
fn function_call_and_function_response_pairing() {
    let call = assistant_tool_call("get_weather", json!({ "city": "上海" }));
    let result = tool_result("get_weather", "call_1", "晴 25 度");
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("查天气")),
        Arc::new(call),
        Arc::new(result),
    ];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    let contents = body["contents"].as_array().expect("contents 数组");

    // assistant tool-call → model content，part.functionCall 保全真实 call.id（BC08-6）
    let fc = contents
        .iter()
        .position(|c| c["role"] == "model" && c["parts"][0].get("functionCall").is_some())
        .expect("应存在 model functionCall content");
    assert_eq!(contents[fc]["role"], "model");
    assert_eq!(
        contents[fc]["parts"][0]["functionCall"]["id"], "call_1",
        "functionCall 必须保全真实 call.id"
    );
    assert_eq!(
        contents[fc]["parts"][0]["functionCall"]["name"],
        "get_weather"
    );
    assert_eq!(
        contents[fc]["parts"][0]["functionCall"]["args"]["city"],
        "上海"
    );

    // tool-result → user content，part.functionResponse 回填真实 tool_call_id（函数调用紧随其后配对）
    let fr = contents
        .iter()
        .position(|c| c["role"] == "user" && c["parts"][0].get("functionResponse").is_some())
        .expect("应存在 user functionResponse content");
    assert_eq!(contents[fr]["role"], "user");
    assert_eq!(
        contents[fr]["parts"][0]["functionResponse"]["id"], "call_1",
        "functionResponse 必须回填真实 tool_call_id"
    );
    assert_eq!(
        contents[fr]["parts"][0]["functionResponse"]["name"],
        "get_weather"
    );
    assert_eq!(
        contents[fr]["parts"][0]["functionResponse"]["response"]["result"],
        "晴 25 度"
    );
}

#[test]
fn function_call_and_response_preserves_distinct_ids_for_same_tool_name() {
    let call1 = message(
        AgentMessageRole::Assistant,
        "a1",
        vec![AgentMessageBlock::ToolCall(ToolCallBlock {
            id: "call_shanghai_99".to_string(),
            tool_name: "get_weather".to_string(),
            input: json!({ "city": "上海" }),
        })],
    );
    let call2 = message(
        AgentMessageRole::Assistant,
        "a2",
        vec![AgentMessageBlock::ToolCall(ToolCallBlock {
            id: "call_beijing_100".to_string(),
            tool_name: "get_weather".to_string(),
            input: json!({ "city": "北京" }),
        })],
    );
    let res1 = tool_result("get_weather", "call_shanghai_99", "晴 25 度");
    let res2 = tool_result("get_weather", "call_beijing_100", "阴 18 度");
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("查两地天气")),
        Arc::new(call1),
        Arc::new(res1),
        Arc::new(call2),
        Arc::new(res2),
    ];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    let contents = body["contents"].as_array().expect("contents 数组");

    // 检查两个 functionCall 均完整保留了其真实 call.id
    let fc_parts: Vec<&Value> = contents
        .iter()
        .filter_map(|c| c.get("parts").and_then(Value::as_array))
        .flatten()
        .filter_map(|p| p.get("functionCall"))
        .collect();
    assert_eq!(fc_parts.len(), 2);
    assert_eq!(fc_parts[0]["id"], "call_shanghai_99");
    assert_eq!(fc_parts[1]["id"], "call_beijing_100");

    // 检查两个 functionResponse 均完整回填了其真实 tool_call_id
    let fr_parts: Vec<&Value> = contents
        .iter()
        .filter_map(|c| c.get("parts").and_then(Value::as_array))
        .flatten()
        .filter_map(|p| p.get("functionResponse"))
        .collect();
    assert_eq!(fr_parts.len(), 2);
    assert_eq!(fr_parts[0]["id"], "call_shanghai_99");
    assert_eq!(fr_parts[1]["id"], "call_beijing_100");
}

#[test]
fn function_response_parses_json_object_output() {
    let result = message(
        AgentMessageRole::Tool,
        "t1",
        vec![AgentMessageBlock::ToolResult {
            tool_call_id: "call_1".to_string(),
            tool_name: "get_stock".to_string(),
            output: ToolOutput::text(r#"{"price": 123.5, "ticker": "AAPL"}"#.to_string()),
            is_error: false,
        }],
    );
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(result)];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    let contents = body["contents"].as_array().expect("contents 数组");
    let response = &contents[0]["parts"][0]["functionResponse"]["response"];
    assert_eq!(response["price"], 123.5);
    assert_eq!(response["ticker"], "AAPL");
    assert!(
        response.as_object().is_some(),
        "JSON 对象输出原样放入 response"
    );
}

// ── 验收 1d：maxOutputTokens ──

#[test]
fn max_output_tokens_in_generation_config() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let opts = GeminiRequestOptions {
        max_output_tokens: Some(1024),
        ..GeminiRequestOptions::default()
    };
    let body = build_gemini_request_body(&opts, &context_for(&messages));
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
    assert!(
        body["generationConfig"].get("thinking_level").is_none(),
        "未启用思考时不含 thinking_level"
    );
}

#[test]
fn temperature_in_generation_config() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let opts = GeminiRequestOptions {
        temperature: Some(0.7),
        ..GeminiRequestOptions::default()
    };
    let body = build_gemini_request_body(&opts, &context_for(&messages));
    assert_eq!(body["generationConfig"]["temperature"], 0.7);
}

// ── 验收 1e + 3：thinking_level（启用/关闭）──

#[test]
fn thinking_level_when_enabled() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    // W7：map 值原样进 thinkingConfig.thinkingLevel（"HIGH" 不折 "high"）
    let mut high_map = indexmap::IndexMap::new();
    high_map.insert("High".to_string(), "HIGH".to_string());
    let opts = GeminiRequestOptions {
        thinking_format: Some(crate::models::catalog_types::ThinkingFormat::Gemini),
        thinking_map: Some(high_map),
        reasoning_effort: Some(ReasoningEffort::High),
        ..GeminiRequestOptions::default()
    };
    let body = build_gemini_request_body(&opts, &context_for(&messages));
    assert_eq!(
        body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "HIGH"
    );

    // 中档 → map 值 medium
    let mut medium_map = indexmap::IndexMap::new();
    medium_map.insert("Medium".to_string(), "medium".to_string());
    let opts = GeminiRequestOptions {
        thinking_format: Some(crate::models::catalog_types::ThinkingFormat::Gemini),
        thinking_map: Some(medium_map),
        reasoning_effort: Some(ReasoningEffort::Medium),
        ..GeminiRequestOptions::default()
    };
    let body = build_gemini_request_body(&opts, &context_for(&messages));
    assert_eq!(
        body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "medium"
    );
}

#[test]
fn thinking_off_omits_thinking_keys() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let opts = GeminiRequestOptions {
        thinking_intensity: Some(ThinkingIntensity::Off),
        ..GeminiRequestOptions::default()
    };
    let body = build_gemini_request_body(&opts, &context_for(&messages));
    let generation = body["generationConfig"].as_object();
    if let Some(generation) = generation {
        assert!(
            !generation.contains_key("thinking_level"),
            "off 不应含 thinking_level：{generation:?}"
        );
    }
    assert!(
        serde_json::to_string(&body)
            .map(|s| !s.contains("thinking"))
            .unwrap_or(false),
        "off 时请求体不得包含 thinking 相关键"
    );
}

#[test]
fn generation_config_and_thinking_absent_when_no_fields() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    assert!(
        body.get("generationConfig").is_none(),
        "无 maxOutputTokens/temperature/思考时不输出 generationConfig：{body}"
    );
}

#[test]
fn max_output_tokens_none_omits_field_and_no_invented_64000() {
    // 轨G P2：无 max_output_tokens 时 generationConfig 省略 maxOutputTokens
    // （跟随协议缺省），且 dialect 不发明 64000 兜底（对齐 build_chat 的 unwrap_or(0) 契约）。
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let mut budget_map = indexmap::IndexMap::new();
    budget_map.insert("High".to_string(), "32000".to_string());
    let opts = GeminiRequestOptions {
        thinking_format: Some(crate::models::catalog_types::ThinkingFormat::Gemini),
        thinking_map: Some(budget_map),
        reasoning_effort: Some(ReasoningEffort::High),
        // max_output_tokens 缺省 → 不得发明 64000
        ..GeminiRequestOptions::default()
    };
    let body = build_gemini_request_body(&opts, &context_for(&messages));
    let generation = body["generationConfig"]
        .as_object()
        .expect("generationConfig");
    assert!(
        !generation.contains_key("maxOutputTokens"),
        "无 max_output_tokens 时不得发明 64000 写入 maxOutputTokens：{generation:?}"
    );
    // 思考预算来自用户字典原样（32000），不得被发明的 64000 钳制
    assert_eq!(
        body["generationConfig"]["thinkingConfig"]["thinkingBudget"], 32000,
        "无已知上限时 thinkingBudget 应取用户字典值"
    );
}

#[test]
fn max_output_tokens_some_emits_field() {
    // 有显式 max_output_tokens：按 generationConfig.maxOutputTokens 写入（防回归）
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let opts = GeminiRequestOptions {
        max_output_tokens: Some(1024),
        ..GeminiRequestOptions::default()
    };
    let body = build_gemini_request_body(&opts, &context_for(&messages));
    assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
}

// ── 工具：functionDeclarations + toolConfig ──

#[test]
fn tools_function_declarations_shape() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let context = RequestBuildContext {
        tools: vec![g_tool("read_file")],
        ..context_for(&messages)
    };
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context);
    assert_eq!(
        body["tools"][0]["functionDeclarations"][0]["name"],
        "read_file"
    );
    assert_eq!(
        body["tools"][0]["functionDeclarations"][0]["description"],
        "工具 read_file"
    );
    assert_eq!(
        body["tools"][0]["functionDeclarations"][0]["parameters"],
        json!({ "type": "object" })
    );
    assert_eq!(
        body["toolConfig"],
        json!({ "functionCallingConfig": { "mode": "AUTO" } })
    );
}

#[test]
fn tool_config_choice_variants() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    for (choice, expected_mode, expected_allowed) in [
        (ToolChoice::Auto, "AUTO", None),
        (ToolChoice::None, "NONE", None),
        (ToolChoice::Required, "ANY", None),
        (
            ToolChoice::Function {
                name: "read_file".into(),
            },
            "ANY",
            Some(vec!["read_file"]),
        ),
    ] {
        let description = format!("{choice:?}");
        let opts = GeminiRequestOptions {
            tool_choice: Some(choice),
            ..GeminiRequestOptions::default()
        };
        let context = RequestBuildContext {
            tools: vec![g_tool("read_file")],
            ..context_for(&messages)
        };
        let body = build_gemini_request_body(&opts, &context);
        let fcc = &body["toolConfig"]["functionCallingConfig"];
        assert_eq!(
            fcc["mode"], expected_mode,
            "ToolChoice {description} 映射 mode"
        );
        if let Some(expected_names) = expected_allowed {
            let names: Vec<&str> = fcc["allowedFunctionNames"]
                .as_array()
                .expect("allowedFunctionNames 应为数组")
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert_eq!(
                names, expected_names,
                "ToolChoice {description} allowedFunctionNames"
            );
        } else {
            assert!(
                fcc.get("allowedFunctionNames").is_none(),
                "ToolChoice {description} 不应含 allowedFunctionNames"
            );
        }
    }
}

#[test]
fn tools_absent_when_empty() {
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi"))];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    assert!(body.get("tools").is_none());
    assert!(body.get("toolConfig").is_none());
}

// ── 验收 2：头断言（x-goog-api-key + content-type）──

#[test]
fn headers_contain_api_key_and_content_type() {
    let headers = gemini_request_headers("sk-gemini-123");
    let names: Vec<&str> = headers.iter().map(|(n, _)| *n).collect();
    assert!(
        names.contains(&"x-goog-api-key"),
        "头必须含 x-goog-api-key：{names:?}"
    );
    assert!(names.contains(&"content-type"), "头必须含 content-type");
    let key_value = headers
        .iter()
        .find(|(n, _)| *n == "x-goog-api-key")
        .map(|(_, v)| v.clone())
        .expect("key 头值");
    assert_eq!(key_value, "sk-gemini-123");
}

#[test]
fn headers_omit_key_when_api_key_empty() {
    let headers = gemini_request_headers("");
    assert!(
        !headers.iter().any(|(n, _)| *n == "x-goog-api-key"),
        "空 api_key 不输出 key 头"
    );
    assert!(headers.iter().any(|(n, _)| *n == "content-type"));
}

// ── compactObject：缺省/空输入零字段 ──

#[test]
fn minimal_body_has_model_and_empty_contents() {
    let body = build_gemini_request_body(
        &GeminiRequestOptions {
            model: Some("gemini-2.5-flash".to_string()),
            ..GeminiRequestOptions::default()
        },
        &RequestBuildContext::default(),
    );
    assert_eq!(body["model"], "gemini-2.5-flash");
    assert_eq!(body["contents"], json!([]));
    for key in [
        "systemInstruction",
        "generationConfig",
        "tools",
        "toolConfig",
    ] {
        assert!(body.get(key).is_none(), "{key} 缺省不应出现：{body}");
    }
}

// ── 成对性 Fail-Closed 守门（详案 02 §3.4 轨三）──

/// 同名多次调用全部被同名 response 覆盖 → 无孤儿（禁止假阴性误伤）
#[test]
fn pairing_gate_same_name_multiple_calls_fully_covered() {
    let call1 = assistant_tool_call("get_weather", json!({ "city": "上海" }));
    let call2 = assistant_tool_call("get_weather", json!({ "city": "北京" }));
    let result1 = tool_result("get_weather", "call_1", "晴 25 度");
    let result2 = tool_result("get_weather", "call_1", "阴 18 度");
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("查天气")),
        Arc::new(call1),
        Arc::new(call2),
        Arc::new(result1),
        Arc::new(result2),
    ];
    let orphans = detect_gemini_unpaired_tool_calls(&messages);
    assert!(
        orphans.is_empty(),
        "同名多次调用全部被覆盖不应报孤儿：{orphans:?}"
    );
}

/// 同名多次调用仅部分被 response 覆盖 → 多余部分为孤儿
#[test]
fn pairing_gate_same_name_partial_coverage_leaves_orphan() {
    let call1 = assistant_tool_call("get_weather", json!({ "city": "上海" }));
    let call2 = assistant_tool_call("get_weather", json!({ "city": "北京" }));
    let result1 = tool_result("get_weather", "call_1", "晴 25 度");
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("查天气")),
        Arc::new(call1),
        Arc::new(call2),
        Arc::new(result1),
    ];
    let orphans = detect_gemini_unpaired_tool_calls(&messages);
    assert_eq!(
        orphans,
        ["get_weather#1"],
        "第二次调用应为孤儿：{orphans:?}"
    );
}

/// 不同名调用各自独立配对，互不干扰
#[test]
fn pairing_gate_different_names_independent_pairing() {
    let call_a = assistant_tool_call("read_file", json!({ "path": "a.txt" }));
    let call_b = assistant_tool_call("get_weather", json!({ "city": "上海" }));
    let result_b = tool_result("get_weather", "call_1", "晴");
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("操作")),
        Arc::new(call_a),
        Arc::new(call_b),
        Arc::new(result_b),
    ];
    let orphans = detect_gemini_unpaired_tool_calls(&messages);
    assert_eq!(
        orphans,
        ["read_file#0"],
        "read_file 无 response 应为孤儿：{orphans:?}"
    );
}

/// 空 name 的 call 不参与配对（归入孤儿检测面之外，不误伤）
#[test]
fn pairing_gate_empty_name_call_excluded() {
    let call = assistant_tool_call("", json!({}));
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("hi")), Arc::new(call)];
    let orphans = detect_gemini_unpaired_tool_calls(&messages);
    assert!(
        orphans.is_empty(),
        "空 name call 不参与配对检测：{orphans:?}"
    );
}

/// validate 对孤儿返回 Err(UnpairedToolCalls) 并记录结构化日志（Debug 与 Release 统一行为）。
#[test]
fn pairing_gate_validate_returns_err_on_orphan() {
    let call = assistant_tool_call("read_file", json!({ "path": "a.txt" }));
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("读文件")), Arc::new(call)];
    let res = validate_gemini_tool_pairing(&messages);
    match res {
        Err(RequestBuildError::UnpairedToolCalls {
            protocol,
            orphan_ids,
        }) => {
            assert_eq!(protocol, "gemini");
            assert_eq!(orphan_ids, vec!["read_file#0"]);
        }
        other => panic!("期望 UnpairedToolCalls 错误，得到：{other:?}"),
    }
}

/// build 入口在孤儿输入下 Fail-Closed：安全过滤孤儿 functionCall，不发生 panic。
#[test]
fn build_gemini_fail_closed_on_orphan() {
    let call = assistant_tool_call("read_file", json!({ "path": "a.txt" }));
    let messages: Vec<Arc<AgentMessage>> = vec![Arc::new(user_msg("读文件")), Arc::new(call)];
    let body = build_gemini_request_body(&GeminiRequestOptions::default(), &context_for(&messages));
    let contents = body["contents"].as_array().expect("contents 必须为数组");
    let mut found_model = false;
    for content in contents {
        if content.get("role").and_then(Value::as_str) == Some("model") {
            found_model = true;
            let parts = content["parts"].as_array().expect("model parts 必须为数组");
            assert_eq!(parts.len(), 1);
            assert_eq!(parts[0]["text"], WIRE_CONTINUATION_NOTE);
        }
        if let Some(parts) = content.get("parts").and_then(Value::as_array) {
            for part in parts {
                assert!(
                    part.get("functionCall").is_none(),
                    "带毒孤儿 functionCall 必须被过滤掉，不得残留在出站请求体中: {part:?}"
                );
            }
        }
    }
    assert!(found_model, "必须包含 model 消息");
}

/// 成对完整对话经 detect 确认无孤儿（正向回归）
#[test]
fn pairing_gate_paired_conversation_no_orphans() {
    let call = assistant_tool_call("get_weather", json!({ "city": "上海" }));
    let result = tool_result("get_weather", "call_1", "晴 25 度");
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("查天气")),
        Arc::new(call),
        Arc::new(result),
    ];
    let orphans = detect_gemini_unpaired_tool_calls(&messages);
    assert!(orphans.is_empty(), "成对完整对话不应检出孤儿：{orphans:?}");
}
