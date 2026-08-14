//! MCP 假 server（测试夹具）：stdio 行分隔 JSON-RPC 2.0 最小实现
//!
//! 仅供 agent-tools 集成测试使用（tests/mcp_bridge.rs 经
//! `env!("CARGO_BIN_EXE_mcp_fake_server")` 拉起）。纯 std 实现，无依赖。
//!
//! 行为由环境变量控制（供各测试场景）：
//! - FAKE_MCP_SLOW_MS：处理 tools/call 前睡眠毫秒数（测超时）
//! - FAKE_MCP_CRASH_AFTER_MS：运行满该毫秒数后以退出码 1 崩溃（测崩溃检测）
//! - FAKE_MCP_CRASH_ON_CALL=1：处理完一次 tools/call 后崩溃（测调用中崩溃）
//! - FAKE_MCP_REJECT_INIT=1：initialize 返回 JSON-RPC 错误（测握手失败）
//! - FAKE_MCP_ENV_VALUE：经 env 工具回显（测环境变量透传）
//!
//! 协议语义对齐 MCP 官方 stdio：每行一条 JSON 消息；stdin EOF 即退出。

use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::ExitCode;
use std::time::Duration;

fn env_bool(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value == "1")
}

fn env_u64(name: &str) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn main() -> ExitCode {
    let slow_ms = env_u64("FAKE_MCP_SLOW_MS");
    let crash_after_ms = env_u64("FAKE_MCP_CRASH_AFTER_MS");
    let crash_on_call = env_bool("FAKE_MCP_CRASH_ON_CALL");
    let reject_init = env_bool("FAKE_MCP_REJECT_INIT");

    // 崩溃计时独立线程：阻塞读 stdin 期间也能按点退出
    if crash_after_ms > 0 {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(crash_after_ms));
            std::process::exit(1);
        });
    }

    let stdin = std::io::stdin();
    let mut lines = BufReader::new(stdin.lock()).lines();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    while let Some(Ok(line)) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(String::from);
        let id = message.get("id").cloned();
        match method.as_deref() {
            Some("initialize") => {
                if reject_init {
                    respond(
                        &mut out,
                        &id,
                        Some(json!({ "code": -32000, "message": "initialize 被拒绝" })),
                        None,
                    );
                } else {
                    // 回显请求中的协议版本（对齐真实 server 的协商行为）
                    let version = message
                        .pointer("/params/protocolVersion")
                        .and_then(Value::as_str)
                        .unwrap_or("2025-03-26");
                    respond(
                        &mut out,
                        &id,
                        None,
                        Some(json!({
                            "protocolVersion": version,
                            "capabilities": {},
                            "serverInfo": { "name": "fake-mcp-server", "version": "1.0.0" }
                        })),
                    );
                }
            }
            Some("notifications/initialized") => {
                // 通知无需响应
            }
            Some("tools/list") => respond(
                &mut out,
                &id,
                None,
                Some(json!({
                    "tools": [
                        {
                            "name": "echo",
                            "description": "回显入参",
                            "inputSchema": {
                                "type": "object",
                                "properties": { "msg": { "type": "string" } }
                            }
                        },
                        {
                            "name": "add",
                            "description": "两数相加",
                            "inputSchema": {
                                "type": "object",
                                "properties": {
                                    "a": { "type": "number" },
                                    "b": { "type": "number" }
                                }
                            }
                        },
                        { "name": "boom", "description": "总是失败" },
                        { "name": "env", "description": "回显环境变量" }
                    ]
                })),
            ),
            Some("tools/call") => {
                if slow_ms > 0 {
                    std::thread::sleep(Duration::from_millis(slow_ms));
                }
                let name = message
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = message
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match name {
                    "echo" => respond(
                        &mut out,
                        &id,
                        None,
                        Some(json!({
                            "content": [{ "type": "text", "text": format!("echoed: {arguments}") }],
                            "isError": false
                        })),
                    ),
                    "add" => {
                        let a = arguments.get("a").and_then(Value::as_f64).unwrap_or(0.0);
                        let b = arguments.get("b").and_then(Value::as_f64).unwrap_or(0.0);
                        let sum = a + b;
                        respond(
                            &mut out,
                            &id,
                            None,
                            Some(json!({
                                "content": [{ "type": "text", "text": format!("{sum}") }],
                                "structuredContent": { "sum": sum },
                                "isError": false
                            })),
                        );
                    }
                    "boom" => respond(
                        &mut out,
                        &id,
                        None,
                        Some(json!({
                            "content": [{ "type": "text", "text": "boom 失败（故意）" }],
                            "isError": true
                        })),
                    ),
                    "env" => {
                        let value = std::env::var("FAKE_MCP_ENV_VALUE")
                            .unwrap_or_else(|_| "<未设置>".to_string());
                        respond(
                            &mut out,
                            &id,
                            None,
                            Some(json!({
                                "content": [{ "type": "text", "text": value }],
                                "isError": false
                            })),
                        );
                    }
                    _ => respond(
                        &mut out,
                        &id,
                        Some(json!({ "code": -32602, "message": format!("未知工具：{name}") })),
                        None,
                    ),
                }
                if crash_on_call {
                    std::process::exit(1);
                }
            }
            _ => respond(
                &mut out,
                &id,
                Some(json!({ "code": -32601, "message": "未知方法" })),
                None,
            ),
        }
    }
    ExitCode::SUCCESS
}

/// 写一条 JSON-RPC 响应（error 与 result 互斥；id 可缺省）并冲刷
fn respond(out: &mut impl Write, id: &Option<Value>, error: Option<Value>, result: Option<Value>) {
    let mut message = Map::new();
    message.insert("jsonrpc".to_string(), json!("2.0"));
    if let Some(id) = id {
        message.insert("id".to_string(), id.clone());
    }
    if let Some(error) = error {
        message.insert("error".to_string(), error);
    }
    if let Some(result) = result {
        message.insert("result".to_string(), result);
    }
    let _ = writeln!(out, "{}", Value::Object(message));
    let _ = out.flush();
}
