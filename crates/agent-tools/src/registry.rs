//! 工具注册表（对齐 TS 端 tool-registry.ts / tools/tool-definition.ts 的 ToolRegistry 语义）

use crate::definition::{Tool, ToolDefinition, ToolError};
use conex_types::error::codes;
use std::collections::HashMap;
use std::sync::Arc;

/// 工具注册表
///
/// 语义对齐 TS ToolRegistry：
/// - register：同名重复注册返回类型化错误（TS 抛 Duplicate tool registered）
/// - get/has：按名查找（未知工具返回 None，由执行器转 tool.not_found）
/// - list：按注册顺序返回（TS Map 插入序）
///
/// 内部为 HashMap 加速查找 + order Vec 保序。
#[derive(Default)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
    order: Vec<String>,
}

impl ToolRegistry {
    /// 空注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册工具
    ///
    /// 同名已注册返回错误（tool.version_conflict 域内冲突码）。
    pub fn register(&mut self, tool: Arc<dyn Tool>) -> Result<(), ToolError> {
        let name = tool.name().to_string();
        if self.tools.contains_key(&name) {
            return Err(ToolError::new(
                codes::TOOL_VERSION_CONFLICT,
                format!("工具重复注册：{name}"),
            ));
        }
        self.tools.insert(name.clone(), tool);
        self.order.push(name);
        Ok(())
    }

    /// 按名查找，未注册返回 None
    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// 是否已注册
    pub fn has(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// 按注册顺序列出全部工具
    pub fn list(&self) -> Vec<Arc<dyn Tool>> {
        self.order
            .iter()
            .filter_map(|n| self.tools.get(n).cloned())
            .collect()
    }

    /// 按注册顺序列出工具定义（对齐 TS resolveForLLM 的消费面）
    pub fn list_definitions(&self) -> Vec<ToolDefinition> {
        self.list()
            .iter()
            .map(|t| t.definition().clone())
            .collect()
    }

    /// 注销工具，返回是否注销成功
    pub fn unregister(&mut self, name: &str) -> bool {
        if self.tools.remove(name).is_none() {
            return false;
        }
        self.order.retain(|n| n != name);
        true
    }

    /// 已注册工具数量
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::EchoTool;
    use serde_json::json;

    fn echo(name: &str) -> Arc<dyn Tool> {
        Arc::new(EchoTool::new(name))
    }

    #[test]
    fn register_and_get() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("echo")).unwrap();
        assert!(reg.has("echo"));
        let tool = reg.get("echo").expect("注册后应可查得");
        assert_eq!(tool.name(), "echo");
        assert_eq!(tool.definition().name, "echo");
        assert_eq!(reg.len(), 1);
        assert!(!reg.is_empty());
    }

    #[test]
    fn duplicate_registration_returns_error() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("echo")).unwrap();
        let err = reg.register(echo("echo")).unwrap_err();
        assert_eq!(err.to_error_payload(0).code, "tool.version_conflict");
        assert!(err.to_string().contains("重复注册"));
        // 重复注册失败后原工具仍可查得
        assert!(reg.has("echo"));
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn list_preserves_registration_order() {
        let mut reg = ToolRegistry::new();
        for name in ["read", "write", "search"] {
            reg.register(echo(name)).unwrap();
        }
        let names: Vec<String> = reg.list().iter().map(|t| t.name().to_string()).collect();
        assert_eq!(names, ["read", "write", "search"]);
    }

    #[test]
    fn get_unknown_returns_none() {
        let reg = ToolRegistry::new();
        assert!(reg.get("nope").is_none());
        assert!(!reg.has("nope"));
    }

    #[test]
    fn unregister_removes_tool() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("echo")).unwrap();
        reg.register(echo("other")).unwrap();
        assert!(reg.unregister("echo"));
        assert!(!reg.has("echo"));
        assert!(!reg.unregister("echo"));
        // 注销不影响其余工具的顺序
        let names: Vec<String> = reg.list().iter().map(|t| t.name().to_string()).collect();
        assert_eq!(names, ["other"]);
        assert_eq!(reg.len(), 1);
    }

    #[test]
    fn list_definitions_in_order_with_schema() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("a")).unwrap();
        reg.register(echo("b")).unwrap();
        let defs = reg.list_definitions();
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].name, "a");
        assert_eq!(defs[1].name, "b");
        // 定义序列化为 camelCase，可作 provider 工具列表载荷
        let v = serde_json::to_value(&defs[0]).unwrap();
        assert_eq!(v["name"], "a");
        assert_eq!(v["description"], "回显入参");
        assert_eq!(v["inputSchema"], json!({ "type": "object", "properties": {} }));
        assert_eq!(v["dangerous"], false);
    }

    #[tokio::test]
    async fn registered_tool_executes_end_to_end() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("echo")).unwrap();
        let tool = reg.get("echo").unwrap();
        let out = tool.execute(json!({ "msg": "闭环" })).await.unwrap();
        assert_eq!(out, json!({ "echo": { "msg": "闭环" } }));
    }
}
