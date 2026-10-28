//! 子代理定义域（SR-06a 拆分）：角色 / 能力 / 任务类型 / 默认权限集 / 定义注册表 /
//! 三方状态机映射。由父模 `crate::tools::subagent`（门面）`mod defs` 接线。

use std::collections::HashMap;
use std::path::PathBuf;

// 领域模型单一真源 = conex-agents；本模块只做门面重导出与默认权限映射。
pub use conex_agents::task::{
    is_db_status_allowed, SubagentCapabilityMode, SubagentRole, SubagentState, TaskType,
    DB_STATUS_ALLOWED,
};

// ── 子代理角色与能力模式（对齐 shared-types/subagent.ts）──────────

// ── 任务类型与系统默认权限集（T-D-07：REQ-D04 定义扩展）──────────

/// 默认权限集的工具集面（D2-2 按此裁剪工具注册表，fail-closed 白名单语义）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultToolSet {
    /// 只读白名单（复用 readonly.rs:27-34 的 READONLY_TOOL_NAMES 六工具）
    ReadOnlyWhitelist,
    /// 只读白名单 + 仅 write_file（design/review 可产出一份文档）
    ReadOnlyPlusWriteFile,
    /// 全工具集（implementation；写路径沙箱 = 工作区根兜底）
    Full,
    /// 仅 shell_command（commit；命令前缀过滤 git）
    ShellOnly,
}

/// 默认权限集的写路径沙箱面（D2-2 落地为 run 级 WritePolicy 的输入）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultWriteScope {
    /// 无写（analysis）
    None,
    /// 凭证式配额（design/review：granted=true quota=1；目录为会话配置的
    /// 方案文档/评审报告目录，缺省不限制具体目录——对齐 explore_quota
    /// 「配额凭证只能由主 agent 在 spawn 时给出」模式，explore_quota.rs:9-10）
    Quota { granted: bool, quota: usize },
    /// 工作区根（implementation：workspace_root 即天然白名单）
    WorkspaceRoot,
    /// 主 agent 显式给的目录（organization：不配 = 退化为只读，fail-closed）
    MainAgentDirs,
    /// 无写文件工具（commit：只经 shell_command 走 git，不碰文件）
    NoWriteTools,
}

/// 默认权限集的命令策略面（D2-2 按此过滤命令工具；「仅 git / 构建测试
/// 白名单」口径差异见调研-权限传递层.md 开放问题 6.5，评审统一）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultCommandPolicy {
    /// 无命令（analysis/design/review/organization）
    None,
    /// 构建/测试类命令（implementation：语义层 CommandClass 过滤，
    /// 复用 permission.rs:119-121 的 semantics::analyze 分类）
    BuildTest,
    /// 仅 git 前缀命令（commit，T-D-08 细化）
    GitOnly,
}

/// 系统默认权限集（T-D-07：task_type 六枚举各一套「够用」默认，
/// 调研-权限传递层.md §2.2 表落地；**默认值由系统硬编码，主 agent
/// 不用配、也不必知道细节**——文档/UI 只展示 [TaskType::boundary_summary]
/// 的一句话边界）。
///
/// **消费约定（与 D2-2 的字段名契约，T-D-07/08 冻结点）**：D2-2（T-D-08）
/// 在 `write_paths.rs` / `readonly.rs` / `tools/mod.rs` 落地 run 级策略时
/// 按本结构**字段名**消费，不依赖本模块的类型之外的具体策略类型：
/// - `tool_set` → 工具注册表裁剪（白名单 fail-closed）；
/// - `write_scope` → run 级 WritePolicy（Allowed/配额/无写）输入；
/// - `command_policy` → 命令工具过滤（CommandClass 语义层 / git 前缀）。
///
/// 引擎侧（T-D-13）在 spawn 时把「定义显式字段 > 默认集」合并后转成
/// 策略再注册。
///
/// 默认集在会话级 permissionMode 之上叠加：子代理无损继承父会话权限模式
/// （00-总方案 §9.1），默认集只追加工具/写入/命令范围的限制，不得抬高权限。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DefaultPermissions {
    /// 工具集面
    pub tool_set: DefaultToolSet,
    /// 写路径沙箱面
    pub write_scope: DefaultWriteScope,
    /// 命令策略面
    pub command_policy: DefaultCommandPolicy,
}

/// 任务类型 → 系统默认权限集（**纯函数**，六映射固定；调研-权限传递层.md
/// §2.2 表 + 03-D 方案 §3.7 表落地）：
///
/// | task_type | 工具集 | 写路径沙箱 | 命令策略 |
/// | :--- | :--- | :--- | :--- |
/// | analysis | 只读白名单（readonly.rs:27-34 语义） | 无写 | 无命令 |
/// | design | 只读白名单 + 仅 write_file | 方案文档目录（配额凭证式 granted=true quota=1） | 无命令 |
/// | review | 同 design | 评审报告目录（缺省不限制 + 配额 1） | 无命令 |
/// | implementation | 全工具集 | 工作区根（workspace_root 即天然白名单） | 构建/测试类（语义层 CommandClass） |
/// | organization | 只读白名单 + 写 | 主 agent 显式目录（不配 = 退化为只读） | 无命令 |
/// | commit | 仅 shell_command | 无写文件工具 | git 前缀过滤 |
pub fn default_permissions(task_type: TaskType) -> DefaultPermissions {
    match task_type {
        TaskType::Analysis => DefaultPermissions {
            tool_set: DefaultToolSet::ReadOnlyWhitelist,
            write_scope: DefaultWriteScope::None,
            command_policy: DefaultCommandPolicy::None,
        },
        TaskType::Design | TaskType::Review => DefaultPermissions {
            tool_set: DefaultToolSet::ReadOnlyPlusWriteFile,
            write_scope: DefaultWriteScope::Quota {
                granted: true,
                quota: 1,
            },
            command_policy: DefaultCommandPolicy::None,
        },
        TaskType::Implementation => DefaultPermissions {
            tool_set: DefaultToolSet::Full,
            write_scope: DefaultWriteScope::WorkspaceRoot,
            command_policy: DefaultCommandPolicy::BuildTest,
        },
        TaskType::Organization => DefaultPermissions {
            tool_set: DefaultToolSet::ReadOnlyPlusWriteFile,
            write_scope: DefaultWriteScope::MainAgentDirs,
            command_policy: DefaultCommandPolicy::None,
        },
        TaskType::Commit => DefaultPermissions {
            tool_set: DefaultToolSet::ShellOnly,
            write_scope: DefaultWriteScope::NoWriteTools,
            command_policy: DefaultCommandPolicy::GitOnly,
        },
    }
}

// ── 子代理定义与注册表（T-D-07 冻结结构，引擎侧 T-D-13 落位）────

/// 子代理定义（REQ-D04 五项收敛参数 + display_label + model_override
/// 扩展点；TS 契约 SubagentDefinition 的 Rust 投影，shared-types/subagent.ts）
///
/// **参数收敛**（调研-权限传递层.md §3.2）：enable_write_tools /
/// enable_command_tools / enable_mcp_tools / allowed_read_paths **不在
/// 定义中**——前三项由 task_type 默认集派生，读路径默认全工作区可读；
/// 主 agent 配置负担从「逐项决策」降到「（可选的）一处路径」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentDefinition {
    /// 定义唯一标识（agentId，run_subagent 按此检索注册表）
    pub id: String,
    /// 展示名
    pub name: String,
    /// 人读职责描述
    pub description: Option<String>,
    /// 完整系统指令
    pub system_prompt: Option<String>,
    /// 任务类型（可选；缺省 analysis——最安全默认）
    pub task_type: Option<TaskType>,
    /// 显式写路径白名单（可选；硬沙箱输入，覆盖 task_type 默认集）
    pub allowed_write_paths: Option<Vec<PathBuf>>,
    /// 角色展示标签（2-5 字自由文本，仅展示不影响调度；T-D-05）
    pub display_label: Option<String>,
    /// 模型覆盖（扩展点预留，T-D-10 已决策「多模型不做」）：
    /// **不得附带任何消费逻辑**——引擎侧恒不读取；解析/装配全构造点
    /// 显式 None（编译器强制，新增消费即编译断裂）。详见
    /// 「调研-可视化与扩展点.md」§3 与 03-D 方案 §3.10。
    pub model_override: Option<String>,
}

impl SubagentDefinition {
    /// 生效任务类型（缺省 = analysis，最安全，fail-closed）
    pub fn effective_task_type(&self) -> TaskType {
        self.task_type.unwrap_or(TaskType::Analysis)
    }

    /// 生效写路径白名单（**合并语义**：定义显式字段 > task_type 默认集，
    /// 现状分析 §4.4 实施要点 2）。Some = 显式白名单直接生效（越权拒绝
    /// 按此拦截，T-D-08）；None = 不覆盖，引擎侧按 [default_permissions]
    /// 的 write_scope 装配（implementation = 工作区根等）。
    pub fn effective_write_paths(&self) -> Option<Vec<PathBuf>> {
        self.allowed_write_paths.clone()
    }

    /// 生效展示标签（display_label 优先，缺省取 name；前端兜底链
    /// displayLabel → description → mode → id → 子智能体）
    pub fn effective_display_label(&self) -> String {
        self.display_label
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| self.name.clone())
    }
}

/// 定义注册表错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentRegistryError {
    /// 重复 id（拒绝覆盖，防静默替换——定义是主 agent 的声明资产）
    DuplicateId(String),
}

/// 子代理定义注册表（T-D-07 **冻结结构**，引擎侧 T-D-13 落位）。
///
/// 持久化面（F11 T-D-13）：session_meta 或插件 manifest 加载
/// （`subagent.ts:44` 插件面注释已预留）；本模块只提供内存 HashMap 容器
/// 与检索/合并纯函数，不感知持久化介质。「定义后可多次实例化」：
/// agentId 每次解析同一份定义 → 与显式参数合并 → 装配 SpawnRequest，
/// 天然支持多次 spawn。
#[derive(Debug, Clone, Default)]
pub struct SubagentDefinitionRegistry {
    /// 定义容器（key = 定义 id / agentId）
    definitions: HashMap<String, SubagentDefinition>,
}

impl SubagentDefinitionRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self {
            definitions: HashMap::new(),
        }
    }

    /// 注册定义（重复 id 拒绝）
    pub fn register(&mut self, def: SubagentDefinition) -> Result<(), SubagentRegistryError> {
        if self.definitions.contains_key(&def.id) {
            return Err(SubagentRegistryError::DuplicateId(def.id));
        }
        self.definitions.insert(def.id.clone(), def);
        Ok(())
    }

    /// 按 agent_id 检索定义
    pub fn get(&self, agent_id: &str) -> Option<&SubagentDefinition> {
        self.definitions.get(agent_id)
    }

    /// 是否已注册
    pub fn contains(&self, agent_id: &str) -> bool {
        self.definitions.contains_key(agent_id)
    }

    /// 定义数量
    pub fn len(&self) -> usize {
        self.definitions.len()
    }

    /// 是否为空
    pub fn is_empty(&self) -> bool {
        self.definitions.is_empty()
    }
}