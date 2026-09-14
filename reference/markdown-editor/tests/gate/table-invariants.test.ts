// ============================================================
// 表格不变量契约测试（战役 table-systemic-remediation · 任务单元 T0）
//
// 权威来源：docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md §6（I1–I10）
//           docs/table-systemic-remediation/08-分维-验收矩阵与防回归门禁.md §2、§8
//
// 本文件是**契约层**，不是行为层：
//   ① 校验指标注册表自洽（每个指标有方向/目标/归属波次，且可实现为数值）；
//   ② 校验棘轮基线存在且**不回退**（棘轮只允许单向收紧）；
//   ③ 用魔鬼用例校验棘轮判定逻辑本身（防止门禁被写成恒真）；
//   ④ 登记运行时类不变量，防止「未实现」被静默略过。
// ============================================================
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  METRICS,
  PENDING_RUNTIME_INVARIANTS,
  findRegressions,
  loadBaseline,
  runChecks,
} from '../../scripts/check-table-invariants.mjs';

/** 计划中已登记的任务单元（00-总方案 §7）；指标归属波次必须落在其中 */
const KNOWN_PHASES = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'];

describe('表格不变量门禁 · 指标注册表', () => {
  it('指标 id 唯一', () => {
    const ids = METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个指标都声明了方向 / 目标 / 归属波次 / 标签', () => {
    for (const m of METRICS) {
      expect(m.id, '指标缺 id').toBeTruthy();
      expect(m.label, `${m.id} 缺 label`).toBeTruthy();
      expect(['down', 'up'], `${m.id} 方向非法`).toContain(m.direction);
      expect(typeof m.target, `${m.id} 目标非数值`).toBe('number');
      expect(KNOWN_PHASES, `${m.id} 归属波次 ${m.phase} 未在计划中登记`).toContain(m.phase);
    }
  });

  it('每个指标都可实现为数值（无未实现占位）', () => {
    const results = runChecks();
    expect(results.length).toBe(METRICS.length);
    for (const r of results) {
      expect(r.error, `${r.id} 未实现：${r.error}`).toBeNull();
      expect(typeof r.value, `${r.id} 未产出数值`).toBe('number');
      expect(r.value, `${r.id} 产出负值`).toBeGreaterThanOrEqual(0);
    }
  });

  it('已达标指标不得超过当前战役进度允许的上限', () => {
    // 这是「防止门禁被写成恒真」的护栏：上限按战役实际进度**只允许上调**，不得下调。
    //   基线期（T0）：1（仅 nativeTableElements 天然达标）
    //   T2 完成后：3（+ headerDerivationSites / identityUpwardProbes）
    //   T4a 完成后：4（+ oracleTableReadsWidths）
    // 每次上调都必须在提交信息与 00-总方案 §12 续航锚点中留痕。
    const MET_PROGRESS_CAP = 4;
    const met = runChecks().filter((r) => r.value === r.target);
    expect(met.length).toBeLessThanOrEqual(MET_PROGRESS_CAP);
    expect(met.length).toBeGreaterThanOrEqual(1);
  });
});

describe('表格不变量门禁 · 棘轮判定逻辑（魔鬼用例）', () => {
  const base = { metrics: { a: { value: 3 }, b: { value: 0 } } };

  it('down 指标变大 → 判为回退', () => {
    const regs = findRegressions(
      [{ id: 'a', direction: 'down', value: 4 }],
      base
    );
    expect(regs.map((r) => r.id)).toEqual(['a']);
  });

  it('down 指标变小或持平 → 不算回退', () => {
    expect(findRegressions([{ id: 'a', direction: 'down', value: 2 }], base)).toEqual([]);
    expect(findRegressions([{ id: 'a', direction: 'down', value: 3 }], base)).toEqual([]);
  });

  it('up 指标变小 → 判为回退；变大或持平不算', () => {
    expect(findRegressions([{ id: 'b', direction: 'up', value: -1 }], base).length).toBe(1);
    expect(findRegressions([{ id: 'b', direction: 'up', value: 0 }], base)).toEqual([]);
    expect(findRegressions([{ id: 'b', direction: 'up', value: 1 }], base)).toEqual([]);
  });

  it('无基线时不判回退（基线期豁免）', () => {
    expect(findRegressions([{ id: 'a', direction: 'down', value: 999 }], null)).toEqual([]);
  });

  it('指标缺数值（未实现）不参与判定，不得静默当作通过之外的副作用', () => {
    expect(findRegressions([{ id: 'a', direction: 'down', value: null }], base)).toEqual([]);
  });
});

describe('表格不变量门禁 · 棘轮基线', () => {
  it('基线已冻结（T0 产出物，缺失即视为 T0 未完成）', () => {
    const baseline = loadBaseline();
    expect(baseline, '缺少 tests/gate/table-invariants-baseline.json').toBeTruthy();
    expect(baseline.metrics, '基线缺少 metrics 段').toBeTruthy();
  });

  it('基线覆盖全部已声明指标', () => {
    const baseline = loadBaseline();
    for (const m of METRICS) {
      expect(baseline.metrics[m.id], `基线缺指标 ${m.id}`).toBeTruthy();
      expect(typeof baseline.metrics[m.id].value, `基线 ${m.id} 非数值`).toBe('number');
    }
  });

  it('当前状态相对基线 0 回退', () => {
    const regs = findRegressions(runChecks(), loadBaseline());
    expect(regs.map((r) => `${r.id}: ${r.baselineValue} → ${r.value}`)).toEqual([]);
  });
});

describe('表格不变量门禁 · 运行时类不变量登记', () => {
  it('运行时类不变量必须登记且归属波次合法（禁止静默略过）', () => {
    expect(PENDING_RUNTIME_INVARIANTS.length).toBeGreaterThan(0);
    for (const p of PENDING_RUNTIME_INVARIANTS) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(KNOWN_PHASES).toContain(p.phase);
    }
  });

  it('I1–I10 全部被覆盖（静态指标或运行时登记，二者必有其一）', () => {
    const covered = new Set([
      'I1',
      'I1-runtime',
      'I2',
      'I3',
      'I4',
      'I5',
      'I6',
      'I7',
      'I8',
      'I9',
      'I10',
    ]);
    // 静态侧覆盖：I1（两条规则指标）、I5、I6、I9、I10
    const staticCovered = [
      'headerDerivationSites',
      'identityUpwardProbes',
      'exportTableWrapper',
      'rowLevelScrollOverflowRules',
      'lastRowScrollbarHacks',
      'selectionInsetShadowSites',
    ];
    for (const id of staticCovered) {
      expect(METRICS.map((m) => m.id), `静态指标 ${id} 缺失`).toContain(id);
    }
    // 运行时侧覆盖：I1-runtime、I2、I3、I4、I6、I7、I8
    const runtimeIds = PENDING_RUNTIME_INVARIANTS.map((p) => p.id);
    for (const id of ['I1-runtime', 'I2', 'I3', 'I4', 'I6', 'I7', 'I8']) {
      expect(runtimeIds, `运行时不变量 ${id} 未登记`).toContain(id);
      expect(covered, `不变量 ${id} 不在 I1–I10 覆盖集`).toContain(id);
    }
  });
});

describe('表格岛 · 结构契约（T3 / I1 的静态形态）', () => {
  const read = (p: string): string =>
    readFileSync(new URL(`../../${p}`, import.meta.url), 'utf-8');

  /** 剥离注释后再做结构断言——注释里提到 `overflow-x` 不构成滚动所有者 */
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('岛样式**恰好一个**横向滚动所有者（I1 的静态形态）', () => {
    const css = stripComments(read('src/styles/table-island.css'));
    expect(css.match(/overflow-x\s*:/g) ?? []).toHaveLength(1);
  });

  it('岛组件自身不声明任何滚动（滚动所有权归样式类）', () => {
    const tsx = stripComments(read('src/components/TableBlock.tsx'));
    expect(tsx.match(/overflow-x|overflowX/g) ?? []).toEqual([]);
  });

  it('岛的行容器**不得**成为滚动所有者', () => {
    const css = read('src/styles/table-island.css');
    const rowBlock = css.match(/\.table-island-row\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rowBlock).not.toContain('overflow');
  });

  it('岛用栅格模板驱动列宽（ADR-4 唯一列宽真源），而非 per-cell flex 写回', () => {
    const tsx = read('src/components/TableBlock.tsx');
    expect(tsx).toContain('buildGridTemplate');
    expect(tsx).toContain('gridTemplateColumns');
    // 不得出现 per-cell flex 写回（旧路径形态）
    expect(tsx.includes('flex: `0 0 ')).toBe(false);
  });

  it('特性开关**默认关闭**（B 期新渲染路径必须可一键关闭，§9.2 规则 2）', async () => {
    const mod = await import('../../src/core/tableIsland');
    expect(mod.isTableIslandEnabled()).toBe(false);
  });

  it('岛内的行数据由外层装配（不自行解析源码，避免第二套行解析）', () => {
    const tsx = read('src/components/TableBlock.tsx');
    // 岛不得引用 parser（行解析唯一真源在 MarkdownEngine / parser）
    expect(tsx).not.toContain("from '../core/parser'");
    expect(tsx).not.toContain('parseLine');
  });
});
