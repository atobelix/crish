/**
 * Stream F 基准：10k 字符 markdown 渲染
 *
 * 目标：测量当前 JS markdown 渲染管线（parseMarkdownToHtml）处理 10k 字符
 * 富文本 markdown 的耗时，建立 Stream A（Rust pulldown-cmark）切换前的基线。
 *
 * 渲染样本包含：标题、段落、列表、代码块、表格、引用、链接、CJK 文本——
 * 覆盖 AsyncMarkdownBlock.tsx 实际遇到的混合内容场景。
 *
 * 可重复执行：npx tsx scripts/bench-markdown-render.ts
 * 输出：perf-report/bench-markdown-render.json
 */
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// 由 crish-desktop 源码导入渲染管线；tsx 直接运行 TS，无需预编译。
// 注意：parseMarkdownToHtml 内置 LRU 缓存，基准需先 warmup 再每次用新文本
// 避免命中缓存（我们要测渲染开销，不是缓存查询）。
async function loadRenderer(): Promise<(raw: string) => string> {
  const mod = await import('../apps/crish-desktop/src/api/markdownRender');
  return mod.parseMarkdownToHtml;
}

function build10kMarkdown(): string {
  const parts: string[] = [];

  // 标题段（H1-H4 各一）
  parts.push('# 性能基准测试文档\n\n');
  parts.push('## 第二节：列表与代码\n\n');
  parts.push('### 第三节：表格\n\n');
  parts.push('#### 第四节：引用与链接\n\n');

  // 段落 + 行内格式（粗体、斜体、行内代码、链接）
  for (let i = 0; i < 40; i++) {
    parts.push(
      `这是第 ${i} 段普通文本，包含 **粗体**、*斜体*、\`inline code\` 与 ` +
        `[链接文本](https://example.com/path/to/resource-${i})。` +
        `中英文混排 benchmark 测试 wbr boundary 检测。` +
        `Inline formatting stress test with mixed CJK and Latin content.\n\n`,
    );
  }

  // 无序列表（嵌套）
  parts.push('- 顶层列表项 A\n');
  parts.push('  - 嵌套子项 A1\n');
  parts.push('  - 嵌套子项 A2\n');
  parts.push('- 顶层列表项 B\n');
  parts.push('  - 嵌套子项 B1\n');
  parts.push('    - 三层嵌套 B1a\n');
  parts.push('- 顶层列表项 C\n\n');

  // 有序列表
  parts.push('1. 第一步：初始化\n');
  parts.push('2. 第二步：执行渲染\n');
  parts.push('3. 第三步：sanitize 与输出\n\n');

  // 任务列表
  parts.push('- [x] 已完成项\n');
  parts.push('- [ ] 未完成项\n');
  parts.push('- [ ] 另一个未完成项\n\n');

  // Fenced code block（多语言）
  parts.push('```typescript file="src/renderer.ts"\n');
  parts.push('export function render(text: string): string {\n');
  parts.push('  const html = parse(text);\n');
  parts.push('  return sanitize(html);\n');
  parts.push('}\n');
  parts.push('```\n\n');

  parts.push('```python\n');
  parts.push('def main():\n');
  parts.push('    data = load_input()\n');
  parts.push('    result = process(data)\n');
  parts.push('    print(result)\n');
  parts.push('```\n\n');

  parts.push('```rust\n');
  parts.push('pub fn render_markdown(text: &str) -> String {\n');
  parts.push('    let parser = Parser::new(text);\n');
  parts.push('    let mut html = String::new();\n');
  parts.push('    pulldown_cmark::html::push_html(&mut html, parser);\n');
  parts.push('    html\n');
  parts.push('}\n');
  parts.push('```\n\n');

  // GFM 表格（含对齐）
  parts.push('| 名称 | 类型 | 描述 | 状态 |\n');
  parts.push('|:-----|:----:|------:|:-----|\n');
  parts.push('| render | function | 主渲染入口 | 完成 |\n');
  parts.push('| highlight | function | 代码高亮 | 完成 |\n');
  parts.push('| sanitize | function | HTML 消毒 | 完成 |\n');
  parts.push('| cache | module | LRU 缓存 | 完成 |\n');
  parts.push('| streaming | module | 流式增量 | 进行中 |\n\n');

  // 引用块
  parts.push('> 这是一段引用文本，用于测试 blockquote 渲染。\n');
  parts.push('> 引用可以跨多行，每行以 > 开头。\n');
  parts.push('>\n');
  parts.push('> 嵌套引用：第二层。\n\n');

  // 水平线
  parts.push('---\n\n');

  // 长段落（CJK 密集，触发 wbr 插入）
  parts.push(
    '这是一段较长的中文文本用于测试中日韩文字与拉丁字符边界的 wbr 插入逻辑。' +
      '混入 English words 与中文交替时，渲染器需要在适当位置插入 <wbr> 标签以便浏览器换行。' +
      '这段文本会重复多次以达到 10k 字符的目标长度。'.repeat(8) + '\n\n',
  );

  // 图片（含 alt 与 title）
  parts.push('![示意图](https://example.com/diagram.png "架构示意图")\n\n');

  // 自动路径链接
  parts.push('参见 src/api/markdownRender.ts 与 src/api/codeHighlight.ts 实现。\n\n');

  // 再来一组列表与段落，确保总长度接近 10k
  for (let i = 0; i < 25; i++) {
    parts.push(`## 子节 ${i}\n\n`);
    parts.push(
      `段落 ${i}：benchmark 测试文本，包含 **强调** 与 \`代码\`。`.repeat(3) + '\n\n',
    );
    parts.push(`- 列表项 ${i}.a\n- 列表项 ${i}.b\n- 列表项 ${i}.c\n\n`);
  }

  const text = parts.join('');
  // 确认长度接近 10k；若超出可截断，若不足则补充
  if (text.length < 9000) {
    parts.push('补充段落：'.repeat(50) + '\n');
  }
  return text.slice(0, 11000); // 允许略超 10k，保留完整结构
}

interface BenchSample {
  index: number;
  elapsedMs: number;
  htmlLength: number;
}

interface BenchReport {
  name: string;
  timestamp: string;
  inputChars: number;
  iterations: number;
  warmupIterations: number;
  samples: BenchSample[];
  warmupSamples: BenchSample[];
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  ops: number;
  htmlLength: number;
}

function percentile(sorted: number[], rank: number): number {
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * rank) - 1),
  );
  return Math.round(sorted[i]! * 100) / 100;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

async function main(): Promise<void> {
  const parseMarkdownToHtml = await loadRenderer();
  const markdown = build10kMarkdown();

  console.log('='.repeat(60));
  console.log('基准：markdown.render.10k');
  console.log('='.repeat(60));
  console.log(`输入长度: ${markdown.length} 字符`);

  const iterations = 30;
  const warmupIterations = 5;
  const warmupSamples: BenchSample[] = [];
  const samples: BenchSample[] = [];

  // Warmup：让 V8 JIT 优化、填充 markdown LRU 缓存
  for (let i = 0; i < warmupIterations; i++) {
    // 每次追加唯一后缀避免缓存命中
    const input = markdown + `\n\n<!-- warmup-${i}-${Date.now()} -->`;
    const start = performance.now();
    const html = parseMarkdownToHtml(input);
    const elapsed = performance.now() - start;
    warmupSamples.push({ index: i, elapsedMs: elapsed, htmlLength: html.length });
  }

  // 实测：每次用唯一后缀避免缓存命中
  for (let i = 0; i < iterations; i++) {
    const input = markdown + `\n\n<!-- bench-${i}-${Date.now()}-${Math.random()} -->`;
    const start = performance.now();
    const html = parseMarkdownToHtml(input);
    const elapsed = performance.now() - start;
    samples.push({ index: i, elapsedMs: elapsed, htmlLength: html.length });
  }

  const elapsedValues = samples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const avgMs = elapsedValues.reduce((a, b) => a + b, 0) / elapsedValues.length;
  const htmlLength = samples[samples.length - 1]!.htmlLength;

  const report: BenchReport = {
    name: 'markdown.render.10k',
    timestamp: new Date().toISOString(),
    inputChars: markdown.length,
    iterations,
    warmupIterations,
    samples,
    warmupSamples,
    avgMs: round2(avgMs),
    minMs: round2(elapsedValues[0]!),
    maxMs: round2(elapsedValues[elapsedValues.length - 1]!),
    p50Ms: percentile(elapsedValues, 0.5),
    p95Ms: percentile(elapsedValues, 0.95),
    p99Ms: percentile(elapsedValues, 0.99),
    ops: avgMs > 0 ? Math.round(1000 / avgMs) : 0,
    htmlLength,
  };

  console.log(`\n结果 ( ${iterations} 次迭代, ${warmupIterations} 次 warmup ):`);
  console.log(`  平均: ${report.avgMs}ms`);
  console.log(`  P50:  ${report.p50Ms}ms`);
  console.log(`  P95:  ${report.p95Ms}ms`);
  console.log(`  P99:  ${report.p99Ms}ms`);
  console.log(`  最小: ${report.minMs}ms`);
  console.log(`  最大: ${report.maxMs}ms`);
  console.log(`  吞吐: ${report.ops} ops/s`);
  console.log(`  HTML 输出长度: ${report.htmlLength} 字符`);

  const reportPath = 'perf-report/bench-markdown-render.json';
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n报告已保存到 ${reportPath}`);
}

main().catch((err) => {
  console.error('基准测试失败:', err);
  process.exitCode = 1;
});
