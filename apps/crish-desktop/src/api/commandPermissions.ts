/**
 * 命令白名单：本机持久化 + 审批时自动放行（契约：LS + 桌面审批桥）
 *
 * - 匹配：命令行以白名单项为前缀，或白名单项为命令前缀（兼容短/长）
 * - 不伪造工具输出；仅在引擎要求确认时自动 approve-tool
 * - 与 permissionMode 配合：plan 模式仍不自动写操作（引擎侧为主）
 */

const STORAGE_KEY = 'crish_command_permissions_v1';

const DEFAULT_SEED = ['git status', 'git diff', 'git log', 'npm test', 'npm run test'];

export function loadCommandPermissions(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_SEED];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [...DEFAULT_SEED];
    return arr.map(String).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [...DEFAULT_SEED];
  }
}

export function saveCommandPermissions(list: string[]): void {
  const cleaned = [...new Set(list.map((s) => s.trim()).filter(Boolean))];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
}

export function addCommandPermission(list: string[], cmd: string): string[] {
  const c = cmd.trim();
  if (!c) return list;
  if (list.some((x) => x === c)) return list;
  const next = [...list, c];
  saveCommandPermissions(next);
  return next;
}

export function removeCommandPermission(list: string[], cmd: string): string[] {
  const next = list.filter((x) => x !== cmd);
  saveCommandPermissions(next);
  return next;
}

/** 规范化命令串便于前缀匹配 */
export function normalizeCommandLine(input: string): string {
  return input
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\$\s*/, '');
}

/**
 * 白名单是否覆盖该命令。
 * - 精确前缀：whitelist "git status" 匹配 "git status --short"
 * - 反向：whitelist 很长时也允许「命令是白名单前缀」避免误伤较少
 */
export function commandMatchesWhitelist(command: string, whitelist: string[]): boolean {
  const cmd = normalizeCommandLine(command).toLowerCase();
  if (!cmd || whitelist.length === 0) return false;
  for (const raw of whitelist) {
    const w = normalizeCommandLine(raw).toLowerCase();
    if (!w) continue;
    if (cmd === w || cmd.startsWith(w + ' ') || cmd.startsWith(w)) return true;
  }
  return false;
}

/**
 * 从审批参数中提取可读命令（与 bridge 提取策略对齐的轻量版）
 */
export function extractCommandForMatch(toolName: string, args: string): string {
  const a = (args || '').trim();
  if (!a) return toolName || '';
  if (!a.startsWith('{')) return a;
  try {
    const o = JSON.parse(a) as Record<string, unknown>;
    const candidates = [o.command, o.cmd, o.script, o.input, o.argv];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
      if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return (c as string[]).join(' ');
    }
  } catch {
    /* ignore */
  }
  return a;
}
