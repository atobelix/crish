//! 工具注册表（对齐 TS 端 tool-registry.ts / tools/tool-definition.ts 的 ToolRegistry 语义）
//!
//! ## E2 统一门面登记（统一输入流收敛 · 扩展门面详案 §1①）
//!
//! **已登记为 canonical**：`ToolRegistry` 是 Rust 引擎侧工具接入的**唯一登记面**
//! （引擎侧插件运行时 = ToolRegistry + register_runtime + register_plugin_server
//! 统一门面）——内置工具（register_builtin_tools）、浏览器 `browser_*`、
//! 电脑 `computer_*`、MCP `mcp_<server>__<tool>` 全部经本注册表并入运行集：
//! - `register`（&mut 面，:40）/ `register_runtime`（&self 共享面，:49）为两个
//!   登记入口；MCP 工具经 `crate::mcp::register_plugin_server`（canonical 出口）
//!   适配为 `Tool` 后走 `register_runtime` 并入同一注册表；
//! - `list_definitions`（:162）为定义改写链（ToolMiddleware::on_definition）
//!   消费面，与执行侧共享构建点。
//! 不改结构：本登记为注释级（门面 = 文档登记 + 装配点登记，不新增组件）。

use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::middleware::ToolMiddleware;
use conex_types::error::codes;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 工具注册表
///
/// 语义对齐 TS ToolRegistry：
/// - register：同名重复注册返回类型化错误（TS 抛 Duplicate tool registered）
/// - get/has：按名查找（未知工具返回 None，由执行器转 tool.not_found）
/// - list：按注册顺序返回（TS Map 插入序）
/// - list_definitions：按 name 升序 + 定义改写链（E4 on_definition）
///
/// 内部为 HashMap 加速查找 + order Vec 保序；E4/E5 起内部经 Mutex 提供
/// 线程安全（注册表以 `Arc<ToolRegistry>` 跨线程共享，执行器只读、插件/
/// MCP 运行集可后置注册）——`register` 保持 `&mut self` 签名兼容既有
/// 调用方，新增 `register_runtime` 支持 &self 后置注册（`Tool` 已约束
/// Send + Sync，锁内无 await、持锁时间短，无死锁面）。
#[derive(Default)]
pub struct ToolRegistry {
    tools: Mutex<HashMap<String, Arc<dyn Tool>>>,
    order: Mutex<Vec<String>>,
    /// 定义改写链（E4：ToolMiddleware::on_definition，list_definitions
    /// 构建点时顺序改写；空链 = 无改写，行为与现状一致）
    definition_transformers: Mutex<Vec<Arc<dyn ToolMiddleware>>>,
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
        self.register_runtime(tool)
    }

    /// 后置注册工具（&self 共享面；E2 插件工具 / E5 MCP 工具并入运行集）
    ///
    /// 语义与 [Self::register] 一致：同名冲突返回 tool.version_conflict。
    /// 线程安全：注册表内部锁保护，可经 `Arc<ToolRegistry>` 跨线程并发
    /// 注册（get/list 读路径同锁互斥，不产生半可见状态）。
    pub fn register_runtime(&self, tool: Arc<dyn Tool>) -> Result<(), ToolError> {
        let name = tool.name().to_string();
        let mut tools = self.tools.lock().unwrap_or_else(|e| {
            // PE-07 T07.6 A 模式：锁中毒恢复，不 panic 且可继续注册
            tracing::error!("工具注册表 tools 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        if tools.contains_key(&name) {
            return Err(ToolError::new(
                codes::TOOL_VERSION_CONFLICT,
                format!("工具重复注册：{name}"),
            ));
        }
        tools.insert(name.clone(), tool);
        drop(tools);
        self.order
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 order 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .push(name);
        Ok(())
    }

    /// 按名查找，未注册返回 None
    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 tools 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .get(name)
            .cloned()
    }

    /// 是否已注册
    pub fn has(&self, name: &str) -> bool {
        self.tools
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 tools 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .contains_key(name)
    }

    /// 按注册顺序列出全部工具
    pub fn list(&self) -> Vec<Arc<dyn Tool>> {
        let names: Vec<String> = self
            .order
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 order 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .clone();
        let tools = self.tools.lock().unwrap_or_else(|e| {
            tracing::error!("工具注册表 tools 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        names.iter().filter_map(|n| tools.get(n).cloned()).collect()
    }

    /// 装配定义改写链（E4 on_definition；替换现有链；空链 = 不启用）。
    ///
    /// 改写链挂 `list_definitions` 构建点——引擎给 provider 发 schema 前
    /// 统一改写（与四维过滤的未来点位共享）；执行侧不改动（工具实际
    /// 执行仍走原定义）。
    pub fn with_definition_transformers(self, chain: Vec<Arc<dyn ToolMiddleware>>) -> Self {
        *self.definition_transformers.lock().unwrap_or_else(|e| {
            tracing::error!("工具注册表 definition_transformers 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        }) = chain;
        self
    }

    /// 追加一个定义改写中间件（&self 共享面；插件工具改写注册用）
    pub fn add_definition_transformer(&self, mw: Arc<dyn ToolMiddleware>) {
        self.definition_transformers
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 definition_transformers 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .push(mw);
    }

    /// 已配置的定义改写中间件数（测试 / 观测）
    pub fn definition_transformer_count(&self) -> usize {
        self.definition_transformers
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 definition_transformers 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .len()
    }

    /// 按 name 升序列出工具定义（对齐 TS resolveForLLM 的消费面）
    ///
    /// P1：按 name 升序排序输出——tools 数组是请求前缀的一部分，
    /// 注册序（代码书写序/插件加载序）可能漂移，名称序在进程重启间稳定
    /// （对齐 jcode `sort_by(name)`：deterministic ordering is critical
    /// for prompt cache hits）。
    /// 排序规则真源：P6 §3.1 R1——工具定义按 name 升序，排序比较按
    /// UTF-8 码点（`String::cmp` 语义），禁止 localeCompare。
    /// 只排序本函数，不动 `list()`：`list()` 的注册序是执行面语义，
    /// 与请求前缀无关。
    ///
    /// E4：排序后依次经定义改写链（on_definition 按注册序同步改写，
    /// 可改 description 与 input_schema；空链 = 无改写，行为与现状一致）。
    pub fn list_definitions(&self) -> Vec<ToolDefinition> {
        let mut defs: Vec<ToolDefinition> =
            self.list().iter().map(|t| t.definition().clone()).collect();
        defs.sort_by(|a, b| a.name.cmp(&b.name));
        let transformers = self
            .definition_transformers
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 definition_transformers 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .clone();
        for mw in transformers {
            for def in &mut defs {
                mw.on_definition(def);
            }
        }
        defs
    }

    /// 注销工具，返回是否注销成功
    pub fn unregister(&mut self, name: &str) -> bool {
        let mut tools = self.tools.lock().unwrap_or_else(|e| {
            tracing::error!("工具注册表 tools 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        if tools.remove(name).is_none() {
            return false;
        }
        drop(tools);
        self.order
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 order 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .retain(|n| n != name);
        true
    }

    /// 已注册工具数量
    pub fn len(&self) -> usize {
        self.tools
            .lock()
            .unwrap_or_else(|e| {
                tracing::error!("工具注册表 tools 锁中毒，按恢复模式继续：{e}");
                e.into_inner()
            })
            .len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.len() == 0
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
        // PE-07 T07.6：测试断言 expect（cfg(test) 模块，legit 断言，保留）
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
        assert_eq!(
            v["inputSchema"],
            json!({ "type": "object", "properties": {} })
        );
        assert_eq!(v["dangerous"], false);
    }

    #[test]
    fn list_definitions_sorted_by_name_regardless_of_registration_order() {
        let mut reg = ToolRegistry::new();
        // 乱序注册（z,a,m）→ 输出按 name 升序 [a,m,z]（P1 E1；规则真源 P6 R1）
        for name in ["z", "a", "m"] {
            reg.register(echo(name)).unwrap();
        }
        let names: Vec<String> = reg
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        assert_eq!(names, ["a", "m", "z"]);
        // list() 仍保注册序（执行面语义不受排序影响）
        let listed: Vec<String> = reg.list().iter().map(|t| t.name().to_string()).collect();
        assert_eq!(listed, ["z", "a", "m"]);
    }

    #[tokio::test]
    async fn registered_tool_executes_end_to_end() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("echo")).unwrap();
        let tool = reg.get("echo").unwrap();
        let out = tool
            .execute(
                &crate::context::create_mock_tool_context(),
                json!({ "msg": "闭环" }),
            )
            .await
            .unwrap();
        assert_eq!(out, json!({ "echo": { "msg": "闭环" } }));
    }

    // ── E4：list_definitions 触发 on_definition 改写链 ──────────────

    /// 测试用定义改写中间件：给 description 追加后缀（E4 钩子）
    struct SuffixDefinitionMiddleware {
        name: String,
        suffix: String,
    }

    impl crate::middleware::ToolMiddleware for SuffixDefinitionMiddleware {
        fn name(&self) -> &str {
            &self.name
        }

        fn on_definition(&self, def: &mut ToolDefinition) {
            def.description = format!("{}{}", def.description, self.suffix);
        }
    }

    fn suffix_mw(name: &str, suffix: &str) -> Arc<dyn crate::middleware::ToolMiddleware> {
        Arc::new(SuffixDefinitionMiddleware {
            name: name.to_string(),
            suffix: suffix.to_string(),
        })
    }

    /// on_definition 改写生效：list_definitions 输出含改写后的描述
    #[test]
    fn list_definitions_applies_definition_transformers() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("shell_run")).unwrap();
        let reg = reg.with_definition_transformers(vec![suffix_mw("suffixer", "（改写）")]);
        let defs = reg.list_definitions();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "shell_run");
        assert_eq!(defs[0].description, "回显入参（改写）");
        // 原始定义不被改写（改写面只作用于 list_definitions 输出克隆）
        assert_eq!(
            reg.get("shell_run").unwrap().definition().description,
            "回显入参"
        );
    }

    /// 空实现 no-op：无改写中间件时 list_definitions 输出与现状一致
    #[test]
    fn list_definitions_without_transformers_keeps_legacy_output() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("a")).unwrap();
        reg.register(echo("b")).unwrap();
        let defs = reg.list_definitions();
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].name, "a");
        assert_eq!(defs[1].name, "b");
        assert_eq!(defs[0].description, "回显入参");
        assert_eq!(reg.definition_transformer_count(), 0);
    }

    /// 链序确定性：多个改写中间件按注册顺序依次生效（determinism）
    #[test]
    fn definition_transformers_apply_in_order() {
        let mut reg = ToolRegistry::new();
        reg.register(echo("x")).unwrap();
        let reg = reg.with_definition_transformers(vec![
            suffix_mw("first", "|1"),
            suffix_mw("second", "|2"),
        ]);
        let defs = reg.list_definitions();
        assert_eq!(
            defs[0].description, "回显入参|1|2",
            "改写必须按链序顺序生效"
        );
    }

    /// add_definition_transformer 共享面追加（&self；插件运行时用）
    #[test]
    fn add_definition_transformer_appends_to_chain() {
        let reg = ToolRegistry::new();
        assert_eq!(reg.definition_transformer_count(), 0);
        reg.add_definition_transformer(suffix_mw("late", "（late）"));
        assert_eq!(reg.definition_transformer_count(), 1);
        let mut reg2 = ToolRegistry::new();
        reg2.register(echo("y")).unwrap();
        reg2.add_definition_transformer(suffix_mw("late", "（late）"));
        let defs = reg2.list_definitions();
        assert_eq!(defs[0].description, "回显入参（late）");
    }

    // ── E5：register_runtime（&self 后置注册；插件/MCP 工具并入）────

    /// register_runtime 与 register 同语义（同名冲突拒绝、可查可执行）
    #[test]
    fn register_runtime_shares_register_semantics() {
        let reg = ToolRegistry::new();
        reg.register_runtime(echo("echo")).unwrap();
        assert!(reg.has("echo"));
        assert_eq!(reg.len(), 1);
        // 同名冲突 → tool.version_conflict
        let err = reg.register_runtime(echo("echo")).unwrap_err();
        assert_eq!(err.code(), "tool.version_conflict");
        // 注册后顺序可见（list 保序）
        reg.register_runtime(echo("other")).unwrap();
        let names: Vec<String> = reg.list().iter().map(|t| t.name().to_string()).collect();
        assert_eq!(names, ["echo", "other"]);
    }
}
