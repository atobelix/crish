//! 子代理定义域（SR-06a 拆分）：角色 / 能力 / 任务类型 / 默认权限集 / 定义注册表 /
//! 三方状态机映射。由父模 `crate::tools::subagent`（门面）`mod defs` 接线。

use std::collections::HashMap;
use std::path::PathBuf;

// ── 子代理角色与能力模式（对齐 shared-types/subagent.ts）──────────

/// 子代理角色（对齐 SubagentRole：5 角色，仅展示/过滤标签，不影响调度）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentRole {
    /// 探索类
    Researcher,
    /// 实现类
    Implementer,
    /// 评审类
    Reviewer,
    /// 排障类
    Debugger,
    /// 规划类
    Planner,
}

impl SubagentRole {
    /// 角色字面量（wire 名，snake_case）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Researcher => "researcher",
            Self::Implementer => "implementer",
            Self::Reviewer => "reviewer",
            Self::Debugger => "debugger",
            Self::Planner => "planner",
        }
    }

    /// 从 wire 名解析（未知返回 None）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "researcher" => Some(Self::Researcher),
            "implementer" => Some(Self::Implementer),
            "reviewer" => Some(Self::Reviewer),
            "debugger" => Some(Self::Debugger),
            "planner" => Some(Self::Planner),
            _ => None,
        }
    }
}

/// 子代理能力模式（对齐 SubagentCapabilityMode：4 档，控制实际权限）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentCapabilityMode {
    /// 只读（工具集裁剪见 readonly.rs，M3 挂接）
    ReadOnly,
    /// 读写
    ReadWrite,
    /// 可执行
    Execute,
    /// 全量
    All,
}

impl SubagentCapabilityMode {
    /// 能力模式字面量（wire 名，kebab-case）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::ReadWrite => "read-write",
            Self::Execute => "execute",
            Self::All => "all",
        }
    }

    /// 从 wire 名解析（未知返回 None）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "read-only" => Some(Self::ReadOnly),
            "read-write" => Some(Self::ReadWrite),
            "execute" => Some(Self::Execute),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

// ── 任务类型与系统默认权限集（T-D-07：REQ-D04 定义扩展）──────────

/// 子代理任务类型（对齐 SubagentTaskType，shared-types/subagent.ts）
///
/// 六枚举与 TS 契约一一对应，wire 名 kebab-case。任务类型是**新维度**，
/// 不并入 role / capabilityMode（禁令 21 保持，subagent.ts:8-12）：
/// - role 是展示/过滤标签（不影响调度）；
/// - capabilityMode 是既有能力档（read-only 做工具集裁剪）；
/// - task_type 驱动系统默认权限集（[default_permissions]），缺省 =
///   analysis（最安全，fail-closed，配少不配错）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskType {
    /// 只读调研，不产生任何改动
    Analysis,
    /// 只读 + 可在方案文档目录产出一份设计文档
    Design,
    /// 只读 + 可在评审报告目录产出一份评审报告
    Review,
    /// 可读写工作区 + 常用构建/测试命令
    Implementation,
    /// 只读 + 可在指定文档目录整理/编辑文档
    Organization,
    /// 仅 git 操作，不碰其他
    Commit,
}

impl TaskType {
    /// wire 名（kebab-case，对齐 TS 枚举字面量）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Analysis => "analysis",
            Self::Design => "design",
            Self::Review => "review",
            Self::Implementation => "implementation",
            Self::Organization => "organization",
            Self::Commit => "commit",
        }
    }

    /// 从 wire 名解析（未知返回 None，由调用方报结构化错误）
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "analysis" => Some(Self::Analysis),
            "design" => Some(Self::Design),
            "review" => Some(Self::Review),
            "implementation" => Some(Self::Implementation),
            "organization" => Some(Self::Organization),
            "commit" => Some(Self::Commit),
            _ => None,
        }
    }

    /// 一句话边界（给主 agent / UI 展示用，调研-权限传递层.md §2.2
    /// 第二列；系统默认集的实现细节不暴露）
    pub fn boundary_summary(&self) -> &'static str {
        match self {
            Self::Analysis => "只读调研，不产生任何改动",
            Self::Design => "只读 + 可在方案文档目录产出一份设计文档",
            Self::Review => "只读 + 可在评审报告目录产出一份评审报告",
            Self::Implementation => "可读写工作区 + 常用构建/测试命令",
            Self::Organization => "只读 + 可在指定文档目录整理/编辑文档",
            Self::Commit => "仅 git 操作，不碰其他",
        }
    }
}

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
/// 默认集在会话级 permissionMode 之上叠加：父会话 full-access 不传导给
/// 子代理（调研-权限传递层.md §2.1 独立价值）——判定与装配均在执行层。
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

// ── 三方状态机映射（TS SubagentState ↔ DB status CHECK 集）────────

/// 子代理状态机（TS 语义 4 态：'pending' | 'running' | 'completed' | 'failed'，
/// shared-types/subagent.ts:17）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentState {
    /// 内存态：已声明未启动（落库时首写即 running，不落 pending）
    Pending,
    /// 运行中
    Running,
    /// 完成
    Completed,
    /// 失败（被终止的 run 终态也归一为 failed，I0 裁决）
    Failed,
}

impl SubagentState {
    /// TS 语义字面量（wire 名）
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    /// 落库值映射（写面）：**pending 首写即 running**——DB CHECK 集
    /// （running/completed/failed/stopped，schema.rs:59）无 pending；
    /// **写面不产生 stopped**——被终止 run 的终态直接写 failed。
    /// 全部返回值 ∈ CHECK 允许集（[DB_STATUS_ALLOWED]）。
    pub fn to_db_status(&self) -> &'static str {
        match self {
            Self::Pending | Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    /// 读回映射（读面）：DB 行 → TS 状态。**stopped 归一 failed**
    /// （TS 状态机无 stopped 值，subagent.ts:17）；未知值宽容归一 failed
    /// （读回不 panic，M2 内容 4「读回 stopped 归一 failed」）。
    pub fn from_db_status(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" | "stopped" => Self::Failed,
            _ => Self::Failed,
        }
    }
}

/// DB status CHECK 允许集（schema.rs:59/217，只读对齐不迁移）
pub const DB_STATUS_ALLOWED: [&str; 4] = ["running", "completed", "failed", "stopped"];

/// 值是否属于 DB CHECK 允许集（落库前护栏断言用）
pub fn is_db_status_allowed(s: &str) -> bool {
    DB_STATUS_ALLOWED.contains(&s)
}
