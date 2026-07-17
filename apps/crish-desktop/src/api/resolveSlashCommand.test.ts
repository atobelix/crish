import { describe, expect, it } from 'vitest';
import {
  KNOWN_SLASH_TOKENS,
  SLASH_COMMAND_SPECS,
  canonicalSlashFill,
  getSlashNoneReason,
  isConversationSlash,
  isEmptySlash,
  isNavigationSlash,
  isSessionlessSlash,
  isSideEffectSlash,
  isUnknownSlash,
  resolveSlashCommand,
  slashMenuPick,
  slashMissingArg,
  slashUsageHint,
} from './resolveSlashCommand';

describe('resolveSlashCommand', () => {
  it('returns none for plain text / empty / whitespace', () => {
    expect(resolveSlashCommand('hello')).toEqual({
      kind: 'none',
      raw: 'hello',
      noneReason: 'plain',
    });
    expect(resolveSlashCommand('')).toEqual({
      kind: 'none',
      raw: '',
      noneReason: 'plain',
    });
    expect(resolveSlashCommand('  ')).toEqual({
      kind: 'none',
      raw: '',
      noneReason: 'plain',
    });
    expect(getSlashNoneReason(resolveSlashCommand('hi'))).toBe('plain');
    expect(isEmptySlash(resolveSlashCommand('hi'))).toBe(false);
    expect(isUnknownSlash(resolveSlashCommand('hi'))).toBe(false);
  });

  it('empty slash `/` is none(empty), not a known command', () => {
    expect(resolveSlashCommand('/')).toEqual({
      kind: 'none',
      raw: '/',
      noneReason: 'empty',
    });
    expect(resolveSlashCommand('／')).toEqual({
      kind: 'none',
      raw: '/',
      noneReason: 'empty',
    });
    expect(isEmptySlash(resolveSlashCommand('/'))).toBe(true);
    expect(isUnknownSlash(resolveSlashCommand('/'))).toBe(false);
    expect(isSessionlessSlash(resolveSlashCommand('/'))).toBe(false);
  });

  it('unknown slash commands stay kind=none (unknown) — pure resolve, no session', () => {
    const u = resolveSlashCommand('/not-a-real-cmd');
    expect(u).toEqual({
      kind: 'none',
      raw: '/not-a-real-cmd',
      noneReason: 'unknown',
    });
    expect(isUnknownSlash(u)).toBe(true);
    expect(getSlashNoneReason(u)).toBe('unknown');
    // 不伪装成导航/对话命令，避免误开面板或误改 modelText
    expect(isNavigationSlash(u.kind)).toBe(false);
    expect(isConversationSlash(u.kind)).toBe(false);
    expect(isSessionlessSlash(u)).toBe(false);
    // 前缀近似但不等于：/goals 不得吞成 /goal
    expect(resolveSlashCommand('/goals')).toMatchObject({
      kind: 'none',
      noneReason: 'unknown',
    });
    expect(resolveSlashCommand('/scheduler')).toMatchObject({
      kind: 'none',
      noneReason: 'unknown',
    });
  });

  it('parses schedule / teamwork / browser (navigation)', () => {
    expect(resolveSlashCommand('/schedule')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('/Schedule')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('/schedule ignored-args')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('/teamwork-preview')).toEqual({ kind: 'teamwork-preview' });
    expect(resolveSlashCommand('/teamwork')).toEqual({ kind: 'teamwork-preview' });
    expect(resolveSlashCommand('/TEAMWORK extra')).toEqual({ kind: 'teamwork-preview' });
    expect(resolveSlashCommand('/browser https://a.com')).toEqual({
      kind: 'browser',
      url: 'https://a.com',
    });
    expect(resolveSlashCommand('/browser')).toEqual({ kind: 'browser', url: '' });
    expect(resolveSlashCommand('/browser   https://b.com  ')).toEqual({
      kind: 'browser',
      url: 'https://b.com',
    });
  });

  it('parses Chinese aliases for known commands', () => {
    expect(resolveSlashCommand('/定时')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('/定时任务')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('/协作')).toEqual({ kind: 'teamwork-preview' });
    expect(resolveSlashCommand('/看板')).toEqual({ kind: 'teamwork-preview' });
    expect(resolveSlashCommand('/浏览 https://cn.example')).toEqual({
      kind: 'browser',
      url: 'https://cn.example',
    });
    expect(resolveSlashCommand('/浏览器 https://x.test')).toEqual({
      kind: 'browser',
      url: 'https://x.test',
    });
    expect(resolveSlashCommand('/学习 保持简洁')).toEqual({
      kind: 'learn',
      rule: '保持简洁',
    });
    expect(resolveSlashCommand('/记住')).toMatchObject({
      kind: 'learn',
      missingArg: true,
    });
    expect(resolveSlashCommand('/目标 修测试')).toEqual({
      kind: 'goal',
      goal: '修测试',
    });
    expect(resolveSlashCommand('/目标')).toMatchObject({
      kind: 'goal',
      missingArg: true,
    });
    expect(resolveSlashCommand('/拷问 API 形状')).toEqual({
      kind: 'grill-me',
      topic: 'API 形状',
    });
    expect(resolveSlashCommand('/对齐')).toMatchObject({
      kind: 'grill-me',
      missingArg: true,
    });
    // 中文别名不得半截匹配
    expect(resolveSlashCommand('/目标foo')).toMatchObject({
      kind: 'none',
      noneReason: 'unknown',
    });
    // IME 全角/半角冒号作中文参数分隔：剥掉冒号，不半截匹配
    expect(resolveSlashCommand('/目标：修测试')).toEqual({
      kind: 'goal',
      goal: '修测试',
    });
    expect(resolveSlashCommand('/学习:保持简洁')).toEqual({
      kind: 'learn',
      rule: '保持简洁',
    });
    expect(resolveSlashCommand('/目标：')).toMatchObject({
      kind: 'goal',
      missingArg: true,
    });
  });

  it('parses learn / goal / grill-me with missing args', () => {
    expect(resolveSlashCommand('/learn')).toMatchObject({ kind: 'learn', missingArg: true });
    expect(resolveSlashCommand('/learn no any')).toEqual({ kind: 'learn', rule: 'no any' });
    expect(resolveSlashCommand('/goal')).toMatchObject({ kind: 'goal', missingArg: true });
    expect(resolveSlashCommand('/goal fix tests')).toEqual({ kind: 'goal', goal: 'fix tests' });
    expect(resolveSlashCommand('/grill-me')).toMatchObject({
      kind: 'grill-me',
      missingArg: true,
    });
    expect(resolveSlashCommand('/grill-me feature x')).toEqual({
      kind: 'grill-me',
      topic: 'feature x',
    });
    // 仅空白参数 → 缺参
    expect(resolveSlashCommand('/goal   ')).toMatchObject({
      kind: 'goal',
      goal: '',
      missingArg: true,
    });
    expect(resolveSlashCommand('/learn\t')).toMatchObject({
      kind: 'learn',
      missingArg: true,
    });
    // 英文别名 grillme
    expect(resolveSlashCommand('/grillme topic')).toEqual({
      kind: 'grill-me',
      topic: 'topic',
    });
  });

  it('parses skill command (colon form) with name/args split', () => {
    const r = resolveSlashCommand('/skill:foo do bar');
    expect(r.kind).toBe('skill');
    if (r.kind === 'skill') {
      expect(r.skillRest).toBe('foo do bar');
      expect(r.skillName).toBe('foo');
      expect(r.skillArgs).toBe('do bar');
      expect(r.raw).toBe('/skill:foo do bar');
    }
    const onlyName = resolveSlashCommand('/skill:review');
    expect(onlyName).toMatchObject({
      kind: 'skill',
      skillRest: 'review',
      skillName: 'review',
      skillArgs: '',
    });
    const cn = resolveSlashCommand('/技能:总结 本周');
    expect(cn).toMatchObject({
      kind: 'skill',
      skillName: '总结',
      skillArgs: '本周',
    });
    // 全角冒号（中文 IME）
    expect(resolveSlashCommand('/技能：总结 本周')).toMatchObject({
      kind: 'skill',
      skillName: '总结',
      skillArgs: '本周',
    });
    expect(resolveSlashCommand('/skill：foo bar')).toMatchObject({
      kind: 'skill',
      skillName: 'foo',
      skillArgs: 'bar',
    });
    expect(resolveSlashCommand('／技能：review')).toMatchObject({
      kind: 'skill',
      skillName: 'review',
      skillArgs: '',
    });
    // 无冒号的 /skill 不是 skill kind
    expect(resolveSlashCommand('/skill foo')).toMatchObject({
      kind: 'none',
      noneReason: 'unknown',
    });
    // 空技能名：解析期可知
    expect(resolveSlashCommand('/skill:')).toMatchObject({
      kind: 'skill',
      skillName: '',
      skillArgs: '',
    });
    expect(resolveSlashCommand('/技能：')).toMatchObject({
      kind: 'skill',
      skillName: '',
    });
  });

  it('accepts fullwidth slash prefix', () => {
    expect(resolveSlashCommand('／schedule')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('／goal ship')).toEqual({ kind: 'goal', goal: 'ship' });
    expect(resolveSlashCommand('／目标 完成迁移')).toEqual({
      kind: 'goal',
      goal: '完成迁移',
    });
  });

  it('classifies navigation vs side-effect vs conversation (错误流/幽灵会话边界)', () => {
    // 纯导航：不建会话、成功不 toast
    expect(isNavigationSlash('schedule')).toBe(true);
    expect(isNavigationSlash('teamwork-preview')).toBe(true);
    expect(isNavigationSlash('browser')).toBe(true);
    expect(isNavigationSlash('learn')).toBe(false);
    expect(isNavigationSlash('goal')).toBe(false);
    expect(isNavigationSlash('none')).toBe(false);

    // side-effect ⊇ navigation + learn
    expect(isSideEffectSlash('schedule')).toBe(true);
    expect(isSideEffectSlash('teamwork-preview')).toBe(true);
    expect(isSideEffectSlash('browser')).toBe(true);
    expect(isSideEffectSlash('learn')).toBe(true);
    expect(isSideEffectSlash('goal')).toBe(false);
    expect(isSideEffectSlash('skill')).toBe(false);

    expect(isConversationSlash('goal')).toBe(true);
    expect(isConversationSlash('grill-me')).toBe(true);
    expect(isConversationSlash('skill')).toBe(true);
    expect(isConversationSlash('schedule')).toBe(false);
    expect(isConversationSlash('teamwork-preview')).toBe(false);
    expect(isConversationSlash('learn')).toBe(false);
  });

  it('isSessionlessSlash guards navigation + missingArg (no ghost session)', () => {
    expect(isSessionlessSlash(resolveSlashCommand('/schedule'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/teamwork'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/browser https://a.com'))).toBe(
      true,
    );
    expect(isSessionlessSlash(resolveSlashCommand('/定时'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/协作'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/浏览'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/goal'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/learn'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/grill-me'))).toBe(true);
    // 中文缺参别名同样 sessionless
    expect(isSessionlessSlash(resolveSlashCommand('/目标'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/记住'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/对齐'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/拷问'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/目标：'))).toBe(true);
    // 空 skill 名：解析期 sessionless（防幽灵）
    expect(isSessionlessSlash(resolveSlashCommand('/skill:'))).toBe(true);
    expect(isSessionlessSlash(resolveSlashCommand('/技能：'))).toBe(true);
    // 有参对话命令：发送路径可能建会话（resolver 不建）
    expect(isSessionlessSlash(resolveSlashCommand('/goal ship'))).toBe(false);
    expect(isSessionlessSlash(resolveSlashCommand('/skill:x'))).toBe(false);
    expect(isSessionlessSlash(resolveSlashCommand('/技能：总结'))).toBe(false);
    expect(isSessionlessSlash(resolveSlashCommand('/目标：修测试'))).toBe(false);
    expect(isSessionlessSlash(resolveSlashCommand('plain'))).toBe(false);
    expect(isSessionlessSlash(resolveSlashCommand('/unknown'))).toBe(false);
  });

  it('slashMissingArg flags incomplete learn/goal/grill-me (no session before toast)', () => {
    expect(slashMissingArg(resolveSlashCommand('/goal'))).toBe(true);
    expect(slashMissingArg(resolveSlashCommand('/goal ship it'))).toBe(false);
    expect(slashMissingArg(resolveSlashCommand('/learn'))).toBe(true);
    expect(slashMissingArg(resolveSlashCommand('/learn keep dry'))).toBe(false);
    expect(slashMissingArg(resolveSlashCommand('/grill-me'))).toBe(true);
    expect(slashMissingArg(resolveSlashCommand('/grill-me api'))).toBe(false);
    expect(slashMissingArg(resolveSlashCommand('/schedule'))).toBe(false);
    expect(slashMissingArg(resolveSlashCommand('plain'))).toBe(false);
    expect(slashMissingArg(resolveSlashCommand('/skill:x'))).toBe(false);
    expect(slashMissingArg(resolveSlashCommand('/目标'))).toBe(true);
    expect(slashMissingArg(resolveSlashCommand('/学习 ok'))).toBe(false);
  });

  it('slashUsageHint provides Chinese usage for arg commands', () => {
    expect(slashUsageHint('learn')).toBe('用法：/learn <要记住的规则>');
    expect(slashUsageHint('goal')).toBe('用法：/goal <要完成的目标>');
    expect(slashUsageHint('grill-me')).toBe('用法：/grill-me <要对齐的主题>');
    expect(slashUsageHint('browser')).toBe('用法：/browser <url>');
    expect(slashUsageHint('skill')).toBe('用法：/skill:<技能名> [参数]');
    expect(slashUsageHint('schedule')).toBeNull();
    expect(slashUsageHint('none')).toBeNull();
  });

  it('canonicalSlashFill and KNOWN_SLASH_TOKENS registry', () => {
    expect(canonicalSlashFill('schedule')).toBe('/schedule');
    expect(canonicalSlashFill('teamwork-preview')).toBe('/teamwork');
    expect(canonicalSlashFill('browser')).toBe('/browser ');
    expect(canonicalSlashFill('goal')).toBe('/goal ');
    expect(canonicalSlashFill('skill')).toBe('/skill:');
    expect(KNOWN_SLASH_TOKENS).toEqual(
      expect.arrayContaining([
        'schedule',
        'teamwork',
        'browser',
        'learn',
        'goal',
        'grill-me',
        'skill',
      ]),
    );
    expect(SLASH_COMMAND_SPECS.some((s) => s.kind === 'goal')).toBe(true);
  });

  it('slashMenuPick aligns menu fill with resolveSlashCommand kinds', () => {
    expect(slashMenuPick('/schedule')).toEqual({ action: 'open-schedule' });
    expect(slashMenuPick('/teamwork')).toEqual({ action: 'fill', text: '/teamwork' });
    expect(slashMenuPick('/teamwork-preview')).toEqual({ action: 'fill', text: '/teamwork' });
    expect(slashMenuPick('/browser')).toEqual({ action: 'fill', text: '/browser ' });
    expect(slashMenuPick('/learn')).toEqual({ action: 'fill', text: '/learn ' });
    expect(slashMenuPick('/goal')).toEqual({ action: 'fill', text: '/goal ' });
    expect(slashMenuPick('/grill-me')).toEqual({ action: 'fill', text: '/grill-me ' });
    expect(slashMenuPick('/skill:review')).toEqual({ action: 'fill', text: '/skill:review ' });
    expect(slashMenuPick('/simulate')).toEqual({ action: 'fill', text: '/simulate ' });
    // 中文别名点选 → 规范英文 fill / open
    expect(slashMenuPick('/定时')).toEqual({ action: 'open-schedule' });
    expect(slashMenuPick('协作')).toEqual({ action: 'fill', text: '/teamwork' });
    expect(slashMenuPick('/目标')).toEqual({ action: 'fill', text: '/goal ' });
    expect(slashMenuPick('')).toEqual({ action: 'fill', text: '/' });
    expect(slashMenuPick('goal')).toEqual({ action: 'fill', text: '/goal ' });
  });

  it('resolve is pure: repeated calls equal, no throw on odd input', () => {
    const samples = [
      null as unknown as string,
      undefined as unknown as string,
      '/',
      '/goal',
      '/goal x',
      '/技能:a b',
      'not slash',
      '／浏览 u',
    ];
    for (const s of samples) {
      const a = resolveSlashCommand(s);
      const b = resolveSlashCommand(s);
      expect(a).toEqual(b);
    }
    // 导航结果不含可写副作用字段
    expect(resolveSlashCommand('/schedule')).toEqual({ kind: 'schedule' });
    expect(resolveSlashCommand('/协作')).toEqual({ kind: 'teamwork-preview' });
  });
});
