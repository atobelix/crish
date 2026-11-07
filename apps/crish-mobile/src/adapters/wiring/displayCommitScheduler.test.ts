// DisplayCommitScheduler 单测（R4 展示合帧调度器）：
// - 同 sequence 连续 delta 在缓冲层就地合并（只留最新内容）；
// - 窗口到期一次 commit；cap 到顶立即 commit（背压有界）；
// - flushSession 跨会话独立；dispose 清残留不触发 commit。
import type { EventEnvelopeFrame } from '@/domain/store/eventReducers';
import {
  DISPLAY_COMMIT_MAX_PENDING_PER_SESSION,
  DisplayCommitScheduler,
} from './displayCommitScheduler';

function deltaFrame(sequence: number, text: string): EventEnvelopeFrame {
  return { type: 'message-delta', sessionId: 's-x', sequence, text };
}

interface HostSpy {
  commits: Array<{ sessionId: string; frames: EventEnvelopeFrame[] }>;
}

function makeHost(): HostSpy {
  return { commits: [] };
}

function makeScheduler(
  host: HostSpy,
  windowMs: number
): DisplayCommitScheduler {
  return new DisplayCommitScheduler(
    {
      commit: (sessionId, frames) => {
        host.commits.push({ sessionId, frames: [...frames] });
      },
    },
    windowMs
  );
}

describe('DisplayCommitScheduler（R4 展示合帧）', () => {
  it('同 sequence 连续 delta 缓冲层合并：只留最新内容，一次 commit 一条', async () => {
    jest.useFakeTimers();
    try {
      const host = makeHost();
      const scheduler = makeScheduler(host, 33);
      scheduler.enqueue('s-1', deltaFrame(2, 'a'));
      scheduler.enqueue('s-1', deltaFrame(2, 'b'));
      scheduler.enqueue('s-1', deltaFrame(2, 'c'));
      expect(host.commits).toHaveLength(0);

      jest.advanceTimersByTime(33);
      expect(host.commits).toHaveLength(1);
      expect(host.commits[0]!.sessionId).toBe('s-1');
      expect(host.commits[0]!.frames).toHaveLength(1);
      expect(host.commits[0]!.frames[0]!['text']).toBe('c');
    } finally {
      jest.useRealTimers();
    }
  });

  it('不同 sequence 帧按到达序保留，窗口到期原序一次 commit', async () => {
    jest.useFakeTimers();
    try {
      const host = makeHost();
      const scheduler = makeScheduler(host, 33);
      scheduler.enqueue('s-1', deltaFrame(1, 'a'));
      scheduler.enqueue('s-1', deltaFrame(2, 'b'));
      scheduler.enqueue('s-1', deltaFrame(3, 'c'));

      jest.advanceTimersByTime(33);
      expect(host.commits).toHaveLength(1);
      expect(host.commits[0]!.frames.map((f) => f['text'])).toEqual([
        'a', 'b', 'c',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cap 到顶立即 commit（背压有界），不等窗口', () => {
    jest.useFakeTimers();
    try {
      const host = makeHost();
      const scheduler = makeScheduler(host, 60_000);
      for (let i = 1; i <= DISPLAY_COMMIT_MAX_PENDING_PER_SESSION; i += 1) {
        scheduler.enqueue('s-1', deltaFrame(i, `t${i}`));
      }
      expect(host.commits).toHaveLength(1);
      expect(host.commits[0]!.frames).toHaveLength(
        DISPLAY_COMMIT_MAX_PENDING_PER_SESSION
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushSession 跨会话独立：只冲目标会话，其余待合帧不动', () => {
    jest.useFakeTimers();
    try {
      const host = makeHost();
      const scheduler = makeScheduler(host, 60_000);
      scheduler.enqueue('s-a', deltaFrame(1, 'a'));
      scheduler.enqueue('s-b', deltaFrame(1, 'b'));

      scheduler.flushSession('s-b');
      expect(host.commits).toHaveLength(1);
      expect(host.commits[0]!.sessionId).toBe('s-b');

      scheduler.flushAll();
      expect(host.commits).toHaveLength(2);
      expect(host.commits[1]!.sessionId).toBe('s-a');
    } finally {
      jest.useRealTimers();
    }
  });

  it('flushAll 逐会话独立 commit 且清定时器；dispose 清残留', () => {
    jest.useFakeTimers();
    try {
      const host = makeHost();
      const scheduler = makeScheduler(host, 33);
      scheduler.enqueue('s-a', deltaFrame(1, 'a'));
      scheduler.enqueue('s-b', deltaFrame(1, 'b'));

      scheduler.flushAll();
      expect(host.commits).toHaveLength(2);

      scheduler.enqueue('s-c', deltaFrame(1, 'c'));
      scheduler.dispose();
      jest.advanceTimersByTime(1000);
      // dispose 后残留清空，定时器已清：不再 commit
      expect(host.commits).toHaveLength(2);
      scheduler.flushAll();
      expect(host.commits).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});
