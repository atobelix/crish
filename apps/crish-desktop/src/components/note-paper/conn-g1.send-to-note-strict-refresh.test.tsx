// @vitest-environment jsdom
/**
 * CONN-G1 · send_to_note → Strict 同 doc 写后读回
 *
 * 完成定义：
 * 1. 同 docId：dispatchSendToNote 成功后 Strict 投影见新块文本
 * 2. 异 docId：不误刷新
 * 3. 流未完成 / sink 拒：不写、不读回
 *
 * 诚实边界：
 * - **≠ EL-08**；**≠ EL-01**；**≠ 打开完成**
 * - Skeleton 双轨保留（本测仅 Strict）
 * - mock / Memory transport；禁止 fixture 伪装 tauri-ipc
 * - 不破坏 assertStreamCompleted / 流式禁写（SURF）
 */
import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  createMemoryNoteTransport,
  setDefaultNoteTransport,
} from '../../api/noteApi';
import {
  clearSendToNoteIdempotencyForTests,
  createMockSendToNoteSink,
  dispatchSendToNote,
  resetSendToNoteIntentSeqForTests,
} from '../../bridges/send-to-note';
import {
  clearNoteDocWrittenListenersForTests,
  noteDocWrittenListenerCountForTests,
  subscribeNoteDocWritten,
} from '../../bridges/note-doc-written';
import { adaptNoteTransportAsHydrate } from './hydrateProjection';
import { NotePaperStrictPanel } from './NotePaperStrictPanel';
import { W5B_SKELETON_PACKAGE_ID } from './notePaperSkeletonTrack';
import { W5B_STRICT_PACKAGE_ID } from './notePaperStrictTrack';

beforeEach(() => {
  resetSendToNoteIntentSeqForTests();
  clearSendToNoteIdempotencyForTests();
  clearNoteDocWrittenListenersForTests();
  setDefaultNoteTransport(null);
});

describe('CONN-G1 · send_to_note → Strict 写后读回', () => {
  it('conn_g1_same_doc_send_to_note_refreshes_strict_projection', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-g1', [['seed-1', 'paragraph', 'seed before write']]);
    const hydrate = adaptNoteTransportAsHydrate(mem);

    render(<NotePaperStrictPanel docId="doc-g1" hydrateTransport={hydrate} />);

    await waitFor(() => {
      expect(screen.getByText('seed before write')).toBeInTheDocument();
    });
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-package-id',
      W5B_STRICT_PACKAGE_ID
    );
    // Skeleton 常量仍独立存在（双轨保留；本测不挂 Skeleton 面板）
    expect(W5B_SKELETON_PACKAGE_ID).not.toBe(W5B_STRICT_PACKAGE_ID);

    const result = await dispatchSendToNote(
      {
        messageId: 'msg-g1',
        markdown: '## CONN-G1 new block text',
        docId: 'doc-g1',
        intentId: 'conn-g1-write-1',
      },
      {
        streamStatus: 'completed',
        transport: mem,
      }
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applied).toBe(true);
    }

    await waitFor(() => {
      expect(screen.getByText('CONN-G1 new block text')).toBeInTheDocument();
    });
    // 原 seed 仍在（append 语义）
    expect(screen.getByText('seed before write')).toBeInTheDocument();
    expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
      'data-hydrate-status',
      'ready'
    );
    const count = Number(
      screen
        .getByTestId('note-paper-strict-panel')
        .getAttribute('data-block-count')
    );
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('conn_g1_other_doc_write_does_not_change_this_strict', async () => {
    const mem = createMemoryNoteTransport();
    mem.seedDoc('doc-keep', [['k1', 'paragraph', 'keep me']]);
    const hydrate = adaptNoteTransportAsHydrate(mem);

    render(
      <NotePaperStrictPanel docId="doc-keep" hydrateTransport={hydrate} />
    );
    await waitFor(() => {
      expect(screen.getByText('keep me')).toBeInTheDocument();
    });
    const beforeCount = screen
      .getByTestId('note-paper-strict-panel')
      .getAttribute('data-block-count');

    const result = await dispatchSendToNote(
      {
        messageId: 'msg-other',
        markdown: '## should not appear here',
        docId: 'doc-other',
        intentId: 'conn-g1-other-1',
      },
      { streamStatus: 'completed', transport: mem }
    );
    expect(result.ok).toBe(true);

    // 给一帧微任务窗口；不得出现他 doc 文本
    await waitFor(() => {
      expect(screen.queryByText('should not appear here')).toBeNull();
    });
    expect(screen.getByText('keep me')).toBeInTheDocument();
    expect(
      screen
        .getByTestId('note-paper-strict-panel')
        .getAttribute('data-block-count')
    ).toBe(beforeCount);
  });

  it('conn_g1_stream_not_completed_no_notify_no_write', async () => {
    const mem = createMemoryNoteTransport();
    const hydrate = adaptNoteTransportAsHydrate(mem);
    const notified: string[] = [];
    const unsub = subscribeNoteDocWritten((ev) => {
      notified.push(ev.docId);
    });

    render(
      <NotePaperStrictPanel docId="doc-stream" hydrateTransport={hydrate} />
    );
    await waitFor(() => {
      expect(screen.getByTestId('note-paper-strict-panel')).toHaveAttribute(
        'data-hydrate-status',
        'empty'
      );
    });

    const result = await dispatchSendToNote(
      {
        messageId: 'msg-stream',
        markdown: '## must not write',
        docId: 'doc-stream',
        intentId: 'conn-g1-stream',
      },
      { streamStatus: 'streaming', transport: mem }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('stream_not_completed');
    }
    // 总线：dispatch 失败路径不 notify（subscribe 仅 Strict 自身）
    // Strict mount 会有 listener，但不应收到 write 事件
    expect(notified).toEqual([]);
    expect(mem.blockCount('doc-stream')).toBe(0);
    expect(screen.queryByText('must not write')).toBeNull();
    unsub();
  });

  it('conn_g1_sink_reject_no_notify', async () => {
    const mock = createMockSendToNoteSink({
      ok: false,
      reason: 'reject for g1',
    });
    const seen = viNotify();
    const result = await dispatchSendToNote(
      {
        messageId: 'msg-rej',
        markdown: 'x',
        docId: 'doc-rej',
        intentId: 'conn-g1-rej',
      },
      mock.sink,
      { streamStatus: 'completed' }
    );
    expect(result.ok).toBe(false);
    expect(seen.docs).toEqual([]);
    seen.cleanup();
  });

  it('conn_g1_idempotent_replay_notifies_once', async () => {
    const mem = createMemoryNoteTransport();
    const seen = viNotify();
    const cache = new Map();
    const input = {
      messageId: 'msg-idem',
      markdown: '## once only',
      docId: 'doc-idem-g1',
      intentId: 'conn-g1-idem',
    };
    const first = await dispatchSendToNote(input, {
      streamStatus: 'completed',
      transport: mem,
      idempotencyCache: cache,
    });
    const second = await dispatchSendToNote(input, {
      streamStatus: 'completed',
      transport: mem,
      idempotencyCache: cache,
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.applied).toBe(true);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.applied).toBe(false);
    // 仅首次 applied 通知
    expect(seen.docs).toEqual(['doc-idem-g1']);
    expect(mem.blockCount('doc-idem-g1')).toBe(1);
    seen.cleanup();
  });

  it('conn_g1_unmount_unsubscribes_listener', async () => {
    const mem = createMemoryNoteTransport();
    const hydrate = adaptNoteTransportAsHydrate(mem);
    const before = noteDocWrittenListenerCountForTests();
    const { unmount } = render(
      <NotePaperStrictPanel docId="doc-unsub" hydrateTransport={hydrate} />
    );
    await waitFor(() => {
      expect(noteDocWrittenListenerCountForTests()).toBe(before + 1);
    });
    unmount();
    expect(noteDocWrittenListenerCountForTests()).toBe(before);
  });
});

function viNotify(): { docs: string[]; cleanup: () => void } {
  const docs: string[] = [];
  const unsub = subscribeNoteDocWritten((ev) => {
    docs.push(ev.docId);
  });
  return {
    docs,
    cleanup: () => {
      unsub();
    },
  };
}
