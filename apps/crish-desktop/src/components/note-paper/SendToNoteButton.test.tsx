// @vitest-environment jsdom
/**
 * SendToNoteButton 单测（W5-B · B-05/B-08）
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  clearSendToNoteIdempotencyForTests,
  createMockSendToNoteSink,
  resetSendToNoteIntentSeqForTests,
} from '../../bridges/send-to-note';
import { SendToNoteButton } from './SendToNoteButton';

beforeEach(() => {
  resetSendToNoteIntentSeqForTests();
  clearSendToNoteIdempotencyForTests();
});

describe('SendToNoteButton', () => {
  it('status≠completed 时按钮 disabled', () => {
    const mock = createMockSendToNoteSink();
    render(
      <SendToNoteButton
        messageId="m1"
        status="streaming"
        markdown="# hi"
        docId="d1"
        sink={mock.sink}
      />
    );
    const btn = screen.getByTestId('send-to-note-button');
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('send-to-note-root')).toHaveAttribute(
      'data-can-send',
      'false'
    );
  });

  it('completed 可点：成功路径展示成功态并回调', async () => {
    const mock = createMockSendToNoteSink({ ok: true, blockIds: ['b-1'] });
    const onSuccess = vi.fn();
    render(
      <SendToNoteButton
        messageId="m-ok"
        status="completed"
        markdown="## done"
        docId="doc-1"
        sink={mock.sink}
        intentId="btn-ok-1"
        onSuccess={onSuccess}
      />
    );
    const btn = screen.getByTestId('send-to-note-button');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('send-to-note-success')).toBeInTheDocument();
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.source.markdown).toBe('## done');
  });

  it('sink 失败：展示错误态，不展示成功', async () => {
    const mock = createMockSendToNoteSink({
      ok: false,
      reason: '权限不足',
    });
    const onError = vi.fn();
    render(
      <SendToNoteButton
        messageId="m-fail"
        status="completed"
        markdown="body"
        docId="doc-x"
        sink={mock.sink}
        intentId="btn-fail-1"
        onError={onError}
      />
    );
    fireEvent.click(screen.getByTestId('send-to-note-button'));

    await waitFor(() => {
      expect(screen.getByTestId('send-to-note-error')).toHaveTextContent(
        /权限不足/
      );
    });
    expect(screen.queryByTestId('send-to-note-success')).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    const arg = onError.mock.calls[0]![0] as { ok: false; code: string };
    expect(arg.ok).toBe(false);
    expect(arg.code).toBe('sink_reject');
  });
});
