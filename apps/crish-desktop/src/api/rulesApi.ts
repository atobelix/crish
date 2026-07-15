/**
 * 规则 → 引擎 scoped-context（契约：ENGINE-SCOPED）
 * id 固定，便于覆盖更新：
 * - rule:desktop:global
 * - rule:desktop:project
 */

import { getDesktopDaemonClient } from './daemonClient';
import { getWorkspacePath } from './projectStore';

export const RULE_ID_GLOBAL = 'rule:desktop:global';
export const RULE_ID_PROJECT = 'rule:desktop:project';

const MAX_RULE_CHARS = 12_000;

export type SyncRulesResult = {
  ok: boolean;
  localSaved: boolean;
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

async function ensureDaemon(timeoutMs = 6_000): Promise<boolean> {
  const client = getDesktopDaemonClient();
  if (client.isConnected()) return true;
  return client.waitUntilConnected(timeoutMs);
}

async function upsertRule(opts: {
  id: string;
  title: string;
  content: string;
  scope: 'global' | 'project';
}): Promise<void> {
  const client = getDesktopDaemonClient();
  if (!opts.content.trim()) {
    try {
      await client.request(
        { type: 'delete-scoped-context', id: opts.id },
        'scoped-context-deleted',
        8_000,
      );
    } catch {
      /* 无记录时忽略 */
    }
    return;
  }
  await client.request(
    {
      type: 'upsert-scoped-context',
      record: {
        id: opts.id,
        kind: 'rule',
        title: opts.title,
        content: opts.content,
        description: opts.title,
        scope: opts.scope,
        activation: 'enabled',
        appliesTo: [],
        tags: ['desktop', 'rules'],
        source: {
          type: 'desktop-settings',
          path: opts.scope === 'project' ? getWorkspacePath() || '' : 'global',
          label: opts.title,
        },
        order: opts.scope === 'project' ? 1 : 0,
        updatedAt: new Date().toISOString(),
      },
    },
    'scoped-context-upserted',
    12_000,
  );
}

/**
 * 将规则同步到引擎。localSaved 由调用方在 saveSettings 后设为 true。
 * projectText 省略时仅更新全局规则，避免误删项目规则。
 */
export async function syncRulesToDaemon(opts: {
  globalText: string;
  /** 省略则不同步项目规则 */
  projectText?: string;
}): Promise<SyncRulesResult> {
  const g = normalizeRuleBody(opts.globalText);
  const p =
    opts.projectText !== undefined ? normalizeRuleBody(opts.projectText) : null;
  const truncated = g.truncated || Boolean(p?.truncated);

  if (!(await ensureDaemon())) {
    return {
      ok: true,
      localSaved: true,
      daemonSynced: false,
      error: '引擎未连接',
      truncated,
    };
  }

  try {
    await upsertRule({
      id: RULE_ID_GLOBAL,
      title: '全局规则',
      content: g.body,
      scope: 'global',
    });
    if (p) {
      await upsertRule({
        id: RULE_ID_PROJECT,
        title: '项目规则',
        content: p.body,
        scope: 'project',
      });
    }
    return { ok: true, localSaved: true, daemonSynced: true, truncated };
  } catch (e) {
    return {
      ok: false,
      localSaved: true,
      daemonSynced: false,
      error: e instanceof Error ? e.message : String(e),
      truncated,
    };
  }
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
