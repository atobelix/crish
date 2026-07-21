import { describe, expect, it } from 'vitest';
import {
  EMPTY_SESSION_TITLE,
  SESSION_TITLE_MAX_LEN,
  deriveSessionTitle,
  fillDefaultSessionTitles,
  findReusableEmptyShell,
  firstUserMessageText,
  isDefaultSessionTitle,
  isEmptyShellSession,
  isScheduledSessionTitle,
  maybeAutoTitleFromMessages,
  prepareSessionsForUi,
  pruneEmptyShellSessions,
  sanitizeSessionTitleText,
  sessionHasListableContent,
  sessionListDisplayTitle,
  shellPruneKeepIds,
  shouldListSessionInSidebar,
  truncateSessionTitle,
  withTitleCollisionSuffix,
} from './sessionTitle';

describe('sessionTitle shell helpers', () => {
  it('isDefaultSessionTitle covers zh/en placeholders', () => {
    expect(isDefaultSessionTitle('')).toBe(true);
    expect(isDefaultSessionTitle('  ')).toBe(true);
    expect(isDefaultSessionTitle('新会话')).toBe(true);
    expect(isDefaultSessionTitle(EMPTY_SESSION_TITLE)).toBe(true);
    expect(isDefaultSessionTitle('新对话')).toBe(true);
    expect(isDefaultSessionTitle('会话')).toBe(true);
    expect(isDefaultSessionTitle('无标题')).toBe(true);
    expect(isDefaultSessionTitle('新会话 2')).toBe(true);
    expect(isDefaultSessionTitle('新会话2')).toBe(true);
    expect(isDefaultSessionTitle('新对话(1)')).toBe(true);
    expect(isDefaultSessionTitle('新会话#3')).toBe(true);
    // 英文 / 引擎常见占位
    expect(isDefaultSessionTitle('New Session')).toBe(true);
    expect(isDefaultSessionTitle('new chat')).toBe(true);
    expect(isDefaultSessionTitle('Untitled')).toBe(true);
    expect(isDefaultSessionTitle('Untitled Session')).toBe(true);
    expect(isDefaultSessionTitle('Untitled Conversation')).toBe(true);
    expect(isDefaultSessionTitle('Untitled-1')).toBe(true);
    expect(isDefaultSessionTitle('No Title')).toBe(true);
    expect(isDefaultSessionTitle('Session')).toBe(true);
    expect(isDefaultSessionTitle('Chat 3')).toBe(true);
    expect(isDefaultSessionTitle('真实标题')).toBe(false);
    // 真实中文标题不得被 startsWith 误伤
    expect(isDefaultSessionTitle('新会话记录')).toBe(false);
    expect(isDefaultSessionTitle('新对话中的方案')).toBe(false);
    expect(isDefaultSessionTitle('未命名方案')).toBe(false);
    // 连字符 / 括号编号（对齐 Untitled-1）
    expect(isDefaultSessionTitle('新会话-2')).toBe(true);
    expect(isDefaultSessionTitle('新对话#3')).toBe(true);
    // 未命名* 幽灵标签（对称 Untitled）
    expect(isDefaultSessionTitle('未命名')).toBe(true);
    expect(isDefaultSessionTitle('未命名会话')).toBe(true);
    expect(isDefaultSessionTitle('未命名对话')).toBe(true);
    expect(isDefaultSessionTitle('未命名聊天')).toBe(true);
    expect(isDefaultSessionTitle('未命名会话 2')).toBe(true);
    // 定时任务占位标题不是默认，勿被当成可复用空壳
    expect(isDefaultSessionTitle('定时 · 每日 PR 总结')).toBe(false);
    expect(isDefaultSessionTitle('定时 · 任务')).toBe(false);
    expect(isDefaultSessionTitle('定时·紧凑')).toBe(false);
  });

  it('isScheduledSessionTitle matches workflow prefix', () => {
    expect(isScheduledSessionTitle('定时 · 每日 PR 总结')).toBe(true);
    expect(isScheduledSessionTitle('定时 · 任务')).toBe(true);
    expect(isScheduledSessionTitle('定时·紧凑')).toBe(true);
    expect(isScheduledSessionTitle('  定时 · x  ')).toBe(true);
    expect(isScheduledSessionTitle('新会话')).toBe(false);
    expect(isScheduledSessionTitle('定时任务无间隔点')).toBe(false);
    expect(isScheduledSessionTitle('')).toBe(false);
  });

  it('isEmptyShellSession ignores pinned and content', () => {
    expect(
      isEmptyShellSession({ title: '新会话', messages: [], isPinned: false })
    ).toBe(true);
    expect(
      isEmptyShellSession({ title: '新会话', messages: [], isPinned: true })
    ).toBe(false);
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [{ sender: 'user', text: 'hi' }],
      })
    ).toBe(false);
    // 仅空白 text 的消息不算实质内容 → 仍是空壳
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [{ sender: 'user', text: '   ' }],
      })
    ).toBe(true);
    // 空白 thinking / 空 toolCalls 仍是空壳
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [
          { sender: 'assistant', text: '', thinking: '  ', toolCalls: [] },
        ],
      })
    ).toBe(true);
    // messages/agents 为 null/undefined 视为无内容
    expect(
      isEmptyShellSession({ title: '新会话', messages: null, agents: null })
    ).toBe(true);
    expect(isEmptyShellSession({ title: 'New Session' })).toBe(true);
    // 有 toolCalls 视为实质内容
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [
          { sender: 'assistant', text: '', toolCalls: [{ id: 't1' }] },
        ],
      })
    ).toBe(false);
    // 仅有 thinking 亦不当空壳（水合半成品）
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [{ sender: 'assistant', text: '', thinking: 'plan…' }],
      })
    ).toBe(false);
    // 有 agent 不当空壳
    expect(
      isEmptyShellSession({
        title: '新会话',
        messages: [],
        agents: [{ id: 'a1' }],
      })
    ).toBe(false);
  });

  it('isEmptyShellSession never treats scheduled titles as shells', () => {
    expect(
      isEmptyShellSession({
        title: '定时 · 每日 PR 总结',
        messages: [],
        isPinned: false,
      })
    ).toBe(false);
    expect(
      isEmptyShellSession({
        title: '定时 · 任务',
        messages: [],
      })
    ).toBe(false);
    // 定时空消息壳：prune 后仍保留
    const kept = pruneEmptyShellSessions(
      [
        { id: 'sched', title: '定时 · 巡检', messages: [] },
        { id: 'ghost', title: '新会话', messages: [] },
      ],
      { keepIds: [] }
    );
    expect(kept.map((s) => s.id)).toEqual(['sched']);
  });

  it('sessionHasListableContent requires substance', () => {
    expect(sessionHasListableContent({ messages: [] })).toBe(false);
    expect(
      sessionHasListableContent({ messages: [{ sender: 'user', text: '' }] })
    ).toBe(false);
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'user', text: 'x' }],
      })
    ).toBe(true);
    expect(sessionHasListableContent({ agents: [{}] })).toBe(true);
    expect(
      sessionHasListableContent({
        messages: [{ sender: 'assistant', thinking: 'draft' }],
      })
    ).toBe(true);
  });

  it('shouldListSessionInSidebar hides empty default-title shells', () => {
    const shell = { id: 'a', title: '新会话', messages: [] as [] };
    // 空壳默认标题：active / 非 active 均不列表（草稿由 PENDING_DRAFT 处理）
    expect(shouldListSessionInSidebar(shell, 'a')).toBe(false);
    expect(shouldListSessionInSidebar(shell, 'other')).toBe(false);
    expect(
      shouldListSessionInSidebar(
        {
          id: 'b',
          title: '有内容',
          messages: [{ sender: 'user', text: 'x' }],
        },
        'other'
      )
    ).toBe(true);
    // 定时后台会话始终可列表
    expect(
      shouldListSessionInSidebar(
        { id: 's', title: '定时 · 任务', messages: [] },
        'other'
      )
    ).toBe(true);
    // 置顶空壳仍列表
    expect(
      shouldListSessionInSidebar(
        { id: 'p', title: '新会话', messages: [], isPinned: true },
        'other'
      )
    ).toBe(true);
    // 归档双重保险
    expect(
      shouldListSessionInSidebar(
        {
          id: 'ar',
          title: '有内容',
          messages: [{ sender: 'user', text: 'x' }],
          isArchived: true,
        },
        'ar'
      )
    ).toBe(false);
  });

  it('findReusableEmptyShell prefers folder match and preferId', () => {
    const sessions = [
      { id: '1', title: '新会话', folder: 'p1', messages: [] },
      { id: '2', title: '新会话', folder: 'p2', messages: [] },
      { id: '3', title: '新会话', folder: 'p2', messages: [] },
    ];
    expect(findReusableEmptyShell(sessions, 'p2')).toBe('2');
    expect(findReusableEmptyShell(sessions, 'missing')).toBe(null);
    // preferId 优先（同 folder）
    expect(findReusableEmptyShell(sessions, 'p2', { preferId: '3' })).toBe('3');
    // preferId 跨 folder 不合格 → 回落同 folder 第一项
    expect(findReusableEmptyShell(sessions, 'p2', { preferId: '1' })).toBe('2');
    // excludeId
    expect(findReusableEmptyShell(sessions, 'p2', { excludeId: '2' })).toBe(
      '3'
    );
    // 归档不可复用
    expect(
      findReusableEmptyShell(
        [
          {
            id: 'a',
            title: '新会话',
            folder: 'p1',
            messages: [],
            isArchived: true,
          },
        ],
        'p1'
      )
    ).toBe(null);
    // 定时标题不可被「新建」复用
    expect(
      findReusableEmptyShell(
        [
          { id: 'sched', title: '定时 · 巡检', folder: 'p1', messages: [] },
          { id: 'shell', title: '新会话', folder: 'p1', messages: [] },
        ],
        'p1'
      )
    ).toBe('shell');
  });

  it('pruneEmptyShellSessions keeps keepIds and identity when unchanged', () => {
    const sessions = [
      { id: 'a', title: '新会话', messages: [] },
      { id: 'b', title: '新会话', messages: [] },
      {
        id: 'c',
        title: '真实',
        messages: [{ sender: 'user', text: 'hi' }],
      },
    ];
    const next = pruneEmptyShellSessions(sessions, { keepIds: ['b'] });
    expect(next.map((s) => s.id)).toEqual(['b', 'c']);
    // 无壳可剪时返回同一引用
    const onlyContent = [
      { id: 'c', title: '真实', messages: [{ sender: 'user', text: 'hi' }] },
    ];
    expect(pruneEmptyShellSessions(onlyContent)).toBe(onlyContent);
  });

  it('pruneEmptyShellSessions keeps pinned shells without keepIds', () => {
    const sessions = [
      { id: 'ghost', title: '新会话', messages: [] as [], isPinned: false },
      { id: 'pinned', title: '新会话', messages: [] as [], isPinned: true },
      { id: 'sched', title: '定时 · 巡检', messages: [] as [] },
    ];
    const next = pruneEmptyShellSessions(sessions);
    expect(next.map((s) => s.id)).toEqual(['pinned', 'sched']);
  });

  it('shellPruneKeepIds: activating drops old active from keep', () => {
    expect(shellPruneKeepIds('new', 'old', { activating: true })).toEqual([
      'new',
    ]);
    expect(shellPruneKeepIds('bg', 'old', { activating: false })).toEqual([
      'bg',
      'old',
    ]);
    expect(shellPruneKeepIds('same', 'same', { activating: false })).toEqual([
      'same',
    ]);
    expect(shellPruneKeepIds(null, 'old', { activating: true })).toEqual([]);
    // activating:true 时旧 active 不进 keep，但 extra 仍保留
    expect(
      shellPruneKeepIds('new', 'old', {
        activating: true,
        extraKeepIds: ['extra', 'new'],
      })
    ).toEqual(['new', 'extra']);
    // activate:false 后台建会话：primary + active + extra
    expect(
      shellPruneKeepIds('sched', 'active', {
        activating: false,
        extraKeepIds: ['other'],
      })
    ).toEqual(['sched', 'active', 'other']);
  });

  it('prepareSessionsForUi fills titles then prunes non-active shells', () => {
    const sessions = [
      {
        id: 'ghost',
        title: '新会话',
        messages: [] as { sender: string; text: string }[],
      },
      {
        id: 'active-shell',
        title: '新会话',
        messages: [] as { sender: string; text: string }[],
      },
      {
        id: 'with-msg',
        title: '新会话',
        messages: [{ sender: 'user', text: '帮我写 PR 总结' }],
      },
      {
        id: 'sched',
        title: '定时 · 巡检',
        messages: [] as { sender: string; text: string }[],
      },
    ];
    const next = prepareSessionsForUi(sessions, 'active-shell');
    expect(next.map((s) => s.id)).toEqual([
      'active-shell',
      'with-msg',
      'sched',
    ]);
    // 有消息的默认标题被推导
    expect(next.find((s) => s.id === 'with-msg')?.title).toContain('帮我写');
    // 定时保留；活动空壳保留；幽灵剪掉
    expect(next.find((s) => s.id === 'ghost')).toBeUndefined();
  });

  it('prepareSessionsForUi returns same ref when nothing to change', () => {
    const sessions = [
      {
        id: 'a',
        title: '真实标题',
        messages: [{ sender: 'user', text: 'x' }],
      },
    ];
    expect(prepareSessionsForUi(sessions, null)).toBe(sessions);
  });

  it('prepareSessionsForUi honors explicit keepIds over active', () => {
    const sessions = [
      { id: 'a', title: '新会话', messages: [] as [] },
      { id: 'b', title: '新会话', messages: [] as [] },
      { id: 'c', title: '新会话', messages: [] as [] },
    ];
    // keepIds 显式优先：可保留非 active 的空壳（并发后台会话）
    const next = prepareSessionsForUi(sessions, 'a', { keepIds: ['b', 'c'] });
    expect(next.map((s) => s.id).sort()).toEqual(['b', 'c']);
  });

  it('deriveSessionTitle / maybeAutoTitle / displayTitle boundaries', () => {
    expect(deriveSessionTitle('  hello   world  ')).toBe('hello world');
    expect(deriveSessionTitle('/help')).toBe(EMPTY_SESSION_TITLE);
    expect(deriveSessionTitle('/help')).toBe('新会话');
    expect(deriveSessionTitle('/cmd 真实问题')).toBe('真实问题');
    expect(deriveSessionTitle('x'.repeat(40)).endsWith('…')).toBe(true);
    expect(deriveSessionTitle('x'.repeat(40)).length).toBe(
      SESSION_TITLE_MAX_LEN + 1
    ); // 28 + …

    expect(
      maybeAutoTitleFromMessages('用户改名', [{ sender: 'user', text: 'hi' }])
    ).toBe(null);
    expect(
      maybeAutoTitleFromMessages('新会话', [{ sender: 'user', text: '/help' }])
    ).toBe(null);
    expect(
      maybeAutoTitleFromMessages('新会话', [
        { sender: 'assistant', text: 'ignore me' },
        { sender: 'user', text: '帮我写单测' },
      ])
    ).toContain('帮我写');

    expect(
      sessionListDisplayTitle({
        title: '真实侧栏名',
        messages: [{ sender: 'user', text: '应被忽略' }],
      })
    ).toBe('真实侧栏名');
    expect(
      sessionListDisplayTitle({
        title: '新会话',
        messages: [{ sender: 'user', text: '从消息展示' }],
      })
    ).toContain('从消息');
    expect(sessionListDisplayTitle({ title: '', messages: [] })).toBe('新会话');
    expect(sessionListDisplayTitle({ title: '', messages: [] })).toBe(
      EMPTY_SESSION_TITLE
    );
    expect(
      sessionListDisplayTitle({ title: '定时 · 任务', messages: [] })
    ).toBe('定时 · 任务');
  });

  it('findReusableEmptyShell without folder returns first non-archived shell', () => {
    const sessions = [
      { id: 'archived', title: '新会话', messages: [], isArchived: true },
      { id: 'first', title: '新会话', folder: 'p1', messages: [] },
      { id: 'second', title: '新会话', folder: 'p2', messages: [] },
    ];
    expect(findReusableEmptyShell(sessions)).toBe('first');
    expect(findReusableEmptyShell(sessions, null, { preferId: 'second' })).toBe(
      'second'
    );
  });
});

describe('sessionTitle pure helpers: sanitize / CJK / collision', () => {
  it('sanitizeSessionTitleText strips control, slash, markdown, list, quotes', () => {
    expect(sanitizeSessionTitleText('  a\n\tb  ')).toBe('a b');
    expect(sanitizeSessionTitleText('/help')).toBe('');
    expect(sanitizeSessionTitleText('/cmd  /other  正文')).toBe('正文');
    expect(sanitizeSessionTitleText('## 标题草稿')).toBe('标题草稿');
    expect(sanitizeSessionTitleText('- 列表项')).toBe('列表项');
    expect(sanitizeSessionTitleText('1. 有序项')).toBe('有序项');
    expect(sanitizeSessionTitleText('1、中文有序')).toBe('中文有序');
    expect(sanitizeSessionTitleText('「加引号」')).toBe('加引号');
    expect(sanitizeSessionTitleText('句末噪声。')).toBe('句末噪声');
    expect(sanitizeSessionTitleText('Hello!')).toBe('Hello');
    // 零宽 / BOM
    expect(sanitizeSessionTitleText('\u200B隐\uFEFF藏')).toBe('隐藏');
    // 全角空格
    expect(sanitizeSessionTitleText('中文\u3000标题')).toBe('中文 标题');
    expect(sanitizeSessionTitleText(null)).toBe('');
    expect(sanitizeSessionTitleText(undefined)).toBe('');
  });

  it('truncateSessionTitle is codepoint-safe for CJK and emoji', () => {
    expect(truncateSessionTitle('短', 28)).toBe('短');
    expect(truncateSessionTitle('测'.repeat(30), 10)).toBe(
      `${'测'.repeat(10)}…`
    );
    // emoji 代理对：按码点截断，不出现半个 surrogate
    const emoji = '🙂'.repeat(5);
    const cut = truncateSessionTitle(emoji, 3);
    expect(Array.from(cut.replace(/…$/, '')).length).toBe(3);
    expect(cut.endsWith('…')).toBe(true);
    // 中英混合
    const mixed = '帮我写一个很长的PR总结文档以及后续流程说明ABC';
    const t = truncateSessionTitle(mixed, 12);
    expect(Array.from(t.replace(/…$/, '')).length).toBe(12);
    expect(t.endsWith('…')).toBe(true);
  });

  it('deriveSessionTitle: CJK length caps and empty → EMPTY_SESSION_TITLE', () => {
    expect(deriveSessionTitle('')).toBe(EMPTY_SESSION_TITLE);
    expect(deriveSessionTitle('   ')).toBe(EMPTY_SESSION_TITLE);
    expect(deriveSessionTitle('/only')).toBe(EMPTY_SESSION_TITLE);
    // 中文不损坏
    expect(deriveSessionTitle('帮我重构 sessionTitle 模块')).toBe(
      '帮我重构 sessionTitle 模块'
    );
    // 超长中文截断
    const longZh =
      '这是一段非常非常非常非常非常非常非常非常长的中文用户首条消息用于侧栏';
    const derived = deriveSessionTitle(longZh);
    expect(derived.endsWith('…')).toBe(true);
    expect(Array.from(derived.replace(/…$/, '')).length).toBe(
      SESSION_TITLE_MAX_LEN
    );
    // 自定义 maxLen
    expect(deriveSessionTitle('一二三四五六', 4)).toBe('一二三四…');
    // 句末标点洗净
    expect(deriveSessionTitle('修复登录崩溃！')).toBe('修复登录崩溃');
  });

  it('firstUserMessageText picks first visible user text', () => {
    expect(firstUserMessageText(undefined)).toBe('');
    expect(firstUserMessageText([])).toBe('');
    expect(
      firstUserMessageText([
        { sender: 'assistant', text: 'nope' },
        { sender: 'user', text: '  ' },
        { sender: 'user', text: '\u200B\u200B' },
        { sender: 'user', text: '首条有效' },
      ])
    ).toBe('首条有效');
    // 纯双向控制 / LRM-RLM 亦跳过，与 sanitize 不可见集对齐
    expect(
      firstUserMessageText([
        { sender: 'user', text: '\u200E\u200F\u202A\u202C' },
        { sender: 'user', text: '真实正文' },
      ])
    ).toBe('真实正文');
    expect(
      firstUserMessageText([{ sender: 'user', text: '/cmd 带命令的正文' }])
    ).toBe('/cmd 带命令的正文');
  });

  it('withTitleCollisionSuffix appends 2, 3… for Chinese and English', () => {
    expect(withTitleCollisionSuffix('帮我写 PR', [])).toBe('帮我写 PR');
    expect(withTitleCollisionSuffix('帮我写 PR', ['其他'])).toBe('帮我写 PR');
    expect(withTitleCollisionSuffix('帮我写 PR', ['帮我写 PR'])).toBe(
      '帮我写 PR 2'
    );
    expect(
      withTitleCollisionSuffix('帮我写 PR', ['帮我写 PR', '帮我写 PR 2'])
    ).toBe('帮我写 PR 3');
    // 空 base → 清晰空会话标题再碰撞
    expect(withTitleCollisionSuffix('', [])).toBe(EMPTY_SESSION_TITLE);
    expect(withTitleCollisionSuffix('  ', ['新会话'])).toBe('新会话 2');
    // 英文
    expect(
      withTitleCollisionSuffix('Refactor', ['Refactor', 'Refactor 2'])
    ).toBe('Refactor 3');
    // existing 含 null/空白忽略
    expect(withTitleCollisionSuffix('A', [null, undefined, '  ', 'A'])).toBe(
      'A 2'
    );
  });

  it('maybeAutoTitleFromMessages optional collision via existingTitles', () => {
    const msgs = [{ sender: 'user', text: '同一问题' }];
    expect(maybeAutoTitleFromMessages('新会话', msgs)).toBe('同一问题');
    expect(
      maybeAutoTitleFromMessages('新会话', msgs, {
        existingTitles: ['同一问题'],
      })
    ).toBe('同一问题 2');
    // excludeTitle 避免与自身碰撞
    expect(
      maybeAutoTitleFromMessages('同一问题', msgs, {
        existingTitles: ['同一问题', '其他'],
        excludeTitle: '同一问题',
      })
    ).toBe(null); // 非默认标题，不改
    // 默认标题 + 排除旧默认
    expect(
      maybeAutoTitleFromMessages('新会话', msgs, {
        existingTitles: ['新会话', '同一问题'],
        excludeTitle: '新会话',
      })
    ).toBe('同一问题 2');
  });

  it('fillDefaultSessionTitles resolveCollisions uniquifies batch', () => {
    const sessions = [
      {
        id: 'a',
        title: '新会话',
        messages: [{ sender: 'user', text: '重复主题' }],
      },
      {
        id: 'b',
        title: '新会话',
        messages: [{ sender: 'user', text: '重复主题' }],
      },
      {
        id: 'c',
        title: '用户手改',
        messages: [{ sender: 'user', text: '重复主题' }],
      },
    ];
    // 默认不碰撞解析：两会话可同名
    const plain = fillDefaultSessionTitles(sessions);
    expect(plain.find((s) => s.id === 'a')?.title).toBe('重复主题');
    expect(plain.find((s) => s.id === 'b')?.title).toBe('重复主题');
    expect(plain.find((s) => s.id === 'c')?.title).toBe('用户手改');

    const unique = fillDefaultSessionTitles(sessions, {
      resolveCollisions: true,
    });
    expect(unique.find((s) => s.id === 'a')?.title).toBe('重复主题');
    expect(unique.find((s) => s.id === 'b')?.title).toBe('重复主题 2');
    // 用户手改不覆盖
    expect(unique.find((s) => s.id === 'c')?.title).toBe('用户手改');
  });

  it('empty session title is clear 新会话 — no ghost labels', () => {
    expect(EMPTY_SESSION_TITLE).toBe('新会话');
    expect(deriveSessionTitle('')).toBe('新会话');
    expect(
      sessionListDisplayTitle({
        title: null as unknown as string,
        messages: [],
      })
    ).toBe('新会话');
    expect(sessionListDisplayTitle({ title: 'Untitled', messages: [] })).toBe(
      '新会话'
    );
    expect(sessionListDisplayTitle({ title: 'No Title', messages: [] })).toBe(
      '新会话'
    );
    // 展示层把「未命名*」幽灵回落为清晰「新会话」
    expect(sessionListDisplayTitle({ title: '未命名', messages: [] })).toBe(
      EMPTY_SESSION_TITLE
    );
    expect(sessionListDisplayTitle({ title: '未命名会话', messages: [] })).toBe(
      EMPTY_SESSION_TITLE
    );
    // 未命名空壳可被 prune
    expect(
      isEmptyShellSession({
        title: '未命名会话',
        messages: [],
        isPinned: false,
      })
    ).toBe(true);
    // 不发明「未命名会话」等幽灵
    expect(deriveSessionTitle('/ping')).not.toMatch(/未命名|untitled|ghost/i);
  });
});
