/**
 * 流式 Markdown 渲染性能基准测试
 *
 * 测量维度：
 *   1. FPS：基于 performance.now()（与 requestAnimationFrame 同源单调时钟）推算有效帧率
 *   2. 每帧解析耗时：performance.mark/measure 测量 push() 与 render() 单次耗时
 *   3. 内存占用：finalizedBlocks / LINE_CACHE / assetUrlCache 缓存大小
 *   4. 流式场景：段落 / 代码块 / 列表 / 表格 / 最坏情况
 *
 * 目标（对齐 STREAMING_RENDER_PLAN.md 性能预估）：
 *   - 120 FPS（8.33ms 预算）下每帧 < 2ms
 *   - 典型段落 ~0.15ms | 代码块 ~0.25ms | 列表 ~0.3ms | 表格 ~0.2ms | 最坏 ~1.2ms
 *
 * 运行方式：
 *   - vitest（jsdom）：npx vitest run src/api/markdown-render/perfBenchmark.ts
 *   - tsx（需 DOM 环境）：npx tsx src/api/markdown-render/perfBenchmark.ts
 */

import {
  IncrementalMarkdownParser,
  type IncrementalParseResult,
} from './IncrementalMarkdownParser';
import { IncrementalDomRenderer } from './IncrementalDomRenderer';
import { LINE_CACHE } from './IncrementalInlineRenderer';
import { assetUrlCache } from '../workspaceFsApi';

// ===== 类型定义 =====

export interface PerfResult {
  scenario: string;
  totalFrames: number;
  avgFrameMs: number;
  p1FrameMs: number;
  p5FrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  pushMsAvg: number;
  renderMsAvg: number;
  totalMsAvg: number;
  memoryStats: {
    finalizedBlocks: number;
    lineCache: number;
    assetUrlCache: number;
    estimatedBytes: number;
  };
  fps: number;
  meetsTarget: boolean;
}

export interface BenchmarkScenario {
  name: string;
  /** 每帧推送的完整文本（流式累积，chunks[i] 为第 i 帧时的全文） */
  chunks: string[];
}

// ===== 常量 =====

const FPS_TARGET = 120;
const FRAME_BUDGET_MS = 1000 / FPS_TARGET; // ~8.33ms
const PER_FRAME_TARGET_MS = 2;

// ===== 辅助函数 =====

/** 算术平均值 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

/**
 * 计算分位数（线性插值法）。
 * @param sortedAsc 升序排序后的数组
 * @param p 百分位（0-100），如 99 表示 99th percentile
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/**
 * 使用 performance.mark/measure 测量单次操作耗时。
 * 测量后自动清理 mark/measure 条目，避免 PerformanceEntry 缓存膨胀。
 */
function measureTimed<T>(
  label: string,
  fn: () => T
): { result: T; duration: number } {
  const startMark = `${label}-start`;
  const endMark = `${label}-end`;
  const measureName = `${label}-measure`;

  performance.mark(startMark);
  const result = fn();
  performance.mark(endMark);
  performance.measure(measureName, startMark, endMark);

  const entries = performance.getEntriesByName(measureName);
  const duration =
    entries.length > 0 ? entries[entries.length - 1]!.duration : 0;

  performance.clearMarks(startMark);
  performance.clearMarks(endMark);
  performance.clearMeasures(measureName);

  return { result, duration };
}

/** 创建真实 DOM 容器，用于 IncrementalDomRenderer 渲染 */
function ensureDomContainer(): HTMLDivElement {
  if (typeof document === 'undefined') {
    throw new Error(
      'perfBenchmark 需要 DOM 环境。请通过 vitest（jsdom）或在浏览器/WebView 中运行。'
    );
  }
  return document.createElement('div');
}

/** 测量缓存内存占用（finalizedBlocks HTML 长度 + LINE_CACHE + assetUrlCache） */
function measureMemory(
  parseResult: IncrementalParseResult
): PerfResult['memoryStats'] {
  let estimatedBytes = 0;
  for (const block of parseResult.finalizedBlocks) {
    // HTML 字符串以 UTF-16 存储（约 2 bytes/char）；BlockNode 结构有少量固定开销
    estimatedBytes += block.html.length * 2 + 64;
  }
  if (parseResult.tailBlock) {
    estimatedBytes += parseResult.tailBlock.html.length * 2 + 64;
  }
  return {
    finalizedBlocks: parseResult.finalizedBlocks.length,
    lineCache: LINE_CACHE.size,
    assetUrlCache: assetUrlCache.size,
    estimatedBytes,
  };
}

// ===== 场景生成器 =====

/** 典型段落流式：每帧追加 100-500 字符到段落尾块 */
function generateParagraphScenario(): BenchmarkScenario {
  const chunks: string[] = [];
  const words =
    '流式Markdown渲染引擎通过增量解析与DOM块级patch实现高性能渲染每帧仅处理新增行已闭合块永不重分析 ';
  let text = '';
  const charCounts = [100, 200, 300, 400, 500, 150, 250, 350, 450, 120];
  for (let i = 0; i < 60; i++) {
    const addChars = charCounts[i % charCounts.length]!;
    let addition = '';
    while (addition.length < addChars) addition += words;
    text += addition.slice(0, addChars);
    chunks.push(text);
  }
  return { name: '典型段落流式（尾块 100-500 字符）', chunks };
}

/** 代码块流式：每帧 +1-3 行代码 */
function generateCodeBlockScenario(): BenchmarkScenario {
  const chunks: string[] = [];
  let text = '```typescript\n';
  chunks.push(text);
  const lineCounts = [1, 2, 3, 1, 2, 3, 1, 2];
  for (let i = 0; i < 40; i++) {
    const linesToAdd = lineCounts[i % lineCounts.length]!;
    for (let j = 0; j < linesToAdd; j++) {
      text += `const result_${i}_${j} = await asyncCompute(${i}, ${j}, payload);\n`;
    }
    chunks.push(text);
  }
  text += '```';
  chunks.push(text);
  return { name: '代码块流式（每帧 +1-3 行）', chunks };
}

/** 长列表流式：每帧 +1 列表项 */
function generateListScenario(): BenchmarkScenario {
  const chunks: string[] = [];
  let text = '';
  for (let i = 0; i < 50; i++) {
    text += `- 列表项 ${i}: 这是第 ${i} 个条目包含描述性文本用于测试长列表流式渲染性能\n`;
    chunks.push(text);
  }
  return { name: '长列表流式（尾块 +1 项）', chunks };
}

/** 表格流式：每帧 +1 行 */
function generateTableScenario(): BenchmarkScenario {
  const chunks: string[] = [];
  let text = '| 名称 | 值 | 描述 |\n| --- | --- | --- |\n';
  chunks.push(text);
  for (let i = 0; i < 30; i++) {
    text += `| item_${i} | ${i * 100} | 描述文本行 ${i} |\n`;
    chunks.push(text);
  }
  return { name: '表格流式（尾行 +1 行）', chunks };
}

/** 最坏情况：每帧 500 字符尾块 + 3 行代码（对齐计划预估 ~1.2ms） */
function generateWorstCaseScenario(): BenchmarkScenario {
  const chunks: string[] = [];
  let text = '```typescript\n';
  chunks.push(text);
  const longLine = `// ${'x'.repeat(497)}`; // ~500 字符
  for (let i = 0; i < 20; i++) {
    text += longLine + '\n';
    text += `const a${i} = computeStep(${i});\n`;
    text += `const b${i} = transformData(${i});\n`;
    text += `const c${i} = finalizeResult(${i});\n`;
    chunks.push(text);
  }
  text += '```';
  chunks.push(text);
  return { name: '最坏情况（500 字符尾块 + 3 行代码）', chunks };
}

/** 默认基准测试场景集合（对齐 STREAMING_RENDER_PLAN.md 性能预估表） */
export const DEFAULT_SCENARIOS: BenchmarkScenario[] = [
  generateParagraphScenario(),
  generateCodeBlockScenario(),
  generateListScenario(),
  generateTableScenario(),
  generateWorstCaseScenario(),
];

// ===== 核心 benchmark 函数 =====

/**
 * 运行单个场景的基准测试。
 *
 * 分位数约定（帧耗时升序排序后取值）：
 *   p1  = 99th percentile（最慢 1% 帧的边界值）
 *   p5  = 95th percentile（最慢 5% 帧的边界值）
 *   p50 = 50th percentile（中位数）
 *   p95 = 5th percentile（最快 5% 帧的边界值）
 */
function runScenario(scenario: BenchmarkScenario): PerfResult {
  const container = ensureDomContainer();
  const parser = new IncrementalMarkdownParser();
  const renderer = new IncrementalDomRenderer(container);

  const frameTimes: number[] = [];
  const pushTimes: number[] = [];
  const renderTimes: number[] = [];
  let lastParseResult: IncrementalParseResult = {
    finalizedBlocks: [],
    tailBlock: null,
    blockCount: 0,
  };

  for (const chunk of scenario.chunks) {
    // 帧总耗时用 performance.now()（与 requestAnimationFrame 同源单调时钟）
    const frameStart = performance.now();

    // push 单次耗时用 performance.mark/measure
    const { result: parseResult, duration: pushDur } = measureTimed(
      'perf-push',
      () => parser.push(chunk)
    );
    // render 单次耗时用 performance.mark/measure
    const { duration: renderDur } = measureTimed('perf-render', () =>
      renderer.render(parseResult)
    );
    lastParseResult = parseResult;

    const frameEnd = performance.now();

    pushTimes.push(pushDur);
    renderTimes.push(renderDur);
    frameTimes.push(frameEnd - frameStart);
  }

  parser.dispose();
  renderer.dispose();
  container.remove();

  const sortedAsc = [...frameTimes].sort((a, b) => a - b);
  const avgFrame = mean(frameTimes);
  const pushAvg = mean(pushTimes);
  const renderAvg = mean(renderTimes);

  return {
    scenario: scenario.name,
    totalFrames: frameTimes.length,
    avgFrameMs: avgFrame,
    p1FrameMs: percentile(sortedAsc, 99),
    p5FrameMs: percentile(sortedAsc, 95),
    p50FrameMs: percentile(sortedAsc, 50),
    p95FrameMs: percentile(sortedAsc, 5),
    pushMsAvg: pushAvg,
    renderMsAvg: renderAvg,
    totalMsAvg: pushAvg + renderAvg,
    memoryStats: measureMemory(lastParseResult),
    fps: avgFrame > 0 ? 1000 / avgFrame : 0,
    meetsTarget: avgFrame < PER_FRAME_TARGET_MS,
  };
}

/**
 * 运行全部基准测试场景。
 * @param scenarios 自定义场景；省略时使用 DEFAULT_SCENARIOS
 */
export function runBenchmark(scenarios?: BenchmarkScenario[]): PerfResult[] {
  const list = scenarios ?? DEFAULT_SCENARIOS;
  const results: PerfResult[] = [];
  for (const scenario of list) {
    results.push(runScenario(scenario));
  }
  return results;
}

/**
 * 对单段文本重复推送的基准测试。
 * 每次迭代创建全新 parser/renderer，测量完整解析+渲染成本。
 * @param text 待解析的 Markdown 文本
 * @param iterations 重复次数
 */
export function benchmarkIncrementalPush(
  text: string,
  iterations: number
): PerfResult {
  const container = ensureDomContainer();

  const frameTimes: number[] = [];
  const pushTimes: number[] = [];
  const renderTimes: number[] = [];
  let lastParseResult: IncrementalParseResult = {
    finalizedBlocks: [],
    tailBlock: null,
    blockCount: 0,
  };

  for (let i = 0; i < iterations; i++) {
    const parser = new IncrementalMarkdownParser();
    const renderer = new IncrementalDomRenderer(container);
    renderer.reset(); // 清理上一轮残留 DOM

    const frameStart = performance.now();

    const { result: parseResult, duration: pushDur } = measureTimed(
      'perf-push-single',
      () => parser.push(text)
    );
    const { duration: renderDur } = measureTimed('perf-render-single', () =>
      renderer.render(parseResult)
    );
    lastParseResult = parseResult;

    const frameEnd = performance.now();

    pushTimes.push(pushDur);
    renderTimes.push(renderDur);
    frameTimes.push(frameEnd - frameStart);

    parser.dispose();
    renderer.dispose();
  }

  container.remove();

  const sortedAsc = [...frameTimes].sort((a, b) => a - b);
  const avgFrame = mean(frameTimes);
  const pushAvg = mean(pushTimes);
  const renderAvg = mean(renderTimes);

  return {
    scenario: `benchmarkIncrementalPush (${iterations} iterations, ${text.length} chars)`,
    totalFrames: frameTimes.length,
    avgFrameMs: avgFrame,
    p1FrameMs: percentile(sortedAsc, 99),
    p5FrameMs: percentile(sortedAsc, 95),
    p50FrameMs: percentile(sortedAsc, 50),
    p95FrameMs: percentile(sortedAsc, 5),
    pushMsAvg: pushAvg,
    renderMsAvg: renderAvg,
    totalMsAvg: pushAvg + renderAvg,
    memoryStats: measureMemory(lastParseResult),
    fps: avgFrame > 0 ? 1000 / avgFrame : 0,
    meetsTarget: avgFrame < PER_FRAME_TARGET_MS,
  };
}

// ===== 独立运行入口 =====

function formatMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}us` : `${ms.toFixed(3)}ms`;
}

function printResult(r: PerfResult): void {
  const log = (s: string) => console.log(s);
  log('');
  log(`--- ${r.scenario} ---`);
  log(`  总帧数:       ${r.totalFrames}`);
  log(
    `  平均帧耗时:   ${formatMs(r.avgFrameMs)}  (push ${formatMs(r.pushMsAvg)} + render ${formatMs(r.renderMsAvg)})`
  );
  log(`  有效 FPS:     ${r.fps.toFixed(1)}`);
  log(`  帧耗时分位:`);
  log(`    p1  (最慢 1%):  ${formatMs(r.p1FrameMs)}`);
  log(`    p5  (最慢 5%):  ${formatMs(r.p5FrameMs)}`);
  log(`    p50 (中位数):   ${formatMs(r.p50FrameMs)}`);
  log(`    p95 (最快 5%):  ${formatMs(r.p95FrameMs)}`);
  log(`  内存:`);
  log(`    finalizedBlocks: ${r.memoryStats.finalizedBlocks}`);
  log(`    LINE_CACHE:      ${r.memoryStats.lineCache}`);
  log(`    assetUrlCache:   ${r.memoryStats.assetUrlCache}`);
  log(`    估计字节:        ${r.memoryStats.estimatedBytes}`);
  log(`  达标 (< ${PER_FRAME_TARGET_MS}ms/帧): ${r.meetsTarget ? '是' : '否'}`);
}

async function main(): Promise<void> {
  const log = (s: string) => console.log(s);

  log('=== Markdown 流式渲染性能基准测试 ===');
  log(
    `目标: ${FPS_TARGET} FPS (${FRAME_BUDGET_MS.toFixed(2)}ms 预算), 每帧 < ${PER_FRAME_TARGET_MS}ms`
  );
  log('');

  const results = runBenchmark();
  for (const r of results) {
    printResult(r);
  }

  log('');
  log('--- benchmarkIncrementalPush ---');
  const sampleText = [
    '# 标题示例',
    '',
    '这是一段用于测试的段落文本，包含 **加粗** 和 *斜体* 标记。',
    '',
    '```typescript',
    'function hello(name: string): string {',
    '  return `Hello, ${name}!`;',
    '}',
    '```',
    '',
    '- 列表项一',
    '- 列表项二',
    '- 列表项三',
  ].join('\n');
  const singleResult = benchmarkIncrementalPush(sampleText, 30);
  log(`  文本长度:    ${sampleText.length} chars`);
  log(`  迭代次数:    ${singleResult.totalFrames}`);
  log(`  平均 push:   ${formatMs(singleResult.pushMsAvg)}`);
  log(`  平均 render: ${formatMs(singleResult.renderMsAvg)}`);
  log(`  总平均:      ${formatMs(singleResult.totalMsAvg)}`);
  log(`  有效 FPS:    ${singleResult.fps.toFixed(1)}`);
  log(`  达标:        ${singleResult.meetsTarget ? '是' : '否'}`);

  log('');
  log('=== 基准测试完成 ===');
}

// 独立运行检测：当通过 tsx/node 直接执行此文件时运行 main
const isStandalone = (() => {
  try {
    if (typeof process === 'undefined' || !process.argv) return false;
    const argv1 = process.argv[1];
    if (typeof argv1 !== 'string') return false;
    return argv1.replace(/\\/g, '/').endsWith('perfBenchmark.ts');
  } catch {
    return false;
  }
})();

if (isStandalone) {
  main().catch((err) => {
    console.error(err);
    if (typeof process !== 'undefined') process.exit(1);
  });
}

// ===== Vitest 入口 =====
// 当 vitest 配置了 importMetaVitest 时，import.meta.vitest 提供测试 API。
// 未配置时该块不执行，文件仍可独立运行。

interface VitestLike {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void) => void;
  expect: <T>(actual: T) => {
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeTruthy(): void;
  };
}

const vitestCtx = (import.meta as unknown as { vitest?: VitestLike }).vitest;

if (vitestCtx) {
  const { describe, it, expect } = vitestCtx;

  describe('perfBenchmark', () => {
    it('所有默认场景应产出有效结果', () => {
      const results = runBenchmark();
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.totalFrames).toBeGreaterThan(0);
        expect(r.fps).toBeGreaterThan(0);
      }
    });

    it('最坏场景 p5 帧耗时应在合理范围', () => {
      const results = runBenchmark([generateWorstCaseScenario()]);
      const worst = results[0]!;
      // jsdom 环境允许性能波动，阈值放宽至 20ms
      expect(worst.p5FrameMs).toBeLessThan(20);
    });

    it('benchmarkIncrementalPush 应测量单次推送', () => {
      const result = benchmarkIncrementalPush('# Hello\n\nWorld', 10);
      expect(result.totalFrames).toBeGreaterThan(0);
      expect(result.pushMsAvg).toBeGreaterThanOrEqual(0);
    });
  });
}
