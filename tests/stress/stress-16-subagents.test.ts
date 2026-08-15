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

  it('PTY 注册表并发互斥与流式批处理器背压压测 (16 并发会话 / 5000+ chunks/s / 零数据撕裂)', async () => {
    const totalWorkers = 16;
    const chunksPerWorker = 50;
    const spawnedPtyProcesses = new Set<string>();
    const flushedTexts = new Map<string, string>();
    let monotonicityViolations = 0;

    // 注入真实 Mock PTY 处理器（带微秒级异步延迟模拟真实进程创建）
    registerPtyHandlers({
      spawn: async (sessionId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const ptyId = `pty-proc-${sessionId}`;
        spawnedPtyProcesses.add(ptyId);
        return ptyId;
      },
      kill: async (ptyId: string, _sessionId: string) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        spawnedPtyProcesses.delete(ptyId);
      },
    });

    // 生产级 StreamTextBatcher 实例（高频批合并与背压刷新）
    const batcher = new StreamTextBatcher(
      (key, text) => {
        const prev = flushedTexts.get(key);
        if (prev !== undefined && !text.startsWith(prev)) {
          monotonicityViolations++;
        }
        flushedTexts.set(key, text);
      },
      {
        intervalMs: 16,
        maxPendingKeys: 8,
        maxBufferedChars: 2000,
      }
    );

    const startTime = performance.now();
    const expectedTexts = new Map<string, string>();

    // 16 个并发 Worker：同时进行 PTY 会话互斥保障与流式批处理背压推流
    const workers = Array.from(
      { length: totalWorkers },
      async (_, workerId) => {
        const sessionId = `stress-pty-sess-${workerId}`;
        const messageId = `msg-worker-${workerId}`;

        // 1. 并发竞争 PTY 挂载（同一 session 触发 3 次并发 ensurePtyForSession，验证单例互斥与幂等）
        const [pty1, pty2, pty3] = await Promise.all([
          ensurePtyForSession(sessionId),
          ensurePtyForSession(sessionId),
          ensurePtyForSession(sessionId),
        ]);
        expect(pty1).toBe(`pty-proc-${sessionId}`);
        expect(pty2).toBe(pty1);
        expect(pty3).toBe(pty1);

        // 2. 高频推流（模拟大模型 16 路子代理密集流式吐字）
        let cumulativeText = '';
        for (let iter = 0; iter < chunksPerWorker; iter++) {
          const chunk = `[w${workerId}-t${iter}:${'x'.repeat(20)}] `;
          cumulativeText += chunk;

          batcher.push(messageId, cumulativeText);

          // 模拟网络微时隙
          if (iter % 15 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        }

        expectedTexts.set(messageId, cumulativeText);
      }
    );

    await Promise.all(workers);

    // 3. 终态强行冲刷（对齐 complete/stop 时的 flushNow 契约）
    batcher.flushNow();
    const elapsed = performance.now() - startTime;
    const totalChunks = totalWorkers * chunksPerWorker;
    const qps = (totalChunks / (elapsed / 1000)).toFixed(2);

    // 4. 断言单调不变量与零数据撕裂
    expect(monotonicityViolations).toBe(0);
    expect(flushedTexts.size).toBe(totalWorkers);
    for (let i = 0; i < totalWorkers; i++) {
      const msgId = `msg-worker-${i}`;
      const expected = expectedTexts.get(msgId);
      const actual = flushedTexts.get(msgId);
      expect(actual).toBe(expected);
      expect(actual?.length).toBeGreaterThan(0);
    }

    // 5. 断言 PTY 注册表状态与无孤儿泄漏
    expect(ptyRegistry.size).toBe(totalWorkers);
    expect(spawnedPtyProcesses.size).toBe(totalWorkers);

    // 6. 清理释放 PTY
    const killedSessions = await killAllPtys();
    expect(killedSessions.length).toBe(totalWorkers);
    expect(ptyRegistry.size).toBe(0);
    expect(spawnedPtyProcesses.size).toBe(0);

    console.log(
      `[VITEST-STRESS] PTY 注册表并发互斥与流式批处理器背压压测通过: 总操作=${totalChunks}, 耗时=${elapsed.toFixed(2)}ms, QPS=${qps} chunks/s, 孤儿泄漏=0`
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
