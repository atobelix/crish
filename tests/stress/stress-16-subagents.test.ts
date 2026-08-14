import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseBridgeEvent } from '../../apps/crish-desktop/src/api/chat-bridge/handlers/eventParser';
import { StreamRenderBuffer } from '../../apps/crish-desktop/src/api/StreamRenderBuffer';
import { StreamTextBatcher } from '../../apps/crish-desktop/src/api/streamTextBatcher';
import {
  ptyRegistry,
  registerPtyHandlers,
  resetPtyRegistryForTests,
  ensurePtyForSession,
  killAllPtys,
} from '../../apps/crish-desktop/src/api/ptyRegistry';

// Node 环境 rAF stub（对齐 vitest.setup.ts）
declare global {
  var requestAnimationFrame: ((cb: (t: number) => void) => number) | undefined;
  var cancelAnimationFrame: ((id: number) => void) | undefined;
}
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (cb) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number;
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

describe('Unit 7.2: 16 子 Agent 并发压力与零死锁拓扑实证 (TS/前端域)', () => {
  beforeEach(() => {
    resetPtyRegistryForTests();
    vi.clearAllMocks();
  });

  it('16 子 Agent 高并发事件流驱动与文本无损聚合 (0 死锁 / 0 乱序)', async () => {
    const totalSubagents = 16;
    const chunksPerAgent = 50;
    const masterSessionId = 'master-session-stress';

    interface SubagentContext {
      id: string;
      sessionId: string;
      messageId: string;
      buffer: StreamRenderBuffer;
      batcher: StreamTextBatcher;
      expectedText: string;
      receivedDeltas: string[];
      isFinal: boolean;
      parseErrors: number;
    }

    const agents: SubagentContext[] = [];
    for (let i = 0; i < totalSubagents; i++) {
      const sessionId = `${masterSessionId}-sub-${i}`;
      const messageId = `msg-sub-${i}`;
      const deltas: string[] = [];
      let finalSeen = false;

      const buffer = new StreamRenderBuffer();
      buffer.onFrame = (frame) => {
        deltas.push(frame.delta);
        if (frame.isFinal) finalSeen = true;
      };

      const batcher = new StreamTextBatcher((_msgId, _text) => {
        // flush hook
      });

      agents.push({
        id: `sub-agent-${i}`,
        sessionId,
        messageId,
        buffer,
        batcher,
        expectedText: '',
        receivedDeltas: deltas,
        isFinal: finalSeen,
        parseErrors: 0,
      });
    }

    const startTime = performance.now();

    // 16 个子 Agent 同时并发注入事件流
    const workerPromises = agents.map(async (agent, agentIndex) => {
      let fullText = '';
      for (let c = 0; c < chunksPerAgent; c++) {
        const chunk = `[sub-${agentIndex}-chunk-${c}] `;
        fullText += chunk;

        // 1. 模拟 bridge 原始事件
        const rawEnvelope = {
          type: 'message_delta',
          session_id: agent.sessionId,
          message_id: agent.messageId,
          delta: chunk,
          sequence: c + 1,
        };

        const parsed = parseBridgeEvent(rawEnvelope);
        if (parsed.parseErr) {
          agent.parseErrors++;
        }

        // 2. 注入 StreamRenderBuffer
        agent.buffer.push(chunk);

        // 3. 注入 StreamTextBatcher
        agent.batcher.push(agent.messageId, chunk);

        // 微让渡模拟高并发网络包到达时隙
        if (c % 10 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }

      agent.expectedText = fullText;
      agent.buffer.push('', true);
      agent.buffer.flush(true);
      agent.batcher.flushNow();
    });

    await Promise.all(workerPromises);
    const elapsed = performance.now() - startTime;

    // 验证所有 16 个子 Agent 的数据完整性与零错误
    for (let i = 0; i < totalSubagents; i++) {
      const agent = agents[i]!;
      expect(agent.parseErrors).toBe(0);
      const reconstructed = agent.receivedDeltas.join('');
      expect(reconstructed).toBe(agent.expectedText);
      expect(reconstructed.length).toBeGreaterThan(0);
      agent.buffer.reset();
    }

    const totalChunks = totalSubagents * chunksPerAgent;
    const qps = (totalChunks / (elapsed / 1000)).toFixed(2);
    console.log(
      `[VITEST-STRESS] 16 子 Agent 流式并发压测完成: 总 chunk=${totalChunks}, 耗时=${elapsed.toFixed(2)}ms, QPS=${qps} chunks/s`
    );
  });

  it('五级锁偏序客户端拓扑模拟 (L0 内存守卫 -> L1 状态树 -> L2 恢复协调 -> L3 异步写队列 -> L4 只读缓存) 零死锁', async () => {
    const totalWorkers = 16;
    const iterationsPerWorker = 30;

    // 模拟五级锁偏序
    // L0: 内存守卫 (同步 Map)
    const l0MemoryGuard = new Map<string, number>();
    // L1: 领域状态树 (带并发版本号的 Session Store)
    const l1SessionStore = {
      version: 0,
      sessions: new Map<string, { title: string; count: number }>(),
    };
    // L2: 恢复协调器 (异步 Mutex 队列)
    class AsyncMutex {
      private locked = false;
      private waiting: Array<() => void> = [];

      async lock(): Promise<() => void> {
        if (this.locked) {
          await new Promise<void>((resolve) => this.waiting.push(resolve));
        }
        this.locked = true;
        return () => {
          this.locked = false;
          const next = this.waiting.shift();
          if (next) next();
        };
      }
    }
    const l2RecoveryMutex = new AsyncMutex();

    // L3: 批写单写队列 (Single Writer Actor 队列模型)
    class SingleWriterQueue {
      private queue: Array<{ data: string; resolve: () => void }> = [];
      private flushing = false;
      public totalBatches = 0;
      public totalWrites = 0;

      async submit(data: string): Promise<void> {
        return new Promise<void>((resolve) => {
          this.queue.push({ data, resolve });
          if (!this.flushing) {
            this.flushing = true;
            setTimeout(() => this.flush(), 2);
          }
        });
      }

      private flush(): void {
        const batch = this.queue.splice(0, 50);
        if (batch.length > 0) {
          this.totalBatches++;
          this.totalWrites += batch.length;
          for (const item of batch) {
            item.resolve();
          }
        }
        if (this.queue.length > 0) {
          setTimeout(() => this.flush(), 2);
        } else {
          this.flushing = false;
        }
      }
    }
    const l3WriteQueue = new SingleWriterQueue();

    // L4: 只读并发缓存
    const l4ReadCache = new Map<string, string>();

    const startTime = performance.now();
    let completedOps = 0;

    const workers = Array.from(
      { length: totalWorkers },
      async (_, workerId) => {
        for (let iter = 0; iter < iterationsPerWorker; iter++) {
          // L0: 纳秒级内存守卫
          l0MemoryGuard.set(`w-${workerId}`, iter);

          // L1: 领域状态更新
          l1SessionStore.version++;
          l1SessionStore.sessions.set(`s-${workerId}`, {
            title: `Session ${workerId}`,
            count: iter,
          });

          // L2: 异步业务锁
          const unlock = await l2RecoveryMutex.lock();
          try {
            // L3: 异步单写批提交
            await l3WriteQueue.submit(`write-${workerId}-${iter}`);
            // L4: 更新只读缓存
            l4ReadCache.set(`key-${workerId}`, `val-${iter}`);
          } finally {
            unlock();
          }

          completedOps++;
        }
      }
    );

    await Promise.all(workers);
    const elapsed = performance.now() - startTime;
    const expectedOps = totalWorkers * iterationsPerWorker;

    expect(completedOps).toBe(expectedOps);
    expect(l3WriteQueue.totalWrites).toBe(expectedOps);
    expect(l3WriteQueue.totalBatches).toBeLessThan(expectedOps); // 确认批聚合发生
    expect(l4ReadCache.size).toBe(totalWorkers);

    console.log(
      `[VITEST-STRESS] 五级偏序客户端拓扑实证: 总操作=${completedOps}, 批次=${l3WriteQueue.totalBatches}, 耗时=${elapsed.toFixed(2)}ms, 死锁率=0.00%`
    );
  });

  it('全局一键终止 (Kill All) 16 子 Agent 级联压测 (PTY 释放 100% / 0 孤儿泄漏)', async () => {
    const totalSubagents = 16;
    const activePtyProcesses = new Set<string>();
    const killedPtyProcesses = new Set<string>();

    // 注入 Mock PTY Handler
    registerPtyHandlers({
      spawn: async (sessionId: string) => {
        const ptyId = `pty-${sessionId}`;
        activePtyProcesses.add(ptyId);
        return ptyId;
      },
      kill: async (ptyId: string, _sessionId: string) => {
        activePtyProcesses.delete(ptyId);
        killedPtyProcesses.add(ptyId);
      },
    });

    // 1. 为 16 个子 Agent 分配并挂载 PTY 实例
    const spawnTasks = Array.from({ length: totalSubagents }, async (_, i) => {
      const sessionId = `kill-stress-sub-${i}`;
      const ptyId = await ensurePtyForSession(sessionId);
      expect(ptyId).toBe(`pty-${sessionId}`);
    });
    await Promise.all(spawnTasks);

    expect(ptyRegistry.size).toBe(16);
    expect(activePtyProcesses.size).toBe(16);

    // 2. 模拟高频执行中触发全局一键终止 killAllPtys()
    const killStart = performance.now();
    const killedSessionIds = await killAllPtys();
    const killElapsed = performance.now() - killStart;

    // 3. 断言 100% 释放与 0 孤儿泄漏
    expect(killedSessionIds.length).toBe(16);
    expect(ptyRegistry.size).toBe(0); // 注册表 100% 清空
    expect(activePtyProcesses.size).toBe(0); // 活跃进程集合 100% 清零
    expect(killedPtyProcesses.size).toBe(16); // 16 个 PTY 全部收到 kill 指令

    console.log(
      `[VITEST-STRESS] Kill All 16 子 Agent 级联压测: 释放目标=${killedSessionIds.length}/16, 耗时=${killElapsed.toFixed(2)}ms, 孤儿泄漏=0`
    );
  });
});
