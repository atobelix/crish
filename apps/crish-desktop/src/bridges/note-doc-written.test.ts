/**
 * note-doc-written 总线单测（CONN-G1 通知面）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearNoteDocWrittenListenersForTests,
  noteDocWrittenListenerCountForTests,
  notifyNoteDocWritten,
  subscribeNoteDocWritten,
} from './note-doc-written';

beforeEach(() => {
  clearNoteDocWrittenListenersForTests();
});

describe('note-doc-written bus（CONN-G1）', () => {
  it('subscribe 收到同 payload；unsub 后不再调用', () => {
    const seen: string[] = [];
    const unsub = subscribeNoteDocWritten((ev) => {
      seen.push(ev.docId);
    });
    expect(noteDocWrittenListenerCountForTests()).toBe(1);

    notifyNoteDocWritten({
      docId: 'doc-a',
      intentId: 'i1',
      source: 'send_to_note',
    });
    expect(seen).toEqual(['doc-a']);

    unsub();
    expect(noteDocWrittenListenerCountForTests()).toBe(0);
    notifyNoteDocWritten({
      docId: 'doc-b',
      source: 'send_to_note',
    });
    expect(seen).toEqual(['doc-a']);
  });

  it('空 docId 不广播', () => {
    const fn = vi.fn();
    subscribeNoteDocWritten(fn);
    notifyNoteDocWritten({ docId: '', source: 'send_to_note' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('单 listener 抛错不阻断其它 listener', () => {
    const ok = vi.fn();
    subscribeNoteDocWritten(() => {
      throw new Error('boom');
    });
    subscribeNoteDocWritten(ok);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    notifyNoteDocWritten({ docId: 'doc-x', source: 'send_to_note' });
    expect(ok).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
