/**
 * skills/ barrel — 技能加载器公共导出。
 *
 * 依据 ROUND-08-plugin-sdk.md §3.1 目录结构：
 *   skills/
 *     skill-loader.ts   # SkillLoader（SKILL.md 解析 + 技能→工具）
 *     skill-types.ts    # PluginSkill + SkillFrontmatter + 诊断类型
 *     index.ts          # barrel
 */

export { SkillLoader } from './skill-loader';
export type {
  PluginSkill,
  SkillFrontmatter,
  LoadSkillsResult,
  SkillDiagnostic,
  LoadSkillsOptions,
} from './skill-types';
