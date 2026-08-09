// tests/unit/decoration-set.test.ts
// R5-D 装饰层统一：DecorationSet 单元测试（06-扩展功能-技术维度 §2）
//
// 覆盖：
// 1. add/remove/query 行 bucket 语义（单行 / 跨行 / 零长度 / 行边界）；
// 2. 增量维护（remove 只清该种类涉及行、其他种类不受影响、bucket 收敛）；
// 3. 查询谓词与旧 LineItem selector 逐点等价（穷举光标/选区全组合 ×
//    多文档形态——active 迁移后行为零变化的强等价验证）；
// 4. 统一派生 applyCursorSelectionDecorations（选区 XOR 光标 + 幂等）；
// 5. 搜索高亮 API（addSearchRange / clearSearch / getKind 多区间）；
// 6. 防御归一化（反向区间 / 负偏移 / 文档外区间）与真实 store 集成冒烟。

import { describe, it, expect } from 'vitest';
import { createEditorStore } from '../../src/core/EditorStore';
import {
  DecorationSet,
  applyCursorSelectionDecorations,
  type DecorationLineResolver,
} from '../../src/core/DecorationSet';

// 行边界解析器构造：镜像 LineOffsetTree.findLineIndex（SegmentTree.ts:104）
// 的逻辑语义——行起点 = 前缀和(行长 + 1 换行符)；pos 恰在行首时归属该行；
// pos 超过文末时归属末行。
function makeResolver(lineLengths: number[]): DecorationLineResolver {
  return {
    findLineIndex(pos: number): number {
      let acc = 0;
      for (let i = 0; i < lineLengths.length; i++) {
        acc += lineLengths[i] + 1;
        if (acc > pos) return i;
      }
      return lineLengths.length - 1;
    },
  };
}

// 行范围展开：[行首偏移, 行尾偏移]（行尾含——与 LineItem 的
// lineStart/lineEnd 口径一致）
function lineRanges(lineLengths: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let acc = 0;
  for (const len of lineLengths) {
    out.push([acc, acc + len]);
    acc += len + 1;
  }
  return out;
}

describe('行 bucket 基础：add / query', () => {
  // 三行：偏移 0/4/7，行范围 [0,3] / [4,6] / [7,10]
  const resolver = makeResolver([3, 2, 3]);

  it('单行装饰只命中该行', () => {
    const ds = new DecorationSet(resolver);
    ds.add(1, 2, 'custom');
    expect(ds.query(0, 3)).toHaveLength(1);
    expect(ds.query(0, 3)[0]).toMatchObject({ from: 1, to: 2, kind: 'custom' });
    expect(ds.query(4, 6)).toHaveLength(0);
    expect(ds.query(7, 10)).toHaveLength(0);
  });

  it('跨行装饰在每行 bucket 都可查（同一对象引用，无裁剪复制）', () => {
    const ds = new DecorationSet(resolver);
    ds.add(2, 8, 'selection');
    const first = ds.query(0, 3);
    const mid = ds.query(4, 6);
    const last = ds.query(7, 10);
    expect(first).toHaveLength(1);
    expect(mid).toHaveLength(1);
    expect(last).toHaveLength(1);
    expect(first[0]).toBe(mid[0]);
    expect(mid[0]).toBe(last[0]);
    expect(first[0]).toMatchObject({ from: 2, to: 8, kind: 'selection' });
  });

  it('跨行区间查询按对象引用去重（多行合并只返回一次）', () => {
    const ds = new DecorationSet(resolver);
    ds.add(2, 8, 'selection');
    const all = ds.query(0, 10);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ from: 2, to: 8 });
  });

  it('零长度装饰（光标）命中所在行，闭区间含行首行尾', () => {
    const ds = new DecorationSet(resolver);
    ds.add(4, 4, 'active');
    // 行 [4,6]：光标 4（行首）命中
    expect(ds.query(4, 6)).toHaveLength(1);
    // 邻行不命中
    expect(ds.query(0, 3)).toHaveLength(0);
    expect(ds.query(7, 10)).toHaveLength(0);
    // 光标恰在行尾 3 = 行 [0,3] 行尾（含）
    const ds2 = new DecorationSet(resolver);
    ds2.add(3, 3, 'active');
    expect(ds2.query(0, 3)).toHaveLength(1);
    expect(ds2.query(4, 6)).toHaveLength(0);
  });

  it('空行（零宽行）查询：行内装饰与光标命中', () => {
    const r = makeResolver([3, 0, 3]); // 偏移 0/4/5，中段空行 [4,4]
    const ds = new DecorationSet(r);
    ds.add(4, 4, 'active');
    expect(ds.query(4, 4)).toHaveLength(1);
    expect(ds.query(0, 3)).toHaveLength(0);
    expect(ds.query(5, 8)).toHaveLength(0);
  });

  it('反向区间参数对调归一', () => {
    const ds = new DecorationSet(resolver);
    ds.add(8, 2, 'selection');
    expect(ds.getKind('selection')[0]).toMatchObject({ from: 2, to: 8 });
  });

  it('负偏移钳 0；区间整体在文档外忽略', () => {
    const ds = new DecorationSet(resolver);
    ds.add(-5, 3, 'custom');
    expect(ds.getKind('custom')[0]).toMatchObject({ from: 0, to: 3 });
    ds.add(-5, -3, 'custom');
    // 文档外区间（钳 0 后终点仍 < 起点）被忽略，不产生新装饰
    expect(ds.getKind('custom')).toHaveLength(1);
  });

  it('零长度（光标）在文档起点合法', () => {
    const ds = new DecorationSet(resolver);
    ds.add(0, 0, 'active');
    expect(ds.query(0, 3)).toHaveLength(1);
  });
});

describe('增量维护：remove(kind)', () => {
  it('只清该种类涉及行，其他种类保留', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    ds.add(0, 2, 'search');
    ds.add(1, 8, 'selection');
    ds.add(4, 4, 'active');
    expect(ds.bucketCount).toBe(3);

    ds.remove('search');
    // 行 0 的 search 消失，selection 仍在（同 bucket 原地过滤）
    const line0 = ds.query(0, 3);
    expect(line0).toHaveLength(1);
    expect(line0[0].kind).toBe('selection');
    expect(ds.getKind('search')).toHaveLength(0);
    expect(ds.getKind('selection')).toHaveLength(1);
    expect(ds.getKind('active')).toHaveLength(1);
    // 其他种类的行 bucket 不受扰动
    expect(ds.bucketCount).toBe(3);
  });

  it('清空后 bucket 收敛归零，重复 remove 幂等', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    ds.add(0, 2, 'search');
    ds.add(1, 8, 'selection');
    ds.remove('search');
    ds.remove('selection');
    expect(ds.bucketCount).toBe(0);
    ds.remove('search'); // 幂等空操作
    expect(ds.bucketCount).toBe(0);
    expect(ds.query(0, 10)).toHaveLength(0);
  });

  it('从未添加的种类 remove 为空操作（不误伤其他种类）', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    ds.add(0, 2, 'search');
    ds.remove('active');
    expect(ds.getKind('search')).toHaveLength(1);
    expect(ds.query(0, 3)).toHaveLength(1);
  });

  it('增量重建：选区变化只更新受影响行，旧覆盖行不残留', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 2, 8); // 选区 [2,8]：行 0/1/2
    expect(ds.bucketCount).toBe(3);
    // 选区收窄 [2,6]：行 2 不再覆盖，bucket 随之收敛
    applyCursorSelectionDecorations(ds, 5, 2, 6);
    expect(ds.query(7, 10)).toHaveLength(0);
    expect(ds.query(0, 3)).toHaveLength(1);
    expect(ds.query(4, 6)).toHaveLength(1);
    expect(ds.bucketCount).toBe(2);
  });

  it('clear 清空全部种类', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    ds.addSearchRange(0, 2);
    applyCursorSelectionDecorations(ds, 4, 2, 8);
    ds.clear();
    expect(ds.bucketCount).toBe(0);
    expect(ds.getKind('selection')).toHaveLength(0);
    expect(ds.getKind('search')).toHaveLength(0);
    expect(ds.query(0, 10)).toHaveLength(0);
  });
});

describe('统一派生：applyCursorSelectionDecorations', () => {
  it('有选区 → 只写 selection；选区折叠 → 只写 active（光标）', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 2, 8);
    expect(ds.getKind('selection')).toHaveLength(1);
    expect(ds.getKind('active')).toHaveLength(0);
    applyCursorSelectionDecorations(ds, 5, 5, 5); // 折叠
    expect(ds.getKind('active')).toHaveLength(1);
    expect(ds.getKind('selection')).toHaveLength(0);
  });

  it('幂等：同状态重复应用不产生重复装饰', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 5, 2, 8);
    applyCursorSelectionDecorations(ds, 5, 2, 8);
    expect(ds.getKind('selection')).toHaveLength(1);
    expect(ds.query(4, 6)).toHaveLength(1);
  });

  it('反向选区（start > end）归一为 [min, max]', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    applyCursorSelectionDecorations(ds, 2, 8, 2);
    expect(ds.getKind('selection')[0]).toMatchObject({ from: 2, to: 8 });
  });

  it('选区不对称边界（旧语义保留）：终点恰在行首的行不活动、起点恰在行尾的行活动', () => {
    // 行 [0,5] / [6,9]（偏移 0/6）
    const resolver = makeResolver([5, 3]);
    // 选区终点 e=6 = 行 2 行首：行 2 不活动，行 1 活动
    let ds = new DecorationSet(resolver);
    applyCursorSelectionDecorations(ds, 6, 2, 6);
    expect(ds.query(0, 5).some((d) => d.kind === 'selection')).toBe(true);
    expect(ds.query(6, 9).some((d) => d.kind === 'selection')).toBe(false);
    // 选区起点 s=5 = 行 1 行尾：行 1 活动（lineEnd >= s 含边界）
    ds = new DecorationSet(resolver);
    applyCursorSelectionDecorations(ds, 7, 5, 7);
    expect(ds.query(0, 5).some((d) => d.kind === 'selection')).toBe(true);
    expect(ds.query(6, 9).some((d) => d.kind === 'selection')).toBe(true);
  });

  it('光标闭区间：恰在行首/行尾的光标所在行活动', () => {
    const resolver = makeResolver([5, 3]); // 行 [0,5] / [6,9]
    let ds = new DecorationSet(resolver);
    applyCursorSelectionDecorations(ds, 5, 5, 5); // 光标在行 1 行尾
    expect(ds.query(0, 5).some((d) => d.kind === 'active')).toBe(true);
    expect(ds.query(6, 9).some((d) => d.kind === 'active')).toBe(false);
    ds = new DecorationSet(resolver);
    applyCursorSelectionDecorations(ds, 6, 6, 6); // 光标在行 2 行首
    expect(ds.query(6, 9).some((d) => d.kind === 'active')).toBe(true);
    expect(ds.query(0, 5).some((d) => d.kind === 'active')).toBe(false);
  });
});

describe('查询谓词与旧 LineItem selector 逐点等价（行为零变化）', () => {
  // 旧 selector（MarkdownEngine.tsx 迁移前）判定公式：
  //   hasRange ? (lineStart < e && lineEnd >= s) : (cursorPos >= lineStart && cursorPos <= lineEnd)
  function oldIsLineActive(
    lineStart: number,
    lineEnd: number,
    cursorPos: number,
    selectionStart: number,
    selectionEnd: number
  ): boolean {
    const hasRange = selectionStart !== selectionEnd;
    const s = Math.min(selectionStart, selectionEnd);
    const e = Math.max(selectionStart, selectionEnd);
    return hasRange
      ? lineStart < e && lineEnd >= s
      : cursorPos >= lineStart && cursorPos <= lineEnd;
  }

  // 文档形态矩阵：多行 / 单行 / 空行（首/中/末空行）
  const docs: Array<{ name: string; lengths: number[] }> = [
    { name: '三行', lengths: [3, 2, 3] },
    { name: '单行', lengths: [5] },
    { name: '单空行', lengths: [0] },
    { name: '首行空行', lengths: [0, 4] },
    { name: '末行空行', lengths: [3, 0] },
    { name: '中段空行', lengths: [2, 0, 2] },
  ];

  for (const doc of docs) {
    it(`穷举等价：${doc.name}（光标/选区全组合 × 全部行）`, () => {
      const resolver = makeResolver(doc.lengths);
      const ranges = lineRanges(doc.lengths);
      const totalLen = ranges[ranges.length - 1][1];
      const ds = new DecorationSet(resolver);
      for (let cursor = 0; cursor <= totalLen; cursor++) {
        for (let selStart = 0; selStart <= totalLen; selStart++) {
          for (let selEnd = 0; selEnd <= totalLen; selEnd++) {
            applyCursorSelectionDecorations(ds, cursor, selStart, selEnd);
            for (const [ls, le] of ranges) {
              const newActive = ds
                .query(ls, le)
                .some((d) => d.kind === 'active' || d.kind === 'selection');
              const oldActive = oldIsLineActive(ls, le, cursor, selStart, selEnd);
              expect(
                newActive,
                `组合不匹配：cursor=${cursor} sel=[${selStart},${selEnd}] line=[${ls},${le}]`
              ).toBe(oldActive);
            }
          }
        }
      }
      // 派生收敛：末态（折叠光标）仍有 1 个行 bucket，无残留
      expect(ds.bucketCount).toBeGreaterThan(0);
    });
  }

  it('派生 activeState 的区间字段与旧 selector 输出一致', () => {
    // 旧输出：{ cursor: cursorPos, selStart: hasRange ? s : undefined, selEnd: hasRange ? e : undefined }
    const resolver = makeResolver([3, 2, 3]);
    const ds = new DecorationSet(resolver);
    // 有选区：行 [4,6] 命中的 selection 装饰 from/to = 选区 [min, max]
    applyCursorSelectionDecorations(ds, 4, 2, 8);
    const sel = ds.query(4, 6).find((d) => d.kind === 'selection');
    expect(sel).toBeDefined();
    expect(sel!.from).toBe(2);
    expect(sel!.to).toBe(8);
    // 折叠：active 装饰为零长度光标区间（activeState.cursor 的数据源）
    applyCursorSelectionDecorations(ds, 4, 4, 4);
    const act = ds.query(4, 6).find((d) => d.kind === 'active');
    expect(act).toBeDefined();
    expect(act!.from).toBe(4);
    expect(act!.to).toBe(4);
  });
});

describe('搜索高亮 API（05 高频项预留）', () => {
  it('addSearchRange 多区间 + getKind 按插入序返回 + 行级可查', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    ds.addSearchRange(0, 2);
    ds.addSearchRange(7, 9);
    const ranges = ds.getKind('search');
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({ from: 0, to: 2, kind: 'search' });
    expect(ranges[1]).toMatchObject({ from: 7, to: 9, kind: 'search' });
    // 行级查询：命中行可查（is-search-line 行级 class 的数据源）
    expect(ds.query(0, 3).some((d) => d.kind === 'search')).toBe(true);
    expect(ds.query(7, 10).some((d) => d.kind === 'search')).toBe(true);
    expect(ds.query(4, 6).some((d) => d.kind === 'search')).toBe(false);
  });

  it('clearSearch 只清搜索，不影响光标/选区装饰', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    ds.addSearchRange(0, 2);
    applyCursorSelectionDecorations(ds, 4, 4, 4);
    ds.clearSearch();
    expect(ds.getKind('search')).toHaveLength(0);
    expect(ds.getKind('active')).toHaveLength(1);
    expect(ds.query(4, 6)).toHaveLength(1);
  });

  it('getKind 无该种类时返回共享空数组（零分配）', () => {
    const ds = new DecorationSet(makeResolver([3, 2, 3]));
    const a = ds.getKind('custom');
    const b = ds.getKind('custom');
    expect(a).toHaveLength(0);
    expect(a).toBe(b);
  });
});

describe('真实 store 集成（LineOffsetTree 解析器 + 编辑收敛）', () => {
  it('setText/光标/编辑后派生与 store 状态一致', () => {
    const store = createEditorStore();
    store.getState().setText('abc\nde\nfgh');
    const ds = new DecorationSet({
      findLineIndex: (pos) => store.getState().lineOffsets.findLineIndex(pos),
    });
    // 光标 4 = 行 1（'de' [4,6]）行首
    store.getState().setCursorPos(4);
    let s = store.getState();
    applyCursorSelectionDecorations(ds, s.cursorPos, s.selectionStart, s.selectionEnd);
    expect(ds.query(4, 6).some((d) => d.kind === 'active')).toBe(true);
    expect(ds.query(0, 3).some((d) => d.kind === 'active')).toBe(false);
    // 行 2 选区 [1, 8]：跨三行
    store.getState().setSelection(1, 8);
    s = store.getState();
    applyCursorSelectionDecorations(ds, s.cursorPos, s.selectionStart, s.selectionEnd);
    expect(ds.getKind('selection')[0]).toMatchObject({ from: 1, to: 8 });
    expect(ds.bucketCount).toBe(3);
    // 编辑插入新行：光标落点变化 → 重新派生收敛到新行布局
    store.getState().setCursorPos(0);
    store.getState().insertText('X\n');
    s = store.getState();
    applyCursorSelectionDecorations(ds, s.cursorPos, s.selectionStart, s.selectionEnd);
    // 插入后行 0 = 'X' [0,1]、行 1 = 'abc' [2,5]，光标 2 = 行 1 行首
    expect(ds.query(2, 5).some((d) => d.kind === 'active')).toBe(true);
    expect(ds.bucketCount).toBe(1);
  });
});
