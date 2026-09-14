// ============================================================
// 表格身份稳定化 单元测试（战役 table-systemic-remediation · T2）
//
// 权威：docs/table-systemic-remediation/03-分维-表格语义模型与身份SSOT.md
//       docs/table-systemic-remediation/00-总方案-表格子系统端到端重构.md（ADR-3 / 裁决 R18）
//       不变量 I4：表格**上方**插入/删除行后，列宽 / 列对齐 / 选区均不变
//
// 覆盖：身份与行号解耦 / 签名与位置兜底两级匹配 / 重复表格区分 /
//       表头判定唯一入口 / 列对齐投影（none→left）/ 分隔行查询 /
//       注册表清理 / TableStore 自愈读取与陈旧键清理
// ============================================================
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getTableIdentity,
  getTableSeparatorLine,
  isTableHeaderRow,
  observeTableRange,
  pruneTableIdentities,
  readTableAlignments,
  resetTableIdentities,
  resolveTableId,
  tableIdentityCount,
} from '../../src/core/tableIdentity';
import { useTableStore } from '../../src/core/TableStore';

const getter = (lines: string[]) => (i: number) => lines[i] ?? '';

beforeEach(() => {
  resetTableIdentities();
  useTableStore.setState({
    tableWidths: {},
    tableScrollLeft: {},
    tableAlignments: {},
    selectedCell: null,
    isDraggingCell: false,
  });
});

describe('TableIdentity · 身份与行号解耦（I4 核心）', () => {
  it('表格**上方**插入行后身份不变', () => {
    const before = ['para', '| H1 | H2 |', '| --- | --- |', '| a | b |'];
    const id1 = resolveTableId(getter(before), 1);
    expect(id1).toBeDefined();

    const after = ['p1', 'p2', 'p3', 'para', '| H1 | H2 |', '| --- | --- |', '| a | b |'];
    const id2 = resolveTableId(getter(after), 4);
    expect(id2).toBe(id1);
  });

  it('表格**上方**删除行后身份不变', () => {
    const before = ['p1', 'p2', 'p3', '| H1 | H2 |', '| --- | --- |', '| a | b |'];
    const id1 = resolveTableId(getter(before), 3);
    const after = ['| H1 | H2 |', '| --- | --- |', '| a | b |'];
    const id2 = resolveTableId(getter(after), 0);
    expect(id2).toBe(id1);
  });

  it('表内**数据行**增删后身份不变（签名只含表头与列数）', () => {
    const id1 = resolveTableId(getter(['| H1 | H2 |', '| --- | --- |', '| a | b |']), 0);
    const id2 = resolveTableId(
      getter(['| H1 | H2 |', '| --- | --- |', '| a | b |', '| c | d |', '| e | f |']),
      0
    );
    expect(id2).toBe(id1);
  });

  it('改**列对齐**后身份不变（对齐不属于签名）', () => {
    const id1 = resolveTableId(getter(['| H1 | H2 |', '| --- | --- |', '| a | b |']), 0);
    const id2 = resolveTableId(getter(['| H1 | H2 |', '| :---: | ---: |', '| a | b |']), 0);
    expect(id2).toBe(id1);
  });

  it('**表头文本被编辑** → 换新身份（已登记限制，见模块头注释）', () => {
    // 设计取舍：匹配只认 (签名, 序位)，不引入「位置最近」兜底——
    // 实测该兜底会把身份偷给邻近的另一张表（比它要解决的问题更严重）。
    // 代价：改表头会重置该表的列宽/对齐（下次测量自愈）。相对重构前
    // 「表格上方任何编辑都重置」已是严格改善；T8 随表格岛落地时收敛。
    const id1 = resolveTableId(getter(['para', '| H1 | H2 |', '| --- | --- |', '| a | b |']), 1);
    const id2 = resolveTableId(getter(['para', '| H1x | H2 |', '| --- | --- |', '| a | b |']), 1);
    expect(id2).not.toBe(id1);
  });

  it('表内任意一行解析出的身份一致', () => {
    const lines = ['| H1 | H2 |', '| --- | --- |', '| a | b |', '| c | d |'];
    const ids = [0, 1, 2, 3].map((i) => resolveTableId(getter(lines), i));
    expect(new Set(ids).size).toBe(1);
  });
});

describe('TableIdentity · 多表与边界', () => {
  it('非表格行返回 undefined', () => {
    expect(resolveTableId(getter(['para', '| a | b |']), 0)).toBeUndefined();
    expect(resolveTableId(getter([]), 0)).toBeUndefined();
    expect(resolveTableId(getter(['| a | b |']), -1)).toBeUndefined();
  });

  it('两张**签名相同**的表格获得不同身份，且各自稳定', () => {
    const lines = [
      '| H1 | H2 |',
      '| --- | --- |',
      '| a | b |',
      '',
      '| H1 | H2 |',
      '| --- | --- |',
      '| c | d |',
    ];
    const t1 = resolveTableId(getter(lines), 0);
    const t2 = resolveTableId(getter(lines), 4);
    expect(t1).not.toBe(t2);

    // 上方插入行后，两表身份均保持
    const shifted = ['x', 'y', ...lines];
    expect(resolveTableId(getter(shifted), 2)).toBe(t1);
    expect(resolveTableId(getter(shifted), 6)).toBe(t2);
  });

  it('无分隔行的裸管道行块也能获得稳定身份', () => {
    const id1 = resolveTableId(getter(['| a | b |', '| c | d |']), 0);
    const id2 = resolveTableId(getter(['p', '| a | b |', '| c | d |']), 1);
    expect(id1).toBe(id2);
    expect(getTableIdentity(id1)?.hasHeader).toBe(false);
    expect(getTableIdentity(id1)?.separatorLine).toBeNull();
  });
});

describe('TableIdentity · 消费侧查询（渲染层不再解码身份格式）', () => {
  it('isTableHeaderRow 仅在「有表头且为首行」时为 true', () => {
    const lines = ['| H1 | H2 |', '| --- | --- |', '| a | b |'];
    const id = resolveTableId(getter(lines), 0);
    expect(isTableHeaderRow(id, 0)).toBe(true);
    expect(isTableHeaderRow(id, 2)).toBe(false);
    expect(isTableHeaderRow(undefined, 0)).toBe(false);
  });

  it('分隔行居首（无表头）时 isTableHeaderRow 恒为 false', () => {
    const lines = ['| --- | --- |', '| a | b |'];
    const id = resolveTableId(getter(lines), 0);
    expect(isTableHeaderRow(id, 0)).toBe(false);
    expect(getTableIdentity(id)?.hasHeader).toBe(false);
  });

  it('getTableSeparatorLine 返回分隔行行号（无分隔行 → null）', () => {
    const withSep = resolveTableId(getter(['| H | X |', '| --- | --- |', '| a | b |']), 0);
    expect(getTableSeparatorLine(withSep)).toBe(1);
    const withoutSep = resolveTableId(getter(['| a | b |', '| c | d |']), 0);
    expect(getTableSeparatorLine(withoutSep)).toBeNull();
  });

  it('readTableAlignments 投影为三值（none → left，与既有 parseTableAlignments 行为一致）', () => {
    const lines = ['| H1 | H2 | H3 | H4 |', '| --- | :---: | ---: | :--- |', '| a | b | c | d |'];
    const id = resolveTableId(getter(lines), 0);
    expect(readTableAlignments(id)).toEqual(['left', 'center', 'right', 'left']);
  });

  it('readTableAlignments 对未知身份返回空数组', () => {
    expect(readTableAlignments('nope')).toEqual([]);
    expect(readTableAlignments(undefined)).toEqual([]);
  });
});

describe('TableIdentity · 注册表生命周期', () => {
  it('pruneTableIdentities 只保留给定集合', () => {
    // 两张表必须在**同一份文档**里观测（rank 依赖前序表格扫描）
    const lines = [
      '| A1 | A2 |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '| B1 | B2 |',
      '| --- | --- |',
      '| 3 | 4 |',
    ];
    const a = observeTableRange(0, 2, getter(lines));
    const b = observeTableRange(4, 6, getter(lines));
    expect(a).not.toBe(b);
    expect(tableIdentityCount()).toBe(2);
    const removed = pruneTableIdentities(new Set([a]));
    expect(removed).toEqual([b]);
    expect(tableIdentityCount()).toBe(1);
    expect(getTableIdentity(a)).toBeDefined();
    expect(getTableIdentity(b)).toBeUndefined();
  });

  it('resetTableIdentities 清空注册表', () => {
    observeTableRange(0, 2, getter(['| A |', '| --- |', '| 1 |']));
    resetTableIdentities();
    expect(tableIdentityCount()).toBe(0);
  });

  it('同一次观测重复调用幂等（不新增条目）', () => {
    const lines = ['| A |', '| --- |', '| 1 |'];
    observeTableRange(0, 2, getter(lines));
    observeTableRange(0, 2, getter(lines));
    expect(tableIdentityCount()).toBe(1);
  });
});

describe('TableStore · 自愈读取与陈旧键清理', () => {
  it('getWidthsFor：列数相符返回数组，不符返回 undefined（脏状态丢弃）', () => {
    const store = useTableStore.getState();
    store.setTableWidths('t1', [100, 200, 300]);
    expect(useTableStore.getState().getWidthsFor('t1', 3)).toEqual([100, 200, 300]);
    expect(useTableStore.getState().getWidthsFor('t1', 2)).toBeUndefined();
    expect(useTableStore.getState().getWidthsFor('t1', 4)).toBeUndefined();
    expect(useTableStore.getState().getWidthsFor('unknown', 3)).toBeUndefined();
  });

  it('getAlignmentsFor：同上', () => {
    const store = useTableStore.getState();
    store.setTableAlignments('t1', ['left', 'center']);
    expect(useTableStore.getState().getAlignmentsFor('t1', 2)).toEqual(['left', 'center']);
    expect(useTableStore.getState().getAlignmentsFor('t1', 3)).toBeUndefined();
  });

  it('pruneTables 清理三类陈旧键并返回被移除的 tableId', () => {
    const store = useTableStore.getState();
    store.setTableWidths('keep', [1]);
    store.setTableWidths('drop', [2]);
    store.setTableAlignments('drop', ['left']);
    store.setTableScrollLeft('drop', 42);
    store.setTableScrollLeft('keep', 7);

    const removed = useTableStore.getState().pruneTables(new Set(['keep']));
    expect(removed).toEqual(['drop']);

    const s = useTableStore.getState();
    expect(s.tableWidths['drop']).toBeUndefined();
    expect(s.tableAlignments['drop']).toBeUndefined();
    expect(s.tableScrollLeft['drop']).toBeUndefined();
    expect(s.tableWidths['keep']).toEqual([1]);
    expect(s.tableScrollLeft['keep']).toBe(7);
  });
});
