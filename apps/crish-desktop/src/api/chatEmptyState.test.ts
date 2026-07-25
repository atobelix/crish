import { describe, expect, it } from 'vitest';
import {
  CHAT_EMPTY_ACTION_LABELS,
  CHAT_EMPTY_ARIA_LABELS,
  CHAT_EMPTY_KINDS,
  CHAT_EMPTY_QUICK_PROMPTS,
  CHAT_EMPTY_TITLES,
  chatEmptyKindAriaLabel,
  isChatEmptyKind,
  resolveChatEmptyActionLabel,
  resolveChatEmptyCopy,
  resolveChatEmptyKind,
  resolveChatEmptyPrimaryAction,
  resolveNeedsKeySoftHintText,
  resolveNeedsModelSoftHintText,
  shouldShowChatEmptyShell,
  shouldShowEmptyQuickPrompts,
  shouldShowNeedsKeySoftHint,
  shouldShowNeedsModelSoftHint,
  truncateFilterPreview,
  type ChatEmptyKind,
} from './chatEmptyState';

describe('resolveChatEmptyKind', () => {
  it('returns null on scheduled surface', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: false,
        messageCount: 0,
        displayCount: 0,
        mainSurface: 'scheduled',
      })
    ).toBeNull();
  });

  it('no-session when no active session', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: false,
        messageCount: 0,
        displayCount: 0,
      })
    ).toBe('no-session');
  });

  it('filter-empty when query hits zero of many', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 5,
        displayCount: 0,
        filterQuery: 'xyz',
      })
    ).toBe('filter-empty');
  });

  it('does not treat empty filter as filter-empty', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 3,
        displayCount: 3,
        filterQuery: '  ',
      })
    ).toBeNull();
  });

  it('session-empty when session has zero messages', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 0,
        displayCount: 0,
        filterQuery: '',
      })
    ).toBe('session-empty');
  });

  it('filter with zero total messages falls through to session-empty', () => {
    // 无消息时过滤条通常也无命中；欢迎面优先，避免「无匹配」误导
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 0,
        displayCount: 0,
        filterQuery: 'anything',
      })
    ).toBe('session-empty');
  });

  it('returns null when messages visible', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 4,
        displayCount: 2,
        filterQuery: 'hi',
      })
    ).toBeNull();
  });

  it('prefers no-session over filter-empty', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: false,
        messageCount: 10,
        displayCount: 0,
        filterQuery: 'q',
      })
    ).toBe('no-session');
  });

  it('treats negative / NaN counts as zero → session-empty', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: Number.NaN,
        displayCount: -3,
        filterQuery: 'q',
      })
    ).toBe('session-empty');
  });

  it('filter-empty ignores fractional displayCount (floors to 0)', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 2.9,
        displayCount: 0.4,
        filterQuery: 'x',
      })
    ).toBe('filter-empty');
  });

  it('chat mainSurface with messages still non-empty', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 1,
        displayCount: 1,
        mainSurface: 'chat',
      })
    ).toBeNull();
  });

  it('messagesLoading with active session suppresses empty shell (no ghost welcome)', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 0,
        displayCount: 0,
        messagesLoading: true,
      })
    ).toBeNull();
    // 水合中即使带着 filter 也不闪 filter-empty
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 3,
        displayCount: 0,
        filterQuery: 'x',
        messagesLoading: true,
      })
    ).toBeNull();
  });

  it('messagesLoading does not hide no-session CTA when there is no active session', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: false,
        messageCount: 0,
        displayCount: 0,
        messagesLoading: true,
      })
    ).toBe('no-session');
  });

  it('scheduled wins over messagesLoading', () => {
    expect(
      resolveChatEmptyKind({
        hasActiveSession: true,
        messageCount: 0,
        displayCount: 0,
        messagesLoading: true,
        mainSurface: 'scheduled',
      })
    ).toBeNull();
  });
});

describe('shouldShowChatEmptyShell', () => {
  it('mirrors resolveChatEmptyKind non-null', () => {
    expect(
      shouldShowChatEmptyShell({
        hasActiveSession: false,
        messageCount: 0,
        displayCount: 0,
      })
    ).toBe(true);
    expect(
      shouldShowChatEmptyShell({
        hasActiveSession: true,
        messageCount: 2,
        displayCount: 2,
      })
    ).toBe(false);
    expect(
      shouldShowChatEmptyShell({
        hasActiveSession: true,
        messageCount: 0,
        displayCount: 0,
        messagesLoading: true,
      })
    ).toBe(false);
  });
});

describe('truncateFilterPreview', () => {
  it('trims and truncates long queries', () => {
    expect(truncateFilterPreview('  ab  ')).toBe('ab');
    expect(truncateFilterPreview('x'.repeat(30), 10)).toBe(
      `${'x'.repeat(10)}…`
    );
  });

  it('returns empty for blank input; non-positive max falls back', () => {
    expect(truncateFilterPreview('   ')).toBe('');
    expect(
      truncateFilterPreview('hello-world', 0).endsWith('…') ||
        truncateFilterPreview('hello-world', 0).length <= 24
    ).toBe(true);
  });
});

describe('CHAT_EMPTY_KINDS + titles + aria + type guard', () => {
  it('exposes exactly three kinds in product priority order', () => {
    expect([...CHAT_EMPTY_KINDS]).toEqual([
      'no-session',
      'filter-empty',
      'session-empty',
    ]);
  });

  it('CHAT_EMPTY_TITLES covers three kinds with pairwise distinct titles', () => {
    const titles = CHAT_EMPTY_KINDS.map((k) => CHAT_EMPTY_TITLES[k]);
    expect(new Set(titles).size).toBe(3);
    for (const t of titles) {
      expect(t.trim().length).toBeGreaterThan(1);
    }
  });

  it('aria labels are non-empty and pairwise distinct (constant + helper agree)', () => {
    const labels = CHAT_EMPTY_KINDS.map(chatEmptyKindAriaLabel);
    expect(new Set(labels).size).toBe(3);
    for (const kind of CHAT_EMPTY_KINDS) {
      expect(chatEmptyKindAriaLabel(kind)).toBe(CHAT_EMPTY_ARIA_LABELS[kind]);
      expect(CHAT_EMPTY_ARIA_LABELS[kind].trim().length).toBeGreaterThan(2);
    }
  });

  it('isChatEmptyKind accepts only the three product kinds', () => {
    expect(isChatEmptyKind('no-session')).toBe(true);
    expect(isChatEmptyKind('filter-empty')).toBe(true);
    expect(isChatEmptyKind('session-empty')).toBe(true);
    expect(isChatEmptyKind('scheduled')).toBe(false);
    expect(isChatEmptyKind(null)).toBe(false);
    expect(isChatEmptyKind('')).toBe(false);
  });

  it('CHAT_EMPTY_ACTION_LABELS covers create-session + clear-filter in Chinese', () => {
    expect(CHAT_EMPTY_ACTION_LABELS['create-session']).toBe('新建对话');
    expect(CHAT_EMPTY_ACTION_LABELS['clear-filter']).toBe('清除过滤');
    expect(resolveChatEmptyActionLabel('create-session')).toBe('新建对话');
    expect(resolveChatEmptyActionLabel('clear-filter')).toBe('清除过滤');
    expect(resolveChatEmptyActionLabel(null)).toBeUndefined();
  });
});

describe('resolveChatEmptyPrimaryAction', () => {
  it('maps three kinds to distinct affordances', () => {
    expect(resolveChatEmptyPrimaryAction('no-session')).toBe('create-session');
    expect(resolveChatEmptyPrimaryAction('filter-empty')).toBe('clear-filter');
    expect(resolveChatEmptyPrimaryAction('session-empty')).toBeNull();
  });

  it('hides no-session action under first-run', () => {
    expect(
      resolveChatEmptyPrimaryAction('no-session', { firstRunOpen: true })
    ).toBeNull();
    // filter-empty 不受 firstRun 影响（过滤条与向导可并存）
    expect(
      resolveChatEmptyPrimaryAction('filter-empty', { firstRunOpen: true })
    ).toBe('clear-filter');
  });
});

describe('resolveChatEmptyCopy', () => {
  it('three kinds have distinct titles matching CHAT_EMPTY_TITLES', () => {
    for (const kind of CHAT_EMPTY_KINDS) {
      const c = resolveChatEmptyCopy({ kind });
      expect(c.title).toBe(CHAT_EMPTY_TITLES[kind]);
    }
    const titles = CHAT_EMPTY_KINDS.map(
      (kind) => resolveChatEmptyCopy({ kind }).title
    );
    expect(new Set(titles).size).toBe(3);
  });

  it('no-session short copy + action', () => {
    const c = resolveChatEmptyCopy({ kind: 'no-session' });
    expect(c.title).toBe('暂无会话');
    expect(c.sub.length).toBeLessThan(24);
    expect(c.actionLabel).toBe('新建对话');
    expect(c.actionLabel).toBe(CHAT_EMPTY_ACTION_LABELS['create-session']);
    expect(c.primaryAction).toBe('create-session');
    expect(c.showProjectBar).toBe(false);
    expect(c.showQuickPrompts).toBe(false);
  });

  it('no-session under first-run hides action', () => {
    const c = resolveChatEmptyCopy({ kind: 'no-session', firstRunOpen: true });
    expect(c.actionLabel).toBeUndefined();
    expect(c.primaryAction).toBeNull();
    expect(c.sub).toMatch(/引导/);
  });

  it('filter-empty includes truncated query, no project/prompts', () => {
    const c = resolveChatEmptyCopy({
      kind: 'filter-empty',
      filterQuery: 'foo-bar-baz',
    });
    expect(c.title).toBe('无匹配消息');
    expect(c.sub).toContain('foo-bar-baz');
    expect(c.actionLabel).toBe('清除过滤');
    expect(c.primaryAction).toBe('clear-filter');
    expect(c.showProjectBar).toBe(false);
    expect(c.showQuickPrompts).toBe(false);
  });

  it('filter-empty truncates long query in sub', () => {
    const long = 'q'.repeat(40);
    const c = resolveChatEmptyCopy({ kind: 'filter-empty', filterQuery: long });
    expect(c.sub).toContain('…');
    expect(c.sub.length).toBeLessThan(long.length + 20);
  });

  it('filter-empty blank query uses generic sub', () => {
    const c = resolveChatEmptyCopy({ kind: 'filter-empty', filterQuery: '  ' });
    expect(c.sub).toBe('没有匹配的消息');
    expect(c.primaryAction).toBe('clear-filter');
  });

  it('session-empty ready state shows project + prompts', () => {
    const c = resolveChatEmptyCopy({ kind: 'session-empty' });
    expect(c.title).toBe('开始对话');
    expect(c.sub.length).toBeLessThan(28);
    expect(c.showProjectBar).toBe(true);
    expect(c.showQuickPrompts).toBe(true);
    expect(c.primaryAction).toBeNull();
    // 禁止在空态标题/副文案里写密钥（soft-hint 独占）
    expect(`${c.title}${c.sub}`).not.toMatch(/密钥|API/);
  });

  it('session-empty needsKey does not mention 密钥 and keeps draft affordances', () => {
    const c = resolveChatEmptyCopy({
      kind: 'session-empty',
      needsKeySetup: true,
    });
    expect(`${c.title}${c.sub}`).not.toMatch(/密钥|配置服务商/);
    expect(c.sub).toMatch(/草稿|项目/);
    expect(c.showProjectBar).toBe(true);
    expect(c.showQuickPrompts).toBe(true);
  });

  it('session-empty firstRun is minimal (no project/prompts)', () => {
    const c = resolveChatEmptyCopy({
      kind: 'session-empty',
      firstRunOpen: true,
      needsKeySetup: true,
    });
    expect(c.showProjectBar).toBe(false);
    expect(c.showQuickPrompts).toBe(false);
    expect(`${c.title}${c.sub}`).not.toMatch(/密钥/);
  });

  it('session-empty needsModel short sub without key talk', () => {
    const c = resolveChatEmptyCopy({
      kind: 'session-empty',
      needsModelSetup: true,
    });
    expect(c.sub).toMatch(/模型/);
    expect(c.showQuickPrompts).toBe(true);
  });

  it('needsKey wins over needsModel for session-empty copy', () => {
    const c = resolveChatEmptyCopy({
      kind: 'session-empty',
      needsKeySetup: true,
      needsModelSetup: true,
    });
    expect(c.sub).toMatch(/草稿|项目/);
    expect(c.sub).not.toMatch(/模型/);
  });

  it('daemon offline (engineOk false) uses draft sub and hides quick prompts', () => {
    const c = resolveChatEmptyCopy({
      kind: 'session-empty',
      engineOk: false,
      needsKeySetup: true,
      needsModelSetup: true,
    });
    // 引擎条优先：离线口径压过 key/model 欢迎文案
    expect(c.sub).toMatch(/引擎未就绪|草稿/);
    expect(c.sub).not.toMatch(/密钥|模型 id/);
    expect(c.showProjectBar).toBe(true);
    expect(c.showQuickPrompts).toBe(false);
    expect(c.primaryAction).toBeNull();
  });

  it('firstRun wins over daemon offline for session-empty', () => {
    const c = resolveChatEmptyCopy({
      kind: 'session-empty',
      firstRunOpen: true,
      engineOk: false,
    });
    expect(c.showProjectBar).toBe(false);
    expect(c.showQuickPrompts).toBe(false);
    expect(c.sub).toMatch(/引导/);
  });

  it('engineOk null/true keeps ready welcome (no offline false-positive)', () => {
    const unknown = resolveChatEmptyCopy({
      kind: 'session-empty',
      engineOk: null,
    });
    const ready = resolveChatEmptyCopy({
      kind: 'session-empty',
      engineOk: true,
    });
    expect(unknown.showQuickPrompts).toBe(true);
    expect(ready.showQuickPrompts).toBe(true);
    expect(unknown.sub).not.toMatch(/引擎未就绪/);
    expect(ready.sub).not.toMatch(/引擎未就绪/);
  });

  it('only no-session / filter-empty expose actionLabel; session-empty never does', () => {
    expect(
      resolveChatEmptyCopy({ kind: 'no-session' }).actionLabel
    ).toBeTruthy();
    expect(
      resolveChatEmptyCopy({ kind: 'filter-empty' }).actionLabel
    ).toBeTruthy();
    expect(
      resolveChatEmptyCopy({ kind: 'session-empty' }).actionLabel
    ).toBeUndefined();
    expect(
      resolveChatEmptyCopy({ kind: 'session-empty' }).primaryAction
    ).toBeNull();
  });

  it('copy.primaryAction always agrees with resolveChatEmptyPrimaryAction', () => {
    const cases: Array<{ kind: ChatEmptyKind; firstRunOpen?: boolean }> = [
      { kind: 'no-session' },
      { kind: 'no-session', firstRunOpen: true },
      { kind: 'filter-empty' },
      { kind: 'session-empty' },
      { kind: 'session-empty', firstRunOpen: true },
    ];
    for (const c of cases) {
      const copy = resolveChatEmptyCopy(c);
      expect(copy.primaryAction).toBe(
        resolveChatEmptyPrimaryAction(c.kind, { ...(c.firstRunOpen !== undefined && { firstRunOpen: c.firstRunOpen }) })
      );
      expect(copy.actionLabel).toBe(
        resolveChatEmptyActionLabel(copy.primaryAction)
      );
    }
  });

  it('all three kinds keep short sub copy (scannable)', () => {
    for (const kind of CHAT_EMPTY_KINDS) {
      const c = resolveChatEmptyCopy({ kind, filterQuery: 'ab' });
      expect(c.sub.length).toBeLessThan(40);
      expect(c.title.length).toBeLessThan(12);
    }
    // 离线副文案仍可扫视
    const offline = resolveChatEmptyCopy({
      kind: 'session-empty',
      engineOk: false,
    });
    expect(offline.sub.length).toBeLessThan(28);
  });
});

describe('soft-hint coordination with empty', () => {
  it('suppresses needsKey soft-hint while FirstRun is open', () => {
    expect(
      shouldShowNeedsKeySoftHint({
        needsKeySetup: true,
        firstRunOpen: true,
        engineOk: true,
      })
    ).toBe(false);
  });

  it('suppresses needsKey soft-hint when engine is down', () => {
    expect(
      shouldShowNeedsKeySoftHint({
        needsKeySetup: true,
        firstRunOpen: false,
        engineOk: false,
      })
    ).toBe(false);
  });

  it('shows needsKey soft-hint after FirstRun when still no key', () => {
    expect(
      shouldShowNeedsKeySoftHint({
        needsKeySetup: true,
        firstRunOpen: false,
        engineOk: true,
      })
    ).toBe(true);
  });

  it('engineOk null still allows needsKey soft-hint', () => {
    expect(
      shouldShowNeedsKeySoftHint({
        needsKeySetup: true,
        firstRunOpen: false,
        engineOk: null,
      })
    ).toBe(true);
  });

  it('uses compact soft-hint text on empty surface', () => {
    const full = resolveNeedsKeySoftHintText({ onEmptySurface: false });
    const compact = resolveNeedsKeySoftHintText({ onEmptySurface: true });
    expect(compact.length).toBeLessThan(full.length);
    expect(compact).toMatch(/密钥/);
    expect(
      resolveNeedsModelSoftHintText({ onEmptySurface: true }).length
    ).toBeLessThan(
      resolveNeedsModelSoftHintText({ onEmptySurface: false }).length
    );
  });

  it('shows needsModel soft-hint only when key ready and wizard closed', () => {
    expect(
      shouldShowNeedsModelSoftHint({
        needsModelSetup: true,
        needsKeySetup: false,
        firstRunOpen: false,
        engineOk: true,
      })
    ).toBe(true);
    expect(
      shouldShowNeedsModelSoftHint({
        needsModelSetup: true,
        firstRunOpen: true,
        engineOk: true,
      })
    ).toBe(false);
  });
});

describe('CHAT_EMPTY_QUICK_PROMPTS', () => {
  it('has short labels and non-empty prompts', () => {
    expect(CHAT_EMPTY_QUICK_PROMPTS.length).toBeGreaterThanOrEqual(3);
    for (const p of CHAT_EMPTY_QUICK_PROMPTS) {
      expect(p.label.length).toBeLessThanOrEqual(12);
      expect(p.prompt.trim().length).toBeGreaterThan(4);
    }
  });

  it('labels are unique (chip keys)', () => {
    const labels = CHAT_EMPTY_QUICK_PROMPTS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('shouldShowEmptyQuickPrompts', () => {
  it('only session-empty ready surface shows prompts', () => {
    expect(shouldShowEmptyQuickPrompts({ kind: 'session-empty' })).toBe(true);
    expect(shouldShowEmptyQuickPrompts({ kind: 'no-session' })).toBe(false);
    expect(shouldShowEmptyQuickPrompts({ kind: 'filter-empty' })).toBe(false);
  });

  it('hides on first-run, loading, and daemon offline', () => {
    expect(
      shouldShowEmptyQuickPrompts({ kind: 'session-empty', firstRunOpen: true })
    ).toBe(false);
    expect(
      shouldShowEmptyQuickPrompts({
        kind: 'session-empty',
        messagesLoading: true,
      })
    ).toBe(false);
    expect(
      shouldShowEmptyQuickPrompts({ kind: 'session-empty', engineOk: false })
    ).toBe(false);
  });

  it('agrees with resolveChatEmptyCopy.showQuickPrompts for key offline/firstRun matrix', () => {
    const matrix: Array<{
      firstRunOpen?: boolean;
      engineOk?: boolean | null;
    }> = [
      {},
      { firstRunOpen: true },
      { engineOk: false },
      { engineOk: true },
      { firstRunOpen: true, engineOk: false },
    ];
    for (const m of matrix) {
      const copy = resolveChatEmptyCopy({ kind: 'session-empty', ...m });
      expect(shouldShowEmptyQuickPrompts({ kind: 'session-empty', ...m })).toBe(
        copy.showQuickPrompts
      );
    }
  });
});

describe('three-state exclusive matrix', () => {
  it('priority table: scheduled > loading > no-session > filter-empty > session-empty > null', () => {
    const table: Array<{
      name: string;
      input: Parameters<typeof resolveChatEmptyKind>[0];
      want: ChatEmptyKind | null;
    }> = [
      {
        name: 'scheduled wins even with no session',
        input: {
          hasActiveSession: false,
          messageCount: 0,
          displayCount: 0,
          mainSurface: 'scheduled',
        },
        want: null,
      },
      {
        name: 'loading suppresses active empty shell',
        input: {
          hasActiveSession: true,
          messageCount: 0,
          displayCount: 0,
          messagesLoading: true,
        },
        want: null,
      },
      {
        name: 'no-session beats filter signals',
        input: {
          hasActiveSession: false,
          messageCount: 9,
          displayCount: 0,
          filterQuery: 'x',
          mainSurface: 'chat',
        },
        want: 'no-session',
      },
      {
        name: 'filter-empty when hits zero',
        input: {
          hasActiveSession: true,
          messageCount: 3,
          displayCount: 0,
          filterQuery: 'nope',
        },
        want: 'filter-empty',
      },
      {
        name: 'session-empty welcome',
        input: {
          hasActiveSession: true,
          messageCount: 0,
          displayCount: 0,
        },
        want: 'session-empty',
      },
      {
        name: 'list surface',
        input: {
          hasActiveSession: true,
          messageCount: 2,
          displayCount: 2,
        },
        want: null,
      },
    ];
    for (const row of table) {
      expect(resolveChatEmptyKind(row.input), row.name).toBe(row.want);
      expect(shouldShowChatEmptyShell(row.input), row.name).toBe(
        row.want != null
      );
    }
  });
});
