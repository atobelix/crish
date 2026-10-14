import type { SkillActivation, SkillScope } from './skillsApi.types';

export const ACTIVATION_KEY = 'crish_skill_activation_v1'; // gitleaks:allow
export const EXTRA_DIRS_KEY = 'crish_skill_extra_dirs_v1'; // gitleaks:allow

/** 子目录名以这些开头时不跳过（点目录通常跳过） */
export const ALLOWED_DOT_DIRS = new Set(['.system']);

export function joinPath(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes('\\') ? '\\' : '/';
  return `${base.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function basename(p: string): string {
  const n = p.replace(/[\\/]+$/, '');
  const i = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
  return i >= 0 ? n.slice(i + 1) : n;
}

export function dirname(p: string): string {
  const n = p.replace(/[\\/]+$/, '');
  const i = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
  return i >= 0 ? n.slice(0, i) : n;
}

/** Legacy desktop id (pre-T1). Used only for localStorage migration. */
export function legacySkillIdFromPath(filePath: string): string {
  return `skill-file:${filePath.replace(/\\/g, '/').toLowerCase()}`;
}

/**
 * Resolve activation for a skill id, migrating legacy `skill-file:...` keys
 * onto runtime-compatible `skill_<hash>` when found by path.
 */
export function resolveActivationFromMap(
  map: Record<string, SkillActivation>,
  id: string,
  filePath: string
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

export function normalizeSlashName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/* ---------- frontmatter（对齐 agent-runtime / Codex SKILL.md） ---------- */

export function parseFrontmatter(content: string): {
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

export function stringList(v: unknown): string[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  return v
    .split(/[,[\]]/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function skillScope(v: unknown): SkillScope | undefined {
  if (v === 'global' || v === 'project' || v === 'workspace') return v;
  return undefined;
}

export function skillActivation(v: unknown): SkillActivation | undefined {
  if (v === 'enabled' || v === 'recommended' || v === 'disabled') return v;
  return undefined;
}

export function firstMarkdownSentence(content: string): string | undefined {
  const line = content
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'));
  return line?.slice(0, 160);
}

/* ---------- activation store ---------- */

export function loadActivationMap(): Record<string, SkillActivation> {
  try {
    const raw = localStorage.getItem(ACTIVATION_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export function saveActivationMap(map: Record<string, SkillActivation>) {
  localStorage.setItem(ACTIVATION_KEY, JSON.stringify(map));
}
