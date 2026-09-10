import { describe, expect, it } from 'vitest';
import type { SessionMessage } from './types';
import { mergeMessagesById } from '../api/sessionEventProjection';
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

describe('upsertMessageById 有序插入（D1 canonical order）', () => {
  it('新消息按 ts 插入中间而非尾部', () => {
    const list: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'first', timestamp: 100 }),
      msg({ id: 'a1', sender: 'assistant', text: 'second', timestamp: 200 }),
    ];
    const result = upsertMessageById(
      list,
      msg({ id: 'u0', sender: 'user', text: 'early', timestamp: 50 })
    );
    expect(result).toBe('appended');
    expect(list.map((m) => m.id)).toEqual(['u0', 'u1', 'a1']);
  });

  it('新消息 ts 更大时仍插到正确中间位（不裸 push）', () => {
    const list: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'first', timestamp: 100 }),
      msg({ id: 'a1', sender: 'assistant', text: 'second', timestamp: 300 }),
    ];
    upsertMessageById(
      list,
      msg({ id: 'mid', sender: 'assistant', text: 'mid', timestamp: 200 })
    );
    expect(list.map((m) => m.id)).toEqual(['u1', 'mid', 'a1']);
  });

  it('同 id merge 不改变位置', () => {
    const list: SessionMessage[] = [
      msg({
        id: 'a1',
        sender: 'assistant',
        text: 'hel',
        timestamp: 200,
        status: 'processing',
      }),
      msg({
        id: 'a2',
        sender: 'assistant',
        text: 'later',
        timestamp: 300,
        status: 'completed',
      }),
    ];
    // 同 id 回放：即使 incoming.timestamp 更早，也不得把消息搬到前面
    const result = upsertMessageById(
      list,
      msg({
        id: 'a1',
        sender: 'assistant',
        text: 'hello world',
        timestamp: 50,
        status: 'completed',
      })
    );
    expect(result).toBe('updated');
    expect(list.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(list[0]?.text).toBe('hello world');
    expect(list[0]?.status).toBe('completed');
  });

  it('缺省 timestamp 视为 0，插到列表头部', () => {
    const list: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'a', timestamp: 100 }),
    ];
    upsertMessageById(list, msg({ id: 'legacy', sender: 'user', text: 'x' }));
    expect(list.map((m) => m.id)).toEqual(['legacy', 'u1']);
  });

  it('engineSequence 优先于 timestamp 决定插入位', () => {
    const withSeq = msg({
      id: 'has-seq',
      sender: 'assistant',
      text: 's',
      timestamp: 9999,
    });
    (withSeq as SessionMessage & { engineSequence?: number }).engineSequence = 1;
    const list: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'a', timestamp: 100 }),
    ];
    upsertMessageById(list, withSeq);
    expect(list.map((m) => m.id)).toEqual(['has-seq', 'u1']);
  });
});

describe('mergeMessagesById 有序插入（D1）', () => {
  it('incoming 旧 ts 消息插入正确位置，不追加到末尾', () => {
    const local: SessionMessage[] = [
      msg({ id: 'u2', sender: 'user', text: 'l1', timestamp: 200, status: 'completed' }),
      msg({ id: 'a2', sender: 'assistant', text: 'l2', timestamp: 201, status: 'completed' }),
    ];
    const engine: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'e1', timestamp: 100, status: 'completed' }),
      msg({ id: 'a1', sender: 'assistant', text: 'e2', timestamp: 101, status: 'completed' }),
    ];
    const merged = mergeMessagesById(local, engine);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('同 id merge 不改变既有位置（ts 保持序内时）', () => {
    const local: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'hi', timestamp: 100, status: 'completed' }),
      msg({ id: 'a1', sender: 'assistant', text: 'hel', timestamp: 200, status: 'processing' }),
    ];
    // 同 id、同 ts 回放：仅升终态与正文，不触发重排
    const incoming: SessionMessage[] = [
      msg({ id: 'a1', sender: 'assistant', text: 'hello', timestamp: 200, status: 'completed' }),
    ];
    const merged = mergeMessagesById(local, incoming);
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(merged[1]?.text).toBe('hello');
    expect(merged[1]?.status).toBe('completed');
  });

  it('同 id merge 更新 ts 后列表按 canonical order 兜底收敛（不乱序）', () => {
    const local: SessionMessage[] = [
      msg({ id: 'u1', sender: 'user', text: 'hi', timestamp: 100, status: 'completed' }),
      msg({ id: 'a1', sender: 'assistant', text: 'hel', timestamp: 200, status: 'processing' }),
    ];
    // incoming 把 a1.timestamp 改到 10：merge 后无序 → sortMessagesByOrder 收敛
    const incoming: SessionMessage[] = [
      msg({ id: 'a1', sender: 'assistant', text: 'hello', timestamp: 10, status: 'completed' }),
    ];
    const merged = mergeMessagesById(local, incoming);
    // 收敛后 a1(ts=10) 在 u1(ts=100) 之前
    expect(merged.map((m) => m.id)).toEqual(['a1', 'u1']);
    expect(merged[0]?.text).toBe('hello');
    expect(merged[0]?.status).toBe('completed');
    expect(merged[1]?.text).toBe('hi');
  });
});
