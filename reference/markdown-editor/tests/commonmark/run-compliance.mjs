#!/usr/bin/env node
/**
 * CommonMark 合规跑分脚本（R0 基线轮）
 *
 * 流程：读用例（examples.json，未就绪则内嵌解析官方 spec.txt）→
 *       引擎 MarkdownParser.parse → AST→HTML 投影器 astToHtml →
 *       归一化对比（normalizeHtml）→ 输出分章节统计 JSON。
 *
 * 数据源优先级：
 *   1. examples.json（R0-A 并行产出的 CommonMark 用例 JSON，候选多路径）；
 *   2. tests/commonmark/spec.txt（官方 0.31.2 原始格式，内嵌临时解析器：
 *      ``` 分隔的 example 块，`.` 分隔 markdown 与期望 HTML，`→` 为 tab）。
 *
 * 用例结构：{ markdown, html, section, example? }（examples.json
 *   兼容 { input, output } 别名；section 缺失时按 spec 章节分组）。
 *
 * 输出：完整 JSON（total/pass/fail/bySection/baseline）打印到 stdout，
 *   同时写入 tests/commonmark/compliance-report.json。
 *   可选参数：--summary 仅打印摘要；--out <path> 指定报告文件路径。
 */
import { createServer } from 'vite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：reference/markdown-editor */
const repoRoot = path.resolve(__dirname, '..', '..');

/** 章节名归一化：官方 spec 章节名 → 任务约定章节名 */
const SECTION_ALIAS = {
  'Indented code blocks': 'Indented code',
  'Fenced code blocks': 'Fenced code',
};

/** 任务约定的章节分组顺序（bySection 按键顺序与输出顺序） */
const SECTION_ORDER = [
  'Tabs',
  'Precedence',
  'Thematic breaks',
  'ATX headings',
  'Setext headings',
  'Indented code',
  'Fenced code',
  'HTML blocks',
  'Link reference definitions',
  'Paragraphs',
  'Blank lines',
  'Block quotes',
  'List items',
  'Lists',
  'Backslash escapes',
  'Entity and numeric character references',
  'Code spans',
  'Emphasis and strong emphasis',
  'Links',
  'Images',
  'Autolinks',
  'Raw HTML',
  'Hard line breaks',
  'Soft line breaks',
  'Textual content',
];

/** 通过项目真实模块解析器加载源码，依赖与产品构建使用同一条解析路径。 */
async function loadEngine() {
  const server = await createServer({
    root: repoRoot,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
  });
  try {
    const { MarkdownParser } = await server.ssrLoadModule('/src/core/parser.ts');
    const { astToHtml, normalizeHtml } = await server.ssrLoadModule('/tests/commonmark/astToHtml.ts');
    return { MarkdownParser, astToHtml, normalizeHtml };
  } finally {
    await server.close();
  }
}

/** 候选 examples.json 路径（R0-A 并行产出的共享位置） */
function findExamplesJson() {
  const candidates = [
    path.join(repoRoot, 'tests', 'cmspec', 'examples.json'),
    path.join(repoRoot, 'tests', 'commonmark', 'examples.json'),
    path.join(__dirname, '..', 'cmspec', 'examples.json'),
    path.join(repoRoot, '..', '..', 'tests', 'cmspec', 'examples.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** 加载 examples.json（兼容 {markdown,html} 与 {input,output} 两种字段名） */
function loadExamplesJson(p) {
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.examples ?? raw.cases ?? [];
  const out = [];
  for (const ex of list) {
    const markdown = ex.markdown ?? ex.input ?? ex.md;
    const html = ex.html ?? ex.output;
    if (typeof markdown !== 'string' || typeof html !== 'string') continue;
    out.push({
      markdown: markdown.replace(/\r\n/g, '\n'),
      html: html.replace(/\r\n/g, '\n'),
      section: ex.section ? normalizeSection(ex.section) : null,
      example: ex.n ?? ex.example ?? null,
    });
  }
  return { source: p, examples: out };
}

/**
 * 从 spec.txt 推导「例号 → 章节」映射（examples.json 仅携带例号 n 时使用）：
 * 顺序扫描 example 块，按块序记录章节边界，得到每个例号所属章节。
 */
function deriveSectionsFromSpec() {
  const p = path.join(__dirname, 'spec.txt');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const FENCE = '`'.repeat(32);
  const lines = text.split('\n');
  const boundaries = []; // { start: 例号, section }
  let section = '(前言)';
  let count = 0;
  let inside = false;
  for (const l of lines) {
    if (l.startsWith(FENCE)) {
      // 开围栏：32 反引号 + " example"；闭围栏：恰好 32 反引号
      if (!inside) {
        inside = true;
      } else {
        inside = false;
        count++;
        boundaries.push({ start: count, section });
      }
      continue;
    }
    if (!inside && l.startsWith('## ')) {
      section = normalizeSection(l.slice(3).trim());
    }
  }
  const sectionOf = (n) => {
    let best = '(前言)';
    for (const b of boundaries) {
      if (b.start <= n) best = b.section;
    }
    return best;
  };
  return { sectionOf, total: count };
}

/** 章节名归一化 */
function normalizeSection(name) {
  return SECTION_ALIAS[name] ?? name;
}

/**
 * 内嵌 spec.txt 解析器（官方 CommonMark 0.31.2 原始格式）：
 * - 32 反引号 + " example" 为开围栏、恰好 32 反引号为闭围栏，
 *   块内以单独一行的 `.` 分隔 markdown 与期望 HTML；
 * - `→`（U+2192）代表 tab，解析时统一替换为真正的制表符；
 * - 仅跟踪 example 块外的 `## 章节` 标题，避免把用例内容误判为章节。
 */
function parseSpecTxt(p) {
  const text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const FENCE = '`'.repeat(32);
  const OPEN = FENCE + ' example';
  const lines = text.split('\n');
  const examples = [];
  let section = '(前言)';
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l === OPEN) {
      i++;
      const md = [];
      while (i < lines.length && lines[i] !== '.') {
        md.push(lines[i]);
        i++;
      }
      i++; // 跳过 "." 分隔行
      const html = [];
      while (i < lines.length && lines[i] !== FENCE) {
        html.push(lines[i]);
        i++;
      }
      i++; // 跳过闭围栏
      // 官方 spec_tests.py 惯例：markdown 与期望 HTML 均保留尾部换行
      // （每行以 \n 结尾），与 R0-A 产出的 examples.json 格式一致。
      // `→`（U+2192）代表 tab，统一替换为真正的制表符。
      examples.push({
        markdown: (md.join('\n') + (md.length > 0 ? '\n' : '')).replace(/→/g, '\t'),
        html: (html.join('\n') + (html.length > 0 ? '\n' : '')).replace(/→/g, '\t'),
        section,
        example: examples.length + 1,
      });
      continue;
    }
    if (l === FENCE) {
      i++; // 防御：孤立的闭围栏行直接跳过
      continue;
    }
    if (l.startsWith('## ')) {
      section = normalizeSection(l.slice(3).trim());
      i++;
      continue;
    }
    i++;
  }
  return { source: p, examples };
}

/** 加载用例：examples.json 优先，回退 spec.txt */
function loadExamples() {
  const jsonPath = findExamplesJson();
  if (jsonPath) {
    const r = loadExamplesJson(jsonPath);
    if (r.examples.length > 0) {
      // examples.json 无 section 字段时，用 spec.txt 的例号→章节映射补分组
      if (r.examples.every((e) => e.section === null)) {
        const derived = deriveSectionsFromSpec();
        if (derived && derived.total === r.examples.length) {
          for (const e of r.examples) {
            e.section = derived.sectionOf(e.example);
          }
        } else {
          for (const e of r.examples) e.section = '(未分组)';
        }
      }
      return { ...r, format: 'examples.json' };
    }
    console.warn(`[warn] ${jsonPath} 存在但无有效用例，回退 spec.txt`);
  }
  const specCandidates = [
    path.join(__dirname, 'spec.txt'),
    path.join(repoRoot, 'tests', 'cmspec', 'spec.txt'),
  ];
  for (const p of specCandidates) {
    if (existsSync(p)) {
      return { ...parseSpecTxt(p), format: 'spec.txt' };
    }
  }
  throw new Error('未找到 examples.json 或 spec.txt（tests/commonmark/spec.txt）');
}

/** 主流程：跑分 */
async function main() {
  const args = process.argv.slice(2);
  const onlySummary = args.includes('--summary');
  const outArgIdx = args.indexOf('--out');
  const reportPath = outArgIdx >= 0
    ? path.resolve(args[outArgIdx + 1])
    : path.join(__dirname, 'compliance-report.json');

  const { MarkdownParser, astToHtml, normalizeHtml } = await loadEngine();
  const { examples, source, format } = loadExamples();

  // 跑分：parse → 投影 → 归一化对比（引擎异常按 FAIL 计数，不中断）
  const bySection = {};
  const failIndices = [];
  const actualList = [];
  const expectedList = [];
  let pass = 0;
  let fail = 0;

  examples.forEach((ex, idx) => {
    const sec = bySection[ex.section] ?? { pass: 0, fail: 0 };
    let actual;
    try {
      const doc = MarkdownParser.parse(ex.markdown);
      actual = astToHtml(doc);
    } catch (e) {
      actual = `<PARSE_ERROR: ${String(e.message ?? e)}>`;
    }
    const ok = normalizeHtml(actual) === normalizeHtml(ex.html);
    if (ok) {
      pass++;
      sec.pass++;
    } else {
      fail++;
      sec.fail++;
      failIndices.push(idx);
    }
    bySection[ex.section] = sec;
    actualList.push(actual);
    expectedList.push(ex.html);
  });

  // 按任务约定顺序组织 bySection（未约定的章节按首次出现顺序追加）
  const orderedSections = SECTION_ORDER.filter((s) => bySection[s]);
  const extraSections = Object.keys(bySection).filter((s) => !SECTION_ORDER.includes(s));
  const report = {
    total: examples.length,
    pass,
    fail,
    bySection: {},
    baseline: {
      actual: actualList,
      expected: expectedList,
    },
    failIndices,
    source,
    format,
    generatedAt: new Date().toISOString(),
  };
  for (const s of [...orderedSections, ...extraSections]) {
    report.bySection[s] = bySection[s];
  }

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  // 摘要
  const pct = examples.length > 0 ? ((pass / examples.length) * 100).toFixed(2) : '0.00';
  console.log(`CommonMark 合规跑分（${format}：${source}）`);
  console.log(`总用例 ${examples.length}｜通过 ${pass}｜失败 ${fail}｜符合度 ${pct}%`);
  console.log('--- 分章节 ---');
  for (const s of [...orderedSections, ...extraSections]) {
    const r = bySection[s];
    console.log(`  ${s.padEnd(36)} pass=${r.pass} fail=${r.fail}`);
  }
  console.log(`报告已写入：${reportPath}`);

  if (!onlySummary) {
    console.log('--- 完整 JSON ---');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((e) => {
  console.error('跑分失败：', e);
  process.exit(1);
});
