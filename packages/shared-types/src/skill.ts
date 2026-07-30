/**
 * 技能（Skill）类型（从 agent-runtime/src/skills.ts 下沉的纯类型）
 *
 * agent-context 的 scoped-context-resources 需要这些类型来声明 skill 加载结果的结构，
 * 通过依赖注入接收 skill 加载器，避免跨层引用 agent-runtime。
 */

/**
 * 已加载的 Agent 技能定义。
 * 迁移自 agent-runtime/src/skills.ts
 */
export interface AgentSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  content: string;
  disableModelInvocation: boolean;
  scope?: 'global' | 'project' | 'workspace';
  activation?: 'enabled' | 'recommended' | 'disabled';
  runAs?: 'inline' | 'subagent';
  readOnly?: boolean;
  allowedTools?: string[];
  invocation?: 'auto' | 'manual';
  appliesTo?: string[];
  tags?: string[];
}

/**
 * 技能加载诊断信息。
 * 迁移自 agent-runtime/src/skills.ts
 */
export interface SkillDiagnostic {
  severity: 'warning';
  code:
    | 'skill-directory-unreadable'
    | 'skill-file-unreadable'
    | 'skill-file-not-file'
    | 'skill-file-too-large'
    | 'skill-file-binary'
    | 'skill-name-invalid'
    | 'skill-description-invalid';
  path: string;
  message: string;
}
