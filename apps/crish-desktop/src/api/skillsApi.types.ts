/**
 * 技能发现与激活类型定义
 */

export type SkillScope = 'global' | 'project' | 'workspace';
export type SkillActivation = 'enabled' | 'recommended' | 'disabled';

export type DesktopSkill = {
  id: string;
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  /** SKILL.md 正文（无 frontmatter） */
  content: string;
  /** 完整文件原文（含 frontmatter），便于预览 */
  raw: string;
  scope: SkillScope;
  activation: SkillActivation;
  tags: string[];
  appliesTo: string[];
  disableModelInvocation: boolean;
  /** 来自系统目录（如 ~/.codex/skills/.system） */
  system?: boolean;
};

export type SkillSlashCommand = {
  cmd: string;
  desc: string;
  skillId: string;
  skillName: string;
};
