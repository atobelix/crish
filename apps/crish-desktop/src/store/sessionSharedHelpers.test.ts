import { describe, expect, it } from 'vitest';
import type { SessionMessage } from './types';
import {
  isTerminalSessionMessageStatus,
  mergeSessionMessageFields,
  preferSessionMessageStatus,
  preferSessionMessageText,
  upsertMessageById,
} from './sessionSharedHelpers';

function msg(
  partial: Partial<SessionMessage> & Pick<SessionMessage, 'id'>
): SessionMessage {
  return {
    sender: 'assistant',
    timestamp: 1,
    ...partial,
  };
}

describe('preferSessionMessageStatus / text (C0 residual)', () => {
  it('isTerminalSessionMessageStatus', () => {
    expect(isTerminalSessionMessageStatus('completed')).toBe(true);
    expect(isTerminalSessionMessageStatus('error')).toBe(true);
    expect(isTerminalSessionMessageStatus('processing')).toBe(false);
    expect(isTerminalSessionMessageStatus('queued')).toBe(false);
    expect(isTerminalSessionMessageStatus(undefined)).toBe(false);
  });

  it('prefer completed over processing / queued', () => {
    expect(preferSessionMessageStatus('completed', 'processing')).toBe(
      'completed'
    );
    expect(preferSessionMessageStatus('processing', 'completed')).toBe(
      'completed'
    );
    expect(preferSessionMessageStatus('queued', 'processing')).toBe(
      'processing'
    );
    expect(preferSessionMessageStatus('error', 'completed')).toBe('error');
    expect(preferSessionMessageStatus('completed', 'error')).toBe('error');
    expect(preferSessionMessageStatus(undefined, 'processing')).toBe(
      'processing'
    );
  });

  it('preferSessionMessageText：终态正文不被 partial 缩短', () => {
    expect(
      preferSessionMessageText(
        'full final',
        'completed',
        'par',
        'processing'
      )
    ).toBe('full final');
    expect(
      preferSessionMessageText('par', 'processing', 'full final', 'completed')
    ).toBe('full final');
    expect(
      preferSessionMessageText('hello', 'processing', 'hel', 'processing')
    ).toBe('hello');
    expect(
      preferSessionMessageText('hel', 'processing', 'hello', 'processing')
    ).toBe('hello');
    expect(
      preferSessionMessageText('keep', 'completed', '', 'completed')
    ).toBe('keep');
  });
});

describe('mergeSessionMessageFields / upsertMessageById', () => {
  it('completed + partial 同 id：status/text 不回退，tools 不抹', () => {
    const existing = msg({
      id: 'asst-1',
      text: 'final answer',
      status: 'completed',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'read',
          arguments: '{}',
          status: 'success',
          output: 'ok',
        },
      ],
      blocks: [
        { type: 'tool_call', id: 'tc-1' },
        { type: 'text', content: 'final answer' },
      ],
      streamTextOffset: 12,
      thinkingTime: 3,
    });
    mergeSessionMessageFields(
      existing,
      msg({
        id: 'asst-1',
        text: 'fin',
        status: 'processing',
        toolCalls: [],
        blocks: [{ type: 'text', content: 'fin' }],
        streamTextOffset: 3,
        thinkingTime: 0,
      })
    );
    expect(existing.status).toBe('completed');
    expect(existing.text).toBe('final answer');
    expect(existing.toolCalls).toHaveLength(1);
    expect(existing.streamTextOffset).toBe(12);
    expect(existing.thinkingTime).toBe(3);
  });

  it('processing → completed upsert 升终态并取更长正文', () => {
    const list: SessionMessage[] = [
      msg({
        id: 'asst-1',
        text: 'hel',
        status: 'processing',
      }),
    ];
    const r1 = upsertMessageById(
      list,
      msg({
        id: 'asst-1',
        text: 'hello world',
        status: 'completed',
      })
    );
    expect(r1).toBe('updated');
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('completed');
    expect(list[0]?.text).toBe('hello world');
  });

  it('对抗：同 clientMessageId 连 upsert 两次不双 append', () => {
    const list: SessionMessage[] = [];
    const a = msg({
      id: 'user-client-1',
      sender: 'user',
      text: 'hi',
      status: 'processing',
    });
    const b = msg({
      id: 'user-client-1',
      sender: 'user',
      text: 'hi',
      status: 'completed',
    });
    expect(upsertMessageById(list, a)).toBe('appended');
    expect(upsertMessageById(list, b)).toBe('updated');
    expect(upsertMessageById(list, b)).toBe('updated');
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('completed');
  });

  it('不同 id 仍 append', () => {
    const list: SessionMessage[] = [];
    upsertMessageById(list, msg({ id: 'a', sender: 'user', text: 'u' }));
    upsertMessageById(list, msg({ id: 'b', sender: 'assistant', text: 'r' }));
    expect(list).toHaveLength(2);
  });
});
