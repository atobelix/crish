/**
 * 技能发现层（T4-11 R5 基线清零）。
 *
 * 从 `skillsApi.ts` 拆分而来；本模块承载 SKILL.md 文件解析与多根目录扫描发现
 * （Rust 命令优先，失败回退 legacy JS 发现）。无激活态写入 / 斜杠命令逻辑。
 * 依赖：`./skillsApiFs`（FS 访问）、`./skillsApiHelpers`（frontmatter / 路径工具）、
 * `./skillsApi.types`（类型契约）、`./skillId`（稳定 id）、`./projectStore`、
 * `./workspaceFsApi`、`./tauriInvoke`、`./userFacingErrors`。
 */

import { getWorkspacePath } from './projectStore';
import { invokeTyped } from './tauriInvoke';
import { logInternalError } from './userFacingErrors';
import { skillStableId } from './skillId';
import {
  isAbsoluteFsPath,
} from './workspaceFsApi';
import {
  ALLOWED_DOT_DIRS,
  basename,
  firstMarkdownSentence,
  joinPath,
  loadActivationMap,
  parseFrontmatter,
  resolveActivationFromMap,
  saveActivationMap,
  skillActivation,
  skillScope,
  stringList,
} from './skillsApiHelpers';
import type {
  DesktopSkill,
  SkillActivation,
  SkillScope,
} from './skillsApi.types';
import {
  listDirAny,
  readTextAny,
  tryHomeDir,
  getExtraSkillDirs,
} from './skillsApiFs';

/* ---------- 单文件解析 ---------- */

export async function loadSkillFile(
  filePath: string,
  scope: SkillScope,
  opts?: { system?: boolean; activationOverride?: SkillActivation }
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
    parsed.data.description || firstMarkdownSentence(parsed.body) || name
  );
  const fileActivation =
    skillActivation(parsed.data.activation) ||
    (opts?.system ? 'recommended' : 'recommended');
  // Must match agent-runtime: stableId("skill", `${name}:${filePath}`)
  const id = skillStableId(name, filePath);
  const map = loadActivationMap();
  const resolved = resolveActivationFromMap(map, id, filePath);
  if (resolved.migrated) saveActivationMap(map);
  const activation =
    opts?.activationOverride || resolved.activation || fileActivation;
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

/* ---------- 目录递归扫描 ---------- */

export async function discoverInDir(
  dir: string,
  scope: SkillScope,
  depth = 0,
  out: DesktopSkill[] = [],
  system = false
): Promise<DesktopSkill[]> {
  if (depth > 5) return out;
  const entries = await listDirAny(dir);
  if (!entries.length) return out;

  const hasSkillMd = entries.some(
    (e) => !e.isDir && e.name.toUpperCase() === 'SKILL.MD'
  );
  if (hasSkillMd) {
    const skillPath = joinPath(dir, 'SKILL.md');
    const hit = entries.find(
      (e) => !e.isDir && e.name.toUpperCase() === 'SKILL.MD'
    );
    const filePath = hit?.path || skillPath;
    const skill = await loadSkillFile(filePath, scope, { system });
    if (skill) out.push(skill);
    return out;
  }

  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '__pycache__') continue;
    if (e.name.startsWith('.') && !ALLOWED_DOT_DIRS.has(e.name.toLowerCase()))
      continue;
    if (e.isDir) {
      const nextSystem = system || e.name.toLowerCase() === '.system';
      await discoverInDir(e.path, scope, depth + 1, out, nextSystem);
    } else if (
      depth === 0 &&
      e.name.endsWith('.md') &&
      e.name.toUpperCase() !== 'README.MD'
    ) {
      const skill = await loadSkillFile(e.path, scope, { system });
      if (skill) out.push(skill);
    }
  }
  return out;
}

export type DiscoverSkillsResult = {
  skills: DesktopSkill[];
  roots: {
    path: string;
    scope: SkillScope;
    ok: boolean;
    count: number;
    error?: string;
  }[];
};

/* ---------- 发现入口：Rust 优先，回退 legacy JS ---------- */

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

  // T-F 06 T6.1 / T5-5：invokeTyped 三态化（原 tryInvokeTauri 别名）——
  // missing/error → logInternalError 后走 legacy JS 发现 fallback
  // （错误不再被吞为 null，可观测性保留；fallback 语义与旧行为等价）
  const res = await invokeTyped<RustSkillRow[]>('workbench_discover_skills', {
    workspacePath: workspace || null,
    extraDirs,
  });
  let rustSkills: unknown = null;
  if (res.status === 'error') {
    logInternalError('discoverSkills', res.message);
  } else if (res.status === 'ok') {
    rustSkills = res.data;
  }

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

      const fileActivation =
        skillActivation(rs.fileActivation) ||
        (rs.system ? 'recommended' : 'recommended');
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
      { path: joinPath(workspace, '.claude/skills'), scope: 'project' }
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
      { path: joinPath(home, '.grok/bundled/skills'), scope: 'global' }
    );
  }

  for (const extra of getExtraSkillDirs()) {
    roots.push({
      path: extra,
      scope: isAbsoluteFsPath(extra) ? 'global' : 'project',
    });
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
      rootStatus.push({
        path: r.path,
        scope: r.scope,
        ok: true,
        count: found.length,
      });
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
