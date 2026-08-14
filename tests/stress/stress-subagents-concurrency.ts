import {
  runStressTest,
  SeededRandom,
  type StressScenario,
  type InvariantCheck,
} from './stress-runner';
import { parseBridgeEvent } from '../../apps/crish-desktop/src/api/chat-bridge/handlers/eventParser';
import { StreamRenderBuffer } from '../../apps/crish-desktop/src/api/StreamRenderBuffer';
import { StreamTextBatcher } from '../../apps/crish-desktop/src/api/streamTextBatcher';
import {
  registerPtyHandlers,
  ensurePtyForSession,
  killAllPtys,
} from '../../apps/crish-desktop/src/api/ptyRegistry';

// Node 环境 rAF stub
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

interface SubagentsConcurrencyState {
  rng: SeededRandom;
  totalSubagentRuns: number;
  totalChunks: number;
  totalPtysSpawned: number;
  totalPtysKilled: number;
  failures: number;
  failSamples: string[];
  activePtys: Set<string>;
}

function createSubagentsConcurrencyState(): SubagentsConcurrencyState {
  return {
    rng: new SeededRandom(1337),
    totalSubagentRuns: 0,
    totalChunks: 0,
    totalPtysSpawned: 0,
    totalPtysKilled: 0,
    failures: 0,
    failSamples: [],
    activePtys: new Set(),
  };
}

const state = createSubagentsConcurrencyState();

// 初始化 PTY handlers
registerPtyHandlers({
  spawn: async (sessionId: string) => {
    const ptyId = `pty-${sessionId}`;
    state.activePtys.add(ptyId);
    state.totalPtysSpawned++;
    return ptyId;
  },
  kill: async (ptyId: string) => {
    state.activePtys.delete(ptyId);
    state.totalPtysKilled++;
  },
});

async function* subagentsConcurrencyScenario(
  s: SubagentsConcurrencyState
): AsyncGenerator<() => Promise<void>> {
  let globalRunCounter = 0;

  while (true) {
    const runId = ++globalRunCounter;
    yield async () => {
      const workerId = s.rng.nextInt(16);
      const sessionId = `stress-sess-${workerId}-${runId}`;
      const messageId = `msg-${workerId}-${runId}`;
      const chunkCount = s.rng.nextIntRange(10, 30);

      const deltas: string[] = [];
      const buffer = new StreamRenderBuffer();
      buffer.onFrame = (frame) => {
        deltas.push(frame.delta);
      };

      const batcher = new StreamTextBatcher((_k, _v) => {});

      let expected = '';
      let parseErrors = 0;

      // 1. 确保并分配 PTY
      await ensurePtyForSession(sessionId);

      // 2. 注入多块事件流
      for (let i = 0; i < chunkCount; i++) {
        const text = s.rng.nextString(16) + ' ';
        expected += text;

        const rawEnvelope = {
          type: 'message_delta',
          session_id: sessionId,
          message_id: messageId,
          delta: text,
          sequence: i + 1,
        };

        const parsed = parseBridgeEvent(rawEnvelope);
        if (parsed.parseErr) {
          parseErrors++;
        }

        buffer.push(text);
        batcher.push(messageId, text);
      }

      buffer.push('', true);
      buffer.flush(true);
      batcher.flushNow();

      const reconstructed = deltas.join('');
      const match = reconstructed === expected;
      if (!match || parseErrors > 0) {
        s.failures++;
        if (s.failSamples.length < 10) {
          s.failSamples.push(
            `Run ${sessionId}: match=${match}, parseErrors=${parseErrors}`
          );
        }
      }

      // 3. 模拟周期性一键终止 / 正常释放
      if (runId % 10 === 0) {
        await killAllPtys();
      }

      buffer.reset();
      s.totalSubagentRuns++;
      s.totalChunks += chunkCount;
    };
  }
}

function verifySubagentsConcurrency(
  s: SubagentsConcurrencyState
): InvariantCheck[] {
  const checks: InvariantCheck[] = [];

  checks.push({
    ok: s.totalSubagentRuns > 0,
    message: `成功驱动 ${s.totalSubagentRuns} 个子 Agent 运行周期 (共 ${s.totalChunks} chunks)`,
  });

  checks.push({
    ok: s.failures === 0,
    message: `16 子 Agent 并发事件流 100% 聚合完整且 0 解析错误 (失败: ${s.failures})`,
  });

  for (const sample of s.failSamples) {
    checks.push({ ok: false, message: `失败详情: ${sample}` });
  }

  return checks;
}

export const SUBAGENTS_CONCURRENCY_STRESS: StressScenario = {
  name: 'subagents.16.concurrency.and.killall',
  duration: 5_000,
  concurrency: 16,
  seed: 1337,
  modules: [
    'chat-bridge/handlers/eventParser.parseBridgeEvent',
    'api/StreamRenderBuffer',
    'api/streamTextBatcher.StreamTextBatcher',
    'api/ptyRegistry',
  ],
  scenario: () => subagentsConcurrencyScenario(state),
  verify: () => verifySubagentsConcurrency(state),
  expectedErrorRate: 0.01,
  expected: {
    ops: { min: 50 },
    memory: { maxHeap: 500 * 1024 * 1024 },
    latency: { p95: 50, p99: 100 },
  },
};

async function main() {
  const result = await runStressTest(SUBAGENTS_CONCURRENCY_STRESS);
  process.exit(result.passed ? 0 : 1);
}

const isMain = process.argv[1]?.endsWith('stress-subagents-concurrency.ts');
if (isMain) main();
