//! 子代理任务、能力与状态模型（从 `agent-tools` 下沉的单一真源）。

/// 子代理角色（仅展示/过滤标签，不影响调度）
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

/// 子代理能力档（控制实际工具面；与 PermissionMode 正交）
///
/// - `ReadOnly`：只读工具白名单；
/// - `ReadWrite`：只读 + 写文件（不含 shell）；
/// - `Execute`：在 ReadWrite 基础上允许命令执行；
/// - `All`：完整工具面（仍受父能力与沙箱约束）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SubagentCapabilityMode {
    /// 只读
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

    /// 子请求能力不得超过父能力（只可收窄）。
    pub fn clamp_to_parent(self, parent: Self) -> Self {
        self.min(parent)
    }

    /// 是否允许写文件（含创建/替换/删除）。
    pub fn allows_write(self) -> bool {
        self >= Self::ReadWrite
    }

    /// 是否允许执行命令。
    pub fn allows_execute(self) -> bool {
        self >= Self::Execute
    }
}

/// 子代理任务类型（驱动默认能力/工具集；缺省 = analysis，fail-closed）
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
    /// wire 名（kebab-case）
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

    /// 一句话边界（给主 agent / UI 展示用）
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

    /// 任务类型默认能力档（可在 spawn 时收窄，不可放宽）。
    pub fn default_capability(self) -> SubagentCapabilityMode {
        match self {
            Self::Analysis | Self::Organization => SubagentCapabilityMode::ReadOnly,
            Self::Design | Self::Review => SubagentCapabilityMode::ReadWrite,
            Self::Implementation => SubagentCapabilityMode::Execute,
            Self::Commit => SubagentCapabilityMode::Execute,
        }
    }
}

/// 子代理状态机（TS 语义 4 态）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentState {
    /// 内存态：已声明未启动（落库时首写即 running）
    Pending,
    /// 运行中
    Running,
    /// 完成
    Completed,
    /// 失败（被终止的 run 终态也归一为 failed）
    Failed,
}

impl SubagentState {
    /// TS 语义字面量
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    /// 落库值映射（pending 首写即 running；写面不产生 stopped）
    pub fn to_db_status(&self) -> &'static str {
        match self {
            Self::Pending | Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    /// 读回映射（stopped 归一 failed；未知值宽容归一 failed）
    pub fn from_db_status(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" | "stopped" => Self::Failed,
            _ => Self::Failed,
        }
    }
}

/// DB status CHECK 允许集（只读对齐，不迁移）
pub const DB_STATUS_ALLOWED: [&str; 4] = ["running", "completed", "failed", "stopped"];

/// 值是否属于 DB CHECK 允许集
pub fn is_db_status_allowed(s: &str) -> bool {
    DB_STATUS_ALLOWED.contains(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_clamp_never_broadens() {
        assert_eq!(
            SubagentCapabilityMode::All.clamp_to_parent(SubagentCapabilityMode::ReadOnly),
            SubagentCapabilityMode::ReadOnly
        );
        assert_eq!(
            SubagentCapabilityMode::ReadOnly.clamp_to_parent(SubagentCapabilityMode::Execute),
            SubagentCapabilityMode::ReadOnly
        );
    }

    #[test]
    fn task_type_defaults_are_fail_closed() {
        assert_eq!(
            TaskType::Analysis.default_capability(),
            SubagentCapabilityMode::ReadOnly
        );
        assert_eq!(
            TaskType::Implementation.default_capability(),
            SubagentCapabilityMode::Execute
        );
        assert!(!TaskType::Analysis
            .default_capability()
            .allows_execute());
    }

    #[test]
    fn state_maps_pending_to_running_and_stopped_to_failed() {
        assert_eq!(SubagentState::Pending.to_db_status(), "running");
        assert_eq!(SubagentState::from_db_status("stopped"), SubagentState::Failed);
        assert!(is_db_status_allowed("stopped"));
    }
}
