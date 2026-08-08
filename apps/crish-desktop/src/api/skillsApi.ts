/**
 * 技能发现与激活（正规 SKILL.md 范式）
 * - 发现：项目 / 工作区 / 全局 skills 目录
 * - 解析 frontmatter + markdown 正文
 * - 激活态：localStorage 覆盖（T03.7：upsert/delete-scoped-context 幽灵命令已删，
 *   daemon 同步显式本地-only，engineSynced 恒 false）
 * - 斜杠命令：/skill:name 与 enableSkillCommands
 *
 * @see docs/plans/2026-07-product-trust-topdown.md §1.2 / §2
 */

import { getWorkspacePath } from './projectStore';
import { invokeCmd as tryInvokeTauri } from './tauriInvoke';
import { skillStableId } from './skillId';
import { openDirectoryDialogSafe } from './openDirectoryDialog';
import {
  isAbsoluteFsPath,
  listDirectory,
  readTextFile,
  type FsDirEntry,
} from './workspaceFsApi';

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

const ACTIVATION_KEY = 'crish_skill_activation_v1';
const EXTRA_DIRS_KEY = 'crish_skill_extra_dirs_v1';

/** 子目录名以这些开头时不跳过（点目录通常跳过） */
const ALLOWED_DOT_DIRS = new Set(['.system']);

function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

function basename(p: string): string {
  const n = p.replace(/[\\/]+$/, '');
  const i = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
  return i >= 0 ? n.slice(i + 1) : n;
}

function dirname(p: string): string {
  const n = p.replace(/[\\/]+$/, '');
  const i = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
  return i >= 0 ? n.slice(0, i) : n;
}

/** Legacy desktop id (pre-T1). Used only for localStorage migration. */
function legacySkillIdFromPath(filePath: string): string {
  return `skill-file:${filePath.replace(/\\/g, '/').toLowerCase()}`;
}

/**
 * Resolve activation for a skill id, migrating legacy `skill-file:...` keys
 * onto runtime-compatible `skill_<hash>` when found by path.
 */
function resolveActivationFromMap(
  map: Record<string, SkillActivation>,
  id: string,
  filePath: string,
): { activation?: SkillActivation; migrated: boolean } {
  if (map[id]) return { activation: map[id], migrated: false };
  const legacyId = legacySkillIdFromPath(filePath);
  if (legacyId !== id && map[legacyId]) {
    map[id] = map[legacyId]!;
    delete map[legacyId];
    return { activation: map[id], migrated: true };
  }
  return { migrated: false };
}

function normalizeSlashName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* ---------- frontmatter（对齐 agent-runtime / Codex SKILL.md） ---------- */

function parseFrontmatter(content: string): {
  data: Record<string, string | boolean>;
  body: string;
} {
  if (!content.startsWith('---')) return { data: {}, body: content };
  const end = content.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: content };
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, '');
  const data: Record<string, string | boolean> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([^:#]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.trim();
    const value = match[2]!.trim().replace(/^["']|["']$/g, '');
    data[key] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return { data, body };
}

function stringList(v: unknown): string[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  return v
    .split(/[,[\]]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function skillScope(v: unknown): SkillScope | undefined {
  if (v === 'global' || v === 'project' || v === 'workspace') return v;
  return undefined;
}

function skillActivation(v: unknown): SkillActivation | undefined {
  if (v === 'enabled' || v === 'recommended' || v === 'disabled') return v;
  return undefined;
}

function firstMarkdownSentence(content: string): string | undefined {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'));
  return line?.slice(0, 160);
}

/* ---------- activation store ---------- */

function loadActivationMap(): Record<string, SkillActivation> {
  try {
    const raw = localStorage.getItem(ACTIVATION_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

function saveActivationMap(map: Record<string, SkillActivation>) {
  localStorage.setItem(ACTIVATION_KEY, JSON.stringify(map));
}

export function getExtraSkillDirs(): string[] {
  try {
    const raw = localStorage.getItem(EXTRA_DIRS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function setExtraSkillDirs(dirs: string[]) {
  localStorage.setItem(EXTRA_DIRS_KEY, JSON.stringify(dirs.filter(Boolean)));
}

export function addExtraSkillDir(dir: string) {
  const d = dir.trim();
  if (!d) return getExtraSkillDirs();
  const list = getExtraSkillDirs();
  if (!list.includes(d)) list.push(d);
  setExtraSkillDirs(list);
  return list;
}

export function removeExtraSkillDir(dir: string) {
  const list = getExtraSkillDirs().filter((d) => d !== dir);
  setExtraSkillDirs(list);
  return list;
}

/* ---------- FS helpers（plugin-fs 优先，突破工作区沙箱） ---------- */

async function tryPluginFs(): Promise<{
  readDir?: (p: string) => Promise<Array<{ name?: unknown; isDirectory?: boolean; isDir?: boolean; children?: unknown }>>;
  readTextFile?: (p: string) => Promise<string>;
  writeTextFile?: (p: string, content: string) => Promise<void>;
  mkdir?: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  exists?: (p: string) => Promise<boolean>;
} | null> {
  try {
    const fs: unknown = await (Function('return import("@tauri-apps/plugin-fs")')() as Promise<unknown>).catch(
      () => null,
    );
    if (!fs) return null;
    return fs as NonNullable<Awaited<ReturnType<typeof tryPluginFs>>>;
  } catch {
    return null;
  }
}

async function tryHomeDir(): Promise<string | null> {
  try {
    const pathApi = (await (Function(
      'return import("@tauri-apps/api/path")',
    )() as Promise<unknown>).catch(() => null)) as { homeDir?: () => Promise<string> } | null;
    if (pathApi?.homeDir) {
      const h = await pathApi.homeDir();
      if (h) return String(h);
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function listDirAny(dirPath: string): Promise<FsDirEntry[]> {
  const path = dirPath.trim();
  if (!path) return [];
  const fs = await tryPluginFs();
  if (fs?.readDir) {
    try {
      const entries = await fs.readDir(path);
      return (entries || []).map((e) => {
        const name = String(e.name ?? e);
        const isDir = Boolean(e.isDirectory ?? e.isDir ?? e.children);
        return { name, isDir, path: joinPath(path, name) };
      });
    } catch {
      /* fall through */
    }
  }
  try {
    return await listDirectory(path);
  } catch {
    return [];
  }
}

async function readTextAny(filePath: string, maxLines = 8000): Promise<string | null> {
  const path = filePath.trim();
  if (!path) return null;
  const fs = await tryPluginFs();
  if (fs?.readTextFile) {
    try {
      return await fs.readTextFile(path);
    } catch {
      /* fall through */
    }
  }
  try {
    const r = await readTextFile(path, maxLines);
    return r.content;
  } catch {
    return null;
  }
}

async function writeTextAny(filePath: string, content: string): Promise<boolean> {
  const fs = await tryPluginFs();
  if (fs?.writeTextFile) {
    try {
      await fs.writeTextFile(filePath, content);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function mkdirAny(dirPath: string): Promise<boolean> {
  const fs = await tryPluginFs();
  if (fs?.mkdir) {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/* ---------- discovery ---------- */

async function loadSkillFile(
  filePath: string,
  scope: SkillScope,
  opts?: { system?: boolean; activationOverride?: SkillActivation },
): Promise<DesktopSkill | null> {
  const raw = await readTextAny(filePath);
  if (raw == null) return null;
  const parsed = parseFrontmatter(raw);
  const baseDir = filePath.replace(/[\\/][^\\/]+$/, '') || filePath;
  const fallbackName = basename(baseDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = String(parsed.data.name || fallbackName || 'skill');
  const description = String(
    parsed.data.description || firstMarkdownSentence(parsed.body) || name,
  );
  const fileActivation =
    skillActivation(parsed.data.activation) ||
    (opts?.system ? 'recommended' : 'recommended');
  // Must match agent-runtime: stableId("skill", `${name}:${filePath}`)
  const id = skillStableId(name, filePath);
  const map = loadActivationMap();
  const resolved = resolveActivationFromMap(map, id, filePath);
  if (resolved.migrated) saveActivationMap(map);
  const activation = opts?.activationOverride || resolved.activation || fileActivation;
  const isSystem =
    opts?.system ||
    /[/\\]\.system[/\\]/i.test(filePath) ||
    parsed.data.system === true;

  return {
    id,
    name,
    description,
    filePath,
    baseDir,
    content: parsed.body.trim(),
    raw,
    scope: skillScope(parsed.data.scope) || scope,
    activation,
    tags: stringList(parsed.data.tags),
    appliesTo: stringList(parsed.data['applies-to'] ?? parsed.data.appliesTo),
    disableModelInvocation: parsed.data['disable-model-invocation'] === true,
    system: isSystem,
  };
}

async function discoverInDir(
  dir: string,
  scope: SkillScope,
  depth = 0,
  out: DesktopSkill[] = [],
  system = false,
): Promise<DesktopSkill[]> {
  if (depth > 5) return out;
  const entries = await listDirAny(dir);
  if (!entries.length) return out;

  const hasSkillMd = entries.some((e) => !e.isDir && e.name.toUpperCase() === 'SKILL.MD');
  if (hasSkillMd) {
    const skillPath = joinPath(dir, 'SKILL.md');
    const hit = entries.find((e) => !e.isDir && e.name.toUpperCase() === 'SKILL.MD');
    const filePath = hit?.path || skillPath;
    const skill = await loadSkillFile(filePath, scope, { system });
    if (skill) out.push(skill);
    return out;
  }

  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '__pycache__') continue;
    if (e.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(e.name.toLowerCase())) continue;
    if (e.isDir) {
      const nextSystem = system || e.name.toLowerCase() === '.system';
      await discoverInDir(e.path, scope, depth + 1, out, nextSystem);
    } else if (depth === 0 && e.name.endsWith('.md') && e.name.toUpperCase() !== 'README.MD') {
      const skill = await loadSkillFile(e.path, scope, { system });
      if (skill) out.push(skill);
    }
  }
  return out;
}

export type DiscoverSkillsResult = {
  skills: DesktopSkill[];
  roots: { path: string; scope: SkillScope; ok: boolean; count: number; error?: string }[];
};

export async function discoverSkills(opts?: {
  workspacePath?: string | null;
}): Promise<DiscoverSkillsResult> {
  const workspace = (opts?.workspacePath ?? getWorkspacePath() ?? '').trim();
  const extraDirs = getExtraSkillDirs();

  type RustSkillRow = {
  name?: unknown;
  filePath?: unknown;
  description?: unknown;
  baseDir?: unknown;
  content?: unknown;
  raw?: unknown;
  scope?: unknown;
  tags?: unknown;
  appliesTo?: unknown;
  fileActivation?: unknown;
  system?: unknown;
  disableModelInvocation?: unknown;
};

const rustSkills = await tryInvokeTauri<RustSkillRow[]>('workbench_discover_skills', {
    workspacePath: workspace || null,
    extraDirs,
  });

  if (Array.isArray(rustSkills)) {
    const skills: DesktopSkill[] = [];
    const map = loadActivationMap();
    const seenSkill = new Set<string>();

    for (const rs of rustSkills) {
      const name = String(rs.name);
      const filePath = String(rs.filePath);
      const id = skillStableId(name, filePath);
      if (seenSkill.has(id)) continue;
      seenSkill.add(id);

      const resolved = resolveActivationFromMap(map, id, filePath);
      if (resolved.migrated) saveActivationMap(map);

      const fileActivation = skillActivation(rs.fileActivation) || (rs.system ? 'recommended' : 'recommended');
      const activation = resolved.activation || fileActivation;

      skills.push({
        id,
        name,
        description: String(rs.description),
        filePath,
        baseDir: String(rs.baseDir),
        content: String(rs.content),
        raw: String(rs.raw),
        scope: (rs.scope as SkillScope) || 'global',
        activation,
        tags: Array.isArray(rs.tags) ? rs.tags.map(String) : [],
        appliesTo: Array.isArray(rs.appliesTo) ? rs.appliesTo.map(String) : [],
        disableModelInvocation: Boolean(rs.disableModelInvocation),
        system: Boolean(rs.system),
      });
    }

    skills.sort((a, b) => {
      const scopeOrder = { project: 0, workspace: 1, global: 2 };
      const d = scopeOrder[a.scope] - scopeOrder[b.scope];
      if (d !== 0) return d;
      const actOrder = { enabled: 0, recommended: 1, disabled: 2 };
      const ad = actOrder[a.activation] - actOrder[b.activation];
      if (ad !== 0) return ad;
      return a.name.localeCompare(b.name, 'zh-CN');
    });

    return { skills, roots: [] };
  }

  // Fallback to legacy JS discovery
  const roots: { path: string; scope: SkillScope }[] = [];

  if (workspace) {
    roots.push(
      { path: joinPath(workspace, '.conex/skills'), scope: 'project' },
      { path: joinPath(workspace, '.codex/skills'), scope: 'project' },
      { path: joinPath(workspace, '.agents/skills'), scope: 'project' },
      { path: joinPath(workspace, '.claude/skills'), scope: 'project' },
    );
  }

  const home = await tryHomeDir();
  if (home) {
    roots.push(
      { path: joinPath(home, '.codex/skills'), scope: 'global' },
      { path: joinPath(home, '.conex/skills'), scope: 'global' },
      { path: joinPath(home, '.claude/skills'), scope: 'global' },
      { path: joinPath(home, '.agents/skills'), scope: 'global' },
      { path: joinPath(home, '.grok/skills'), scope: 'global' },
      { path: joinPath(home, '.grok/bundled/skills'), scope: 'global' },
    );
  }

  for (const extra of getExtraSkillDirs()) {
    roots.push({ path: extra, scope: isAbsoluteFsPath(extra) ? 'global' : 'project' });
  }

  const seenRoot = new Set<string>();
  const uniqueRoots = roots.filter((r) => {
    const k = r.path.replace(/\\/g, '/').toLowerCase();
    if (seenRoot.has(k)) return false;
    seenRoot.add(k);
    return true;
  });

  const skills: DesktopSkill[] = [];
  const rootStatus: DiscoverSkillsResult['roots'] = [];
  const seenSkill = new Set<string>();

  for (const r of uniqueRoots) {
    try {
      const found = await discoverInDir(r.path, r.scope, 0, []);
      rootStatus.push({ path: r.path, scope: r.scope, ok: true, count: found.length });
      for (const s of found) {
        if (seenSkill.has(s.id)) continue;
        seenSkill.add(s.id);
        skills.push(s);
      }
    } catch (e) {
      rootStatus.push({
        path: r.path,
        scope: r.scope,
        ok: false,
        count: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  skills.sort((a, b) => {
    const scopeOrder = { project: 0, workspace: 1, global: 2 };
    const d = scopeOrder[a.scope] - scopeOrder[b.scope];
    if (d !== 0) return d;
    const actOrder = { enabled: 0, recommended: 1, disabled: 2 };
    const ad = actOrder[a.activation] - actOrder[b.activation];
    if (ad !== 0) return ad;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return { skills, roots: rootStatus };
}

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
  activation: SkillActivation,
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
export async function syncSkillsToDaemon(_skills: DesktopSkill[]): Promise<{ ok: number; fail: number }> {
  return { ok: 0, fail: 0 };
}

export async function readSkillRaw(filePath: string): Promise<string | null> {
  return readTextAny(filePath);
}

/** 开发时探测：是否具备本机文件读取能力 */
export async function skillsFsAvailable(): Promise<boolean> {
  const fs = await tryPluginFs();
  if (fs?.readDir && fs?.readTextFile) return true;
  return Boolean(getWorkspacePath());
}

/** 选择额外技能目录（原生对话框） */
export async function pickSkillDirectory(): Promise<string | null> {
  return openDirectoryDialogSafe('选择技能目录');
}

/** 在系统资源管理器中显示路径 */
export async function revealSkillPath(filePath: string): Promise<boolean> {
  try {
    const opener = (await (Function(
      'return import("@tauri-apps/plugin-opener")',
    )() as Promise<unknown>).catch(() => null)) as {
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
    /* ignore */
  }
  try {
    const shell = (await (Function(
      'return import("@tauri-apps/plugin-shell")',
    )() as Promise<unknown>).catch(() => null)) as { open?: (url: string) => Promise<unknown> } | null;
    if (shell?.open) {
      await shell.open(dirname(filePath));
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

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

/** 启用且未禁用模型调用的技能 → 斜杠命令 */
export function skillsToSlashCommands(skills: DesktopSkill[]): SkillSlashCommand[] {
  return skills
    .filter(
      (s) =>
        (s.activation === 'enabled' || s.activation === 'recommended') &&
        !s.disableModelInvocation,
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
  skills?: DesktopSkill[],
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

export function formatSkillInjection(skill: DesktopSkill, userRest: string): string {
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

/** 缓存：斜杠菜单用，避免每次按键全量扫描 */
let slashCache: { at: number; commands: SkillSlashCommand[]; skills: DesktopSkill[] } | null =
  null;
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
