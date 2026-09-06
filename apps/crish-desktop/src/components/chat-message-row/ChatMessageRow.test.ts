/**
 * ChatMessageRow 纯函数契约：复制、工具栈浅比较、中文角色/Pin a11y、密度截断、handoff。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildToolStackHostProps,
  copyTextBestEffort,
  formatMsgTime,
  isUserBubbleLong,
  looksLikePlan,
  messageRoleLabelZh,
  messageRowAriaLabel,
  pinToggleLabels,
  shouldHostToolStack,
  toolStackSharedPropsEqual,
  userBubbleDisplayText,
  userBubbleExpandAria,
  USER_BUBBLE_LONG_CHARS,
  USER_BUBBLE_PREVIEW_CHARS,
  type ChatToolStackProps,
} from './ChatMessageRow';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import type { ToolRenderItem } from '../../api/toolPresentation';

function baseToolStack(
  over: Partial<ChatToolStackSharedProps> = {},
): ChatToolStackSharedProps {
  return {
    agents: [],
    activeSessionId: 's1',
    expandedTools: {},
    onToggleTool: () => {},
    approvalBusy: false,
    pendingApprovalMsgId: '',
    onOpenDiff: () => {},
    onOpenPath: () => {},
    onOpenTerminal: () => {},
    onApprovalAllow: () => {},
    onApprovalDeny: () => {},
    ...over,
  };
}

describe('copyTextBestEffort', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false for empty text without calling clipboard', async () => {
    await expect(copyTextBestEffort('')).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns true when clipboard.writeText resolves', async () => {
    writeText.mockResolvedValue(undefined);
    await expect(copyTextBestEffort('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns false when clipboard rejects (no document fallback in node)', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    // node 环境无 document：clipboard 失败后直接 false，对应 toast「复制失败」
    await expect(copyTextBestEffort('x')).resolves.toBe(false);
  });
});

describe('toolStackSharedPropsEqual', () => {
  it('equals when data fields share identity', () => {
    const expandedTools = { t1: true };
    const agents: ChatToolStackSharedProps['agents'] = [];
    const a = baseToolStack({ expandedTools, agents, activeSessionId: 's1' });
    const b = baseToolStack({ expandedTools, agents, activeSessionId: 's1' });
    expect(toolStackSharedPropsEqual(a, b)).toBe(true);
  });

  it('differs when expandedTools / session / approval change', () => {
    const base = baseToolStack();
    expect(
      toolStackSharedPropsEqual(base, baseToolStack({ expandedTools: { a: true } })),
    ).toBe(false);
    expect(
      toolStackSharedPropsEqual(base, baseToolStack({ activeSessionId: 's2' })),
    ).toBe(false);
    expect(
      toolStackSharedPropsEqual(base, baseToolStack({ approvalBusy: true })),
    ).toBe(false);
    expect(
      toolStackSharedPropsEqual(
        base,
        baseToolStack({ pendingApprovalMsgId: 'm1' }),
      ),
    ).toBe(false);
  });

  it('ChatToolStackProps alias is the shared shape', () => {
    const p: ChatToolStackProps = baseToolStack();
    expect(p.activeSessionId).toBe('s1');
  });
});

describe('Chinese role labels', () => {
  it('messageRoleLabelZh matches pinned-bar copy', () => {
    expect(messageRoleLabelZh('user')).toBe('你');
    expect(messageRoleLabelZh('assistant')).toBe('助手');
  });

  it('messageRowAriaLabel composes role · pin · status', () => {
    expect(messageRowAriaLabel({ role: 'user' })).toBe('你');
    expect(messageRowAriaLabel({ role: 'assistant', isPinned: true })).toBe(
      '助手 · 已固定',
    );
    expect(
      messageRowAriaLabel({ role: 'user', status: 'queued', isPinned: true }),
    ).toBe('你 · 已固定 · 排队中');
    expect(
      messageRowAriaLabel({
        role: 'assistant',
        isThinking: true,
        status: 'processing',
      }),
    ).toBe('助手 · 生成中');
    // queued 优先于 processing 语义（用户排队不会同时思考）
    expect(
      messageRowAriaLabel({ role: 'user', status: 'queued', isThinking: true }),
    ).toBe('你 · 排队中');
  });
});

describe('pin / expand / thinking a11y labels', () => {
  it('pinToggleLabels Chinese title + aria', () => {
    expect(pinToggleLabels(false)).toEqual({
      title: '固定',
      ariaLabel: '固定消息',
    });
    expect(pinToggleLabels(true)).toEqual({
      title: '取消固定',
      ariaLabel: '取消固定',
    });
  });

  it('userBubbleExpandAria Chinese', () => {
    expect(userBubbleExpandAria(false)).toBe('展开全文');
    expect(userBubbleExpandAria(true)).toBe('收起全文');
  });
});

describe('density: long user bubble + time + plan', () => {
  it('isUserBubbleLong uses USER_BUBBLE_LONG_CHARS threshold', () => {
    expect(isUserBubbleLong('')).toBe(false);
    expect(isUserBubbleLong(null)).toBe(false);
    expect(isUserBubbleLong('x'.repeat(USER_BUBBLE_LONG_CHARS))).toBe(false);
    expect(isUserBubbleLong('x'.repeat(USER_BUBBLE_LONG_CHARS + 1))).toBe(true);
  });

  it('userBubbleDisplayText truncates only when long and collapsed', () => {
    const long = '字'.repeat(USER_BUBBLE_LONG_CHARS + 40);
    const collapsed = userBubbleDisplayText(long, false);
    expect(collapsed.endsWith('…')).toBe(true);
    expect(collapsed.length).toBe(USER_BUBBLE_PREVIEW_CHARS + 1);
    expect(userBubbleDisplayText(long, true)).toBe(long);
    expect(userBubbleDisplayText('短', false)).toBe('短');
    expect(userBubbleDisplayText(undefined, false)).toBe('');
  });

  it('formatMsgTime empty / 24h shape', () => {
    expect(formatMsgTime(undefined)).toBe('');
    expect(formatMsgTime(0)).toBe('');
    const label = formatMsgTime(Date.UTC(2026, 0, 1, 9, 5));
    // locale-dependent digits but always HH:MM-ish without AM/PM
    expect(label).toMatch(/\d{1,2}:\d{2}/);
    expect(label.toLowerCase()).not.toMatch(/am|pm/);
  });

  it('looksLikePlan detects 中文计划 / headings / numbered lists', () => {
    expect(looksLikePlan('')).toBe(false);
    expect(looksLikePlan('普通闲聊')).toBe(false);
    expect(looksLikePlan('执行步骤如下')).toBe(true);
    expect(looksLikePlan('## 实施计划')).toBe(true);
    expect(looksLikePlan('1. 先改 A\n2. 再改 B')).toBe(true);
    expect(looksLikePlan('1、准备环境')).toBe(true);
  });
});

describe('tool row hosting handoff only', () => {
  it('shouldHostToolStack requires non-empty items', () => {
    expect(shouldHostToolStack(undefined)).toBe(false);
    expect(shouldHostToolStack(null)).toBe(false);
    expect(shouldHostToolStack([])).toBe(false);
    const item: ToolRenderItem = {
      kind: 'single',
      tc: { id: 't1', name: 'shell', arguments: '', status: 'running' },
    };
    expect(shouldHostToolStack([item])).toBe(true);
  });

  it('buildToolStackHostProps merges shared + msg-local without extra keys', () => {
    const shared = baseToolStack({ activeSessionId: 'sess-9', approvalBusy: true });
    const items: ToolRenderItem[] = [
      {
        kind: 'single',
        tc: { id: 't1', name: 'read', arguments: '', status: 'success' },
      },
    ];
    const host = buildToolStackHostProps(items, 'msg-42', shared);
    expect(host.msgId).toBe('msg-42');
    expect(host.items).toBe(items);
    expect(host.activeSessionId).toBe('sess-9');
    expect(host.approvalBusy).toBe(true);
    expect(host.agents).toBe(shared.agents);
    expect(host.expandedTools).toBe(shared.expandedTools);
    // handoff 仅透传共享字段 + 局部 items/msgId
    expect(Object.keys(host).sort()).toEqual(
      [
        'activeSessionId',
        'agents',
        'approvalBusy',
        'expandedTools',
        'items',
        'msgId',
        'onApprovalAllow',
        'onApprovalDeny',
        'onOpenDiff',
        'onOpenPath',
        'onOpenTerminal',
        'onToggleTool',
        'pendingApprovalMsgId',
      ].sort(),
    );
  });
});
