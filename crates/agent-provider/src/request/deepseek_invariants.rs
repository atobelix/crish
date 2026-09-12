//! DeepSeek 请求体不变量测试钉死（T-22，P3 步骤 4 A3 修正：只补测试，不实现第二遍接线）
//!
//! 钉死的三组不变量（P3 §3.4.1 / ⑤ 验收 5，对齐 Reasonix anthropic_test.go:452-461
//! 的"DeepSeek 请求体任意块不得出现 cache_control"模式）：
//!
//! 1. **cache_control 键全省略**：任意组合下（DeepSeek base_url + 任意模型名）经
//!    [build_cache_policy] 判定为 None（机制 Auto 全省略 / 直判省略），端到端请求体
//!    递归扫描不得出现 `cache_control` 键（消息级、part 级、工具级、顶层全部覆盖）。
//! 2. **tool_calls 回合必带 reasoning_content 键**：engine 对 DeepSeek 恒
//!    [ReasoningContentMode::Require]（C1 唯一接线，P1 T-06/T-09 承担），带 tool_calls
//!    的 assistant 消息序列化后必含该键，历史无思考时空串兜底（Reasonix
//!    openai.go:669-680：缺键 400）。
//! 3. **矩阵联动**：[cache_behavior_for] 的 DeepSeek 行 `omit_cache_control == true`
//!    与 `supports_prompt_cache_key == false` 恒同时成立（矩阵是唯一数据真源，C2；
//!    omit 强制省略断点 + 官方不支持 prompt_cache_key，vendor-cache-gaps.md:104）。
//!
//! 本文件只读既有源码，不修改任何实现；挂载于 request/mod.rs（#[cfg(test)]）。

use std::sync::Arc;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::tool::{SystemPromptWireMode, ToolOutput};
use serde_json::{json, Value};

use crate::models::{cache_behavior_for, ModelCatalog, VendorId};
use crate::request::build::{
    build_chat_completions_request_body, ChatCompletionsRequestOptions, RequestBuildContext,
};
use crate::request::cache::build_cache_policy;
use crate::request::messages::{to_chat_messages, ReasoningContentMode};
use crate::request::tools::ToolDefinition;

// ── 便捷构造（只读复用既有测试模式，messages.rs/build.rs 同款）──

fn text_block(text: &str) -> AgentMessageBlock {
    AgentMessageBlock::Text {
        text: text.to_string(),
    }
}

fn message(role: AgentMessageRole, blocks: Vec<AgentMessageBlock>) -> AgentMessage {
    AgentMessage {
        id: format!("m-{role:?}"),
        role,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks,
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

fn user_msg(text: &str) -> AgentMessage {
    message(AgentMessageRole::User, vec![text_block(text)])
}

/// 带 tool_calls 的 assistant 消息（thought 为空串表示无思考，P3 §3.4.1 规则 1 场景）
fn assistant_tool_call_msg(thought: &str) -> AgentMessage {
    let mut blocks = vec![
        AgentMessageBlock::ToolCall(ToolCallBlock {
            id: "call_1".to_string(),
            tool_name: "read_file".to_string(),
            input: json!({ "path": "/a" }),
        }),
        text_block("正在调用工具"),
    ];
    if !thought.is_empty() {
        blocks.push(AgentMessageBlock::Thought {
            text: thought.to_string(),
            redacted: None,
        });
    }
    message(AgentMessageRole::Assistant, blocks)
}

fn tool_result_msg() -> AgentMessage {
    tool_result_msg_for("call_1")
}

/// 指定 call_id 的 Tool 结果消息（W04 成对性守门要求 tool_call_id 与
/// assistant ToolCall.id 严格一致——fixture 不得制造孤儿）
fn tool_result_msg_for(call_id: &str) -> AgentMessage {
    message(
        AgentMessageRole::Tool,
        vec![AgentMessageBlock::ToolResult {
            tool_call_id: call_id.to_string(),
            tool_name: "read_file".to_string(),
            output: ToolOutput::text("文件内容"),
            is_error: false,
        }],
    )
}

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: format!("工具 {name}"),
        input_schema: json!({ "type": "object" }),
    }
}

/// 递归扫描：任意嵌套对象/数组内出现 `cache_control` 键即失败。
/// 覆盖消息级、part 级、工具级、顶层与未来扩展的全部潜在落点——
/// 比逐层断言更严格地钉死"DeepSeek 请求体任意块不得出现 cache_control"
/// （对齐 Reasonix anthropic_test.go:452-461 的任意 block 语义）。
fn assert_no_cache_control_key(value: &Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                assert_ne!(
                    key.as_str(),
                    "cache_control",
                    "DeepSeek 请求体不得出现 cache_control 键（完整请求体：{value}）"
                );
                assert_no_cache_control_key(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                assert_no_cache_control_key(item);
            }
        }
        _ => {}
    }
}

// ════════════════════════════════════════════════════════════════════════
// 不变量 1：任意组合下 DeepSeek 请求体不含 cache_control 键
// ════════════════════════════════════════════════════════════════════════

#[test]
fn deepseek_any_combination_yields_none_policy() {
    // 判定组合矩阵：base_url 关键字命中 + 任意模型名 / model 前缀兜底 /
    // 大小写变体 / 空模型名 / 显式 overrides 开启——全部归 None
    // （机制 Auto 全省略 + 步骤 3 直判省略双重保证，cache.rs T-13b）
    let combos: &[(&str, &str)] = &[
        // base_url 命中 + 任意模型（模型名不含 deepseek 前缀也必须省略）
        ("https://api.deepseek.com", "any-model"),
        ("https://api.deepseek.com", "custom-gateway-model"),
        // 官方域名 + 官方模型
        ("https://api.deepseek.com", "deepseek-v4-flash"),
        ("https://api.deepseek.com", "deepseek-chat"),
        // 大小写变体（判定走 to_ascii_lowercase）
        ("https://API.DEEPSEEK.COM/v1", "any-model"),
        // model 前缀兜底（base_url 无关键字）
        ("https://gateway.example.com/v1", "deepseek-v4-flash"),
        // 空模型名（仅 base_url 判定）
        ("https://api.deepseek.com", ""),
    ];
    for (base_url, model) in combos {
        assert_eq!(
            build_cache_policy(None, Some(base_url), Some(model), Some("ses-1"), None),
            None,
            "DeepSeek 组合（base_url={base_url}, model={model}）必须全省略缓存参数"
        );
    }
    // 无 model（None 形态）
    assert_eq!(
        build_cache_policy(
            None,
            Some("https://api.deepseek.com"),
            None,
            Some("ses-1"),
            None
        ),
        None
    );
    // 即使 extra.cache 显式开启也省略（omit 优先于覆盖，P3 §3.2.2 Deepseek 行）
    assert_eq!(
        build_cache_policy(
            None,
            Some("https://api.deepseek.com"),
            Some("deepseek-v4"),
            Some("ses-1"),
            Some(&json!({ "enabled": true }))
        ),
        None
    );
}

#[test]
fn deepseek_request_body_never_contains_cache_control_key() {
    // 端到端：DeepSeek 判定（base_url 命中 + 任意模型名）→ build_cache_policy 归 None
    // → 请求体构建（Require 模式 = engine 对 DeepSeek 的恒接线，C1）。
    // 消息序列覆盖完整工具循环形态（user / assistant+tool_calls / tool / assistant+思考），
    // 工具列表带两个工具——递归扫描整个请求体不得出现 cache_control 键。
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("读一下 /a 文件")),
        Arc::new(assistant_tool_call_msg("")),
        Arc::new(tool_result_msg()),
        // W04 成对性守门：末条 assistant 为纯思考回合（不带 ToolCall——
        // 否则须再补 tool_result；本测试焦点是 cache_control 全省略）
        Arc::new(message(
            AgentMessageRole::Assistant,
            vec![
                AgentMessageBlock::Thought {
                    text: "推理过程".to_string(),
                    redacted: None,
                },
                text_block("已完成读取"),
            ],
        )),
        Arc::new(user_msg("继续")),
    ];
    let context = RequestBuildContext {
        system_prompt: Some("全局提示词".to_string()),
        messages: &messages,
        tools: vec![tool("read_file"), tool("search")],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let opts = ChatCompletionsRequestOptions {
        model: Some("deepseek-v4-flash".to_string()),
        reasoning_content: Some(ReasoningContentMode::Require),
        cache: build_cache_policy(
            None,
            Some("https://api.deepseek.com"),
            Some("deepseek-v4-flash"),
            Some("ses-1"),
            None,
        ),
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &context);
    assert_no_cache_control_key(&body);

    // 请求体形态抽查：messages 全部保持 string content（无断点改写为 parts 形态）
    // 数量 = system 前置 + 5 条对话消息（system_prompt 非空时 to_chat_messages 前置一条）
    let wire_messages = body["messages"].as_array().expect("messages 数组");
    assert_eq!(wire_messages.len(), 6);
    for wire in wire_messages {
        assert!(
            wire["content"].is_string(),
            "无断点注入时 content 必须保持 string 形态：{wire}"
        );
    }
    // 顶层无任何缓存键（prompt_cache_key / retention / options 一并省略）
    for key in [
        "prompt_cache_key",
        "prompt_cache_retention",
        "prompt_cache_options",
    ] {
        assert!(
            body.get(key).is_none(),
            "DeepSeek 请求体不得注入顶层键 {key}"
        );
    }
}

// ════════════════════════════════════════════════════════════════════════
// 不变量 2：带 tool_calls 的 assistant 消息必含 reasoning_content 键（空串可）
// ════════════════════════════════════════════════════════════════════════

#[test]
fn deepseek_tool_call_assistant_always_carries_reasoning_content_key() {
    // 无思考：空串兜底，键必须存在（DeepSeek 工具轮次缺键 400；
    // Reasonix openai.go:669-680；P1 C3 Require 语义）
    let messages = to_chat_messages(
        None,
        &[assistant_tool_call_msg("")],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(messages.len(), 1);
    let value = messages[0].to_value();
    assert!(
        value.get("reasoning_content").is_some(),
        "带 tool_calls 的 assistant 消息必须含 reasoning_content 键：{value}"
    );
    assert_eq!(value["reasoning_content"], "", "无思考时空串兜底");
    assert!(value.get("tool_calls").is_some(), "tool_calls 键必须存在");
    assert_eq!(value["tool_calls"][0]["id"], "call_1");

    // 有思考：键存在且为思考内容
    let messages = to_chat_messages(
        None,
        &[assistant_tool_call_msg("推理过程")],
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    let value = messages[0].to_value();
    assert!(
        value.get("reasoning_content").is_some(),
        "带 tool_calls 的 assistant 消息必须含 reasoning_content 键：{value}"
    );
    assert_eq!(value["reasoning_content"], "推理过程");

    // 对照（语义边界）：Omit 模式不带键——Require 是 DeepSeek 专用开关，
    // engine 对 DeepSeek 恒 Require（C1），其他厂商才允许省略
    let messages = to_chat_messages(
        None,
        &[assistant_tool_call_msg("")],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    let value = messages[0].to_value();
    assert!(
        value.get("reasoning_content").is_none(),
        "Omit 模式不得含 reasoning_content 键（Require 才是 DeepSeek 接线）：{value}"
    );
}

#[test]
fn deepseek_request_body_tool_call_messages_have_reasoning_content_key() {
    // 请求体级钉死：完整构建路径下，带 tool_calls 的 assistant 消息必含该键
    // （防御 future 注入路径改动在 wire 层丢失 Require 语义）
    let messages: Vec<Arc<AgentMessage>> = vec![
        Arc::new(user_msg("调用工具")),
        Arc::new(assistant_tool_call_msg("")),
        // W04 成对性守门：assistant ToolCall 必须有对应 Tool 结果，否则
        // build 入口的 Fail-Closed 闸会拦截（本测试焦点是 reasoning_content 键）
        Arc::new(tool_result_msg()),
    ];
    let context = RequestBuildContext {
        system_prompt: None,
        messages: &messages,
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let opts = ChatCompletionsRequestOptions {
        model: Some("deepseek-v4-flash".to_string()),
        reasoning_content: Some(ReasoningContentMode::Require),
        cache: None,
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &context);
    let wire_messages = body["messages"].as_array().expect("messages 数组");
    let assistant = wire_messages
        .iter()
        .find(|m| m["role"] == "assistant")
        .expect("请求体必须含 assistant 消息");
    assert!(
        assistant.get("tool_calls").is_some(),
        "assistant 消息必须带 tool_calls：{assistant}"
    );
    assert!(
        assistant.get("reasoning_content").is_some(),
        "带 tool_calls 的 assistant 消息必须含 reasoning_content 键（请求体级）：{assistant}"
    );
    assert_eq!(assistant["reasoning_content"], "");
}

// ════════════════════════════════════════════════════════════════════════
// 不变量 3：cache_behavior_for DeepSeek 行 omit 与键开关联动断言
// ════════════════════════════════════════════════════════════════════════

#[test]
fn deepseek_matrix_omits_cache_control_and_forbids_cache_key_together() {
    // 联动断言：`omit_cache_control == true` 与 `supports_prompt_cache_key == false`
    // 恒同时成立（P3 §3.2.2 Deepseek 行 + ⑤ 验收 2；矩阵是唯一数据真源 C2）。
    // 语义：断点强制省略（官方忽略 cache_control）且官方不支持 prompt_cache_key
    // （vendor-cache-gaps.md:104），两开关互为补充，任何一侧翻转都必须同步审视。
    for model in [
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "deepseek-chat",
        "unknown-model",
    ] {
        let behavior = cache_behavior_for(None, VendorId::Deepseek, model);
        assert!(
            behavior.omit_cache_control,
            "DeepSeek 行（model={model}）必须恒 omit cache_control"
        );
        assert!(
            !behavior.supports_prompt_cache_key,
            "DeepSeek 行（model={model}）必须恒不注入 prompt_cache_key"
        );
        assert!(!behavior.supports_cache_control, "DeepSeek 行不支持断点");
        assert!(
            behavior.auto_cache && behavior.supports_prompt_caching,
            "自动缓存轨在"
        );
        assert_eq!(behavior.default_ttl, Some(crate::models::CacheTtl::Short));
    }
    // 内置 catalog 路径（模型级覆盖不翻转 omit/键开关）同样联动成立
    let catalog = ModelCatalog::bundled();
    let behavior = cache_behavior_for(Some(&catalog), VendorId::Deepseek, "deepseek-v4-flash");
    assert!(behavior.omit_cache_control);
    assert!(!behavior.supports_prompt_cache_key);
}

#[test]
fn deepseek_matrix_drives_injection_decision_to_none() {
    // 闭环一致性：矩阵开关（omit=true / key=false）必须传导到注入决策面——
    // 矩阵说省略，build_cache_policy 就必须归 None（数据真源 → 唯一判定入口，
    // C2 消费链）。任一厂商行/决策面单独改动都会被本测试钉死。
    let behavior = cache_behavior_for(None, VendorId::Deepseek, "deepseek-v4-flash");
    assert!(behavior.omit_cache_control);
    assert!(!behavior.supports_prompt_cache_key);
    for (base_url, model) in [
        ("https://api.deepseek.com", "deepseek-v4-flash"),
        ("https://api.deepseek.com", "any-model"),
        ("https://gateway.example.com", "deepseek-chat"),
    ] {
        assert_eq!(
            build_cache_policy(None, Some(base_url), Some(model), Some("ses-1"), None),
            None,
            "矩阵省略语义必须传导到 build_cache_policy（{base_url}, {model}）"
        );
    }
}

// ════════════════════════════════════════════════════════════════════════
// 不变量 4：第三方代理网关出站历史消息清洗（彻底剥离 reasoning_content 杜绝 400）
// ════════════════════════════════════════════════════════════════════════

/// 出站历史消息清洗纯函数：剥离历史 Assistant 中的 Thought 块与 reasoning_content 元数据
fn sanitize_outbound_messages_for_proxy(messages: &mut [AgentMessage]) {
    for msg in messages.iter_mut() {
        if msg.role == AgentMessageRole::Assistant {
            msg.blocks
                .retain(|b| !matches!(b, AgentMessageBlock::Thought { .. }));
            if let Some(Value::Object(map)) = &mut msg.metadata {
                map.remove("thought");
                map.remove("reasoning_content");
            }
        }
    }
}

#[test]
fn deepseek_proxy_outbound_sanitizes_history_reasoning_content() {
    // 构造真实多轮交互历史：包含用户提问、带思考与工具调用的 Assistant、工具返回、带思考的最终回答
    let mut messages: Vec<AgentMessage> = vec![
        user_msg("分析这个项目的架构"),
        AgentMessage {
            id: "m-asst-1".to_string(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-01-01T00:00:01Z".to_string(),
            blocks: vec![
                AgentMessageBlock::Thought {
                    text: "内部深度推理：用户需要分析架构，先调用工具检查 Cargo.toml".to_string(),
                    redacted: None,
                },
                text_block("我将首先检查 Cargo.toml 文件以了解项目结构。"),
                AgentMessageBlock::ToolCall(ToolCallBlock {
                    id: "call_ds_init".to_string(),
                    tool_name: "read_file".to_string(),
                    input: json!({ "path": "Cargo.toml" }),
                }),
            ],
            metadata: Some(json!({
                "thought": "内部深度推理：用户需要分析架构，先调用工具检查 Cargo.toml",
                "reasoning_content": "内部深度推理：用户需要分析架构，先调用工具检查 Cargo.toml",
                "custom_trace_id": "trace-12345"
            })),
            client_message_id: None,
            content: None,
        },
        tool_result_msg_for("call_ds_init"),
        AgentMessage {
            id: "m-asst-2".to_string(),
            role: AgentMessageRole::Assistant,
            created_at: "2026-01-01T00:00:03Z".to_string(),
            blocks: vec![
                AgentMessageBlock::Thought {
                    text: "Cargo.toml 内容已获取，准备给出最终总结".to_string(),
                    redacted: None,
                },
                text_block("项目采用标准的 Workspace 拓扑结构。"),
            ],
            metadata: Some(json!({
                "reasoning_content": "Cargo.toml 内容已获取，准备给出最终总结"
            })),
            client_message_id: None,
            content: None,
        },
        user_msg("请继续详细展开"),
    ];

    // 执行出站历史消息清洗管线
    sanitize_outbound_messages_for_proxy(&mut messages);

    // 1. 断言：所有 Assistant 消息中 Thought 块被彻底剔除
    for msg in &messages {
        if msg.role == AgentMessageRole::Assistant {
            assert!(
                msg.blocks
                    .iter()
                    .all(|b| !matches!(b, AgentMessageBlock::Thought { .. })),
                "清洗后 Assistant 消息不得残留任何 Thought 块：{:?}",
                msg.blocks
            );
            // 元数据中的 thought 与 reasoning_content 必须彻底移除
            if let Some(meta) = &msg.metadata {
                assert!(meta.get("thought").is_none(), "元数据中 thought 必须被清洗");
                assert!(
                    meta.get("reasoning_content").is_none(),
                    "元数据中 reasoning_content 必须被清洗"
                );
            }
        }
    }

    // 2. 断言：非 Thought 内容（Text 文本、ToolCall 结构）以及非 Assistant 消息必须完整保留
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[0].role, AgentMessageRole::User);
    assert_eq!(messages[1].role, AgentMessageRole::Assistant);
    assert_eq!(messages[1].blocks.len(), 2); // Text + ToolCall (Thought 已被剔除)
    assert!(
        matches!(&messages[1].blocks[0], AgentMessageBlock::Text { text } if text.contains("检查 Cargo.toml"))
    );
    assert!(matches!(
        &messages[1].blocks[1],
        AgentMessageBlock::ToolCall(_)
    ));
    assert_eq!(messages[2].role, AgentMessageRole::Tool);
    assert_eq!(messages[3].role, AgentMessageRole::Assistant);
    assert_eq!(messages[3].blocks.len(), 1); // 仅剩 Text
    assert!(
        matches!(&messages[3].blocks[0], AgentMessageBlock::Text { text } if text.contains("Workspace"))
    );

    // 3. 断言 Wire 序列化出站结果：在代理模式 (ReasoningContentMode::Omit) 下，序列化出来的 JSON 绝无 reasoning_content 键
    let wire_messages = to_chat_messages(
        Some("系统提示词"),
        &messages,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    for wire_msg in &wire_messages {
        let val = wire_msg.to_value();
        assert!(
            val.get("reasoning_content").is_none(),
            "经出站清洗的消息序列化为 Wire 时绝不能包含 reasoning_content 键（防止第三方网关 400）：{val}"
        );
    }

    // 4. 断言完整端到端请求体：发往第三方代理网关的请求体 messages 中 100% 干净
    let arc_messages: Vec<Arc<AgentMessage>> = messages.into_iter().map(Arc::new).collect();
    let context = RequestBuildContext {
        system_prompt: Some("系统提示词".to_string()),
        messages: &arc_messages,
        tools: vec![tool("read_file")],
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    let opts = ChatCompletionsRequestOptions {
        model: Some("deepseek-v4-pro".to_string()),
        reasoning_content: Some(ReasoningContentMode::Omit),
        cache: None,
        ..ChatCompletionsRequestOptions::default()
    };
    let body = build_chat_completions_request_body(&opts, &context);
    assert_no_cache_control_key(&body);
    let body_messages = body["messages"].as_array().expect("messages 数组必须存在");
    for msg in body_messages {
        assert!(
            msg.get("reasoning_content").is_none(),
            "请求体中任意 message 均不得包含 reasoning_content 键：{msg}"
        );
    }

    // 5. 对照验证：官方直连模式 (ReasoningContentMode::Require) 下，带 tool_calls 的回合仍然遵循官方规范生成 reasoning_content
    let direct_wire = to_chat_messages(
        None,
        &arc_messages,
        ReasoningContentMode::Require,
        SystemPromptWireMode::NativeSystemRole,
    );
    let tool_call_asst = direct_wire
        .iter()
        .find(|m| m.role == "assistant" && !m.tool_calls.is_empty())
        .expect("必须找到带 tool_calls 的 assistant 消息");
    let val = tool_call_asst.to_value();
    assert!(
        val.get("reasoning_content").is_some(),
        "官方直连模式下工具调用轮次仍须带 reasoning_content 空串兜底：{val}"
    );
    assert_eq!(val["reasoning_content"], "");
}
