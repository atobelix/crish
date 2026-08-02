/**
 * 规则 → 本机设置（T03.7：upsert/delete-scoped-context 幽灵命令已删，显式本地-only）。
 * id 固定，便于覆盖更新：
 * - rule:desktop:global
 * - rule:desktop:project
 */

export const RULE_ID_GLOBAL = 'rule:desktop:global';
export const RULE_ID_PROJECT = 'rule:desktop:project';

const MAX_RULE_CHARS = 12_000;

export type SyncRulesResult = {
  ok: boolean;
  localSaved: boolean;
  /** T03.7：scoped-context 仅本机保存，恒 false（显式本地-only） */
  daemonSynced: boolean;
  error?: string;
  truncated?: boolean;
};

function normalizeRuleBody(text: string): { body: string; truncated: boolean } {
  let body = text.replace(/\r\n/g, '\n').trim();
  let truncated = false;
  if (body.length > MAX_RULE_CHARS) {
    body = body.slice(0, MAX_RULE_CHARS) + '\n\n…（已截断，完整内容仍保存在本机设置）';
    truncated = true;
  }
  return { body, truncated };
}

/**
 * 将规则保存到本机设置（localSaved 由调用方在 saveSettings 后设为 true）。
 * T03.7：引擎 scoped-context 通道已删，daemonSynced 恒 false（无引擎同步）。
 * projectText 省略时仅处理全局规则。
 */
export async function syncRulesToDaemon(opts: {
  globalText: string;
  /** 省略则不同步项目规则 */
  projectText?: string;
}): Promise<SyncRulesResult> {
  const g = normalizeRuleBody(opts.globalText);
  const truncated =
    g.truncated ||
    (opts.projectText !== undefined
      ? normalizeRuleBody(opts.projectText).truncated
      : false);
  return {
    ok: true,
    localSaved: true,
    daemonSynced: false,
    truncated,
  };
}

/** 从 settings.customRules 拼成可编辑正文 */
export function rulesLinesToText(lines: string[] | undefined, heading: string): string {
  const body = (lines || []).filter(Boolean).join('\n');
  if (body.trim()) return body;
  return `${heading}\n\n`;
}

export function textToRuleLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
}
