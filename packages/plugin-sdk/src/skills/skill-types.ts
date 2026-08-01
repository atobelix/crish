/**
 * 技能类型定义 — SKILL.md frontmatter 结构与加载结果。
 *
 * 依据 ROUND-08-plugin-sdk.md §3.7：
 *   技能目录结构（移除 agents/ 子目录，避免与 agent-subagent 概念混淆）：
 *     skills/
 *       <skill-name>/
 *         SKILL.md          # frontmatter + 正文
 *         scripts/          # 可选，辅助脚本
 *         prompts/          # 可选，prompt 片段
 *
 * 迁移自 agent-tools/src/skills.ts（AgentSkill frontmatter 解析），
 * 复用字段命名与校验规则，确保与现有技能目录兼容。
 */

/**
 * 插件技能定义（从 SKILL.md frontmatter 解析）。
 *
 * 技能是一种特殊的工具：由 Markdown 文档驱动，可被 LLM 自动调用或手动触发。
 * 技能 → 工具转换由 SkillLoader.toTool() 完成。
 *
 * 字段对齐 shared-types/src/skill.ts 的 AgentSkill（保持兼容），
 * 命名为 PluginSkill 以区分插件 SDK 上下文。
 */
export interface PluginSkill {
  /** 技能名（唯一，作为工具名，小写字母+数字+连字符） */
  readonly name: string;

  /** 技能描述（供 LLM 决策是否调用） */
  readonly description: string;

  /** SKILL.md 绝对路径 */
  readonly filePath: string;

  /** 技能根目录（含 scripts/ prompts/ 子目录） */
  readonly baseDir: string;

  /** SKILL.md 正文内容（去除 frontmatter 后） */
  readonly content: string;

  /** 是否禁止模型自动调用（仅手动触发） */
  readonly disableModelInvocation: boolean;

  /** 作用域 */
  readonly scope?: 'global' | 'project' | 'workspace';

  /** 激活建议 */
  readonly activation?: 'enabled' | 'recommended' | 'disabled';

  /** 运行模式 */
  readonly runAs?: 'inline' | 'subagent';

  /** 是否只读 */
  readonly readOnly?: boolean;

  /** 允许调用的工具白名单（runAs=subagent 时生效） */
  readonly allowedTools?: readonly string[];

  /** 调用方式 */
  readonly invocation?: 'auto' | 'manual';

  /** 适用范围（glob 模式） */
  readonly appliesTo?: readonly string[];

  /** 标签 */
  readonly tags?: readonly string[];
}

/**
 * SKILL.md frontmatter 结构（kebab-case 键名，对齐现有技能文件约定）。
 *
 * frontmatter 解析规则（迁移自 agent-tools/src/skills.ts）：
 * - 布尔值：true / false
 * - 字符串：去除首尾引号
 * - 列表：逗号分隔字符串（如 'read,write,search'）或 [a, b, c] 数组字面量
 */
export interface SkillFrontmatter {
  /** 技能名（必填） */
  readonly name: string;

  /** 技能描述（必填） */
  readonly description: string;

  /** 禁止模型自动调用 */
  readonly 'disable-model-invocation'?: boolean;

  /** 作用域 */
  readonly scope?: 'global' | 'project' | 'workspace';

  /** 激活建议 */
  readonly activation?: 'enabled' | 'recommended' | 'disabled';

  /** 运行模式 */
  readonly 'run-as'?: 'inline' | 'subagent';

  /** 是否只读 */
  readonly 'read-only'?: boolean;

  /** 允许调用的工具白名单 */
  readonly 'allowed-tools'?: readonly string[];

  /** 调用方式 */
  readonly invocation?: 'auto' | 'manual';

  /** 适用范围 */
  readonly 'applies-to'?: readonly string[];

  /** 标签 */
  readonly tags?: readonly string[];
}

/**
 * 加载技能的结果（技能列表 + 诊断信息）。
 */
export interface LoadSkillsResult {
  /** 成功解析的技能列表 */
  readonly skills: readonly PluginSkill[];

  /** 加载过程中的诊断信息（warning 不阻塞加载，error 跳过该技能） */
  readonly diagnostics: readonly SkillDiagnostic[];
}

/**
 * 技能加载诊断信息。
 *
 * severity 语义：
 * - warning：该技能被跳过，但不影响其他技能加载
 * - error：目录级故障（如根目录不可读）
 */
export interface SkillDiagnostic {
  readonly severity: 'warning' | 'error';

  readonly code:
    | 'skill-directory-unreadable'
    | 'skill-file-unreadable'
    | 'skill-file-not-file'
    | 'skill-file-too-large'
    | 'skill-file-binary'
    | 'skill-name-invalid'
    | 'skill-description-invalid'
    | 'skill-frontmatter-malformed';

  /** 触发诊断的文件或目录路径 */
  readonly path: string;

  /** 人类可读的诊断消息 */
  readonly message: string;
}

/**
 * 技能加载选项。
 */
export interface LoadSkillsOptions {
  /** 单个 SKILL.md 最大字节数（默认 512KB） */
  readonly maxSkillBytes?: number;
}
