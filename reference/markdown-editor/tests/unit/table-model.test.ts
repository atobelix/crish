// ============================================================
// TableModel 单元测试（战役 table-systemic-remediation · T1）
//
// 权威：docs/table-systemic-remediation/03-分维-表格语义模型与身份SSOT.md
//       docs/table-systemic-remediation/08-分维-验收矩阵与防回归门禁.md（I5）
//
// 覆盖：表头判定 / 列数归一与补齐 / 尾随空单元格 / 前导单元格 / 列对齐 /
//       跨列 `>` / 跨行 `^` / 裸管道行 / 表区间解析 / 缓存 / 文本与 Token 双路径一致
// ============================================================
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildTableModel,
  clearTableModelCache,
  getTableModel,
  isSeparatorText,
  parseAlignments,
  resolveTableStartLine,
  splitRowCells,
  tableModelCacheSize,
} from '../../src/core/tableModel';

/** 便捷构造：由行数组生成访问器 */
function doc(lines: string[]) {
  return {
    getLine: (i: number) => lines[i] ?? '',
    startLine: 0,
    endLine: lines.length - 1,
  };
}

beforeEach(() => clearTableModelCache());

describe('TableModel · 分隔行识别', () => {
  it('识别带前导/尾随管道的分隔行', () => {
    expect(isSeparatorText('| --- | --- |')).toBe(true);
    expect(isSeparatorText('| :--- | ---: |')).toBe(true);
    expect(isSeparatorText('| :---: | --- |')).toBe(true);
  });

  it('识别无前导管道的分隔行', () => {
    expect(isSeparatorText('--- | ---')).toBe(true);
  });

  it('**单列分隔行**（`| --- |` / `| - |`）不判为分隔行——与 parser 同源现状，固化不改', () => {
    // 正则要求「至少两个破折号组」，故单列表格的分隔行不被识别。
    // parser.ts:2305-2307 使用**同一个正则**，故此为既有行为（单列 GFM 表格未支持），
    // 不是本模块的缺陷；本战役不修改该行为（改它会波及 parser 与既有断言）。
    expect(isSeparatorText('| --- |')).toBe(false);
    expect(isSeparatorText('| - |')).toBe(false);
  });

  it('不把数据行误判为分隔行', () => {
    expect(isSeparatorText('| a | b |')).toBe(false);
    expect(isSeparatorText('| 1 | 2 |')).toBe(false);
    expect(isSeparatorText('')).toBe(false);
  });

  it('超长行不判定（与 parser 的 10000 字符上限对齐）', () => {
    expect(isSeparatorText('|' + '-'.repeat(10_001) + '|')).toBe(false);
  });
});

describe('TableModel · 单元格切分（文本路径）', () => {
  it('带前导与尾随管道', () => {
    expect(splitRowCells('| a | b |')).toEqual(['a', 'b']);
  });

  it('无前导/尾随管道（裸管道行）', () => {
    expect(splitRowCells('a | b')).toEqual(['a', 'b']);
  });

  it('尾随空单元格被丢弃（与 parser groupTableCells 对齐）', () => {
    expect(splitRowCells('| a | b |')).toEqual(['a', 'b']);
    expect(splitRowCells('| a | |')).toEqual(['a', '']);
  });

  it('前导管道之前有内容时视为第 0 列', () => {
    expect(splitRowCells('x| a | b |')).toEqual(['x', 'a', 'b']);
  });

  it('空行 → 无单元格', () => {
    expect(splitRowCells('')).toEqual([]);
  });
});

describe('TableModel · 列对齐解析', () => {
  it('左/中/右/未声明', () => {
    expect(parseAlignments('| --- | :---: | ---: | :--- |')).toEqual([
      'none',
      'center',
      'right',
      'left',
    ]);
  });
});

describe('TableModel · 表头判定（I5 唯一真源）', () => {
  it('分隔行在次行 → 首行为表头', () => {
    const m = buildTableModel(doc(['| H1 | H2 |', '| --- | --- |', '| a | b |']));
    expect(m.hasHeader).toBe(true);
    expect(m.separatorLine).toBe(1);
    expect(m.header?.cells.map((c) => c.raw)).toEqual(['H1', 'H2']);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].cells.map((c) => c.raw)).toEqual(['a', 'b']);
  });

  it('分隔行本身就是首行 → 无表头', () => {
    const m = buildTableModel(doc(['| --- | --- |', '| a | b |']));
    expect(m.hasHeader).toBe(false);
    expect(m.separatorLine).toBe(0);
    expect(m.header).toBeNull();
    expect(m.rows).toHaveLength(1);
  });

  it('无分隔行 → 无表头（裸管道行块，非 GFM 表格）', () => {
    const m = buildTableModel(doc(['| a | b |', '| c | d |']));
    expect(m.hasHeader).toBe(false);
    expect(m.separatorLine).toBeNull();
    expect(m.rows).toHaveLength(2);
  });

  it('分隔行在第 3 行（非次行）→ 不认作表头分隔', () => {
    const m = buildTableModel(doc(['| a | b |', '| c | d |', '| --- | --- |']));
    expect(m.hasHeader).toBe(false);
    expect(m.separatorLine).toBeNull();
  });
});

describe('TableModel · 列数归一与补齐', () => {
  it('短行补齐并标记 isPadding', () => {
    const m = buildTableModel(doc(['| H1 | H2 | H3 |', '| --- | --- | --- |', '| a | b |']));
    expect(m.cols).toBe(3);
    const last = m.rows[0].cells;
    expect(last).toHaveLength(3);
    expect(last[2].raw).toBe('');
    expect(last[2].isPadding).toBe(true);
    expect(last[0].isPadding).toBe(false);
  });

  it('列数取「数据行」与「分隔行」的最大值', () => {
    const m = buildTableModel(doc(['| a |', '| --- | --- | --- |']));
    expect(m.cols).toBe(3);
  });

  it('列对齐长度恒为 cols', () => {
    const m = buildTableModel(doc(['| H1 | H2 | H3 |', '| --- | :---: |', '| a | b | c |']));
    expect(m.alignments).toHaveLength(m.cols);
  });
});

describe('TableModel · 合并单元格', () => {
  it('`>` 跨列：前一个非从属格成为 master 并累加 colSpan', () => {
    const m = buildTableModel(doc(['| A | > | C |', '| --- | --- | --- |']));
    // 该行即表头行（分隔行在其后），故断言在 header 上
    const cells = m.header!.cells;
    const [a, gt, c] = cells;
    expect(a.isMergedMaster).toBe(true);
    expect(a.colSpan).toBe(2);
    expect(gt.isMergedSlave).toBe(true);
    expect(gt.mergeType).toBe('horizontal');
    expect(c.colSpan).toBe(1);
  });

  it('`>` 跨列（数据行）：连续两个 `>` 使主格 colSpan = 3', () => {
    const m = buildTableModel(doc(['| H1 | H2 | H3 |', '| --- | --- | --- |', '| A | > | > |']));
    const [a, g1, g2] = m.rows[0].cells;
    expect(a.colSpan).toBe(3);
    expect(g1.isMergedSlave).toBe(true);
    expect(g2.isMergedSlave).toBe(true);
  });

  it('`^` 跨行：向上连续计数得出 master 的 rowSpan（裁决 R10）', () => {
    const m = buildTableModel(
      doc(['| H | X |', '| --- | --- |', '| a | 1 |', '| ^ | 2 |', '| ^ | 3 |'])
    );
    // 第 0 列：a 为 master，rowSpan 应为 3（自身 + 两个 ^）
    expect(m.rows[0].cells[0].isMergedMaster).toBe(true);
    expect(m.rows[0].cells[0].rowSpan).toBe(3);
    expect(m.rows[1].cells[0].isMergedSlave).toBe(true);
    expect(m.rows[1].cells[0].mergeType).toBe('vertical');
    // 第 1 列不受影响
    expect(m.rows[0].cells[1].rowSpan).toBe(1);
  });

  it('孤立 `^`（其上方无 master）不崩、不产生越界', () => {
    const m = buildTableModel(doc(['| ^ |', '| --- |', '| a |']));
    expect(m.rows[0].cells[0].isMergedSlave).toBe(true);
    expect(m.rows[0].cells[0].rowSpan).toBe(1);
  });
});

describe('TableModel · 身份与源区间', () => {
  it('缺省身份为 table-<startLine>（T2 将接管为稳定块身份）', () => {
    const m = buildTableModel({ startLine: 7, endLine: 9, getLine: (i) => ['| a |', '| --- |', '| b |'][i - 7] ?? '' });
    expect(m.id).toBe('table-7');
    expect(m.sourceRange).toEqual({ startLine: 7, endLine: 9 });
  });

  it('可显式传入身份（T2 的稳定块身份接入点）', () => {
    const m = buildTableModel({ startLine: 0, endLine: 1, getLine: (i) => ['| a |', '| --- |'][i] ?? '', id: 'blk-42' });
    expect(m.id).toBe('blk-42');
  });
});

describe('TableModel · 表区间解析（单一实现）', () => {
  const lines = ['para', '| a | b |', '| --- | --- |', '| 1 | 2 |', 'para2'];

  it('从表内任意一行都能回到表格起始行', () => {
    for (const i of [1, 2, 3]) {
      expect(resolveTableStartLine(i, (n) => lines[n])).toBe(1);
    }
  });

  it('表外行返回 null', () => {
    expect(resolveTableStartLine(0, (n) => lines[n])).toBeNull();
    expect(resolveTableStartLine(4, (n) => lines[n])).toBeNull();
  });

  it('优先使用 parser 行类型（裁决 R2：成表判定以行类型为准）', () => {
    // 裸管道行（不以 `|` 开头）——文本口径会漏判，行类型口径正确识别
    const raw = ['para', 'a | b | c', '| --- | --- | --- |', '| 1 | 2 | 3 |'];
    const types = ['body', 'table_row', 'table_separator', 'table_row'];
    const byType = resolveTableStartLine(3, (n) => raw[n], (n) => types[n]);
    expect(byType).toBe(1);
    // 文本口径（未提供行类型）在第 1 行停住 → 起始行误判为 2（正确为 1）。
    // 该偏差属已登记缺陷 C16，此处**固化现状**，避免本战役无意改变既有行为。
    expect(resolveTableStartLine(3, (n) => raw[n])).toBe(2);
  });
});

describe('TableModel · 缓存', () => {
  const lines = ['| a | b |', '| --- | --- |', '| 1 | 2 |'];
  const opts = () => ({ ...doc(lines), revision: 1 });

  it('同一 revision 内重复取模型返回同一对象', () => {
    const a = getTableModel(opts());
    const b = getTableModel(opts());
    expect(a).toBe(b);
    expect(tableModelCacheSize()).toBe(1);
  });

  it('内容变化 → 重建（签名不符）', () => {
    const a = getTableModel(opts());
    lines[2] = '| 9 | 9 |';
    const b = getTableModel(opts());
    expect(b).not.toBe(a);
    expect(b.rows[0].cells.map((c) => c.raw)).toEqual(['9', '9']);
    lines[2] = '| 1 | 2 |';
  });

  it('不同 revision → 不同缓存条目', () => {
    getTableModel({ ...doc(lines), revision: 1 });
    getTableModel({ ...doc(lines), revision: 2 });
    expect(tableModelCacheSize()).toBe(2);
  });

  it('clearTableModelCache 清空', () => {
    getTableModel(opts());
    clearTableModelCache();
    expect(tableModelCacheSize()).toBe(0);
  });
});

describe('TableModel · 文本路径与 Token 路径一致', () => {
  it('两条路径产出相同语义（列数 / 表头 / 对齐）', () => {
    const lines = ['| H1 | H2 |', '| --- | :---: |', '| a | b |'];
    const textOnly = buildTableModel(doc(lines));
    const withTokens = buildTableModel({
      ...doc(lines),
      getLineNode: (i) => ({
        id: `l${i}`,
        type: i === 1 ? 'table_separator' : 'table_row',
        raw: lines[i],
        inlineTokens: lines[i]
          .split('|')
          .slice(1, -1)
          .map((c, k) => ({
            type: 'table_cell' as const,
            raw: c.trim(),
            content: '',
            localOffset: k,
            length: c.length,
            colSpan: 1,
            rowSpan: 1,
          })),
        length: lines[i].length,
        localOffset: 0,
      }),
    });
    expect(withTokens.cols).toBe(textOnly.cols);
    expect(withTokens.hasHeader).toBe(textOnly.hasHeader);
    expect(withTokens.alignments).toEqual(textOnly.alignments);
    expect(withTokens.rows[0].cells.map((c) => c.raw)).toEqual(
      textOnly.rows[0].cells.map((c) => c.raw)
    );
  });
});
