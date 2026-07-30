/**
 * Isolated Subagent Skill Execution Runner
 * 
 * 职责：
 * - 实现 `runAs: subagent` 技能的独立上下文隔离运行
 * - 强制 `readOnly: true` 安全边界（自动剥离写文件、系统修改等高危 Tool）
 * - 按 `allowedTools` 过滤可用工具集合
 * - 将子 Agent 的内部思考与中间 Tool Call 隔离在独立 Context，仅向主会话返回最终提炼结果
 */

import type { AgentSkill, AgentTool } from "@crish/shared-types";

export interface SubagentSkillExecutionConfig {
  skill: AgentSkill;
  parentSessionId: string;
  allTools: AgentTool[];
  userInstruction?: string;
}

export interface SubagentSkillFilterResult {
  scopedTools: AgentTool[];
  isReadOnly: boolean;
  requiresSubagent: boolean;
}

/** 识别工具是否为只读类型 */
export function isReadOnlyTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  // 写操作 / 修改操作关键字
  const mutatingKeywords = [
    "write", "create", "delete", "remove", "edit", "replace",
    "modify", "patch", "exec", "run_command", "terminal", "bash",
    "kill", "apply", "put", "post"
  ];
  return !mutatingKeywords.some((kw) => name.includes(kw));
}

/** 为 Subagent Skill 筛选与隔离可用工具 */
export function filterToolsForSkill(
  allTools: AgentTool[],
  skill: AgentSkill
): SubagentSkillFilterResult {
  const isReadOnly = skill.readOnly === true;
  const requiresSubagent = skill.runAs === "subagent";
  const allowedSet = skill.allowedTools && skill.allowedTools.length > 0
    ? new Set(skill.allowedTools.map((t) => t.toLowerCase()))
    : null;

  const scopedTools = allTools.filter((tool) => {
    const name = tool.name.toLowerCase();

    // 1. 如果指定了 allowedTools，仅保留列表中的工具
    if (allowedSet && !allowedSet.has(name)) {
      return false;
    }

    // 2. 如果标记了 readOnly: true，剥离所有写操作工具
    if (isReadOnly && !isReadOnlyTool(name)) {
      return false;
    }

    return true;
  });

  return {
    scopedTools,
    isReadOnly,
    requiresSubagent,
  };
}

/** 格式化 Subagent 隔离执行后的总结文本，返回主会话 */
export function formatSubagentSkillSummary(skillName: string, synthesisText: string): string {
  return [
    `[Subagent Isolation Execution Result — Skill: \`${skillName}\`]`,
    `> Note: Inner execution loop and intermediate tool calls were completed in an isolated subagent context.`,
    "",
    synthesisText.trim(),
  ].join("\n");
}
