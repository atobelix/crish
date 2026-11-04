// @vitest-environment jsdom
/**
 * ChatMessageList 三态接线测试（批 A）：消息列表的真空窗呈现契约——
 * 1. 切换会话 / 首轮回填：messages 为空且 messagesLoading → Loading 三态
 *    （ContentState loading），不再 return null 空白无反馈；
 * 2. 水合停滞：messages 为空且 messagesLoadStalled → 错误三态，
 *    点「重试」触发 onRetryLoadMessages；
 * 3. 已有消息时即使 messagesLoading 为 true（后台增量刷新）也照常渲染
 *    列表，绝不闪 Loading 三态；
 * 4. 无消息且不在加载/停滞（真空态由 ChatCard 的 ChatEmptyState 负责）：
 *    维持 return null 旧契约。
 */
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageList } from '../ChatMessageList';
import type {
  ChatMessageListMessagesProps,
  ChatMessageListProps,
} from '../chatMessageListProps';
import type { SessionMessage } from '../../../store/types';

vi.mock('../../../services/toast/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), toast: { show: vi.fn() } }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('../../../api/markdown/useMarkdownRender', () => {
  const result = () => ({
    html: '<p>rendered</p>',
    truncated: false,
    loading: false,
    failed: false,
  });
  return {
    useMarkdownResult: vi.fn(result),
    useMarkdownPrewarm: vi.fn(),
  };
});

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function makeProps(
  messagesGroup: Partial<ChatMessageListMessagesProps>
): ChatMessageListProps {
  return {
    messages: {
      messages: [],
      agents: [],
      activeSessionId: 'sess-hist-1',
      ...messagesGroup,
    },
    projectPicker: {
      showProjectPicker: false,
      onShowProjectPicker: vi.fn(),
      onProjectChanged: vi.fn(),
    },
    composer: { onSetChatInput: vi.fn() },
    generation: { onRegenerate: vi.fn(), onBranch: vi.fn() },
    approval: {
      approvalBusy: false,
      pendingApprovalMsgId: '',
      onApprovalAllow: vi.fn(),
      onApprovalDeny: vi.fn(),
    },
    navigation: {
      onOpenDiff: vi.fn(),
      onOpenPath: vi.fn(),
      onOpenTerminal: vi.fn(),
    },
  };
}

describe('ChatMessageList 三态接线（批 A）', () => {
  it('真空窗：空消息 + loading → Loading 三态而非空白', () => {
    render(<ChatMessageList {...makeProps({ messagesLoading: true })} />);
    const el = screen.getByTestId('chat-message-list-loading');
    expect(el).toHaveAttribute('data-kind', 'loading');
    expect(screen.queryByTestId('chat-message-list-load-error')).toBeNull();
  });

  it('水合停滞：空消息 + stalled → 错误三态，点重试触发回调', () => {
    const onRetryLoadMessages = vi.fn();
    render(
      <ChatMessageList
        {...makeProps({ messagesLoadStalled: true, onRetryLoadMessages })}
      />
    );
    const el = screen.getByTestId('chat-message-list-load-error');
    expect(el).toHaveAttribute('data-kind', 'error');
    fireEvent.click(within(el).getByRole('button'));
    expect(onRetryLoadMessages).toHaveBeenCalledTimes(1);
  });

  it('后台刷新不闪：已有消息 + loading → 不呈现 Loading 三态', () => {
    const msg: SessionMessage = {
      id: 'm1',
      sender: 'user',
      timestamp: 1,
      text: '你好',
    } as SessionMessage;
    render(
      <ChatMessageList
        {...makeProps({ messages: [msg], messagesLoading: true })}
      />
    );
    expect(screen.queryByTestId('chat-message-list-loading')).toBeNull();
    expect(screen.queryByTestId('chat-message-list-load-error')).toBeNull();
  });

  it('真空态（非加载非停滞）：维持 return null 旧契约', () => {
    const { container } = render(<ChatMessageList {...makeProps({})} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('chat-message-list-loading')).toBeNull();
    expect(screen.queryByTestId('chat-message-list-load-error')).toBeNull();
  });
});
