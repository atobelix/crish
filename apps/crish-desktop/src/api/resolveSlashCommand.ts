/**
 * 斜杠命令解析：纯函数，无 store / 网络副作用。
 * useChatStream 只负责执行副作用（开面板、写规则、开流）。
 */

export type SlashCommandKind =
  | 'schedule'
  | 'teamwork-preview'
  | 'browser'
  | 'learn'
  | 'goal'
  | 'grill-me'
  | 'skill'
  | 'none';

export type ResolvedSlashCommand =
  | { kind: 'none'; raw: string }
  | { kind: 'schedule' }
  | { kind: 'teamwork-preview' }
  | { kind: 'browser'; url: string }
  | { kind: 'learn'; rule: string; missingArg?: boolean }
  | { kind: 'goal'; goal: string; missingArg?: boolean }
  | { kind: 'grill-me'; topic: string; missingArg?: boolean }
  | { kind: 'skill'; raw: string; skillRest: string };

/**
 * 解析用户输入中的 slash 命令（不含技能正文注入与异步发现）。
 * 空串 / 非 / 开头 → none。
 */
export function resolveSlashCommand(input: string): ResolvedSlashCommand {
  const raw = (input || '').trim();
  if (!raw || raw[0] !== '/') {
    return { kind: 'none', raw };
  }

  if (/^\/schedule\b/i.test(raw)) {
    return { kind: 'schedule' };
  }
  if (/^\/teamwork-preview\b/i.test(raw)) {
    return { kind: 'teamwork-preview' };
  }
  if (/^\/browser\b/i.test(raw)) {
    const url = raw.replace(/^\/browser\b/i, '').trim();
    return { kind: 'browser', url };
  }
  if (/^\/learn\b/i.test(raw)) {
    const rule = raw.replace(/^\/learn\b/i, '').trim();
    return rule
      ? { kind: 'learn', rule }
      : { kind: 'learn', rule: '', missingArg: true };
  }
  if (/^\/goal\b/i.test(raw)) {
    const goal = raw.replace(/^\/goal\b/i, '').trim();
    return goal
      ? { kind: 'goal', goal }
      : { kind: 'goal', goal: '', missingArg: true };
  }
  if (/^\/grill-me\b/i.test(raw)) {
    const topic = raw.replace(/^\/grill-me\b/i, '').trim();
    return topic
      ? { kind: 'grill-me', topic }
      : { kind: 'grill-me', topic: '', missingArg: true };
  }
  if (/^\/skill:/i.test(raw)) {
    const rest = raw.replace(/^\/skill:/i, '').trim();
    return { kind: 'skill', raw, skillRest: rest };
  }

  return { kind: 'none', raw };
}

/** 是否为会改写 modelText 的「对话内」命令（goal/grill-me/skill），而非纯导航 */
export function isConversationSlash(kind: SlashCommandKind): boolean {
  return kind === 'goal' || kind === 'grill-me' || kind === 'skill';
}
