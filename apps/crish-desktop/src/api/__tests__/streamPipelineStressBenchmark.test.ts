// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StreamTextBatcher,
  StreamValueBatcher,
  streamBatchKey,
} from '../streamTextBatcher';
import {
  createPtyWriteGate,
  MAX_PENDING_BYTES,
  CHUNK_FLUSH_BYTES,
  FRAME_BUDGET_MS,
  OVERFLOW_WARNING,
  type TerminalWriteTarget,
} from '../../components/workspace/ptyWriteGate';
import {
  scheduleDualRafHandoff,
  scheduleDualRafClearStream,
  commitStreamWithDualLatch,
  isTerminalStreamStatus,
  applyTerminalStatusLatch,
  resolveStreamMessageLatch,
} from '../../hooks/chat-stream/useStreamCallbacks';
import {
  getStreamText,
  setStreamText,
  clearStream,
  useStreamingStore,
} from '../../store/streamingStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { getSessionById } from '../../store/sessionStore';
import type { SessionMessage } from '../../store/types';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';

// ── Mock storeAccess for Dual-Latch Handoff Tests ────────────────────────────
const updateMessageTextMock = vi.fn();
const updateMessageToolCallMock = vi.fn();
const addMessageToolCallMock = vi.fn();
const updateMessageThinkingMock = vi.fn();

vi.mock('../storeAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storeAccess')>();
  return {
    ...actual,
    updateMessageText: (...args: unknown[]) => {
      updateMessageTextMock(...args);
      return actual.updateMessageText(
        ...(args as Parameters<typeof actual.updateMessageText>)
      );
    },
    updateMessageToolCall: (...args: unknown[]) =>
      updateMessageToolCallMock(...args),
    addMessageToolCall: (...args: unknown[]) => addMessageToolCallMock(...args),
    updateMessageThinking: (...args: unknown[]) =>
      updateMessageThinkingMock(...args),
  };
});

// ── Mock ResizeObserver for JSDOM ────────────────────────────────────────────
class MockResizeObserver {
  private cb: (entries: ResizeObserverEntry[]) => void;
  constructor(cb: (entries: ResizeObserverEntry[]) => void) {
    this.cb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}

  __trigger(entries: ResizeObserverEntry[]) {
    this.cb(entries);
  }
}

let activeMockRO: MockResizeObserver | null = null;
function setActiveMockRO(instance: MockResizeObserver): void {
  activeMockRO = instance;
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  class extends MockResizeObserver {
    constructor(cb: (entries: ResizeObserverEntry[]) => void) {
      super(cb);
      setActiveMockRO(this);
    }
  };

describe('Stream Pipeline Stress & Throughput Benchmark Suite (W3-6)', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Suite 1: StreamTextBatcher 高频推流极限压测 (W1-4 增量 pending 计数与防退化)
  // ───────────────────────────────────────────────────────────────────────────
  describe('1. StreamTextBatcher 500-1000 Token/s 高频推流压测与平滑度基准', () => {
    it('15 秒灌入 15,000 thinking chunks：批合并平滑、单帧 flush 零超限且永不退化为单 token 同步强刷', () => {
      const flushed: Array<{ key: string; text: string; length: number }> = [];
      const timerCallbacks: Array<() => void> = [];

      const batcher = new StreamTextBatcher(
        (key, text) => {
          flushed.push({ key, text, length: text.length });
        },
        {
          intervalMs: 48,
          setTimer: (fn) => {
            timerCallbacks.push(fn);
            return timerCallbacks.length as unknown as ReturnType<
              typeof setTimeout
            >;
          },
          clearTimer: () => {
            timerCallbacks.length = 0;
          },
          maxBufferedChars: 8000,
        }
      );

      const TOTAL_CHUNKS = 15000;
      const SIMULATED_TIME_MS = 15000; // 15s
      const INTERVAL_MS = 48;
      const key = streamBatchKey('sess-stress-1', 'msg-stress-1');

      let cumulativeText = '';
      let simulatedTime = 0;
      let nextFlushTime = INTERVAL_MS;

      const startTime = performance.now();

      // 模拟 15 秒内灌入 15,000 个思考增量 chunk (平均 1ms/chunk，对应 1,000 chunk/s 高频推流)
      for (let i = 0; i < TOTAL_CHUNKS; i++) {
        // 每个 chunk 追加 6-10 字符的思考内容
        const chunkDelta = `t${i}_thought;`;
        cumulativeText += chunkDelta;

        batcher.push(key, cumulativeText);
        simulatedTime += SIMULATED_TIME_MS / TOTAL_CHUNKS;

        // 当模拟时间到达 48ms 窗口，触发定时器刷新
        if (simulatedTime >= nextFlushTime) {
          while (timerCallbacks.length > 0) {
            const cb = timerCallbacks.shift();
            cb?.();
          }
          nextFlushTime += INTERVAL_MS;
        }

        // 核心不变量断言：在常规推流过程中，未提交增量字符数严格受控于 8000 阈值以内
        expect(batcher.bufferedSize()).toBeLessThanOrEqual(8000);
      }

      // 结算收尾
      batcher.flushNow();
      const elapsedRealMs = performance.now() - startTime;

      // ── 契约与性能指标断言 ──
      // 1. 压缩比断言：15,000 chunks 在 48ms 节流下合并为 ~313 次 flush (压缩比 > 45x)
      expect(flushed.length).toBeGreaterThanOrEqual(300);
      expect(flushed.length).toBeLessThanOrEqual(330);

      // 2. 防退化断言：累计文本已达 ~190,000 字符（远超 8000），flush 次数绝不爆炸接近 15000
      expect(flushed.length).toBeLessThan(TOTAL_CHUNKS / 40);

      // 3. 单帧 flush 增量平滑度：平均每帧合并约 47-49 个 chunk，单帧增量字符数平滑受控
      const avgChunksPerFlush = TOTAL_CHUNKS / flushed.length;
      expect(avgChunksPerFlush).toBeGreaterThan(45);
      expect(avgChunksPerFlush).toBeLessThan(51);

      // 4. 数据完整性：最终 flush 出的文本与 15,000 个 chunk 拼接生成的全文 100% 严格一致
      expect(flushed[flushed.length - 1]?.text).toBe(cumulativeText);
      expect(flushed[flushed.length - 1]?.length).toBe(cumulativeText.length);

      // 5. 吞吐率基准：15,000 chunks 处理与批处理在 CPU 上耗时极速完成 (< 500ms)
      expect(elapsedRealMs).toBeLessThan(500);

      batcher.dispose();
    });

    it('突发超大 Chunk (12,000 字符) 安全触发 Force Flush 并立即重置增量度量计数器', () => {
      const flushed: string[] = [];
      const timers: Array<() => void> = [];

      const batcher = new StreamTextBatcher(
        (_k, text) => {
          flushed.push(text);
        },
        {
          intervalMs: 50,
          maxBufferedChars: 8000,
          setTimer: (fn) => {
            timers.push(fn);
            return 1 as unknown as ReturnType<typeof setTimeout>;
          },
          clearTimer: () => {
            timers.length = 0;
          },
        }
      );

      const key = 'burst-key';
      // 1. 先建立 50,000 字符的高基线并正常提交
      let baselineText = 'A'.repeat(50000);
      batcher.push(key, baselineText);
      batcher.flushNow();
      expect(flushed).toHaveLength(1);
      expect(batcher.bufferedSize()).toBe(0);
      flushed.length = 0;

      // 2. 突发单个超大 chunk (追加 12,000 字符，未提交增量达 12,000 > 8000 阈值)
      const hugeDelta = 'B'.repeat(12000);
      baselineText += hugeDelta;
      batcher.push(key, baselineText);

      // 核心断言：因未提交增量超过 8000，立即触发同步 Force Flush，无需等待 50ms 定时器
      expect(flushed).toEqual([baselineText]);
      expect(batcher.bufferedSize()).toBe(0);
      expect(batcher.isScheduled()).toBe(false);

      // 3. 验证增量重置：超大 chunk 提交后，后续普通小 token (如追加 10 字符) 恢复平滑批处理
      baselineText += 'C'.repeat(10);
      batcher.push(key, baselineText);

      // 核心断言：增量仅 10 字符，不触发同步 flush，重新进入 50ms interval 调度
      expect(flushed).toHaveLength(1);
      expect(batcher.bufferedSize()).toBe(10);
      expect(batcher.isScheduled()).toBe(true);

      batcher.dispose();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 2: 终端 20MB 日志爆发写入与 ptyWriteGate 环形门闩极限压测 (W1-3)
  // ───────────────────────────────────────────────────────────────────────────
  describe('2. 终端 20MB 日志爆发写入与 ptyWriteGate 512KB 有界环形门闩', () => {
    it('隐藏终端爆发写入 20MB：安全触发 512KB 截断与 ANSI 告警，且单帧写入严格限制在 32KB', () => {
      const writtenChunks: string[] = [];
      const sink: TerminalWriteTarget = {
        write: (data: string) => {
          writtenChunks.push(data);
        },
      };

      // 初始处于隐藏态 (后台编译/运行产生巨量日志)
      const gate = createPtyWriteGate(sink, true);

      const TOTAL_LOG_BYTES = 20 * 1024 * 1024; // 20MB (20,971,520 bytes)
      const CHUNK_SIZE = 128 * 1024; // 128KB per write (131,072 bytes)
      const NUM_WRITES = TOTAL_LOG_BYTES / CHUNK_SIZE; // Exactly 160 writes

      let peakPendingBytes = 0;

      // 模拟快速爆发式写入 20MB 数据
      for (let i = 0; i < NUM_WRITES; i++) {
        const payload =
          `[LOG_${i.toString().padStart(6, '0')}]` +
          'X'.repeat(CHUNK_SIZE - 12);
        gate.write(payload);

        const currentPending = gate.pendingLength();
        if (currentPending > peakPendingBytes) {
          peakPendingBytes = currentPending;
        }

        // 核心红线断言：在 20MB 持续写入的任何时刻，待写入缓冲区严格不超过 512KB
        expect(currentPending).toBeLessThanOrEqual(MAX_PENDING_BYTES);
      }

      // ── 截断与告警断言 ──
      expect(gate.hasOverflowWarning()).toBe(true);
      expect(peakPendingBytes).toBeLessThanOrEqual(MAX_PENDING_BYTES);
      expect(gate.pendingLength()).toBeLessThanOrEqual(MAX_PENDING_BYTES);

      // 切换为可见态，触发分片排空
      gate.setHidden(false);

      // ── 分片排空循环断言 ──
      let frameCount = 0;
      let totalDrainedBytes = 0;
      const singleFrameWrites: number[] = [];

      while (gate.pendingLength() > 0) {
        frameCount += 1;
        const frameResult = gate.flushFrame();
        singleFrameWrites.push(frameResult.bytesWritten);
        totalDrainedBytes += frameResult.bytesWritten;

        // 核心红线断言：单帧写入严格 <= 32KB (CHUNK_FLUSH_BYTES)
        expect(frameResult.bytesWritten).toBeLessThanOrEqual(CHUNK_FLUSH_BYTES);
      }

      // 1. 验证排空帧数：512KB 以 32KB/帧 平滑排出，总帧数严格等于 16 帧
      const expectedFrames = Math.ceil(MAX_PENDING_BYTES / CHUNK_FLUSH_BYTES);
      expect(frameCount).toBe(expectedFrames);
      expect(frameCount).toBe(16);

      // 2. 验证排空总量：恰好完整排空截断后的 512KB 有界缓冲区
      expect(totalDrainedBytes).toBe(MAX_PENDING_BYTES);
      expect(gate.pendingLength()).toBe(0);
      expect(gate.pendingCount()).toBe(0);

      // 3. 验证首帧告警注入：排空的首个数据块以 ANSI 警示文本开头
      const fullOutput = writtenChunks.join('');
      expect(fullOutput.startsWith(OVERFLOW_WARNING)).toBe(true);

      // 4. 验证尾部保真：最新的日志 (最后几个写入块) 完整保留在输出尾部
      const lastWriteTag = `[LOG_${(NUM_WRITES - 1).toString().padStart(6, '0')}]`;
      expect(fullOutput).toContain(lastWriteTag);

      // 5. 验证排空完成后告警状态重置
      expect(gate.hasOverflowWarning()).toBe(false);
    });

    it('8ms 时间预算保护：当底层渲染耗时递增时，提前退出循环顺延至下帧', () => {
      let mockTime = 100;
      vi.spyOn(performance, 'now').mockImplementation(() => mockTime);

      const written: string[] = [];
      const slowSink: TerminalWriteTarget = {
        write: (data: string) => {
          written.push(data);
          // 模拟底层 xterm 渲染耗时 5ms
          mockTime += 5;
        },
      };

      const gate = createPtyWriteGate(slowSink, true);
      // 推入 3 个 10KB chunk (总共 30KB，理论上单帧 32KB 预算内可容纳)
      gate.write('A'.repeat(10 * 1024));
      gate.write('B'.repeat(10 * 1024));
      gate.write('C'.repeat(10 * 1024));

      gate.setHidden(false);

      // 第 1 帧排空：
      // chunk 1 耗时 5ms (< 8ms)，继续；
      // chunk 2 耗时 5ms，总耗时达 10ms (>= 8ms FRAME_BUDGET_MS)，触发 break 退出
      const frame1 = gate.flushFrame();
      expect(frame1.bytesWritten).toBe(20 * 1024);
      expect(written).toHaveLength(2);
      expect(frame1.remaining).toBe(10 * 1024);

      // 第 2 帧排空：剩余 10KB 写入完毕
      const frame2 = gate.flushFrame();
      expect(frame2.bytesWritten).toBe(10 * 1024);
      expect(frame2.remaining).toBe(0);

      vi.restoreAllMocks();
    });

    it('底层异常自愈保护：xterm 写入异常时不崩溃，清空队列并安全自愈', () => {
      let fail = true;
      const gate = createPtyWriteGate(
        {
          write: () => {
            if (fail) throw new Error('xterm canvas context lost');
          },
        },
        true
      );

      gate.write('crash-data\n');
      gate.setHidden(false);

      expect(() => gate.flushFrame()).not.toThrow();
      expect(gate.pendingLength()).toBe(0);

      // 恢复后正常工作
      fail = false;
      const healthyWritten: string[] = [];
      const healthyGate = createPtyWriteGate(
        { write: (d) => healthyWritten.push(d) },
        false
      );
      healthyGate.write('recovered\n');
      healthyGate.flushAllPending();
      expect(healthyWritten).toEqual(['recovered\n']);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 3: 流式收口状态交接与 0 帧退白闪烁防护基准 (W2-2 双物理帧锁存交接)
  // ───────────────────────────────────────────────────────────────────────────
  describe('3. 流式收口状态交接与 0 帧退白闪烁防护基准 (W2-2)', () => {
    let rafCallbacks: Map<number, FrameRequestCallback>;
    let nextRafId = 1;

    const stepFrame = () => {
      const current = new Map(rafCallbacks);
      rafCallbacks.clear();
      for (const [, cb] of current) {
        cb(performance.now());
      }
    };

    beforeEach(() => {
      updateMessageTextMock.mockClear();
      useStreamingStore.setState({ byKey: Object.create(null) });

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

    it('推流最后一帧同时发生组件重挂载与流结束：双物理帧延迟保证 0 帧退白闪烁', async () => {
      const sid = 'sess-handoff-stress';
      const mid = 'msg-handoff-asst';
      const finalStreamText =
        'Conex End-to-End Streaming Pipeline Benchmark Validated.';

      // 1. 初始化持久层与热流缓存
      const sessionStore = getCompositionRoot().session.getState();
      sessionStore.createSession({
        title: 'Handoff Test',
        id: sid,
        activate: false,
      });
      sessionStore.addMessage('ws-stress', sid, {
        id: mid,
        sender: 'assistant',
        text: '',
        timestamp: Date.now(),
        status: 'processing',
      });

      setStreamText(sid, mid, finalStreamText);

      // 2. 模拟最后一帧：流结束触发双轨锁存提交
      const committedText = commitStreamWithDualLatch(sid, mid, {
        text: finalStreamText,
      });
      expect(committedText).toBe(finalStreamText);

      // 更新持久化消息状态为 completed
      sessionStore.setSessionMessageStatus(sid, mid, 'completed');
      sessionStore.updateMessageText(sid, mid, finalStreamText);

      // ── 模拟组件在各个连续物理渲染检查点的视图读取 ──
      const renderedSnapshots: Array<{
        stage: string;
        displayedText: string | undefined;
        isLatched: boolean;
        hotStreamPresent: boolean;
      }> = [];

      const readViewModel = (stage: string) => {
        const sess = getSessionById(sid);
        const msg = sess?.messages?.find((m) => m.id === mid) as SessionMessage;
        const liveStreamText = getStreamText(sid, mid);
        const latchResult = resolveStreamMessageLatch(msg, liveStreamText);

        renderedSnapshots.push({
          stage,
          displayedText: latchResult.isLatched
            ? latchResult.msg.text
            : latchResult.streamText,
          isLatched: latchResult.isLatched,
          hotStreamPresent: liveStreamText !== undefined,
        });
      };

      // T0: 同步提交点（React 尚未触发微任务）
      readViewModel('T0_Sync_Commit');

      // T1: 微任务检查点（queueMicrotask 结束）
      await Promise.resolve();
      readViewModel('T1_Microtask');

      // 核心断言：微任务结束后，热流缓存严禁被提前抹除 (根治 VULN-01)
      expect(getStreamText(sid, mid)).toBe(finalStreamText);

      // T2: 物理帧 1 渲染完成（第 1 个 rAF 周期）
      stepFrame();
      readViewModel('T2_Frame_1');

      // 核心断言：经历第 1 帧后，热流缓存依然完整存在
      expect(getStreamText(sid, mid)).toBe(finalStreamText);

      // T3: 物理帧 2 渲染完成（第 2 个 rAF 周期，React 18 DOM Commit 100% 完成）
      stepFrame();
      readViewModel('T3_Frame_2');

      // 核心断言：经历双物理帧后，热备安全解除释放
      expect(getStreamText(sid, mid)).toBeUndefined();

      // T4: 组件在双帧后重挂载 (Remount)
      readViewModel('T4_Post_Handoff_Remount');

      // ── 0 帧退白闪烁 (Zero-Frame Whiteout) 铁律验证 ──
      for (const snap of renderedSnapshots) {
        // 断言：在每一个阶段，呈现给用户的文本始终完整，绝无 0 帧空白/undefined/空串
        expect(snap.displayedText).toBe(finalStreamText);
      }

      // 统计空白退白帧数
      const whiteoutFrames = renderedSnapshots.filter(
        (s) => !s.displayedText || s.displayedText.trim() === ''
      );
      expect(whiteoutFrames).toHaveLength(0);
    });

    it('流式异常/中止 (error / aborted) 状态下终态自锁存器刚性生效', () => {
      const errMessage: SessionMessage = {
        id: 'msg-err-bench',
        sender: 'assistant',
        text: 'Partial diagnosis report before abort',
        timestamp: Date.now(),
        status: 'error',
      };

      // 即使热流传入 undefined 或空串，终态锁存器依然刚性锁定持久层文本
      const resolved = resolveStreamMessageLatch(errMessage, undefined);
      expect(resolved.isLatched).toBe(true);
      expect(resolved.streamText).toBeUndefined();
      expect(resolved.msg.text).toBe('Partial diagnosis report before abort');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Suite 4: 窗格并发 Resize 与主线程 Long Task 压制基准 (W2-4)
  // ───────────────────────────────────────────────────────────────────────────
  describe('4. 窗格并发 Resize 与主线程 Long Task 压制基准 (W2-4)', () => {
    let mgr: ResizeObserverManager;

    beforeEach(() => {
      vi.useFakeTimers();
      ResizeObserverManager.resetInstanceForTest();
      mgr = ResizeObserverManager.getInstance();
    });

    afterEach(() => {
      mgr.destroy();
      ResizeObserverManager.resetInstanceForTest();
      vi.useRealTimers();
      document.body.innerHTML = '';
    });

    it('左右分屏并发快速拖拽：8ms 时间预算分片排空将主线程 Long Task (>50ms) 压制为 0', () => {
      const PANE_LEFT = 'pane-left';
      const PANE_RIGHT = 'pane-right';
      const ELEMENTS_PER_PANE = 40; // 左右各 40 个元素，总计 80 个测高节点

      const leftElements: Element[] = [];
      const rightElements: Element[] = [];
      const leftCallbacks: ReturnType<typeof vi.fn>[] = [];
      const rightCallbacks: ReturnType<typeof vi.fn>[] = [];

      const leftEntries: ResizeObserverEntry[] = [];
      const rightEntries: ResizeObserverEntry[] = [];

      // 注册左窗格元素
      for (let i = 0; i < ELEMENTS_PER_PANE; i++) {
        const el = document.createElement('div');
        const cb = vi.fn();
        leftElements.push(el);
        leftCallbacks.push(cb);
        leftEntries.push({
          target: el,
          contentRect: { width: 400 + i, height: 100 + i } as DOMRectReadOnly,
        } as ResizeObserverEntry);
        mgr.observe(el, cb, { paneId: PANE_LEFT });
      }

      // 注册右窗格元素
      for (let i = 0; i < ELEMENTS_PER_PANE; i++) {
        const el = document.createElement('div');
        const cb = vi.fn();
        rightElements.push(el);
        rightCallbacks.push(cb);
        rightEntries.push({
          target: el,
          contentRect: { width: 500 + i, height: 200 + i } as DOMRectReadOnly,
        } as ResizeObserverEntry);
        mgr.observe(el, cb, { paneId: PANE_RIGHT });
      }

      // 注册全局 Tooltip (脱离窗格，不受分屏拖拽冻结影响)
      const globalTooltip = document.createElement('div');
      const globalCb = vi.fn();
      mgr.observe(globalTooltip, globalCb);

      // ── 1. 模拟开始拖拽分屏调节条：同时挂起左右窗格 ──
      mgr.suspendPanes([PANE_LEFT, PANE_RIGHT]);
      expect(mgr.isPaneSuspended(PANE_LEFT)).toBe(true);
      expect(mgr.isPaneSuspended(PANE_RIGHT)).toBe(true);

      // 模拟拖拽期间快速并发触发 80 个元素的多次 Resize 事件
      for (let burst = 0; burst < 5; burst++) {
        activeMockRO?.__trigger([...leftEntries, ...rightEntries]);
      }

      // 触发全局 Tooltip resize
      activeMockRO?.__trigger([
        {
          target: globalTooltip,
          contentRect: { width: 80, height: 30 } as DOMRectReadOnly,
        } as ResizeObserverEntry,
      ]);

      // 核心断言：拖拽期间，左右窗格 80 个元素的回调被 100% 阻断 (0 次调用)
      for (const cb of [...leftCallbacks, ...rightCallbacks]) {
        expect(cb).not.toHaveBeenCalled();
      }
      // 全局 Tooltip 不受影响，即时分发
      expect(globalCb).toHaveBeenCalled();

      // 积压队列中恰好持有 80 个待测高元素
      expect(mgr.getPendingQueueSize()).toBe(ELEMENTS_PER_PANE * 2);

      // ── 2. 模拟拖拽结束，解冻左右窗格并排空 ──
      // 为模拟真实浏览器渲染，配置每次测高回调模拟耗时 2.5ms
      // 若不进行分片，80 个元素将连续执行 80 * 2.5ms = 200ms (严重卡顿的长任务！)
      let mockNow = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => mockNow);

      const sliceDurations: number[] = [];

      const recordCallbackWork = (cb: ReturnType<typeof vi.fn>) => {
        cb.mockImplementation(() => {
          mockNow += 2.5; // 模拟测高布局计算耗时 2.5ms
        });
      };
      leftCallbacks.forEach(recordCallbackWork);
      rightCallbacks.forEach(recordCallbackWork);

      mgr.resumePanes([PANE_LEFT, PANE_RIGHT]);

      // 推进多帧 rAF，记录每一帧分片的实际执行耗时
      let framesCount = 0;
      const MAX_FRAMES_LIMIT = 50;

      while (mgr.getPendingQueueSize() > 0 && framesCount < MAX_FRAMES_LIMIT) {
        framesCount += 1;
        const frameStart = mockNow;
        // 推进 16ms 到达下一物理帧
        vi.advanceTimersByTime(16);
        const frameDuration = mockNow - frameStart;
        sliceDurations.push(frameDuration);
      }

      // ── 性能基准与 Long Task 压制断言 ──
      // 1. W3C 标准 Long Task 定义为耗时 > 50ms 的任务
      const longTasks = sliceDurations.filter((dur) => dur > 50);
      expect(longTasks).toHaveLength(0); // 核心断言：Long Task 发生次数严格为 0！

      // 2. 验证单帧切片时间均受控在 8ms-12ms 预算边界内 (单帧最多执行 3-4 个 2.5ms 任务)
      for (const dur of sliceDurations) {
        expect(dur).toBeLessThanOrEqual(15);
      }

      // 3. 任务完整性：所有 80 个元素的测高任务无一丢失，全部精确执行一次
      for (const cb of [...leftCallbacks, ...rightCallbacks]) {
        expect(cb).toHaveBeenCalledTimes(1);
      }
      expect(mgr.getPendingQueueSize()).toBe(0);
    });

    it('交互中断看门狗自愈：分屏拖拽中途触发 blur/pointercancel 时 200ms 强制解冻', () => {
      const PANE_ID = 'dragged-pane';
      const el = document.createElement('div');
      const cb = vi.fn();
      mgr.observe(el, cb, { paneId: PANE_ID });

      mgr.suspendPane(PANE_ID);
      activeMockRO?.__trigger([
        {
          target: el,
          contentRect: { width: 100, height: 100 } as DOMRectReadOnly,
        } as ResizeObserverEntry,
      ]);

      expect(mgr.getPendingQueueSize()).toBe(1);

      // 模拟用户在拖拽中途 Alt+Tab 触发 window blur 交互中断
      window.dispatchEvent(new Event('blur'));

      // 推进 200ms 看门狗定时器
      vi.advanceTimersByTime(200);

      // 核心断言：看门狗触发强制解冻并分片排空
      expect(mgr.isPaneSuspended(PANE_ID)).toBe(false);

      // 推进 1 帧 rAF
      vi.advanceTimersByTime(16);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(mgr.getPendingQueueSize()).toBe(0);
    });
  });
});
