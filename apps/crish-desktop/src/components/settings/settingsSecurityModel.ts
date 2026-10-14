/**
 * 设置 · 安全：纯逻辑模型与常量（从 SettingsSecurityTab 拆出，供组件与
 * 后续单测共用）。无 React / store 依赖。
 */
import { sanitizeWhitelistEntry } from '../../api/commandPermissions';

/** 常用只读命令 */
export const QUICK_WHITELIST_CMDS = [
  'git status',
  'git diff',
  'git log',
  'npm test',
  'npm run typecheck',
] as const;

export const WHITELIST_MATCH_HINT =
  '按整条命令匹配；后面可带参数，不会误伤相似命令名';

/**
 * 纯 UX 提示（P1 权限归一 B2，主控裁决 3）：白名单仅为批准记忆——是否放行
 * 由引擎按权限模式裁决；高危命令（rm / format 等）即使加入白名单也不会被
 * 自动放行（引擎红线/审批门禁兜底），本处不做任何 allow/deny 判定、不读
 * 风险正则表。
 */
export const WHITELIST_REMEMBER_HINT =
  '高危命令（如 rm、format）不会被自动放行——白名单仅为批准记忆，放行由引擎按权限模式裁决';

/** 路径短名 */
export function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** 批准记忆清洗：sanitize + 大小写去重 + zh 排序（与原 SettingsSecurityTab 实现逐行一致） */
export function dedupeWhitelist(raw: string[]): string[] {
  const cleaned = raw.map((x) => sanitizeWhitelistEntry(x)).filter(Boolean);
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const cmd of cleaned) {
    const key = cmd.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(cmd);
  }
  return deduped.slice().sort((a, b) => a.localeCompare(b, 'zh'));
}
