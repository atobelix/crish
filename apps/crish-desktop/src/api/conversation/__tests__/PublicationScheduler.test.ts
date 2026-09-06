import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConversationSnapshot,
  PublicationScheduler,
} from '../PublicationScheduler';

describe('PublicationScheduler 3-RAF 节流发布管线', () => {
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextRafId: number;

  const createMockSnapshot = (
    revision: number,
    text = ''
  ): ConversationSnapshot => ({
    order: ['node-1'],
    nodes: new Map([
      [
        'node-1',
        {
          id: 'node-1',
          kind: 'assistant',
          sender: 'assistant',
          timestamp: 1000 + revision,
          text,
        },
      ],
    ]),
    revision,
  });

  const stepFrame = () => {
    const current = new Map(rafCallbacks);
    rafCallbacks.clear();
    for (const [, cb] of current) {
      cb(performance.now());
    }
  };

  beforeEach(() => {
    rafCallbacks = new Map();
    nextRafId = 1;

    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, cb);
      return id;
    });

    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('1. 3-RAF 节流与合流防抖测试', () => {
    it('单次 schedule animation-frame 时经历跨 3 帧合流后精确触发 1 次 onPublish', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      const snapshot = createMockSnapshot(1, 'hello');
      scheduler.schedule('animation-frame', () => snapshot);

      // 首帧标记 dirty 且开始排队
      expect(scheduler.isPending).toBe(true);
      expect(published).toHaveLength(0);

      // 第 1 帧：尚未达到 3 帧门限
      stepFrame();
      expect(scheduler.currentFrameCount).toBe(1);
      expect(scheduler.isPending).toBe(true);
      expect(published).toHaveLength(0);

      // 第 2 帧：尚未达到 3 帧门限
      stepFrame();
      expect(scheduler.currentFrameCount).toBe(2);
      expect(scheduler.isPending).toBe(true);
      expect(published).toHaveLength(0);

      // 第 3 帧：达到 3 帧门限，统一触发发布
      stepFrame();
      expect(scheduler.currentFrameCount).toBe(0);
      expect(scheduler.isPending).toBe(false);
      expect(published).toHaveLength(1);
      expect(published[0]).toBe(snapshot);
      expect(published[0].revision).toBe(1);
    });

    it('连续高频注入 100 个 chunk 事件，经 3-RAF 节流后仅触发 1 次发布且包含最新快照', () => {
      const published: ConversationSnapshot[] = [];
      let getterEvalCount = 0;

      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      // 连续高频注入 100 个 chunk
      for (let i = 1; i <= 100; i++) {
        const rev = i;
        scheduler.schedule('animation-frame', () => {
          getterEvalCount++;
          return createMockSnapshot(rev, `chunk-${rev}`);
        });
      }

      // 惰性物化断言：在帧未到达前，一次 getter 都未被执行
      expect(getterEvalCount).toBe(0);
      expect(published).toHaveLength(0);
      expect(scheduler.isPending).toBe(true);

      // 推进帧：第 1 帧
      stepFrame();
      expect(published).toHaveLength(0);
      expect(getterEvalCount).toBe(0);

      // 推进帧：第 2 帧
      stepFrame();
      expect(published).toHaveLength(0);
      expect(getterEvalCount).toBe(0);

      // 推进帧：第 3 帧，触发物化发布
      stepFrame();
      expect(published).toHaveLength(1);
      // 惰性物化断言：100 次 schedule 期间，getter 仅在第 3 帧求值了 1 次
      expect(getterEvalCount).toBe(1);
      expect(published[0].revision).toBe(100);
    });

    it('多轮流式周期中持续注入 100 个 chunk，发布次数严格 <= 4 次', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      // 模拟每隔半帧注入增量，一共走完 12 帧
      let chunkIdx = 0;
      for (let frame = 1; frame <= 12; frame++) {
        for (let burst = 0; burst < 8; burst++) {
          chunkIdx++;
          const rev = chunkIdx;
          scheduler.schedule('animation-frame', () =>
            createMockSnapshot(rev, `text-${rev}`)
          );
        }
        stepFrame();
      }

      // 12 帧按照每 3 帧合流 1 次，12 帧最多发布 4 次
      expect(published.length).toBeGreaterThanOrEqual(1);
      expect(published.length).toBeLessThanOrEqual(4);
    });
  });

  describe('2. immediate 零延迟穿透与短路测试', () => {
    it('单独调用 immediate 零延迟瞬时物化同步发布，不排队任何 RAF', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      const endSnapshot = createMockSnapshot(99, 'completed');
      scheduler.schedule('immediate', () => endSnapshot);

      // 同步执行完成，绝无延迟
      expect(published).toHaveLength(1);
      expect(published[0]).toBe(endSnapshot);
      expect(scheduler.isPending).toBe(false);
      expect(scheduler.currentFrameCount).toBe(0);
      expect(rafCallbacks.size).toBe(0);
    });

    it('在 3-RAF 累积中途遇到 immediate 终态事件，立即取消排队帧、重置计数并同步发布', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      // 先发起增量 chunk，进入 3-RAF 累积
      scheduler.schedule('animation-frame', () =>
        createMockSnapshot(1, 'stream chunk')
      );
      stepFrame(); // 第 1 帧
      expect(scheduler.currentFrameCount).toBe(1);
      expect(rafCallbacks.size).toBe(1);

      // 在第 2 帧到来前，遇到 message_end 关键终态事件
      const endSnapshot = createMockSnapshot(2, 'final text');
      scheduler.schedule('immediate', () => endSnapshot);

      // immediate 零延迟同步完成
      expect(published).toHaveLength(1);
      expect(published[0]).toBe(endSnapshot);
      expect(scheduler.isPending).toBe(false);
      expect(scheduler.currentFrameCount).toBe(0);
      // 挂起的 RAF 已被完全取消
      expect(rafCallbacks.size).toBe(0);

      // 后续即使调用 stepFrame，也绝不再触发任何回调
      stepFrame();
      stepFrame();
      expect(published).toHaveLength(1);
    });

    it('immediate 执行后再次调用 animation-frame，计数器从第 1 帧重新开始累积', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.schedule('immediate', () => createMockSnapshot(1));
      expect(published).toHaveLength(1);

      // 再次发起 animation-frame
      scheduler.schedule('animation-frame', () => createMockSnapshot(2));
      stepFrame(); // 帧 1
      expect(scheduler.currentFrameCount).toBe(1);
      stepFrame(); // 帧 2
      expect(scheduler.currentFrameCount).toBe(2);
      expect(published).toHaveLength(1);

      stepFrame(); // 帧 3
      expect(scheduler.currentFrameCount).toBe(0);
      expect(published).toHaveLength(2);
      expect(published[1].revision).toBe(2);
    });
  });

  describe('3. none 静默折叠测试', () => {
    it('单独调用 none 时静默折叠，不排队、不调度渲染', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.schedule('none', () => createMockSnapshot(1));
      expect(published).toHaveLength(0);
      expect(scheduler.isPending).toBe(false);
      expect(rafCallbacks.size).toBe(0);

      stepFrame();
      expect(published).toHaveLength(0);
    });

    it('在挂起的 animation-frame 期间注入 none，仅更新最新状态，不提前触发渲染', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.schedule('animation-frame', () => createMockSnapshot(1));
      stepFrame(); // 帧 1

      // 注入 none 静默更新
      scheduler.schedule('none', () => createMockSnapshot(2));
      expect(published).toHaveLength(0);

      stepFrame(); // 帧 2
      expect(published).toHaveLength(0);

      stepFrame(); // 帧 3：合流物化
      expect(published).toHaveLength(1);
      expect(published[0].revision).toBe(2);
    });
  });

  describe('4. flush 强制清空并发布测试', () => {
    it('在挂起状态下调用 flush() 立即清空未决帧并同步发布最新快照', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.schedule('animation-frame', () => createMockSnapshot(1));
      stepFrame(); // 帧 1
      expect(scheduler.isPending).toBe(true);

      scheduler.flush();
      expect(published).toHaveLength(1);
      expect(published[0].revision).toBe(1);
      expect(scheduler.isPending).toBe(false);
      expect(rafCallbacks.size).toBe(0);

      // 后续帧推进不再触发
      stepFrame();
      stepFrame();
      expect(published).toHaveLength(1);
    });

    it('空闲状态下调用 flush() 属于安全 no-op', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.flush();
      expect(published).toHaveLength(0);
      expect(scheduler.isPending).toBe(false);
    });
  });

  describe('5. dispose 销毁与 GC 防泄漏测试', () => {
    it('在挂起状态下调用 dispose() 立即切断定时器并释放闭包引用', () => {
      const published: ConversationSnapshot[] = [];
      let getterCalled = false;

      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.schedule('animation-frame', () => {
        getterCalled = true;
        return createMockSnapshot(1);
      });

      expect(scheduler.isPending).toBe(true);
      expect(rafCallbacks.size).toBe(1);

      // 销毁
      scheduler.dispose();
      expect(scheduler.disposed).toBe(true);
      expect(scheduler.isPending).toBe(false);
      expect(rafCallbacks.size).toBe(0);

      // 推进帧，绝不执行 getter 也绝不触发发布
      stepFrame();
      stepFrame();
      stepFrame();

      expect(getterCalled).toBe(false);
      expect(published).toHaveLength(0);
    });

    it('dispose() 之后所有操作 (schedule, flush, cancelPending) 均为安全 no-op', () => {
      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.dispose();

      scheduler.schedule('immediate', () => createMockSnapshot(1));
      scheduler.schedule('animation-frame', () => createMockSnapshot(2));
      scheduler.flush();
      scheduler.cancelPending();
      scheduler.dispose(); // 幂等

      expect(published).toHaveLength(0);
      expect(scheduler.isPending).toBe(false);
    });
  });

  describe('6. 优雅降级测试 (非浏览器/无 requestAnimationFrame 环境)', () => {
    it('在无 requestAnimationFrame 环境下自动降级为 setTimeout 且 3 次 tick 精确发布', () => {
      vi.useFakeTimers();
      // 移除 requestAnimationFrame 模拟无 rAF 环境
      vi.stubGlobal('requestAnimationFrame', undefined);
      vi.stubGlobal('cancelAnimationFrame', undefined);

      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.schedule('animation-frame', () =>
        createMockSnapshot(1, 'fallback')
      );
      expect(scheduler.isPending).toBe(true);

      // 第 1 个 16ms tick
      vi.advanceTimersByTime(16);
      expect(scheduler.currentFrameCount).toBe(1);
      expect(published).toHaveLength(0);

      // 第 2 个 16ms tick
      vi.advanceTimersByTime(16);
      expect(scheduler.currentFrameCount).toBe(2);
      expect(published).toHaveLength(0);

      // 第 3 个 16ms tick，合流完成
      vi.advanceTimersByTime(16);
      expect(scheduler.currentFrameCount).toBe(0);
      expect(scheduler.isPending).toBe(false);
      expect(published).toHaveLength(1);
      expect(published[0].revision).toBe(1);

      vi.useRealTimers();
    });

    it('降级模式下 cancelPending 和 dispose 正确清除 pending 定时器', () => {
      vi.useFakeTimers();
      vi.stubGlobal('requestAnimationFrame', undefined);
      vi.stubGlobal('cancelAnimationFrame', undefined);

      const published: ConversationSnapshot[] = [];
      const scheduler = new PublicationScheduler<ConversationSnapshot>(
        (snapshot) => {
          published.push(snapshot);
        }
      );

      scheduler.schedule('animation-frame', () => createMockSnapshot(1));
      vi.advanceTimersByTime(16); // tick 1
      expect(scheduler.currentFrameCount).toBe(1);

      scheduler.cancelPending();
      expect(scheduler.isPending).toBe(false);
      expect(scheduler.currentFrameCount).toBe(0);

      // 推进时间，不再触发
      vi.advanceTimersByTime(100);
      expect(published).toHaveLength(0);

      vi.useRealTimers();
    });
  });

  describe('7. 构造函数配置项与默认 getter 支持', () => {
    it('支持 options 形式初始化与全局 default getSnapshot', () => {
      const published: ConversationSnapshot[] = [];
      let defaultRev = 10;

      const scheduler = new PublicationScheduler<ConversationSnapshot>({
        onPublish: (s) => published.push(s),
        getSnapshot: () => createMockSnapshot(defaultRev),
      });

      // 不传 getter，使用默认 getter
      scheduler.schedule('immediate');
      expect(published).toHaveLength(1);
      expect(published[0].revision).toBe(10);

      defaultRev = 20;
      scheduler.schedule('animation-frame');
      stepFrame();
      stepFrame();
      stepFrame();
      expect(published).toHaveLength(2);
      expect(published[1].revision).toBe(20);
    });
  });
});
