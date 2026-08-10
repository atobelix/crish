/**
 * 流式渲染性能基线采样（08-detail 步骤 0 产物，commit-1 前置）。
 *
 * 用途：
 * - 在修复前跑一次落盘「修复前基线」，修复后同机重跑对比；
 * - 锚点对应 07 审计 R-01/R-02/R-03/R-10 的同步成本面（纯函数层）：
 *   1. stripFull100KB    —— 全量 stripThoughtPlaceholders（修复前每帧 O(全文) 成本）
 *   2. timelineBuild100KB —— buildAssistantTimeline（20 工具 + 100KB 文本，修复前每帧重建）
 *   3. searchScanPerFrame —— 100 消息 + 搜索激活的每帧全量扫描（messageMatchesSearch × N）
 *   4. flushFrameBudget  —— StreamRenderBuffer.flushFrame 单帧预算吞吐（模块基线）
 *   5. stripperPerFrame  —— IncrementalThoughtStripper.next 单帧增量成本（修复后新增，
 *                           修复前不存在则跳过，不影响基线文件结构）
 *   6. timelineCachedHit —— buildAssistantTimelineCached 签名命中成本（修复后新增）
 *
 * 输出：
 * - tests/perf/baselines/desktop-module.json —— 与 scripts/compare-benchmarks.ts 的
 *   BaselineEntry 同形态（name/avgMs/ops/p95Ms），可直接被 compare 消费。
 *
 * 运行：
 *   npx tsx tests/perf/capture-streaming-baseline.ts [--output <path>]
 *
 * 注意：
 * - 结果对机器/负载敏感：对比必须同机同环境采集；
 * - 本脚本只测纯函数同步成本，浏览器端帧间隔/长任务锚点由 L3 Playwright spec 承载。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface BaselineEntry {
  name: string;
  avgMs: number;
  ops: number;
  p95Ms: number;
}

// ── fixture 构造 ──────────────────────────────────────────────────────────

/** 100KB 级流式文本：中文 + markdown + 周期出现的占位行（贴近真实助手输出） */
function buildBigText(targetBytes = 100 * 1024): string {
  const linePool = [
    '正在思考中…',
    '## 本轮总结',
    '完成了第一阶段的实现，接下来检查边界条件。',
    '- 修复了流式渲染的帧预算问题\n- 补充了对拍测试',
    '```ts\nconst budget = 8192;\n```',
    '正在处理…',
    '## 本回合小结：',
    '跨帧边界的占位行与总结标题需要被剥离。',
    '**本轮总结：**',
  ];
  const chunks: string[] = [];
  let total = 0;
  let i = 0;
  while (total < targetBytes) {
    const line = linePool[i % linePool.length]!;
    chunks.push(line, '\n');
    total += line.length + 1;
    i++;
  }
  return chunks.join('');
}

/** 20 工具 + 100KB 正文的助手消息（工具密集会话形态） */
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

/** 100 条消息（含工具）的会话，供搜索扫描采样 */
function buildSearchSessionMessages(): unknown[] {
  return Array.from({ length: 100 }, (_, i) => {
    const isAsst = i % 2 === 1;
    return {
      id: `msg-${i}`,
      sender: isAsst ? 'assistant' : 'user',
      timestamp: Date.now() + i,
      status: 'completed',
      text: isAsst
        ? `助手回复 ${i}：完成指标验证，命中率 ${i % 17}%。` +
          (i % 13 === 0 ? '\n## 本轮总结' : '')
        : `用户问题 ${i}：请检查第 ${i} 个文件的吞吐与延迟。`,
      thinking: '',
      toolCalls: isAsst
        ? [
            {
              id: `t-${i}`,
              name: 'read_file',
              arguments: `{"path":"file-${i}.ts"}`,
              status: 'success',
              output: `文件 ${i} 内容`,
            },
          ]
        : [],
      blocks: [],
    };
  });
}

// ── 测量工具 ──────────────────────────────────────────────────────────────

function measure(
  name: string,
  fn: () => void,
  iterations: number,
  warmup = 3,
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
  const p95Ms = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1]!;
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
      console.log('用法: npx tsx tests/perf/capture-streaming-baseline.ts [--output <path>]');
      process.exit(0);
    }
  }
  return { output };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { output } = parseArgs();
  const outPath = output ?? 'tests/perf/baselines/desktop-module.json';

  // 修复前也可运行：增量路径（stripper / 签名缓存）修复前不存在 → 动态导入失败跳过，
  // 修复后同脚本自动纳入，保证基线 JSON 结构同构（按 name 对拍）。
  const [strip, timeline, search, buffer] = await Promise.all([
    import('../../apps/crish-desktop/src/api/markdownRenderLite'),
    import('../../apps/crish-desktop/src/api/toolPresentation'),
    import('../../apps/crish-desktop/src/api/sessionSearch'),
    import('../../apps/crish-desktop/src/api/StreamRenderBuffer'),
  ]);

  const bigText = buildBigText();
  const toolRich = buildToolRichMessage(bigText);
  const sessionMessages = buildSearchSessionMessages() as Array<{
    text?: string;
    toolCalls?: unknown[];
  }>;

  const entries: BaselineEntry[] = [];

  console.log(`[perf-baseline] 采样开始（文本 ${bigText.length} 字符 / ${sessionMessages.length} 消息）...`);

  // 1. 全量 strip（修复前每帧同步成本；100KB 文本）
  entries.push(
    measure(
      'stripFull100KB',
      () => {
        strip.stripThoughtPlaceholders(bigText);
      },
      20,
    ),
  );

  // 2. timeline 全量重建（20 工具 + 100KB 正文）
  entries.push(
    measure(
      'timelineBuild100KB',
      () => {
        timeline.buildAssistantTimeline(toolRich as never);
      },
      20,
    ),
  );

  // 3. 搜索态每帧全量扫描（100 消息，query 命中少数消息）
  entries.push(
    measure(
      'searchScanPerFrame',
      () => {
        for (const m of sessionMessages) {
          search.messageMatchesSearch(m as never, '吞吐 延迟');
        }
      },
      30,
    ),
  );

  // 4. StreamRenderBuffer 单帧预算吞吐（100KB 输入按 8192B 分帧）
  entries.push(
    measure(
      'flushFrameBudget',
      () => {
        let pending: string[] = [bigText];
        while (pending.length > 0) {
          const r = buffer.flushFrame(pending, 8192, performance.now() + 6, false);
          pending = r.remaining;
          if (r.batch.length === 0) break;
        }
      },
      10,
    ),
  );

  // 5. 增量 stripper（修复后存在才采样；修复前跳过）
  try {
    const lite = await import('../../apps/crish-desktop/src/api/markdownRenderLite');
    if (typeof lite.IncrementalThoughtStripper === 'function') {
      entries.push(
        measure(
          'stripperPerFrame',
          () => {
            const s = new lite.IncrementalThoughtStripper();
            // 模拟 12KB/帧 的 100KB 流：逐帧增量剥离
            const chunk = 12 * 1024;
            for (let i = 0; i < bigText.length; i += chunk) {
              s.next(bigText.slice(0, Math.min(i + chunk, bigText.length)));
            }
          },
          20,
        ),
      );
    }
  } catch {
    /* 修复前无 stripper，跳过 */
  }

  // 6. timeline 签名缓存（修复后存在才采样）
  try {
    const tp = await import('../../apps/crish-desktop/src/api/toolPresentation');
    if (typeof tp.timelineSignature === 'function') {
      const sig = tp.timelineSignature(toolRich as never);
      let prevTimeline: unknown;
      entries.push(
        measure(
          'timelineCachedHit',
          () => {
            const r = tp.buildAssistantTimelineCached(
              toolRich as never,
              sig,
              prevTimeline as never,
            );
            prevTimeline = r.timeline;
          },
          20,
        ),
      );
    }
  } catch {
    /* 修复前无签名缓存，跳过 */
  }

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(entries, null, 2), 'utf8');

  console.log('[perf-baseline] 采样完成，已落盘:');
  for (const e of entries) {
    console.log(`  ${e.name}: avg ${e.avgMs.toFixed(3)}ms p95 ${e.p95Ms.toFixed(3)}ms (${e.ops} ops)`);
  }
}

main().catch((err) => {
  console.error('[perf-baseline] 失败:', err);
  process.exit(1);
});
