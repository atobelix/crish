//! **W4-D** Strict 子集：MCP 外壳 · **同一 ToolRegistry**
//!
//! # 目标
//! 把本地 [`ToolRegistry`] 以 MCP 协议形状暴露为 `tools/list` / `tools/call`
//! 外壳，使笔记工具（`query_blocks` / `block_batch` 等）与 fs/shell 等**同池**
//! 可见、可调用——**列出与调用路径均以 registry 为唯一真相源**。
//!
//! # 与既有 mcp 面的分工
//! | 模块 | 方向 | 角色 |
//! |------|------|------|
//! | `bridge` | 外→内 | 远端 MCP server 工具适配进 **同一** registry（`mcp_<server>__*`） |
//! | **`shell`（本模块）** | 内→外 | 本地 registry 以 MCP 形状列出 / 调用（笔记工具原生名） |
//! | `servers` | 配置 | 外挂 MCP server 配置表 |
//!
//! # 不变量（可证伪）
//! 1. **list ≡ registry**：`list_tool_names()` 集合 == `registry.list_definitions()` 名集
//! 2. **未注册不可偷创**：`call_tool("never_registered_…")` → `tool.not_found`，
//!    且不会把该名写回 registry
//! 3. **可见性 ≡ has**：`has_tool(n) == registry.has(n)`
//!
//! # 诚实边界（强制 · 禁止假关）
//! - **≠** 生产 MCP 全网关完成（无完整 stdio 服务端进程、resources/prompts、
//!   认证、分页 cursor、list_changed 通知）
//! - **≠** EL-05 / EL-07 关闭（须 W4-B + W6-E 等，见 plans/08）
//! - **≠** W6-E 千次批 + 恶意扩展闭环
//! - Memory 测绿 **禁关**生产 A-AGT
//! - 不回退既有 bridge / note_* 工具测；不破坏 **W6-E-S**
//!
//! # 执行纪律
//! 调用面直接 `registry.get` → `Tool::execute`；**不**旁路 session-loop
//! 中间件装配（装配由调用方在 ToolContext / 上层 executor 完成）。
//! 本外壳只保证「能调的名字必须已在 registry」。

use crate::context::ToolContext;
use crate::definition::{ToolDefinition, ToolError};
use crate::mcp::bridge::McpToolInfo;
use crate::registry::ToolRegistry;
use serde_json::{json, Map, Value};
use std::sync::Arc;

/// **W4-D** 包标识（测 / 文档 / 调度对账）
pub const W4D_MCP_SHELL_PACKAGE_ID: &str = "W4-D";

/// MCP 外壳：绑定一个 [`ToolRegistry`]，暴露 tools/list · tools/call 形状。
///
/// 持有 `Arc<ToolRegistry>`，与 Agent 工具执行面共享同一实例即可保证
/// 「MCP 面列出的笔记工具 ≡ 工具面已注册行」。
#[derive(Clone)]
pub struct McpRegistryShell {
    registry: Arc<ToolRegistry>,
}

impl McpRegistryShell {
    /// 绑定 registry（通常与 builtin 注册 / MCP bridge 后置注册共用同一 Arc）
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self { registry }
    }

    /// 绑定的 registry 引用（观测 / 测试对账）
    pub fn registry(&self) -> &Arc<ToolRegistry> {
        &self.registry
    }

    /// 是否在 MCP 面可见（≡ `registry.has`；未注册不可见）
    pub fn has_tool(&self, name: &str) -> bool {
        self.registry.has(name)
    }

    /// MCP 面工具名列表（按 name 升序，与 `list_definitions` 序一致）
    pub fn list_tool_names(&self) -> Vec<String> {
        self.registry
            .list_definitions()
            .into_iter()
            .map(|d| d.name)
            .collect()
    }

    /// 工具定义 → MCP Tool 声明（`McpToolInfo`）
    ///
    /// 名称保持 registry 原生名（笔记工具为 `block_batch` 等，**不**加
    /// `mcp_` 前缀——前缀仅用于外挂 MCP 工具并入本地表时防冲突）。
    pub fn definition_to_mcp_tool(def: &ToolDefinition) -> McpToolInfo {
        McpToolInfo {
            name: def.name.clone(),
            description: def.description.clone(),
            input_schema: def.effective_input_schema().clone(),
        }
    }

    /// MCP `tools/list` 结果形状：`{ "tools": [ { name, description, inputSchema } ] }`
    ///
    /// 仅含 registry 已注册工具；含笔记工具时即可在 MCP 面点名可见。
    pub fn list_tools(&self) -> Value {
        let tools: Vec<Value> = self
            .registry
            .list_definitions()
            .iter()
            .map(|def| {
                let info = Self::definition_to_mcp_tool(def);
                // MCP 规范字段：inputSchema（camelCase），与 bridge 解析侧对齐
                json!({
                    "name": info.name,
                    "description": info.description,
                    "inputSchema": info.input_schema,
                })
            })
            .collect();
        json!({ "tools": tools })
    }

    /// 按名取 MCP Tool 声明；未注册 → None（不可偷创）
    pub fn get_mcp_tool(&self, name: &str) -> Option<McpToolInfo> {
        self.registry
            .get(name)
            .map(|t| Self::definition_to_mcp_tool(t.definition()))
    }

    /// MCP `tools/call`：仅 registry 已注册可执行
    ///
    /// - 未注册 → `tool.not_found`（**禁止**偷偷创造并执行）
    /// - 成功 → MCP CallToolResult 形状（`content` + 可选 `structuredContent`）
    /// - 工具执行失败 → 仍返回 `Ok` 且 `isError=true`（MCP 语义：call 协议
    ///   成功、工具业务失败）；协议层错误（未注册）走 `Err`
    pub async fn call_tool(
        &self,
        ctx: &ToolContext,
        name: &str,
        args: Value,
    ) -> Result<Value, ToolError> {
        let tool = self
            .registry
            .get(name)
            .ok_or_else(|| ToolError::not_found(name))?;
        match tool.execute(ctx, args).await {
            Ok(output) => Ok(tool_output_to_call_result(&output, false)),
            Err(e) => {
                // 业务失败：MCP CallToolResult.isError=true（非协议错误）
                Ok(tool_output_to_call_result(
                    &json!({ "error": e.to_string(), "code": e.code() }),
                    true,
                ))
            }
        }
    }
}

/// 本地工具输出 → MCP CallToolResult 最小形状
///
/// - text：`stringify` 风格整包 JSON 文本段
/// - structuredContent：原 JSON 对象（机器可读）
/// - isError：业务失败标记
fn tool_output_to_call_result(output: &Value, is_error: bool) -> Value {
    let text = match output {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let mut map = Map::new();
    map.insert(
        "content".to_string(),
        json!([{ "type": "text", "text": text }]),
    );
    map.insert("isError".to_string(), json!(is_error));
    // 非 null 输出进 structuredContent，便于调用方取结构化字段
    if !output.is_null() {
        map.insert("structuredContent".to_string(), output.clone());
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::create_mock_tool_context;
    use crate::test_support::EchoTool;
    use crate::tools::register_builtin_tools;
    use std::sync::Arc;

    fn echo_reg(names: &[&str]) -> Arc<ToolRegistry> {
        let mut reg = ToolRegistry::new();
        for n in names {
            reg.register(Arc::new(EchoTool::new(*n))).unwrap();
        }
        Arc::new(reg)
    }

    fn builtin_shell() -> McpRegistryShell {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        McpRegistryShell::new(Arc::new(reg))
    }

    /// W4-D：内置注册后面，笔记工具名在 MCP list 面可见（可证伪）
    #[test]
    fn w4d_note_tools_visible_on_mcp_list_surface() {
        let shell = builtin_shell();
        let names = shell.list_tool_names();
        // 至少点名若干 note 工具（读 + 写 + batch）
        for note in [
            "query_blocks",
            "document_outline",
            "document_get_md",
            "document_apply_md",
            "send_to_note",
            "block_batch",
            "block_insert",
            "block_update",
            "block_delete",
            "block_move",
        ] {
            assert!(
                names.iter().any(|n| n == note),
                "MCP 面应可见已注册笔记工具 {note}；names={names:?}"
            );
            assert!(shell.has_tool(note), "has_tool({note}) 应 true");
            let info = shell.get_mcp_tool(note).expect("get_mcp_tool 应 Some");
            assert_eq!(info.name, note);
            assert!(
                !info.description.is_empty() || info.input_schema.is_object(),
                "{note} 应有描述或 schema"
            );
        }

        // list_tools JSON 形状
        let listed = shell.list_tools();
        let tools = listed["tools"].as_array().expect("tools 数组");
        assert!(
            tools.iter().any(|t| t["name"] == "block_batch"),
            "tools/list 载荷须含 block_batch"
        );
        assert!(
            tools.iter().any(|t| t["name"] == "query_blocks"),
            "tools/list 载荷须含 query_blocks"
        );
        // 包锚可对账
        assert_eq!(W4D_MCP_SHELL_PACKAGE_ID, "W4-D");
    }

    /// list 名集与 registry.list_definitions 严格一致（同一 registry）
    #[test]
    fn w4d_list_names_match_registry_definitions() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        let reg = Arc::new(reg);
        let shell = McpRegistryShell::new(Arc::clone(&reg));

        let from_shell = shell.list_tool_names();
        let from_reg: Vec<String> = reg.list_definitions().into_iter().map(|d| d.name).collect();
        assert_eq!(
            from_shell, from_reg,
            "MCP list 必须与 registry 定义名完全一致"
        );
    }

    /// 未注册工具：list 不可见、call 拒绝、不偷偷写入 registry
    #[tokio::test]
    async fn w4d_unregistered_tool_cannot_be_invented_via_mcp() {
        let reg = echo_reg(&["echo"]);
        let shell = McpRegistryShell::new(Arc::clone(&reg));
        let ghost = "note_ghost_tool_never_registered_w4d";

        assert!(!shell.has_tool(ghost));
        assert!(shell.get_mcp_tool(ghost).is_none());
        assert!(!shell.list_tool_names().iter().any(|n| n == ghost));
        let tools = shell.list_tools()["tools"].as_array().unwrap().clone();
        assert!(!tools.iter().any(|t| t["name"] == ghost));

        let err = shell
            .call_tool(&create_mock_tool_context(), ghost, json!({}))
            .await
            .expect_err("未注册须 Err(tool.not_found)");
        assert_eq!(err.code(), "tool.not_found");
        assert!(err.to_string().contains(ghost));

        // 调用失败后 registry 仍无该名（禁止偷创）
        assert!(!reg.has(ghost));
        assert_eq!(reg.len(), 1);
        assert!(shell.has_tool("echo"));
    }

    /// 已注册工具经 MCP call 路径可执行（同 registry 转发）
    #[tokio::test]
    async fn w4d_registered_tool_callable_via_mcp_shell() {
        let reg = echo_reg(&["echo"]);
        let shell = McpRegistryShell::new(reg);
        let out = shell
            .call_tool(
                &create_mock_tool_context(),
                "echo",
                json!({ "msg": "w4d-shell" }),
            )
            .await
            .unwrap();
        assert_eq!(out["isError"], false);
        assert!(out["structuredContent"]["echo"]["msg"]
            .as_str()
            .unwrap()
            .contains("w4d-shell"));
        let text = out["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("w4d-shell"));
    }

    /// 空 registry：list 为空数组；任意 call 均 not_found
    #[tokio::test]
    async fn w4d_empty_registry_lists_nothing() {
        let shell = McpRegistryShell::new(Arc::new(ToolRegistry::new()));
        assert!(shell.list_tool_names().is_empty());
        assert_eq!(shell.list_tools()["tools"].as_array().unwrap().len(), 0);
        let err = shell
            .call_tool(&create_mock_tool_context(), "block_batch", json!({}))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.not_found");
    }

    /// definition_to_mcp_tool 字段映射（inputSchema / 描述）
    #[test]
    fn w4d_definition_to_mcp_tool_maps_schema() {
        let def = ToolDefinition {
            name: "block_batch".into(),
            description: "批 ops".into(),
            input_schema: json!({ "type": "object", "properties": { "ops": {} } }),
            dangerous: true,
            fatal_on_error: false,
        };
        let info = McpRegistryShell::definition_to_mcp_tool(&def);
        assert_eq!(info.name, "block_batch");
        assert_eq!(info.description, "批 ops");
        assert_eq!(info.input_schema["properties"]["ops"], json!({}));
    }

    /// 笔记工具经 MCP call 转发同一 registry 实现（未接线 → 稳定占位 JSON）
    #[tokio::test]
    async fn w4d_note_tool_call_via_shell_same_registry() {
        let shell = builtin_shell();
        let out = shell
            .call_tool(
                &create_mock_tool_context(),
                "query_blocks",
                json!({ "doc_id": "d1" }),
            )
            .await
            .expect("已注册 note 工具协议层应 Ok");
        // unwired 占位为业务成功返回 ok=false，非 isError 协议失败
        assert_eq!(out["isError"], false);
        assert_eq!(out["structuredContent"]["reason"], "note_backend_unwired");
        assert_eq!(out["structuredContent"]["ok"], false);
    }

    /// 工具入参非法（Err）→ CallToolResult isError=true，协议层仍 Ok
    #[tokio::test]
    async fn w4d_tool_invalid_input_maps_to_is_error_true() {
        let shell = builtin_shell();
        // query_blocks 缺 doc_id → tool.invalid_input
        let out = shell
            .call_tool(&create_mock_tool_context(), "query_blocks", json!({}))
            .await
            .expect("协议层应 Ok（业务失败用 isError）");
        assert_eq!(out["isError"], true);
        assert_eq!(out["structuredContent"]["code"], "tool.invalid_input");
    }
}
