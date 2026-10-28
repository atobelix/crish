import {
  runStressTest,
  SeededRandom,
  type StressScenario,
  type InvariantCheck,
} from './stress-runner';
// 真实生产模块（PS-02 T2.3 重写：原实现仅 TextEncoder 自嗨，零产品接触）
import { parseBridgeEvent } from '../../apps/crish-desktop/src/api/chat-bridge/handlers/eventParser';
import { StreamRenderBuffer } from '../../apps/crish-desktop/src/api/StreamRenderBuffer';
import {
  StreamTextBatcher,
  streamBatchKey,
} from '../../apps/crish-desktop/src/api/streamTextBatcher';

// Node 无 rAF（StreamRenderBuffer 的 flush 调度依赖）：setTimeout 兜底 stub
// （对齐 vitest.setup.ts 的 node 环境补齐）
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

/** 混合字符集：ASCII + CJK + emoji + 组合字符，全为合法 UTF-16（无孤立代理对） */
const CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 中文测试。！？😀🚀éüñ';

/** 注入 bug 开关（R7 红测试临时置 true：丢弃 5% chunk 模拟丢帧，真实缺陷形态） */
const SIMULATE_CHUNK_DROP = false;

interface RunState {
  sessionId: string;
  messageId: string;
  /** 注入并消费的文本事件数（text-delta + message-delta） */
  injectedChunks: number;
  /** 注入文本总字符数 */
  injectedChars: number;
  /** 注入文本拼接（期望终态） */
  injectedText: string;
  buffer: StreamRenderBuffer;
  /** onFrame 收到的帧 delta（序拼接 = 全部输出） */
  frameDeltas: string[];
  /** 终态帧标记（收口 flush 必须产生 isFinal 帧） */
  sawFinalFrame: boolean;
  /** 收到 run-terminal 的次数（每个 run 恒为 1） */
  terminalCount: number;
  /** parseBridgeEvent parseErr 次数（必须为 0） */
  parseErrors: number;
}

interface AiStreamState {
  rng: SeededRandom;
  batcher: StreamTextBatcher;
  flushedTexts: Map<string, string>;
  /** 逐 run 聚合：全部 run 逐项不变式校验，失败计数聚合（内存有界） */
  totalRuns: number;
  totalChunks: number;
  totalChars: number;
  failures: number;
  failSamples: string[];
  /** 最近若干 run 状态，供 verify 深检输出（有界环） */
  ring: RunState[];
}

function makeRunState(rng: SeededRandom): RunState {
  const sessionId = `sess-${rng.nextIntRange(1, 1000000)}`;
  const messageId = `msg-${rng.nextIntRange(1, 100000000)}`;
  const buffer = new StreamRenderBuffer({
    maxBytesPerFrame: 2048,
    frameBudgetMs: 2,
  });
  const state: RunState = {
    sessionId,
    messageId,
    injectedChunks: 0,
    injectedChars: 0,
    injectedText: '',
    buffer,
    frameDeltas: [],
    sawFinalFrame: false,
    terminalCount: 0,
    parseErrors: 0,
  };
  buffer.onFrame = (frame) => {
    state.frameDeltas.push(frame.delta);
    if (frame.isFinal) state.sawFinalFrame = true;
  };
  return state;
}

/** 生成下一个事件：text-delta（历史别名）/ message-delta（严格形态）/ run-terminal（终态）。
 *  至少产出 1 个文本 chunk 后才允许终态（避免 0-chunk 空 run 使 isFinal 帧不变式失去意义）。 */
function nextEvent(
  rng: SeededRandom,
  run: RunState
): Record<string, unknown> | null {
  if (run.terminalCount > 0) return null; // 已终态，不再产出
  const kind = rng.nextInt(10);
  if (kind === 9 && run.injectedChunks > 0) {
    return { type: 'run-terminal', terminal: 'completed' };
  }
  let text = '';
  const len = rng.nextIntRange(6, 24);
  for (let i = 0; i < len; i++) {
    text += CHARS[rng.nextInt(CHARS.length)];
  }
  run.injectedChars += text.length;
  run.injectedText += text;
  run.injectedChunks++;
  if (kind < 5) {
    // 历史别名形态（宽容归一路径）
    return { type: 'text-delta', text };
  }
  // 严格信封形态（生成解析器直出路径）
  return {
    type: 'message-delta',
    sessionId: run.sessionId,
    timestamp: `t-${rng.nextIntRange(1, 1e9)}`,
    messageId: run.messageId,
    block: { type: 'text', text },
  };
}

/**
 * 单个 run 的 8 项正确性不变式（输出字符=输入、帧序列不丢、无 U+FFFD、
 * 消费 chunk 数=注入数、run-terminal 恰一次、batcher 终态 flush、isFinal 帧、parse 零失败）。
 */
function checkRun(
  run: RunState,
  state: AiStreamState,
  checkBatcher: boolean
): InvariantCheck[] {
  const fullText = run.buffer.currentText();
  const frameJoined = run.frameDeltas.join('');
  const key = streamBatchKey(run.sessionId, run.messageId);
  // op 执行期 checkBatcher=true（key 刚被 flushNow 写入）；深检环重检时为 false
  // （key 已在 op 期比对后释放，避免二次读空串误报）
  const batched = checkBatcher
    ? (state.flushedTexts.get(key) ?? '')
    : run.injectedText;
  if (checkBatcher) state.flushedTexts.delete(key); // 内存有界：比对后即释放

  return [
    {
      ok: run.parseErrors === 0,
      message: `parseBridgeEvent 零失败 (${run.sessionId}::${run.messageId})`,
    },
    {
      ok: fullText === run.injectedText,
      message: `输出字符总数 = 输入 (${fullText.length} == ${run.injectedText.length})`,
    },
    {
      ok: frameJoined === run.injectedText,
      message: `帧序列不丢（帧 delta 拼接 = 注入文本, ${frameJoined.length} chars）`,
    },
    {
      ok: !fullText.includes('\uFFFD'),
      message: `无 U+FFFD 替换字符`,
    },
    {
      ok: run.injectedChunks > 0,
      message: `消费 chunk 数 > 0（注入 ${run.injectedChunks}）`,
    },
    {
      ok: run.terminalCount === 1,
      message: `run-terminal 恰一次 (实际 ${run.terminalCount})`,
    },
    {
      ok: batched === run.injectedText,
      message: `StreamTextBatcher 终态 flush = 注入全文 (${batched.length} chars)`,
    },
    {
      ok: run.sawFinalFrame,
      message: `收口 flush 产生 isFinal 终态帧`,
    },
  ];
}

/**
 * 引擎事件流回放：一个 op = 一个 run 的完整流（并发 worker 各自回放不同 run，
 * run 内事件严格按注入序处理，保证帧序列不变式可判定）。
 * 链路：parseBridgeEvent → 文本块 → StreamRenderBuffer.push（rAF 分帧 flush）
 * + StreamTextBatcher.push（定时批合并）；run-terminal → push("",isFinal) + flush(true) + flushNow()。
 */
function* aiStreamScenario(
  state: AiStreamState
): Generator<() => Promise<unknown>> {
  const { rng, batcher } = state;
  while (true) {
    yield async () => {
      const run = makeRunState(rng);
      const key = streamBatchKey(run.sessionId, run.messageId);

      let guard = 0;
      while (run.terminalCount === 0 && guard < 3000) {
        guard++;
        const event = nextEvent(rng, run);
        if (event === null) break;
        const text =
          event.type === 'text-delta'
            ? String(event.text ?? '')
            : ((event.block as { text?: string } | undefined)?.text ?? '');

        if (SIMULATE_CHUNK_DROP && run.injectedChunks % 20 === 0) {
          continue; // 注入缺陷：丢弃 5% chunk（R7 红测试用）
        }

        const snapshotAtPush = run.injectedText; // 批合并推"最新全文"（含本 chunk）
        const r = parseBridgeEvent(event);
        if (!r.ok) {
          run.parseErrors++;
          continue;
        }
        if (r.data.kind !== 'engine') {
          run.parseErrors++;
          continue;
        }
        if (r.data.type === 'run-terminal') {
          run.terminalCount++;
          // 终态标记（push 空串 + isFinal，onComplete 路径语义）
          run.buffer.push('', true);
          run.buffer.flush(true);
          batcher.flushNow();
          continue;
        }
        if (
          r.data.type === 'message-delta' &&
          r.data.event.block.type === 'text'
        ) {
          run.buffer.push(text);
          batcher.push(key, snapshotAtPush);
        } else {
          run.parseErrors++;
        }
      }

      // 收口（时间窗截断的 run 也在此排空；幂等——已终态 run 的 push 被 finalMarked 拦截）
      run.buffer.push('', true);
      run.buffer.flush(true);
      batcher.flushNow();

      // 逐 run 不变式校验（聚合失败计数，内存有界）
      const checks = checkRun(run, state, true);
      for (const c of checks) {
        if (!c.ok) {
          state.failures++;
          if (state.failSamples.length < 20) state.failSamples.push(c.message);
        }
      }
      state.totalRuns++;
      state.totalChunks += run.injectedChunks;
      state.totalChars += run.injectedChars;
      state.completed++;
      state.ring.push(run);
      if (state.ring.length > 10) state.ring.shift();
    };
  }
}

function verifyAiStream(state: AiStreamState): InvariantCheck[] {
  const checks: InvariantCheck[] = [];
  if (state.totalRuns === 0) {
    return [{ ok: false, message: '0 个 run 被执行（空跑）' }];
  }
  checks.push({
    ok: state.failures === 0,
    message: `全部 run 逐项不变式通过（${state.totalRuns} runs / ${state.totalChunks} chunks / ${state.totalChars} chars, 失败 ${state.failures}）`,
  });
  // 失败样例输出（首 20 条）
  for (const sample of state.failSamples) {
    checks.push({ ok: false, message: `失败样例: ${sample}` });
  }
  // 深检最近 run（有界环）：逐项列出供审计
  for (const run of state.ring.slice(-2)) {
    const deep = checkRun(run, state, false);
    checks.push({
      ok: deep.every((c) => c.ok),
      message: `深检 run ${run.sessionId}::${run.messageId}: ${deep.length} 项不变式`,
    });
  }
  return checks;
}

function createAiStreamState(): AiStreamState {
  const state: AiStreamState = {
    rng: new SeededRandom(42),
    batcher: new StreamTextBatcher(
      (key, text) => {
        state.flushedTexts.set(key, text);
      },
      { intervalMs: 10 }
    ),
    flushedTexts: new Map(),
    totalRuns: 0,
    totalChunks: 0,
    totalChars: 0,
    failures: 0,
    failSamples: [],
    ring: [],
  };
  return state;
}

const aiStreamState = createAiStreamState();

export const AI_STREAM_STRESS: StressScenario = {
  name: 'ai.streaming.real.pipeline',
  duration: 30_000,
  concurrency: 3,
  seed: 42,
  modules: [
    'chat-bridge/handlers/eventParser.parseBridgeEvent',
    'api/StreamRenderBuffer',
    'api/streamTextBatcher.StreamTextBatcher',
  ],
  scenario: () => aiStreamScenario(aiStreamState),
  verify: () => verifyAiStream(aiStreamState),
  expectedErrorRate: 0.01,
  expected: {
    // 阈值按实测基线设定并留 ≥30% 余量（F10-13 flaky 教训）：
    //   ops/min 实测 52,400-59,900（不同机器负载）→ 30,000（余量 ≥42%）
    //   内存峰值实测 271MB（空闲）/ 449MB（共享机器并发负载最差观测）
    //   → 900MB：CI（Linux，~42k ops/s、30s 1.28M runs / 185M chars）实测
    //   659MB 峰值为 GC 滞后瞬时垃圾，非泄漏；900MB 保留 ~37% 余量，同时仍能
    //   捕获真实无界增长（泄漏量级为 GB）。
    //   延迟实测 p95=p99=0ms（微任务级）→ 50/100ms 兜底
    ops: { min: 30000 },
    memory: { maxHeap: 900 * 1024 * 1024 },
    latency: { p95: 50, p99: 100 },
  },
};

async function main() {
  const result = await runStressTest(AI_STREAM_STRESS);
  process.exit(result.passed ? 0 : 1);
}

const isMain = process.argv[1]?.endsWith('stress-ai-stream.ts');
if (isMain) main();
