//! conex-browser-tools —— 软件内 AI 协同浏览器的 browser_* 工具族（维度 17，M7）
//!
//! ## 定位与依赖方向
//! 本 crate 是浏览器工具族的注册与执行面，依赖方向合规（agent-tools 是叶子：
//! crates/agent-tools/src/tools/mod.rs 头注释）：消费 `agent-tools` 的
//! `Tool`/`ToolDefinition`/`ToolContext`/`ToolRegistry` pub 接口与 `conex-browser`
//! 的 `BrowserSession`/`ActionExecutor`/`SnapshotManager`/`DomainGate` pub 导出，
//! **不反向进入** agent-tools 的 `register_builtin_tools`（该函数有注册数断言，
//! tools/mod.rs:718-756，不可扰动）——本 crate 提供**后置注册函数**
//! [register_browser_tools]，经 `ToolRegistry::register_runtime`（&self 共享面，
//! registry.rs:41）并入运行集。
//!
//! ## 命名空间隔离（17 §5.1）
//! 自研工具统一 `browser_*` 前缀，与 MCP 桥 `mcp_<server>__*` 天然互斥：注册表
//! 内无键冲突，同名返回 `tool.version_conflict` 的保护同样生效；注册次序与 MCP
//! 工具无依赖（`register_runtime` 幂等跳过已并入的同名项）。外部 MCP 与自研工具
//! 共存注册、模型同时可见两族工具、名称无歧义（08 §5 S9 验收口径）。
//! 实测（34-MCPattach验证.md）：chrome-devtools-mcp 1.6.0 枚举 29 个工具（新版
//! 工具面 `take_snapshot`/`list_console_messages`/`evaluate_script` 等，无
//! `browser_*` 前缀），经桥适配为 `mcp_<server>__*` 后与自研工具零冲突。
//!
//! ## MCP 并存规则（17 §5.2/§5.3，R-12 只读能力集）
//! - attach 型外部浏览器类 MCP（chrome-devtools-mcp 族）经 `--browserUrl`
//!   `http://127.0.0.1:<随机端口>` 附加受管实例 CDP 端点（DevToolsActivePort
//!   双层不透明 token：随机端口 + WS path uuid，会话存活期间开放）；
//! - 权限独立：自研 `browser_*` 走本 crate 分级表；MCP 工具不继承浏览器分级，
//!   维持既有适配现状 `dangerous: false`（bridge.rs），权限由「用户显式配置该
//!   MCP server」的信任面承载；
//! - **只读能力集（R-12）**：attach 会话下，引擎侧 CDP 会话面仅授予只读命令域
//!   （snapshot/screenshot/console/network 对应域）；交互/求值类（Input 注入、
//!   evaluate、cookie 全量读写）按既有权限矩阵审批且**默认拒绝**——外部 MCP
//!   默认视为只读，如需交互由用户显式配置该 server 时知晓；attach 允许与否由
//!   会话级开关 [BrowserToolsConfig::mcp_attach_allowed] 控制（默认关闭）；
//! - 冲突规避：两族工具共享同一实例/同一 DOM，但快照索引不互通（MCP 用自家
//!   uid、自研用 snapshotVersion 绑定索引），模型侧由命名空间区分。
//!
//! ## 工具清单（MVP 子集 23 个，R-13 §8.2 第 7 项）
//! - 导航 8（dangerous=false）：navigate/back/forward/reload/list_tabs/new_tab/
//!   close_tab/switch_tab；
//! - 感知 5（dangerous=false）：snapshot/screenshot/wait_for/get_url/get_title；
//! - 交互 8（全 dangerous=true，Ask 审批）：click/type/key/scroll/hover/drag/
//!   select_option/upload；
//! - 调试 2（dangerous=false，只读）：console/network。
//!
//! **未注册（MVP 边界）**：`browser_evaluate`（17 §3 白名单面 P1 落地；执行路径
//! 未接线错误构造见 `error::unwired`）与剪贴板 2（面板 UI 桥，M-7/U-8，P1）。
//!
//! ## 会话访问模型（构造注入）
//! 工具经 [BrowserToolsConfig] 注入 `Option<Arc<BrowserSession>>`（+ 可选
//! `BrowserManager`/门禁/预算）；未注入或恢复期（进程 Launching/Crashed，R-9）
//! 时全部工具返回结构化 `tool.browser.not_ready`（17 §1.3 码表）。会话消费经
//! `session::SessionOps` 适配层（真实实现仅用 conex-browser pub 接口，测试注入
//! mock 替身）。
//!
//! ## 权限体系（不改动）
//! 危险分级经 `ToolDefinition.dangerous` 标记 + agent-tools 既有 PermissionMode
//! 体系（Ask/FullAccess/Plan，permission.rs 三态）判定；upload 另有默认拒绝
//! 能力位（`SensitiveCapabilities.upload`，17 §2.3 红线语义，任何模式直接 Deny）。

pub mod codes;
mod error;
mod exec;
/// MVP 域名门禁（pub：引擎侧 LazySessionOps 装配 RealSession 时复用同一
/// 实现实例，与工具注册注入的门禁同源，27 接线方案 S3）
pub mod gate;
mod helpers;
/// 发送层策略钩子 MVP 实现（27 §2.4 D-D：AllowAllPolicy；引擎 connect 注入）
pub mod policy;
pub mod session;
mod tools;

use agent_tools::definition::ToolError;
use agent_tools::registry::ToolRegistry;
use conex_browser::action::gate::DomainGate;
use conex_browser::browser::BrowserManager;
use conex_browser::snapshot::budget::BudgetConfig;
use conex_browser::BrowserSession;
use session::SessionOps;
use std::sync::Arc;

/// 标签数量上限默认值（15 文档 §7.3 MAX_TABS 裁决：默认 8，可配 1-16）。
pub const DEFAULT_MAX_TABS: usize = 8;
/// 标签数量上限配置范围（15 §7.3：1-16，16 以上不开放——超出即触顶）。
pub const MAX_TABS_RANGE: std::ops::RangeInclusive<usize> = 1..=16;

/// 会话级敏感能力开关（17 §2.3 默认拒绝面：默认全关 = 兜底拒绝，红线语义；
/// 开启仅能由用户经会话设置显式授权，Agent 无权自开）。
#[derive(Debug, Clone, Default)]
pub struct SensitiveCapabilities {
    /// evaluate 能力位（MVP 未注册 browser_evaluate，P1 落地后生效）
    pub evaluate: bool,
    /// upload 能力位（browser_upload 默认拒绝面）
    pub upload: bool,
    /// clipboard 能力位（剪贴板工具 P1 接线）
    pub clipboard: bool,
}

/// 浏览器工具注册配置（引擎侧会话装配时注入，17 §1.4）。
///
/// - `sensitive`：敏感能力开关（默认全关）；
/// - `budgets`：快照预算（缺省 [BudgetConfig::active] 全额预算）；
/// - `max_tabs`：标签数量上限（15 文档 §7.3 MAX_TABS 裁决：缺省 8，范围 1-16；
///   超限 new_tab 返回 `tool.browser.tab_limit_exceeded`，U-12 码）；
/// - `session_ops`：会话操作层直接注入（测试替身/引擎高级接线；优先于 `session`，
///   经 `session::SessionOps` trait 面）；
/// - `mcp_attach_allowed`：attach 型外部浏览器类 MCP 的**会话级开关**（R-12，
///   默认 false）。开启后引擎才允许把受管实例 CDP 端点（`http://127.0.0.1:<port>`，
///   17 §5.3）注入外部浏览器类 MCP（chrome-devtools-mcp 族）的启动参数/env
///   （`McpServerConfig.args/env`）；**未开启时引擎不向任何外部 MCP 暴露受管
///   端点信息**（引擎侧接线点：session 装配/面板开关处读取本字段，engine.rs
///   不在此 crate——接线登记见 34-MCPattach验证.md §5）。
#[derive(Clone, Default)]
pub struct BrowserToolsConfig {
    pub session: Option<Arc<BrowserSession>>,
    pub manager: Option<Arc<BrowserManager>>,
    pub gate: Option<Arc<dyn DomainGate>>,
    pub gate_allowlist: Vec<String>,
    pub gate_blocklist: Vec<String>,
    pub sensitive: SensitiveCapabilities,
    pub budgets: Option<BudgetConfig>,
    pub max_tabs: Option<usize>,
    pub session_ops: Option<Arc<dyn SessionOps>>,
    /// attach 型外部浏览器类 MCP 会话级开关（R-12，默认 false）
    pub mcp_attach_allowed: bool,
}

/// 注册全部 23 个 browser_* 工具（后置注册函数，**不进入** agent-tools 的
/// `register_builtin_tools`）。
///
/// 幂等语义（17 §1.4）：同名工具已注册（MCP/引擎预注册）时跳过，不报冲突；
/// 配置非法（门禁模式非法等）返回结构化错误。
pub fn register_browser_tools(
    registry: &mut ToolRegistry,
    config: BrowserToolsConfig,
) -> Result<(), ToolError> {
    // 门禁解析：显式注入优先；缺省用 MVP 实现（配置校验期拒绝非法模式）
    let gate: Arc<dyn DomainGate> = match config.gate {
        Some(g) => g,
        None => Arc::new(
            gate::MvpDomainGate::new(&config.gate_allowlist, &config.gate_blocklist)
                .map_err(|e| ToolError::invalid_input(format!("门禁配置非法：{e}")))?,
        ),
    };
    let budgets = config.budgets.unwrap_or_else(BudgetConfig::active);
    // MAX_TABS 上限校验（15 §7.3：1-16 配置范围；非法配置注册期拒绝）
    let max_tabs = config.max_tabs.unwrap_or(DEFAULT_MAX_TABS);
    if !MAX_TABS_RANGE.contains(&max_tabs) {
        return Err(ToolError::invalid_input(format!(
            "max_tabs 超出范围（1..16），收到 {max_tabs}"
        )));
    }
    // 会话注入：测试/引擎接线面（session_ops）优先，其次构造注入的 BrowserSession
    let session: Option<Arc<dyn SessionOps>> = match config.session_ops {
        Some(ops) => Some(ops),
        None => config.session.map(|s| {
            Arc::new(session::RealSession::new(
                s,
                config.manager.clone(),
                gate.clone(),
                budgets,
            )) as Arc<dyn SessionOps>
        }),
    };
    let ctx = Arc::new(tools::Ctx {
        session,
        gate,
        sensitive: config.sensitive,
        budgets,
        max_tabs,
    });
    tools::register_all(registry, ctx)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R-12 安全默认：attach 开关默认关闭（会话级，未显式授权不向外部 MCP
    /// 暴露受管端点信息）。
    #[test]
    fn mcp_attach_allowed_defaults_false() {
        let config = BrowserToolsConfig::default();
        assert!(
            !config.mcp_attach_allowed,
            "attach 型 MCP 会话级开关必须默认关闭（R-12 安全默认）"
        );
        // 结构体更新语法不破坏其它默认值（回归面）
        let rest = BrowserToolsConfig {
            mcp_attach_allowed: true,
            ..BrowserToolsConfig::default()
        };
        assert!(rest.mcp_attach_allowed);
        assert!(!rest.sensitive.evaluate, "其余字段不受影响");
    }

    /// 开关不参与注册面：开启与否均不影响 24 个工具注册（该字段由引擎侧
    /// 会话装配消费，注册函数无需感知）。
    #[test]
    fn mcp_attach_allowed_does_not_affect_registration() {
        for allowed in [false, true] {
            let mut registry = ToolRegistry::new();
            let config = BrowserToolsConfig {
                mcp_attach_allowed: allowed,
                ..BrowserToolsConfig::default()
            };
            register_browser_tools(&mut registry, config).expect("注册应成功");
            assert_eq!(
                registry.len(),
                24,
                "注册数不随 attach 开关变化（allowed={allowed}）"
            );
        }
    }
}
