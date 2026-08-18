/**
 * 技能发现与激活（正规 SKILL.md 范式）—— hub（T4-11 R5 基线清零）。
 *
 * - 发现：项目 / 工作区 / 全局 skills 目录（实现见 `./skillsApiDiscovery`）
 * - 解析 frontmatter + markdown 正文（实现见 `./skillsApiHelpers`）
 * - 激活态：localStorage 覆盖（T03.7：upsert/delete-scoped-context 幽灵命令已删，
 *   daemon 同步显式本地-only，engineSynced 恒 false）
 * - 斜杠命令：/skill:name 与 enableSkillCommands
 *
 * 本文件为消费方入口，保留对外导出路径不变；FS 访问与发现逻辑已分别拆至
 * `./skillsApiFs` 与 `./skillsApiDiscovery`。
 *
 * @see docs/plans/2026-07-product-trust-topdown.md §1.2 / §2
 */

import { getWorkspacePath } from './projectStore';
import { openDirectoryDialogSafe } from './openDirectoryDialog';
import {
  dirname,
  joinPath,
  legacySkillIdFromPath,
  loadActivationMap,
  normalizeSlashName,
  saveActivationMap,
} from './skillsApiHelpers';
import {
  mkdirAny,
  readTextAny,
  writeTextAny,
} from './skillsApiFs';
import {
  discoverSkills,
  type DiscoverSkillsResult,
} from './skillsApiDiscovery';
import type {
  DesktopSkill,
  SkillActivation,
  SkillSlashCommand,
} from './skillsApi.types';

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
  skillsFsAvailable,
} from './skillsApiFs';

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

const PLUGIN_OPENER_PKG = '@tauri-apps/plugin-opener';
const PLUGIN_SHELL_PKG = '@tauri-apps/plugin-shell';

/** 在系统资源管理器中显示路径 */
export async function revealSkillPath(filePath: string): Promise<boolean> {
  try {
    const opener = (await (
      import(/* @vite-ignore */ PLUGIN_OPENER_PKG) as Promise<unknown>
    ).catch(() => null)) as {
      openPath?: (p: string) => Promise<unknown>;
      revealItemInDir?: (p: string) => Promise<unknown>;
    } | null;
    if (opener?.openPath) {
      await opener.openPath(filePath);
      return true;
    }
    if (opener?.revealItemInDir) {
      await opener.revealItemInDir(filePath);
      return true;
    }
  } catch {
    /* swallow-ok */
  }
  try {
    const shell = (await (
      import(/* @vite-ignore */ PLUGIN_SHELL_PKG) as Promise<unknown>
    ).catch(() => null)) as { open?: (url: string) => Promise<unknown> } | null;
    if (shell?.open) {
      await shell.open(dirname(filePath));
      return true;
    }
  } catch {
    /* swallow-ok */
  }
  return false;
}

// ── 创建项目技能模板 ──────────────────────────────────────────────────

export type CreateSkillResult =
  | { ok: true; skillPath: string; skillDir: string }
  | { ok: false; error: string };

/** 在项目 .conex/skills 下创建技能模板 */
export async function createProjectSkill(opts: {
  name: string;
  description?: string;
  workspacePath?: string | null;
}): Promise<CreateSkillResult> {
  const workspace = (opts.workspacePath ?? getWorkspacePath() ?? '').trim();
  if (!workspace) return { ok: false, error: '未打开工作区，无法创建项目技能' };
  const slug = normalizeSlashName(opts.name);
  if (!slug) return { ok: false, error: '技能名称无效' };

  const skillDir = joinPath(joinPath(workspace, '.conex/skills'), slug);
  const skillPath = joinPath(skillDir, 'SKILL.md');
  const existing = await readTextAny(skillPath);
  if (existing != null) return { ok: false, error: `已存在：${skillPath}` };

  const desc = (opts.description || `${opts.name} 技能`).trim();
  const body = [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(desc)}`,
    'activation: recommended',
    '---',
    '',
    `# ${opts.name.trim() || slug}`,
    '',
    '## 何时使用',
    '',
    `- ${desc}`,
    '',
    '## 步骤',
    '',
    '1. 阅读任务上下文',
    '2. 按本技能约定执行',
    '3. 完成后做简要校验',
    '',
  ].join('\n');

  const mk = await mkdirAny(skillDir);
  if (!mk) {
    // 尝试直接写（部分 fs 会自动建父目录）
  }
  const wrote = await writeTextAny(skillPath, body);
  if (!wrote) {
    return {
      ok: false,
      error: '无法写入 SKILL.md（需要桌面壳 plugin-fs 权限）',
    };
  }
  return { ok: true, skillPath, skillDir };
}

// ── 斜杠命令 ----------

/** 启用且未禁用模型调用的技能 → 斜杠命令 */
export function skillsToSlashCommands(
  skills: DesktopSkill[]
): SkillSlashCommand[] {
  return skills
    .filter(
      (s) =>
        (s.activation === 'enabled' || s.activation === 'recommended') &&
        !s.disableModelInvocation
    )
    .map((s) => ({
      cmd: `/skill:${normalizeSlashName(s.name)}`,
      desc: s.description.slice(0, 120),
      skillId: s.id,
      skillName: s.name,
    }))
    .sort((a, b) => a.cmd.localeCompare(b.cmd));
}

/** 解析 /skill:name 并返回技能正文（用于注入用户消息） */
export async function resolveSkillSlash(
  input: string,
  skills?: DesktopSkill[]
): Promise<{ skill: DesktopSkill; rest: string } | null> {
  const m = /^\/skill:([a-z0-9._-]+)\s*([\s\S]*)$/i.exec(input.trim());
  if (!m) return null;
  const key = m[1]!.toLowerCase();
  const rest = (m[2] || '').trim();
  const list = skills ?? (await discoverSkills()).skills;
  const skill =
    list.find((s) => normalizeSlashName(s.name) === key) ||
    list.find((s) => s.name.toLowerCase() === key);
  if (!skill) return null;
  return { skill, rest };
}

export function formatSkillInjection(
  skill: DesktopSkill,
  userRest: string
): string {
  const header = [
    `【技能：${skill.name}】`,
    skill.description ? `说明：${skill.description}` : '',
    '',
    skill.content || '（技能正文为空）',
    '',
    '---',
    '',
    userRest || '请按上述技能执行。',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
  return header;
}

// ── 斜杠命令缓存（菜单用） ---------- */

/** 缓存：斜杠菜单用，避免每次按键全量扫描 */
let slashCache: {
  at: number;
  commands: SkillSlashCommand[];
  skills: DesktopSkill[];
} | null = null;
const SLASH_CACHE_MS = 30_000;

export async function getSkillSlashCommandsCached(force = false): Promise<{
  commands: SkillSlashCommand[];
  skills: DesktopSkill[];
}> {
  if (!force && slashCache && Date.now() - slashCache.at < SLASH_CACHE_MS) {
    return { commands: slashCache.commands, skills: slashCache.skills };
  }
  const res = await discoverSkills({ workspacePath: getWorkspacePath() });
  const commands = skillsToSlashCommands(res.skills);
  slashCache = { at: Date.now(), commands, skills: res.skills };
  return { commands, skills: res.skills };
}

export function invalidateSkillSlashCache() {
  slashCache = null;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('crish-skills-changed'));
  }
}
