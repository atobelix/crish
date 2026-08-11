// @vitest-environment jsdom
/**
 * ChatSendToNoteEntry 产品入口测（B-05 挂气泡 · A-SURF-06 intentId 幂等）
 *
 * 诚实边界：
 * - 证：completed 才挂入口；稳定 intentId；同 intent 双击 sink 只一次
 * - 不证：EL-08 关闭、跨进程幂等落盘、活动笔记选择器、A-SURF 全表
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  clearSendToNoteIdempotencyForTests,
  createMockSendToNoteSink,
  resetSendToNoteIntentSeqForTests,
} from '../../bridges/send-to-note';
import { ChatSendToNoteEntry } from './ChatSendToNoteEntry';
import { buildChatSendToNoteIntentId } from './sendToNoteMount';

beforeEach(() => {
  resetSendToNoteIntentSeqForTests();
  clearSendToNoteIdempotencyForTests();
});

describe('ChatSendToNoteEntry · 完成态可见性（B-05）', () => {
  it('status≠completed：不渲染入口', () => {
    const mock = createMockSendToNoteSink();
    const { container } = render(
      <ChatSendToNoteEntry
        messageId="m-stream"
        status="processing"
        markdown="# still streaming"
        sink={mock.sink}
      />
    );
    expect(
      container.querySelector('[data-testid="chat-send-to-note-entry"]')
    ).toBeNull();
    expect(screen.queryByTestId('send-to-note-button')).toBeNull();
  });

  it('status=completed：渲染入口且 data-intent-id 为稳定形状', () => {
    const mock = createMockSendToNoteSink();
    render(
      <ChatSendToNoteEntry
        messageId="m-done"
        status="completed"
        markdown="## done body"
        docId="doc-test"
        sink={mock.sink}
      />
    );
    const entry = screen.getByTestId('chat-send-to-note-entry');
    expect(entry).toHaveAttribute('data-message-id', 'm-done');
    expect(entry).toHaveAttribute(
      'data-intent-id',
      buildChatSendToNoteIntentId('m-done')
    );
    expect(entry).toHaveAttribute('data-doc-id', 'doc-test');
    expect(screen.getByTestId('send-to-note-button')).not.toBeDisabled();
  });
});

describe('ChatSendToNoteEntry · 幂等 intentId（A-SURF-06 形状子集）', () => {
  it('同一消息双击：intentId 恒等且 sink 只调用一次（applied 第二次 false）', async () => {
    const mock = createMockSendToNoteSink({ ok: true, blockIds: ['b-ui-1'] });
    const onSuccess = vi.fn();
    render(
      <ChatSendToNoteEntry
        messageId="msg-idem-ui"
        status="completed"
        markdown="once only"
        docId="doc-idem-ui"
        sink={mock.sink}
        onSuccess={onSuccess}
      />
    );

    const btn = screen.getByTestId('send-to-note-button');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
    const first = onSuccess.mock.calls[0]![0] as {
      ok: true;
      intentId: string;
      applied: boolean;
    };
    expect(first.intentId).toBe(buildChatSendToNoteIntentId('msg-idem-ui'));
    expect(first.applied).toBe(true);

    fireEvent.click(btn);
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(2);
    });
    const second = onSuccess.mock.calls[1]![0] as {
      ok: true;
      intentId: string;
      applied: boolean;
    };
    expect(second.intentId).toBe(first.intentId);
    expect(second.applied).toBe(false);
    // 幂等：sink 不双插
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.intentId).toBe(first.intentId);
    expect(mock.calls[0]!.source.markdown).toBe('once only');
  });
});
