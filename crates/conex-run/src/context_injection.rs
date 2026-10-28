//! 上下文注入通道（M1：build_context 立通道；C10/C2/C1/C5 全部提示词层
//! 能力的统一入口）
//!
//! 自壳层 `engine_build.rs` 下沉。注入段经 [ContextInjector::render] 汇入
//! system_prompt 面（wire 归类 system 角色），独立于压缩预算——压缩只作用
//! 于会话对话（conex-compaction system 保留语义），注入段结构上不进压缩
//! 预算；无注入段时 [ContextInjector::render] 原样返回基础段（None → None）。

use agent_tools::definition::ToolDefinition;

// ── M1：Tool Context 注入通道（C10 地基；build_context 立通道）──────

/// 注入段类型（注入顺序契约：M11 重注入断言以此为准；顺序变化视为协议变更）
///
/// 冻结顺序（调度者 I4-M1 指令）：
///
/// `system → skills → mcp → agent 定义`：
/// - [ContextInjectionKind::System]：系统提示词基础段（run-task 下发的
///   systemPrompt），先于一切注入段；
/// - [ContextInjectionKind::Skills]：skill 定义；
/// - [ContextInjectionKind::Mcp]：MCP 工具声明；
/// - [ContextInjectionKind::AgentDefinition]：agent 定义。
///
/// 注：04 文档 C10 第 4 条原稿顺序为「agent 定义 → skill → MCP」，
/// 落盘为「skills → mcp → agent 定义」（enum 声明序 = 排序序 = 协议序，
/// 三者一致由快照断言锁定）。
#[allow(dead_code)] // M1/M4/M5/M11 挂载消费（本域测试先行断言），接线后移除
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ContextInjectionKind {
    /// 系统提示词基础段（systemPrompt；先于一切）
    System,
    /// skill 定义段
    Skills,
    /// MCP 工具声明段
    Mcp,
    /// agent 定义段
    AgentDefinition,
}

/// 注入顺序常量（冻结契约；[ContextInjector::render] 按此顺序拼接，
/// 与 [ContextInjectionKind] 声明序/排序序一致——排序即协议，
/// M11 重注入断言以此为契约）。
#[allow(dead_code)] // M11 重注入断言消费（本域测试先行断言）
pub const CONTEXT_INJECTION_ORDER: [ContextInjectionKind; 4] = [
    ContextInjectionKind::System,
    ContextInjectionKind::Skills,
    ContextInjectionKind::Mcp,
    ContextInjectionKind::AgentDefinition,
];

/// 一段注入内容（M1：只承载「类型 + 标题 + 正文」，不持有任何业务逻辑；
/// M4（started_at）/ M5（检查点摘要）/ M11（配额凭证 + 系统上下文重注入）
/// 只读经 [ContextInjector::push] 挂载）。
///
/// 动态字段（时间戳类）必须显式标记 `@dynamic`（M1 约定 2：C2 的
/// started_at、恢复注入的检查点摘要）——带 `@dynamic` 的内容不在
/// C10 字节级一致断言范围内。
#[derive(Debug, Clone)]
pub struct ContextInjection {
    /// 注入段类型（决定拼接顺序）
    pub kind: ContextInjectionKind,
    /// 节标题（渲染为 `## {title}`）
    pub title: String,
    /// 正文
    pub content: String,
}

impl ContextInjection {
    /// 新建注入段
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言）
    pub fn new(
        kind: ContextInjectionKind,
        title: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            title: title.into(),
            content: content.into(),
        }
    }
}

/// ContextInjector 装配点（M1：build_context 立通道）
///
/// - **注入顺序冻结**：注入段按 [CONTEXT_INJECTION_ORDER] 顺序拼接——
///   构造方乱序 [Self::push] 也会在 [Self::render] 时按契约顺序重排
///   （同类型保持 push 序，sort 稳定）；
/// - **独立于压缩预算**：注入段经 [Self::render] 汇入 `system_prompt`
///   面（wire 上归类 system 角色），压缩只作用于会话对话；
/// - **默认行为不变**：无注入段时 [Self::render] 原样返回基础段
///   （None → None），与现状逐字节一致；
/// - 不持有业务逻辑：挂载点 = 只读注入项注册表（M1 内容 3）。
#[derive(Debug, Clone)]
pub struct ContextInjector {
    injections: Vec<ContextInjection>,
    /// C10 禁用开关（M11）：false = 渲染时忽略全部注入段
    enabled: bool,
}

impl Default for ContextInjector {
    /// 默认：无注入段 + 注入启用（C10 默认开）
    fn default() -> Self {
        Self {
            injections: Vec::new(),
            enabled: true,
        }
    }
}

impl ContextInjector {
    /// 新建空注入器（无注入段 = 默认行为）
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言）
    pub fn new() -> Self {
        Self::default()
    }

    /// 是否启用注入（默认开；C10 禁用开关）
    #[allow(dead_code)] // M11 消费（本域测试先行断言）
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// 追加注入段（render 时按冻结顺序重排；同类型保持追加序）
    #[allow(dead_code)] // M4/M5/M11 挂载消费（本域测试先行断言）
    pub fn push(&mut self, injection: ContextInjection) -> &mut Self {
        self.injections.push(injection);
        self
    }

    /// 是否无任何注入段
    #[allow(dead_code)] // M11 消费（本域测试先行断言）
    pub fn is_empty(&self) -> bool {
        self.injections.is_empty()
    }

    /// 注入段类型序列（按冻结顺序；顺序契约断言入口，M11 复用）
    #[allow(dead_code)] // M11 重注入断言消费
    pub fn kinds(&self) -> Vec<ContextInjectionKind> {
        let mut kinds: Vec<ContextInjectionKind> = self
            .injections
            .iter()
            .map(|injection| injection.kind)
            .collect();
        kinds.sort();
        kinds
    }

    /// 拼接基础系统段与注入段（M1 内容 1：先系统段、再 skill 段、再
    /// MCP 段、再 agent 定义段）：
    ///
    /// - 无注入段 → 基础段原样返回（None → None，默认行为与现状一致）；
    /// - 有注入段 → 基础段（System 段）置首，其后按冻结顺序逐段拼接，
    ///   每段渲染为 `## {title}\n{content}`，段间 `\n\n` 分隔；
    /// - 输出确定（同一配置两次构建字节一致，可快照断言；
    ///   `@dynamic` 字段不在一致性范围）。
    pub fn render(&self, base: Option<String>) -> Option<String> {
        if self.injections.is_empty() || !self.enabled {
            return base;
        }
        let mut ordered = self.injections.clone();
        ordered.sort_by_key(|injection| injection.kind);
        let mut parts: Vec<String> = Vec::new();
        if let Some(base) = base.filter(|text| !text.is_empty()) {
            parts.push(base);
        }
        for injection in ordered {
            if !parts.is_empty() {
                parts.push("\n\n".to_string());
            }
            parts.push(format!("## {}\n{}", injection.title, injection.content));
        }
        Some(parts.concat())
    }

    /// C10 字节级一致断言（M11）：两次渲染（如压缩前后重建）非动态段
    /// 必须逐字节一致；`@dynamic` 标记段（时间戳类）豁免。
    /// 返回：非动态段的字节级指纹（FNV-1a 64），可用于跨构建比对。
    #[allow(dead_code)] // M11 重注入断言消费
    pub fn static_fingerprint(&self) -> u64 {
        let mut ordered = self.injections.clone();
        ordered.sort_by_key(|injection| injection.kind);
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for injection in ordered {
            if injection.content.contains("@dynamic") {
                continue;
            }
            for byte in injection.title.bytes().chain(injection.content.bytes()) {
                hash ^= u64::from(byte);
                hash = hash.wrapping_mul(0x1000_0000_01b3);
            }
        }
        hash
    }

    /// C10 禁用开关（M11）：关 = 渲染时忽略全部注入段（仅基础段透传）。
    #[allow(dead_code)] // M12 联测接线消费
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    /// C10 注入上限（M11）：注入段总体积上限（字节），超限按优先级截断
    /// （核心段保留、扩展段截断），绝不整体丢弃。
    /// 返回截断后的注入段数（日志/审计用）。
    #[allow(dead_code)] // M12 联测接线消费
    pub fn truncate_to_budget(&mut self, budget_bytes: usize) -> usize {
        if self.enabled {
            self.injections.retain(|injection| {
                // 动态段（@dynamic）不参与体积预算（时间戳类极小，保留）
                !injection.content.contains("@dynamic")
            });
        }
        let mut retained = Vec::new();
        let mut used = 0usize;
        let mut dropped = 0usize;
        let mut ordered = std::mem::take(&mut self.injections);
        ordered.sort_by_key(|injection| injection.kind);
        for injection in ordered {
            let size = injection.title.len() + injection.content.len() + 8;
            if used + size > budget_bytes {
                dropped += 1;
                continue;
            }
            used += size;
            retained.push(injection);
        }
        self.injections = retained;
        dropped
    }
}

// ── T-D-03：子代理角色约束注入段（F4 R-D1；spawn 装配路径 F11 T-D-13 接入）──

/// 子代理角色约束注入段标题（T-D-03 冻结文案：测试断言锚点）
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费
pub const SUBAGENT_ROLE_CONSTRAINT_TITLE: &str = "子代理角色约束";
#[allow(dead_code)]
pub const SUBAGENT_ROLE_CONSTRAINT_TITLE_EN: &str = "Subagent Role Constraint";

/// 子代理角色约束注入段正文（T-D-03 冻结文案：测试断言全文匹配）。
///
/// 静态文本，不含 `@dynamic` 字段，纳入 C10 字节级一致断言范围；冻结
/// 文案如需调整，必须同步更新测试断言与 T-D-02 的结构化错误文案。
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费
pub const SUBAGENT_ROLE_CONSTRAINT_CONTENT: &str =
    "你没有创建子 Agent 的能力；所有子 Agent 由主 Agent 分配。\
     如需并行子任务、拆解或汇报，请通过消息/上报通道向主 Agent 提出，由主 Agent 统一派发。";

#[allow(dead_code)]
pub const SUBAGENT_ROLE_CONSTRAINT_CONTENT_EN: &str =
    "You do not have the capability to create subagents; all subagents are assigned by the primary Agent. \
     If parallel subtasks, decomposition, or reporting are needed, request them through the message/report channel to the primary Agent for unified dispatch.";

/// 向 [ContextInjector] 追加「子代理角色约束」注入段（System 段），支持可选 locale。
#[allow(dead_code)]
pub fn push_subagent_role_constraint_with_locale(
    injector: &mut ContextInjector,
    locale: Option<&str>,
) {
    let is_en = locale.is_some_and(|l| l.to_ascii_lowercase().starts_with("en"));
    let (title, content) = if is_en {
        (
            SUBAGENT_ROLE_CONSTRAINT_TITLE_EN,
            SUBAGENT_ROLE_CONSTRAINT_CONTENT_EN,
        )
    } else {
        (
            SUBAGENT_ROLE_CONSTRAINT_TITLE,
            SUBAGENT_ROLE_CONSTRAINT_CONTENT,
        )
    };
    injector.push(ContextInjection::new(
        ContextInjectionKind::System,
        title,
        content,
    ));
}

/// T-D-03：向 [ContextInjector] 追加「子代理角色约束」注入段（System 段）。
///
/// 仅**子代理 run** 的装配路径调用本函数（主 Agent run 的装配点不调用）
/// ——这是「主 Agent run 不含本段」测试断言的关键差异点。
#[allow(dead_code)] // F11 T-D-13 接线：spawn 装配路径消费
pub fn push_subagent_role_constraint(injector: &mut ContextInjector) {
    push_subagent_role_constraint_with_locale(injector, None);
}

// ── E5 内容 3：C10 注入读取面（MCP 工具声明段）────────────────────

/// C10 MCP 工具声明注入段：已并入注册表的 MCP 工具定义 →
/// `## MCP 工具声明` 注入段（与 E4 on_definition 共享
/// `list_definitions` 构建点；渲染确定，可字节级断言）。
#[allow(dead_code)] // E5 接线：run 装配 ContextInjector 时消费
pub fn mcp_context_injection(defs: &[ToolDefinition]) -> ContextInjection {
    let content = defs
        .iter()
        .map(|def| format!("- {}：{}", def.name, def.description))
        .collect::<Vec<_>>()
        .join("\n");
    ContextInjection::new(ContextInjectionKind::Mcp, "MCP 工具声明", content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_subagent_role_constraint_chinese_and_english() {
        let mut injector_zh = ContextInjector::new();
        push_subagent_role_constraint(&mut injector_zh);
        let rendered_zh = injector_zh.render(None).expect("rendered prompt");
        assert!(rendered_zh.contains("## 子代理角色约束"));
        assert!(rendered_zh.contains(SUBAGENT_ROLE_CONSTRAINT_CONTENT));

        let mut injector_en = ContextInjector::new();
        push_subagent_role_constraint_with_locale(&mut injector_en, Some("en"));
        let rendered_en = injector_en.render(None).expect("rendered prompt");
        assert!(rendered_en.contains("## Subagent Role Constraint"));
        assert!(rendered_en.contains(SUBAGENT_ROLE_CONSTRAINT_CONTENT_EN));
    }
}
