/**
 * 技能发现与激活（正规 SKILL.md 范式）—— hub（T4-11 R5 基线清零）。
 *
 * - 发现：项目 / 工作区 / 全局 skills 目录（实现见 `./skillsApiDiscovery`）
 * - 解析 frontmatter + markdown 正文（实现见 `./skillsApiHelpers`）
 * - 激活态：localStorage 覆盖（T03.7：upsert/delete-scoped-context 幽灵命令已删，
 *   daemon 同步显式本地-only，engineSynced 恒 false）
 * - 斜杠命令：/skill:name 与 enableSkillCommands
 *
 * 本文件为消费方入口，保留对外导出路径不变；FS 访问、发现、创建与斜杠缓存已分别
 * 拆至 `./skillsApiFs`、`./skillsApiDiscovery`、`./skillsApiCreate`、`./skillsApiSlashCache`。
 *
 * @see docs/plans/2026-07-product-trust-topdown.md §1.2 / §2
 */

import { openDirectoryDialogSafe } from './openDirectoryDialog';
import {
  dirname,
  legacySkillIdFromPath,
  loadActivationMap,
  normalizeSlashName,
  saveActivationMap,
} from './skillsApiHelpers';
import { discoverSkills } from './skillsApiDiscovery';
import { invalidateSkillSlashCache } from './skillsApiSlashCache';
import type { DesktopSkill, SkillActivation } from './skillsApi.types';
import { createPromptTemplate } from '../prompts';
import type { PromptTemplate } from '../prompts';

// ── 类型再导出（消费方 import 路径不变） ──────────────────────────────
export type {
  DesktopSkill,
  SkillActivation,
  SkillScope,
  SkillSlashCommand,
} from './skillsApi.types';

// ── FS 访问 + extra dirs 管理（再导出） ────────────────────────────────
export {
  addExtraSkillDir,
  getExtraSkillDirs,
  removeExtraSkillDir,
  removePathAny,
  skillsFsAvailable,
  tryHomeDir,
  readTextAny,
  writeTextAny,
  mkdirAny,
} from './skillsApiFs';
export { normalizeSlashName } from './skillsApiHelpers';
export { skillStableId } from './skillId';

// ── 发现（再导出；discoverSkills 同时为本模块内部使用） ────────────────
export {
  discoverInDir,
  loadSkillFile,
  type DiscoverSkillsResult,
} from './skillsApiDiscovery';
export { discoverSkills };

// ── 激活态写入（localStorage 唯一真相） ────────────────────────────────

export type SkillActivationResult = {
  ok: boolean;
  /** T03.7：scoped-context 仅本机保存，恒 false（显式本地-only） */
  engineSynced: boolean;
  error?: string;
};

/**
 * 更新技能激活态：始终写入 localStorage（本机唯一真相）。
 * T03.7：引擎 scoped-context 通道已删，engineSynced 恒 false（无引擎同步）。
 */
export async function setSkillActivation(
  skill: DesktopSkill,
  activation: SkillActivation
): Promise<SkillActivationResult> {
  const map = loadActivationMap();
  map[skill.id] = activation;
  const legacyId = legacySkillIdFromPath(skill.filePath);
  if (legacyId !== skill.id && map[legacyId] !== undefined) {
    delete map[legacyId];
  }
  saveActivationMap(map);
  invalidateSkillSlashCache();
  return { ok: true, engineSynced: false };
}

/** 批量同步到引擎：T03.7 后无引擎通道，恒 0/0（保留签名兼容调用方） */
export async function syncSkillsToDaemon(
  _skills: DesktopSkill[]
): Promise<{ ok: number; fail: number }> {
  return { ok: 0, fail: 0 };
}

/** 选择额外技能目录（原生对话框） */
export async function pickSkillDirectory(): Promise<string | null> {
  return openDirectoryDialogSafe('选择技能目录');
}

// ── 资源管理器定位（plugin-opener / plugin-shell 回退） ────────────────
import { openPathDefault } from './hostOpenersApi';

// ── 资源管理器定位 ──────────────────────────────────────────────────

/** 在系统资源管理器中显示路径对应目录 */
export async function revealSkillPath(filePath: string): Promise<boolean> {
  const raw = (filePath || '').trim();
  if (!raw) return false;
  // 若目标为文件（如 SKILL.md），定位其所在父级目录；若本身已是目录，直接打开
  const targetDir =
    raw.endsWith('.md') || raw.includes('.') ? dirname(raw) : raw;
  try {
    await openPathDefault(targetDir || raw);
    return true;
  } catch {
    try {
      await openPathDefault(raw);
      return true;
    } catch {
      return false;
    }
  }
}

// ── 创建技能模板（实现见 ./skillsApiCreate） ──────────────────────────

export {
  createProjectSkill,
  createGlobalSkill,
  type CreateSkillResult,
} from './skillsApiCreate';

// ── 斜杠命令（实现与缓存见 ./skillsApiSlashCache） ----------

export {
  skillsToSlashCommands,
  getSkillSlashCommandsCached,
  invalidateSkillSlashCache,
} from './skillsApiSlashCache';

const COMMON_SKILL_ALIASES: Record<string, string> = {
  代码检视: 'code-review',
  代码审查: 'code-review',
  智能代码检视: 'code-review',
  简历大师: 'resume-master',
  制作简历: 'resume-master',
  项目简历: 'repo-to-resume-tailor',
  仓库简历: 'repo-to-resume-tailor',
  中文编码: 'chinese-encoding-guard',
  防乱码: 'chinese-encoding-guard',
  学术去ai: 'de-ai-academic-cn',
  学术润色: 'de-ai-academic-cn',
  去ai痕迹: 'de-ai-academic-cn',
};

/** 按 id、路径或名称查找技能 */
export async function resolveSkillByIdOrName(
  idOrName: string,
  skills?: DesktopSkill[]
): Promise<DesktopSkill | null> {
  const list = skills ?? (await discoverSkills()).skills;
  const rawKey = idOrName.trim();
  const key = rawKey.toLowerCase();
  const normKey = normalizeSlashName(rawKey);
  const alias = COMMON_SKILL_ALIASES[rawKey] || COMMON_SKILL_ALIASES[key];
  return (
    list.find(
      (s) =>
        s.id === rawKey ||
        s.filePath === rawKey ||
        s.name === rawKey ||
        s.name.toLowerCase() === key ||
        normalizeSlashName(s.name) === normKey ||
        normalizeSlashName(s.name) === key ||
        (alias &&
          (s.name.toLowerCase() === alias ||
            normalizeSlashName(s.name) === alias ||
            s.id.toLowerCase().includes(alias)))
    ) ?? null
  );
}

/** 解析 /skill:name 或 /技能:name 并返回技能正文（用于注入用户消息） */
export async function resolveSkillSlash(
  input: string,
  skills?: DesktopSkill[]
): Promise<{ skill: DesktopSkill; rest: string } | null> {
  const trimmed = input.trim();
  const m = /^\/(?:skill|技能)[:：]([^\s]+)\s*([\s\S]*)$/iu.exec(trimmed);
  if (!m) return null;
  const rawKey = m[1]!.trim();
  const key = rawKey.toLowerCase();
  const normKey = normalizeSlashName(rawKey);
  const alias = COMMON_SKILL_ALIASES[rawKey] || COMMON_SKILL_ALIASES[key];
  const rest = (m[2] || '').trim();
  const list = skills ?? (await discoverSkills()).skills;
  const skill =
    list.find(
      (s) =>
        s.id === rawKey ||
        s.name === rawKey ||
        s.name.toLowerCase() === key ||
        normalizeSlashName(s.name) === normKey ||
        normalizeSlashName(s.name) === key ||
        (alias &&
          (s.name.toLowerCase() === alias ||
            normalizeSlashName(s.name) === alias ||
            s.id.toLowerCase().includes(alias)))
    ) ?? null;
  if (!skill) return null;
  return { skill, rest };
}

export function formatSkillInjection(
  skill: DesktopSkill,
  userRest: string
): string {
  // 语义等价旧裸拼接：描述为空时整行省略；正文/兜底文案/userRest 原样透出
  const descriptionLine = skill.description ? `说明：${skill.description}` : '';
  const body = (skill.content || skill.raw || '').trim();
  return SKILL_INJECTION_TEMPLATE.render({
    skillName: skill.name,
    descriptionLine,
    skillBody: body || '（技能正文为空）',
    userPrompt: userRest || '请按上述技能执行。',
  });
}

/** 检测并注入 @[label](id:skill) 技能 Mention */
export async function tryInjectSkillMention(
  rawInput: string
): Promise<string | null> {
  const m = /@\[([^\]]+)\]\(([^)]+):skill\)/.exec(rawInput);
  if (!m) return null;
  try {
    const skillName = m[1] ?? '';
    const skillIdOrPath = m[2] ?? '';
    const skill =
      (skillIdOrPath ? await resolveSkillByIdOrName(skillIdOrPath) : null) ||
      (skillName ? await resolveSkillByIdOrName(skillName) : null);
    if (!skill) return null;
    const rest = rawInput.replace(m[0], '').trim();
    return formatSkillInjection(skill, rest);
  } catch {
    return null;
  }
}

/** 统筹 slash 与 mention 的技能前置解析 */
export async function resolveSkillForPreflight(
  rawInput: string,
  slashRaw?: string
): Promise<{ modelText: string; displayText?: string } | null> {
  const targetRaw = (slashRaw || rawInput || '').trim();
  if (targetRaw) {
    const resolved = await resolveSkillSlash(targetRaw);
    if (resolved) {
      return {
        modelText: formatSkillInjection(resolved.skill, resolved.rest),
        displayText: resolved.rest
          ? `/skill:${resolved.skill.name} ${resolved.rest}`
          : `使用技能：${resolved.skill.name}`,
      };
    }
  }
  const injected = await tryInjectSkillMention(rawInput);
  return injected ? { modelText: injected } : null;
}

/**
 * /skill:name 指令的技能说明注入模板（modelText 载荷，消费方 slashSendPreflight）。
 * 经统一插值引擎渲染（SSOT）；维度一阶段就地定义于 skillsApi 消费侧，
 * skills（L4）层集中资产待技能注入后续收口轮迁入 src/prompts/skills/skillFormatter.ts。
 */
interface SkillInjectionParams {
  skillName: string;
  /** 已含「说明：」前缀的描述行；描述为空时为空串（整行省略，等价旧裸拼接） */
  descriptionLine: string;
  skillBody: string;
  userPrompt: string;
}

const SKILL_INJECTION_TEMPLATE: PromptTemplate<SkillInjectionParams> =
  createPromptTemplate(
    {
      id: 'skills-active-injection',
      name: '技能斜杠注入模板',
      description: '/skill:name 指令的技能说明注入（发送前置 modelText 载荷）',
      layer: 'skills',
      version: '1.0.0',
      defaultLocale: 'zh-CN',
      tags: ['skill', 'injection'],
    },
    {
      'zh-CN':
        '【技能：{{skillName}}】\n{{descriptionLine}}\n\n{{skillBody}}\n\n---\n\n{{userPrompt}}',
      'en-US':
        '【技能：{{skillName}}】\n{{descriptionLine}}\n\n{{skillBody}}\n\n---\n\n{{userPrompt}}',
    }
  );
