/**
 * 前端渲染管线 L2 bench（08-detail 6.2，T5.1，R-14 缺口）。
 *
 * 与 shared-utils bench 同格式输出（{ name, avgMs, ops, p95Ms }，
 * 对齐 scripts/compare-benchmarks.ts BaselineEntry），可直接被
 * compare-benchmarks 消费（threshold 0.2 回归口径）。
 *
 * 场景（对齐 07 方案 4.1 的 L2 覆盖）：
 * 1. buffer.flushFrame     —— StreamRenderBuffer 单帧预算吞吐（8192B，100KB 输入）
 * 2. batcher.merge         —— StreamTextBatcher 批量合并
 * 3. vsm.rebuildOffsets    —— VirtualScrollManager offset 重建（1500 行）
 * 4. stripper.perFrame     —— IncrementalThoughtStripper.next 单帧增量 vs 全量 strip
 * 5. timeline.cachedHit    —— buildAssistantTimelineCached 签名命中 vs 未命中
 *
 * 运行：
 *   npx tsx apps/crish-desktop/perf/run-frontend-bench.ts [--output <path>]
 * 默认输出 tests/perf/baselines/desktop-frontend.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface BaselineEntry {
  name: string;
  avgMs: number;
  ops: number;
  p95Ms: number;
}

function measure(
  name: string,
  fn: () => void,
  iterations: number,
  warmup = 3
): BaselineEntry {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p95Ms =
    samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1]!;
  return { name, avgMs, ops: iterations, p95Ms };
}

function parseArgs(): { output?: string } {
  const args = process.argv.slice(2);
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && i + 1 < args.length) {
      output = args[i + 1];
      i++;
    } else if (args[i] === '--help') {
      console.log(
        '用法: npx tsx apps/crish-desktop/perf/run-frontend-bench.ts [--output <path>]'
      );
      process.exit(0);
    }
  }
  return { output };
}

/** 100KB 级流式文本（中文 + markdown + 周期占位行） */
function buildBigText(targetBytes = 100 * 1024): string {
  const pool = [
    '正在思考中…\n',
    '## 本轮总结\n',
    '完成了第一阶段的实现，接下来检查边界条件。\n',
    '- 修复了流式渲染的帧预算问题\n- 补充了对拍测试\n',
    '```ts\nconst budget = 8192;\n```\n',
    '正在处理…\n',
    '## 本回合小结：\n',
    '跨帧边界的占位行与总结标题需要被剥离。\n',
  ];
  const chunks: string[] = [];
  let total = 0;
  let i = 0;
  while (total < targetBytes) {
    const line = pool[i % pool.length]!;
    chunks.push(line);
    total += line.length;
    i++;
  }
  return chunks.join('');
}

/** 20 工具 + 100KB 正文助手消息 */
function buildToolRichMessage(text: string): unknown {
  const toolCalls = Array.from({ length: 20 }, (_, i) => ({
    id: `tool-${i}`,
    name: i % 2 === 0 ? 'run_command' : 'read_file',
    arguments: JSON.stringify({ cmd: `echo step-${i}` }),
    explanation: `执行第 ${i} 步`,
    status: i % 3 === 0 ? 'success' : i % 3 === 1 ? 'error' : 'running',
    output: `第 ${i} 步输出（长度 ${800 - i * 10} 字符）` + 'x'.repeat(400),
  }));
  return {
    id: 'asst-perf-1',
    sender: 'assistant',
    timestamp: Date.now(),
    status: 'processing',
    text,
    thinking: '',
    toolCalls,
    blocks: [
      ...toolCalls.map((t) => ({ type: 'tool_call', id: t.id })),
      { type: 'text', content: text },
    ],
  };
}

async function main(): Promise<void> {
  const { output } = parseArgs();
  const outPath = output ?? 'tests/perf/baselines/desktop-frontend.json';

  const [buffer, batcher, vsm, lite, tp] = await Promise.all([
    import('../src/api/StreamRenderBuffer'),
    import('../src/api/streamTextBatcher'),
    import('../src/api/VirtualScrollManager'),
    import('../src/api/markdownRenderLite'),
    import('../src/api/toolPresentation'),
  ]);

  const bigText = buildBigText();
  const toolRich = buildToolRichMessage(bigText) as never;
  const entries: BaselineEntry[] = [];

  console.log(
    `[frontend-bench] 采样开始（文本 ${bigText.length} 字符 / 100KB 场景）...`
  );

  // 1. flushFrame 预算吞吐：100KB 输入按 8192B 分帧
  entries.push(
    measure(
      'buffer.flushFrame.100KB',
      () => {
        let pending: string[] = [bigText];
        while (pending.length > 0) {
          const r = buffer.flushFrame(
            pending,
            8192,
            performance.now() + 6,
            false
          );
          pending = r.remaining;
          if (r.batch.length === 0) break;
        }
      },
      10
    )
  );

  // 2. StreamTextBatcher 批量合并（200 个 48ms 窗口的合并吞吐）
  entries.push(
    measure(
      'batcher.merge.200',
      () => {
        const b = new batcher.StreamTextBatcher(() => {}, {
          intervalMs: 48,
          maxBufferedChars: 8000,
        });
        for (let i = 0; i < 200; i++) {
          b.push(`k-${i % 10}`, `chunk-${i}-` + 'x'.repeat(64));
        }
        b.flushNow();
      },
      30
    )
  );

  // 3. VirtualScrollManager offset 重建（1500 行）
  entries.push(
    measure(
      'vsm.rebuildOffsets.1500',
      () => {
        const m = new vsm.VirtualScrollManager(120);
        const ids = Array.from({ length: 1500 }, (_, i) => `m${i}`);
        m.syncOrder(ids);
        for (let i = 0; i < 1500; i++) {
          m.setActual(`m${i}`, 100 + (i % 7) * 10);
        }
        void m.getTotalHeight(1500);
      },
      20
    )
  );

  // 4. stripper 单帧增量 vs 全量 strip（12KB/帧 的 100KB 流）
  entries.push(
    measure(
      'stripper.perFrame.100KB',
      () => {
        const s = new lite.IncrementalThoughtStripper();
        const chunk = 12 * 1024;
        for (let i = 0; i < bigText.length; i += chunk) {
          s.next(bigText.slice(0, Math.min(i + chunk, bigText.length)));
        }
      },
      20
    )
  );
  entries.push(
    measure(
      'strip.full.100KB',
      () => {
        lite.stripThoughtPlaceholders(bigText);
      },
      20
    )
  );

  // 5. timeline 签名命中 vs 未命中（20 工具 + 100KB 正文）
  const sig = tp.timelineSignature(toolRich);
  let prevTimeline: unknown;
  entries.push(
    measure(
      'timeline.cachedHit',
      () => {
        const r = tp.buildAssistantTimelineCached(
          toolRich,
          sig,
          prevTimeline as never
        );
        prevTimeline = r.timeline;
      },
      20
    )
  );
  entries.push(
    measure(
      'timeline.fullBuild',
      () => {
        tp.buildAssistantTimeline(toolRich);
      },
      20
    )
  );

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(entries, null, 2), 'utf8');

  console.log('[frontend-bench] 采样完成，已落盘:');
  for (const e of entries) {
    console.log(
      `  ${e.name}: avg ${e.avgMs.toFixed(3)}ms p95 ${e.p95Ms.toFixed(3)}ms (${e.ops} ops)`
    );
  }
}

main().catch((err) => {
  console.error('[frontend-bench] 失败:', err);
  process.exit(1);
});
