// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { VirtualScrollManager } from '../../api/VirtualScrollManager';
import type { SessionMessage } from '../../store/types';
import { FlowScrubber } from './FlowScrubber';
import { MessageVirtualizer } from './MessageVirtualizer';

function userMsg(id: string, text: string): SessionMessage {
  return { id, sender: 'user', timestamp: 1_700_000_000_000, text } as SessionMessage;
}

function assistantMsg(id: string, text: string): SessionMessage {
  return {
    id,
    sender: 'assistant',
    timestamp: 1_700_000_000_100,
    text,
  } as SessionMessage;
}

function createVirtualizerProps(messages: SessionMessage[]): MessageVirtualizerProps {
  return {
    messages,
    activeSessionId: 'sess-1',
    navigation: {
      onOpenDiff: vi.fn(),
      onOpenPath: vi.fn(),
      onOpenTerminal: vi.fn(),
    },
    approval: {
      approvalBusy: false,
      pendingApprovalMsgId: '',
      onApprovalAllow: vi.fn(),
      onApprovalDeny: vi.fn(),
    },
    composer: {
      onSetChatInput: vi.fn(),
      onSendFollowUp: vi.fn(),
    },
    generation: {
      onRegenerate: vi.fn(),
      onBranch: vi.fn(),
      onRetract: vi.fn(),
    },
    pins: {
      pinnedItems: [],
      pinsOpen: false,
      setPinsOpen: vi.fn(),
      jumpToPinned: vi.fn(),
      togglePin: vi.fn(),
    },
    flowControl: {
      hideThinkingBlock: false,
      inPlanMode: false,
      planApproved: false,
      lastAssistantId: messages.find((m) => m.sender === 'assistant')?.id ?? null,
      lastUserId: [...messages].reverse().find((m) => m.sender === 'user')?.id ?? null,
      showAllMessages: true,
    },
    interaction: {
      expandedUserMsgs: {},
      onToggleExpandUser: vi.fn(),
      dismissedFollowUps: {},
      handleDismissFollowUp: vi.fn(),
      handleMarkdownClick: vi.fn(),
      toolStackProps: {
        activeSessionId: 'sess-1',
        onShowToast: vi.fn(),
        onOpenDiff: vi.fn(),
        onOpenDiffPanel: vi.fn(),
      },
    },
    searchHighlightQuery: '',
  };
}

describe('FlowScrubber', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it('空会话 / 无用户气泡不渲染空柱', () => {
    const manager = new VirtualScrollManager(100);
    const scrollerRef = { current: document.createElement('div') };
    const empty = render(
      <FlowScrubber
        messages={[]}
        manager={manager}
        totalHeight={0}
        scrollerRef={scrollerRef}
      />
    );
    expect(empty.container.querySelector('[data-flow-scrubber]')).toBeNull();

    manager.syncOrder(['a1']);
    manager.setActual('a1', 120);
    const onlyAsst = render(
      <FlowScrubber
        messages={[assistantMsg('a1', '助手')] }
        manager={manager}
        totalHeight={120}
        scrollerRef={scrollerRef}
      />
    );
    expect(onlyAsst.container.querySelector('[data-flow-scrubber]')).toBeNull();
    expect(
      onlyAsst.container.querySelector('[data-flow-scrubber-tick]')
    ).toBeNull();
  });

  it('有用户消息才出 [data-flow-scrubber]，tick 数 = 用户气泡数', () => {
    const manager = new VirtualScrollManager(100);
    manager.syncOrder(['u1', 'a1', 'u2']);
    manager.setActual('u1', 80);
    manager.setActual('a1', 200);
    manager.setActual('u2', 120);
    const { container } = render(
      <FlowScrubber
        messages={[
          userMsg('u1', '第一问'),
          assistantMsg('a1', '答'),
          userMsg('u2', '第二问'),
        ]}
        manager={manager}
        totalHeight={400}
        scrollerRef={{ current: document.createElement('div') }}
      />
    );
    expect(container.querySelector('[data-flow-scrubber]')).not.toBeNull();
    const ticks = container.querySelectorAll('[data-flow-scrubber-tick]');
    expect(ticks).toHaveLength(2);
    const p1 = Number(ticks[0]?.getAttribute('data-height-percent'));
    const p2 = Number(ticks[1]?.getAttribute('data-height-percent'));
    expect(p1).toBeCloseTo(80 / 400);
    expect(p2).toBeCloseTo(120 / 400);
    expect(p1).not.toBeCloseTo(p2);
    expect(ticks[0]?.getAttribute('title')).toBeNull();
  });

  it('点 tick 调用滚动 API', () => {
    const intoView = vi.fn();
    const scroller = document.createElement('div');
    const row = document.createElement('article');
    row.setAttribute('data-msg-id', 'u1');
    row.setAttribute('data-role', 'user');
    row.scrollIntoView = intoView;
    scroller.appendChild(row);
    const manager = new VirtualScrollManager(100);
    manager.syncOrder(['u1']);
    manager.setActual('u1', 160);
    const { container } = render(
      <FlowScrubber
        messages={[userMsg('u1', '跳转到我')]}
        manager={manager}
        totalHeight={160}
        scrollerRef={{ current: scroller }}
      />
    );
    const tick = container.querySelector('[data-flow-scrubber-tick]');
    expect(tick).not.toBeNull();
    fireEvent.click(tick!);
    expect(intoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
  });

  it('wheel 把 delta 转给 scroller', () => {
    const scroller = document.createElement('div');
    scroller.scrollTop = 10;
    const manager = new VirtualScrollManager(100);
    manager.syncOrder(['u1']);
    manager.setActual('u1', 100);
    const { container } = render(
      <FlowScrubber
        messages={[userMsg('u1', '滚轮')]}
        manager={manager}
        totalHeight={100}
        scrollerRef={{ current: scroller }}
      />
    );
    const wrap = container.querySelector('[data-flow-scrubber]');
    fireEvent.wheel(wrap!, { deltaY: 40, deltaMode: 0 });
    expect(scroller.scrollTop).toBe(50);
  });

  it('Hover tick 快速呼出问答预览卡片（按图 5 结构无分割线），跨 tick 移动无缝切换且不重新销毁重建', () => {
    vi.useFakeTimers();
    const scroller = document.createElement('div');
    const manager = new VirtualScrollManager(100);
    manager.syncOrder(['u1', 'a1', 'u2', 'a2']);
    manager.setActual('u1', 100);
    manager.setActual('a1', 100);
    manager.setActual('u2', 100);
    manager.setActual('a2', 100);
    const onTogglePin = vi.fn();

    const { container } = render(
      <FlowScrubber
        messages={[
          userMsg('u1', '提问一'),
          assistantMsg('a1', '回答一'),
          userMsg('u2', '提问二'),
          assistantMsg('a2', '回答二'),
        ]}
        manager={manager}
        totalHeight={400}
        scrollerRef={{ current: scroller }}
        onTogglePin={onTogglePin}
      />
    );

    const ticks = container.querySelectorAll('[data-flow-scrubber-tick]');
    expect(ticks).toHaveLength(2);

    // 1. 鼠标移入第一个 tick，60ms 快速呼出
    fireEvent.mouseEnter(ticks[0]!);
    act(() => {
      vi.advanceTimersByTime(80);
    });

    // 呼出卡片，图 5 结构断言
    const tooltipCard = container.querySelector('[class*="scrubberTooltipCard"]');
    expect(tooltipCard).not.toBeNull();
    expect(tooltipCard?.textContent).toContain('提问一');
    expect(tooltipCard?.textContent).toContain('回答一');
    // 断言无细分割线
    expect(container.querySelector('[class*="scrubberTooltipDivider"]')).toBeNull();

    // 2. 跨 tick 移动至第二个 tick：立刻无缝切至提问二
    fireEvent.mouseEnter(ticks[1]!);
    const updatedCard = container.querySelector('[class*="scrubberTooltipCard"]');
    expect(updatedCard?.textContent).toContain('提问二');
    expect(updatedCard?.textContent).toContain('回答二');

    vi.useRealTimers();
  });
});

describe('MessageVirtualizer 挂载 FlowScrubber', () => {
  it('线性列表有用户气泡时挂刻度，且保留虚拟滚动与撤回入口', () => {
    const messages = [
      userMsg('u1', '用户甲'),
      assistantMsg('a1', '助手甲'),
      userMsg('u2', '用户乙'),
    ];
    const { container } = render(
      <MessageVirtualizer {...createVirtualizerProps(messages)} />
    );
    expect(container.querySelector('[data-virtual-scroll="true"]')).not.toBeNull();
    expect(container.querySelector('[data-flow-scrubber]')).not.toBeNull();
    expect(container.querySelectorAll('[data-flow-scrubber-tick]')).toHaveLength(
      2
    );
    expect(container.querySelector('[data-role="user"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-stream-host]')).not.toBeNull();
  });

  it('仅助手消息不画空柱', () => {
    const { container } = render(
      <MessageVirtualizer
        {...createVirtualizerProps([assistantMsg('a1', '只有助手')])}
      />
    );
    expect(container.querySelector('[data-virtual-scroll="true"]')).not.toBeNull();
    expect(container.querySelector('[data-flow-scrubber]')).toBeNull();
  });
});
