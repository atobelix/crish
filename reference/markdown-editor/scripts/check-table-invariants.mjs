// ============================================================
// 表格不变量门禁（战役 table-systemic-remediation · 任务单元 T0）
//
// 权威来源：docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md
//   §6 不变量 I1–I10、§7 T0、§13 裁决记录
//   验收契约：docs/table-systemic-remediation/08-分维-验收矩阵与防回归门禁.md
//
// 设计：**棘轮基线（ratchet）**
//   - 每个指标声明方向（down = 越小越好 / up = 越大越好）与目标值；
//   - 首次运行 `--update-baseline` 把**现状**冻结为基线（现状允许不达标）；
//   - 此后每次运行只要求「不得比基线更差」（棘轮只向下/向上单向收紧），
//     任一指标回退即 exit 1。这样任何重构波次都只能改善，不能回潮。
//
// 覆盖范围（T0 = 静态可判定子集）：
//   M1  headerDerivationSites        表头语义推导处数（I5）           down → 0
//   M2  identityUpwardProbes         表格身份向上探测处数（I10）       down → 0
//   M3  exportTableWrapper           导出是否输出 <table>（I9）        up   → 1
//   M4  toolbarNonIconLabels         表格工具条非图标标签数（F-Vis-10）down → 0
//   M5  nativeTableElements          组件层原生表格元素数（ADR-2 防回潮）down → 0
//   M6  rowLevelScrollOverflowRules  行级 overflow-x 规则数（I1）      down → 0
//   M7  lastRowScrollbarHacks        table-last-row 滚动条 hack（I1）  down → 0
//   M8  selectionInsetShadowSites    逐格 inset 拼选区边处数（I6）      down → 0
//   M9  perCellWidthWritebackSites   per-cell 列宽写回处数（ADR-4）     down → 0
//   M10 oracleTableReadsWidths       高度预言机是否读列宽真源（ADR-5）  up   → 1
//
// 运行时/DOM 类不变量（I1 实例计数 / I2 / I3 / I4 / I6 / I7 / I8）由后续波次
//   在对应代码落地时补入本脚本与 tests/gate/table-invariants.test.ts。
//
// 用法：
//   node scripts/check-table-invariants.mjs                  # 棘轮校验（CI）
//   node scripts/check-table-invariants.mjs --report         # 只打印，不判定
//   node scripts/check-table-invariants.mjs --update-baseline # 冻结当前为基线
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const BASELINE_PATH = join(ROOT, 'tests/gate/table-invariants-baseline.json');

/** 已声明的指标（新增指标必须同步登记，并在 08-分维 里给出对应断言） */
export const METRICS = [
  {
    id: 'headerDerivationSites',
    label: '表头语义推导处数（I5）',
    direction: 'down',
    target: 0,
    // 归属波次由 T1 调整为 T2（2026-09-14）：
    //   T1 只产出 TableModel 本体（src/core/tableModel.ts，纯逻辑 + 单测）；
    //   消费方切换（BlockRenderer 的 isHeaderRow）与身份消费点切换同属 T2
    //   （裁决 R3：T2 只改 MarkdownEngine.tsx:548-562 的身份推导块）。
    //   另：BlockRenderer.tsx 在 check-file-length 的例外名单内（ceiling 冻结），
    //   T1 期间不得为其增加行数——接线随 T3 重构该文件的表格渲染一并完成。
    phase: 'T2',
  },
  {
    id: 'identityUpwardProbes',
    label: '表格身份向上探测处数（I10）',
    direction: 'down',
    target: 0,
    phase: 'T2',
  },
  {
    id: 'exportTableWrapper',
    label: '导出是否输出 <table>（I9）',
    direction: 'up',
    target: 1,
    phase: 'T7',
  },
  {
    id: 'toolbarNonIconLabels',
    label: '表格工具条非图标标签数（F-Vis-10）',
    direction: 'down',
    target: 0,
    phase: 'T6',
  },
  {
    id: 'nativeTableElements',
    label: '组件层原生表格元素数（ADR-2 防回潮）',
    direction: 'down',
    target: 0,
    phase: 'T3',
  },
  {
    id: 'rowLevelScrollOverflowRules',
    label: '行级 overflow-x 规则数（I1）',
    direction: 'down',
    target: 0,
    // 归属波次 T3 → T8（2026-09-14 相位修正）：
    //   T3 交付岛（`TableBlock.tsx` + `styles/table-island.css`）**与旧路径并行**，
    //   开关默认关闭（`00-总方案` §9.2 规则 2），故旧路径的 `.line-table{overflow-x}`
    //   必须保留；真正的**删除**发生在 T8（旧路径清退）。T3 的结构契约由
    //   tests/gate/table-invariants.test.ts 的「岛单滚动所有者」断言承担。
    phase: 'T8',
  },
  {
    id: 'lastRowScrollbarHacks',
    label: 'table-last-row 滚动条 hack 处数（I1）',
    direction: 'down',
    target: 0,
    // 同上：T3 阶段旧路径仍在（开关默认关闭），hack 随 T8 旧路径清退一并删除。
    phase: 'T8',
  },
  {
    id: 'selectionInsetShadowSites',
    label: '逐格 inset 拼选区边处数（I6）',
    direction: 'down',
    target: 0,
    phase: 'T5',
  },
  {
    id: 'perCellWidthWritebackSites',
    label: 'per-cell 列宽写回处数（ADR-4）',
    direction: 'down',
    target: 0,
    // 归属波次 T3 → T8（2026-09-14 相位修正）：
    //   岛的列宽走栅格模板（grid 忽略 flex），故岛**不受**该写回影响；
    //   但旧路径仍需它，删除属 T8。岛侧的结构契约见
    //   tests/gate/table-invariants.test.ts（岛用 buildGridTemplate 驱动列宽）。
    phase: 'T8',
  },
  {
    id: 'oracleTableReadsWidths',
    label: '高度预言机读列宽真源（ADR-5）',
    direction: 'up',
    target: 1,
    phase: 'T4',
  },
];

/** 运行时/DOM 类不变量——尚未实现，登记以免静默略过 */
export const PENDING_RUNTIME_INVARIANTS = [
  { id: 'I1-runtime', label: '单横向滚动所有者实例计数', phase: 'T3' },
  { id: 'I2', label: '列宽无震荡（重复测量恒等）', phase: 'T4' },
  { id: 'I3', label: '表格高度上报源计数 == 1', phase: 'T4' },
  { id: 'I4', label: '表格上方增删行后列宽/对齐/选区不变', phase: 'T2' },
  { id: 'I6', label: '选区单矩形与角单元格几何一致（≤1px）', phase: 'T5' },
  { id: 'I7', label: '增删行列后选区重映射', phase: 'T5' },
  { id: 'I8', label: '无同一源码行重复渲染（含行序完整性）', phase: 'T4' },
];

// ── 工具 ─────────────────────────────────────────────────────

function read(relPath) {
  const p = join(ROOT, relPath);
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8');
}

function countMatches(text, re) {
  return (text.match(re) ?? []).length;
}

// ── 指标实现 ─────────────────────────────────────────────────
// 每个实现只做「计数」这一件事；判定交给棘轮。

const IMPLS = {
  // I5：表头语义应唯一来自 TableModel.hasHeader，不得由「首行即表头」二次推导
  headerDerivationSites() {
    const t = read('src/components/BlockRenderer.tsx');
    return countMatches(t, /isHeaderRow\s*=\s*tableId\s*===/g);
  },

  // I10：表格身份不得依赖「向上遍历、按行文本前缀」探测
  identityUpwardProbes() {
    const t = read('src/components/MarkdownEngine.tsx');
    return countMatches(t, /startsWith\(\s*['"]\|['"]\s*\)/g);
  },

  // I9：导出投影必须输出合法 <table> 包裹
  exportTableWrapper() {
    const t = read('src/core/renderToHtml.ts');
    return countMatches(t, /<table[\s>]/g) > 0 ? 1 : 0;
  },

  // F-Vis-10：工具条按钮必须是图标，不得是文字/基础符号
  toolbarNonIconLabels() {
    const t = read('src/components/TableToolbar.tsx');
    // ① 带文字标签的按钮（合并/拆分）
    const textSpans = countMatches(t, /toolbar-btn-text/g);
    // ② 直接以裸文本/符号作为子节点的按钮（+行↑ / B / </> …）
    const bareTextButtons = countMatches(
      t,
      /title="[^"]*"\s*>\s*([^<\s][^<]*?)\s*<\/button>/g
    );
    // ③ 名为 icon 但实为字符字形的 span（⇤ / ⇔ / ⇥ …）——组件图标不会命中
    const bareGlyphIcons = countMatches(t, /toolbar-btn-icon">\s*([^<\s])/g);
    return textSpans + bareTextButtons + bareGlyphIcons;
  },

  // ADR-2 防回潮：组件层不得改用原生表格元素（原生表格不可按行虚拟化）
  nativeTableElements() {
    const t = read('src/components/BlockRenderer.tsx') + read('src/components/InlineRenderer.tsx');
    return countMatches(t, /<table[\s>]|<thead[\s>]|<tbody[\s>]|<colgroup[\s>]|<tr[\s>]|<td[\s>]|<th[\s>]/g);
  },

  // I1：行级横向滚动所有权（应为 0，滚动所有权归表格岛）
  rowLevelScrollOverflowRules() {
    const t = read('src/index.css');
    // 取 .line-table 规则块（不含 .table-last-row）内的 overflow-x 声明
    const blocks = [...t.matchAll(/\.line-table\s*\{([^}]*)\}/g)].map((m) => m[1]);
    return blocks.reduce((n, b) => n + countMatches(b, /overflow-x\s*:/g), 0);
  },

  // I1：「仅最后一行显示滚动条」的显式 hack 处数
  lastRowScrollbarHacks() {
    const css = countMatches(read('src/index.css'), /table-last-row/g);
    const tsx = countMatches(read('src/components/BlockRenderer.tsx'), /table-last-row/g);
    return css + tsx;
  },

  // I6：选区不得由逐格 inset box-shadow 拼边
  selectionInsetShadowSites() {
    const t = read('src/components/InlineRenderer.tsx');
    return countMatches(t, /\binset\b/g);
  },

  // ADR-4：列宽不得以 per-cell flex 写回
  perCellWidthWritebackSites() {
    const t = read('src/components/InlineRenderer.tsx');
    const flexBasis = countMatches(t, /flex:\s*`0 0 \$\{/g);
    const fallback = countMatches(t, /flex:\s*['"]1 0 auto['"]/g);
    return flexBasis + fallback;
  },

  // ADR-5：高度预言机必须读列宽真源（而非按容器宽自行估算）
  oracleTableReadsWidths() {
    const t = read('src/core/HeightMap.ts');
    return countMatches(t, /tableWidths/g) > 0 ? 1 : 0;
  },
};

// ── 运行 ─────────────────────────────────────────────────────

export function runChecks() {
  const results = [];
  for (const m of METRICS) {
    const impl = IMPLS[m.id];
    if (!impl) {
      results.push({ ...m, value: null, error: '未实现' });
      continue;
    }
    results.push({ ...m, value: impl(), error: null });
  }
  return results;
}

export function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/** 棘轮判定：返回回退的指标列表（空数组 = 通过） */
export function findRegressions(results, baseline) {
  if (!baseline?.metrics) return [];
  const regressions = [];
  for (const r of results) {
    if (r.value === null) continue;
    const b = baseline.metrics[r.id];
    if (!b || typeof b.value !== 'number') continue;
    const worse = r.direction === 'down' ? r.value > b.value : r.value < b.value;
    if (worse) regressions.push({ ...r, baselineValue: b.value });
  }
  return regressions;
}

function formatRow(r, baselineValue) {
  const b = typeof baselineValue === 'number' ? String(baselineValue) : '—';
  const met = r.value === null ? '?' : r.value === r.target ? '✓' : '·';
  return `  ${met} ${r.id.padEnd(30)} 现状=${String(r.value ?? '?').padStart(4)}  基线=${b.padStart(4)}  目标=${String(r.target).padStart(2)} (${r.direction})  [${r.phase}] ${r.label}`;
}

function main() {
  const args = process.argv.slice(2);
  const updateBaseline = args.includes('--update-baseline');
  const reportOnly = args.includes('--report');

  const results = runChecks();
  const baseline = loadBaseline();

  console.log('表格不变量门禁（table-systemic-remediation · T0）');
  console.log(`  权威：docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md §6`);
  console.log(`  基线：tests/gate/table-invariants-baseline.json${baseline ? '' : '（尚无基线）'}`);
  console.log('');
  for (const r of results) {
    console.log(formatRow(r, baseline?.metrics?.[r.id]?.value));
  }

  const met = results.filter((r) => r.value !== null && r.value === r.target).length;
  const measurable = results.filter((r) => r.value !== null).length;
  console.log('');
  console.log(`  达标 ${met}/${measurable} 指标（其余为现状待收敛项，见各指标 [phase]）`);
  console.log(
    `  运行时类不变量待后续波次补入 ${PENDING_RUNTIME_INVARIANTS.length} 项：` +
      PENDING_RUNTIME_INVARIANTS.map((p) => `${p.id}(${p.phase})`).join(' / ')
  );

  if (updateBaseline) {
    const payload = {
      note:
        '表格不变量棘轮基线。由 scripts/check-table-invariants.mjs --update-baseline 生成；' +
        '基线只允许单向收紧（不得回退）。权威定义见 docs/table-systemic-remediation/00-总方案 §6。',
      updatedAt: new Date().toISOString(),
      metrics: Object.fromEntries(results.map((r) => [r.id, { value: r.value, direction: r.direction, target: r.target, phase: r.phase }])),
      pendingRuntime: PENDING_RUNTIME_INVARIANTS,
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    console.log(`\n✓ 已冻结基线（${results.length} 指标）→ tests/gate/table-invariants-baseline.json`);
    process.exit(0);
  }

  if (reportOnly) {
    console.log('\n（--report：只打印，不判定）');
    process.exit(0);
  }

  const regressions = findRegressions(results, baseline);
  if (regressions.length > 0) {
    console.error(`\n✗ check-table-invariants：${regressions.length} 项不变量回退（棘轮只允许单向收紧）`);
    for (const r of regressions) {
      console.error(`    ${r.id}  基线=${r.baselineValue} → 现状=${r.value}  [${r.phase}] ${r.label}`);
    }
    process.exit(1);
  }

  console.log('\n✓ check-table-invariants：0 项回退（棘轮通过）');
}

// CLI 直跑判定（被 import 时不执行）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
