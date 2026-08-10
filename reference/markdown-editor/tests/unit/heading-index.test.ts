// tests/unit/heading-index.test.ts
// B3 大纲索引（N2 大纲/标题索引）：HeadingIndex 增量维护单元测试
//
// 覆盖：
// 1. extractHeading 单行判定（与 parser 同源 /^(#{1,6})\s+/：1-6 级 /
//    块引用前缀剥离 / 非法形态（无空格/七级/正文/空行）不误判）；
// 2. buildHeadingIndex 全量构建（默认提取器，无块级状态过滤）；
// 3. HeadingIndex 增量 applyLines（fenceLines 同款：插入/删除平移 +
//    局部重建）——每条编辑后增量结果与全量重建逐项相等（强等价断言）；
// 4. 零拷贝快速路径：无标题触及 + 行数未变 → 条目数组引用不变；
// 5. findSection 二分（当前章节定位）/ hasEntriesInRange；
// 6. extract 回调注入（块级代码状态过滤模拟：围栏内形似标题行不索引）。

import { describe, it, expect } from 'vitest';
import {
  HeadingIndex,
  buildHeadingIndex,
  extractHeading,
  findHeadingSection,
  type HeadingDoc,
  type HeadingEntry,
  type HeadingExtractor,
} from '../../src/core/headingIndex';

// 默认提取器（镜像引擎注入前的纯行判定形态）
const EXTRACT: HeadingExtractor = (line, raw) => {
  const h = extractHeading(raw);
  return h ? { line, level: h.level, text: h.text } : null;
};

/** 内存文档（HeadingDoc 最小实现） */
function makeDoc(lines: string[]): HeadingDoc {
  return {
    getLineCount: () => lines.length,
    getLine: (i) => lines[i],
  };
}

/** 编辑模拟：返回编辑后的行数组（调用方据此与增量索引做全量比对） */
function applyEdit(
  lines: string[],
  startLineIdx: number,
  deleteCount: number,
  newLines: string[]
): string[] {
  const next = [...lines];
  next.splice(startLineIdx, deleteCount, ...newLines);
  return next;
}

/** 全量重建（对照基准） */
function rebuild(lines: string[], extract = EXTRACT): HeadingEntry[] {
  const idx = new HeadingIndex();
  idx.rebuild(lines.length, extract, (i) => lines[i]);
  return [...idx.getEntries()];
}

describe('extractHeading 单行判定（与 parser 同源）', () => {
  it('1-6 级 ATX 标题提取 level/text', () => {
    expect(extractHeading('# 一级')).toEqual({ level: 1, text: '一级' });
    expect(extractHeading('## 二级')).toEqual({ level: 2, text: '二级' });
    expect(extractHeading('###### 六级')).toEqual({ level: 6, text: '六级' });
  });

  it('多空格分隔与尾随空白归一', () => {
    expect(extractHeading('##   多空格标题')).toEqual({
      level: 2,
      text: '多空格标题',
    });
    expect(extractHeading('# 尾随空白   ')).toEqual({
      level: 1,
      text: '尾随空白',
    });
  });

  it('块引用内标题：剥离前缀后仍判定（与 parser 的 nestedText 同源）', () => {
    expect(extractHeading('> ## 引用标题')).toEqual({
      level: 2,
      text: '引用标题',
    });
    expect(extractHeading('> > # 嵌套引用')).toEqual({
      level: 1,
      text: '嵌套引用',
    });
    expect(extractHeading('   > # 带缩进引用')).toEqual({
      level: 1,
      text: '带缩进引用',
    });
  });

  it('非法形态不误判：无空格 / 七级 / 正文 / 空行 / 前导空格', () => {
    expect(extractHeading('#无空格')).toBeNull();
    expect(extractHeading('####### 七级')).toBeNull();
    expect(extractHeading('普通正文行')).toBeNull();
    expect(extractHeading('')).toBeNull();
    expect(extractHeading('   # 前导空格')).toBeNull();
    expect(extractHeading('##')).toBeNull();
  });
});

describe('buildHeadingIndex 全量构建', () => {
  it('混合文档：只产出标题行条目（默认提取器无块级状态过滤——围栏内形似标题行也会被索引，代码态过滤是引擎侧 extract 注入的职责，见末节）', () => {
    const doc = makeDoc([
      '# 标题一',
      '正文行',
      '## 标题二',
      '```',
      '# 围栏内形似标题',
      '```',
      '### 标题三',
    ]);
    expect(buildHeadingIndex(doc)).toEqual([
      { line: 0, level: 1, text: '标题一' },
      { line: 2, level: 2, text: '标题二' },
      { line: 4, level: 1, text: '围栏内形似标题' },
      { line: 6, level: 3, text: '标题三' },
    ]);
  });

  it('空文档 / 无标题文档 → 空数组', () => {
    expect(buildHeadingIndex(makeDoc([]))).toEqual([]);
    expect(buildHeadingIndex(makeDoc(['正文', '']))).toEqual([]);
  });
});

describe('HeadingIndex 增量维护（fenceLines 同款：平移 + 局部重建）', () => {
  const DOC = [
    '# 标题一',
    '正文',
    '## 标题二',
    '正文',
    '### 标题三',
  ];

  it('前插：后续条目整体平移，新标题插入有序位置', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    lines = applyEdit(lines, 1, 0, ['新行', '# 插入标题']);
    idx.applyLines(1, 0, ['新行', '# 插入标题'], EXTRACT);
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
    // 新标题落在行号 2（插入点 1 处的『新行』占据行号 1）
    expect(idx.getEntries()[1]).toEqual({ line: 2, level: 1, text: '插入标题' });
  });

  it('尾插：追加标题（流式追加路径）', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    lines = applyEdit(lines, lines.length, 0, ['## 尾部标题']);
    idx.applyLines(lines.length - 1, 0, ['## 尾部标题'], EXTRACT);
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
  });

  it('中插多行含标题：条目保持行号升序且与全量一致', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    lines = applyEdit(lines, 3, 0, ['# a', 'b', '## c']);
    idx.applyLines(3, 0, ['# a', 'b', '## c'], EXTRACT);
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
  });

  it('删除标题行：条目移除 + 后缀平移', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    lines = applyEdit(lines, 2, 1, []); // 删除 ## 标题二 行
    idx.applyLines(2, 1, [], EXTRACT);
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
    // 后缀平移：标题三从 4 → 3
    expect(idx.getEntries()[1]).toEqual({ line: 3, level: 3, text: '标题三' });
  });

  it('前删多行：标题随删除平移', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    lines = applyEdit(lines, 0, 2, []);
    idx.applyLines(0, 2, [], EXTRACT);
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
    expect(idx.getEntries()[0]).toEqual({ line: 0, level: 2, text: '标题二' });
  });

  it('替换标题文本：条目内容更新（行数未变）', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    lines = applyEdit(lines, 2, 1, ['## 标题二改']);
    idx.applyLines(2, 1, ['## 标题二改'], EXTRACT);
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
    expect(idx.getEntries()[1]).toEqual({ line: 2, level: 2, text: '标题二改' });
  });

  it('标题 → 正文：条目移除；正文 → 标题：条目新增', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    // 标题二 → 正文
    lines = applyEdit(lines, 2, 1, ['不再是标题']);
    idx.applyLines(2, 1, ['不再是标题'], EXTRACT);
    expect(idx.getEntries().find((e) => e.text === '标题二')).toBeUndefined();
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
    // 正文行 1 → 标题
    lines = applyEdit(lines, 1, 1, ['# 新一级']);
    idx.applyLines(1, 1, ['# 新一级'], EXTRACT);
    expect(idx.getEntries()[1]).toEqual({ line: 1, level: 1, text: '新一级' });
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
  });

  it('零拷贝快速路径：无标题触及 + 行数未变 → 数组引用不变', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    const before = idx.getEntries();
    lines = applyEdit(lines, 1, 1, ['正文被改写']);
    idx.applyLines(1, 1, ['正文被改写'], EXTRACT);
    expect(idx.getEntries()).toBe(before); // 同引用（setState 同引用跳过渲染）
    // 但标题文本未变的「替换标题内容」不得走快速路径：引用必须变化
    lines = applyEdit(lines, 2, 1, ['## 标题二改']);
    idx.applyLines(2, 1, ['## 标题二改'], EXTRACT);
    expect(idx.getEntries()).not.toBe(before);
  });

  it('快速路径不适用：删除区内含标题条目 → 引用变化且条目移除', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    const before = idx.getEntries();
    // 删除 [2,4]（含标题二/标题三）换入等量正文——行数未变但条目必变
    lines = applyEdit(lines, 2, 3, ['x', 'y', 'z']);
    idx.applyLines(2, 3, ['x', 'y', 'z'], EXTRACT);
    expect(idx.getEntries()).not.toBe(before);
    expect([...idx.getEntries()]).toEqual(rebuild(lines));
  });

  it('全量删除（编辑区间覆盖全文档）→ 空索引', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    const n = lines.length; // 删除量必须在清空之前取值
    lines = applyEdit(lines, 0, n, []);
    idx.applyLines(0, n, [], EXTRACT);
    expect(idx.size).toBe(0);
  });

  it('多步编辑链：每步增量与全量重建逐项相等（强等价）', () => {
    let lines = [...DOC];
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, EXTRACT, (i) => lines[i]);
    const steps: Array<[number, number, string[]]> = [
      [1, 0, ['# 新插入']],
      [3, 2, []],
      [0, 0, ['# 头部', '正文']],
      [4, 1, ['## 又改']],
      [lines.length - 1, 0, ['# 尾部']],
      [2, 2, ['x', 'y']],
    ];
    for (const [start, count, news] of steps) {
      lines = applyEdit(lines, start, count, news);
      idx.applyLines(start, count, news, EXTRACT);
      expect([...idx.getEntries()]).toEqual(rebuild(lines));
    }
  });
});

describe('findSection / hasEntriesInRange（二分）', () => {
  const idx = new HeadingIndex();
  idx.rebuild(9, EXTRACT, (i) =>
    ['# a', '', '## b', '', '', '### c', '', '', ''][i]
  );

  it('findSection：首条之前 null / 恰在标题行 / 区间内 / 末条之后', () => {
    expect(idx.findSection(0)).toEqual({ line: 0, level: 1, text: 'a' });
    expect(idx.findSection(1)).toEqual({ line: 0, level: 1, text: 'a' });
    expect(idx.findSection(2)).toEqual({ line: 2, level: 2, text: 'b' });
    expect(idx.findSection(4)).toEqual({ line: 2, level: 2, text: 'b' });
    expect(idx.findSection(5)).toEqual({ line: 5, level: 3, text: 'c' });
    expect(idx.findSection(8)).toEqual({ line: 5, level: 3, text: 'c' });
  });

  it('findSection：空索引返回 null；负数行号返回 null', () => {
    const empty = new HeadingIndex();
    expect(empty.findSection(0)).toBeNull();
    expect(idx.findSection(-1)).toBeNull();
  });

  it('findHeadingSection 独立函数（面板消费数组形态）', () => {
    const entries = [...idx.getEntries()];
    expect(findHeadingSection(entries, 4)).toEqual({
      line: 2,
      level: 2,
      text: 'b',
    });
    expect(findHeadingSection([], 4)).toBeNull();
  });

  it('hasEntriesInRange：区间判定（编辑区间内是否含条目）', () => {
    expect(idx.hasEntriesInRange(0, 1)).toBe(true);
    expect(idx.hasEntriesInRange(3, 4)).toBe(false);
    expect(idx.hasEntriesInRange(2, 5)).toBe(true);
    expect(idx.hasEntriesInRange(5, 8)).toBe(true); // 恰含 line 5 的条目
    expect(idx.hasEntriesInRange(6, 8)).toBe(false);
    expect(idx.hasEntriesInRange(7, 7)).toBe(false);
    expect(idx.hasEntriesInRange(9, 3)).toBe(false); // 空区间（to < from）
  });
});

describe('extract 回调注入（块级代码状态过滤）', () => {
  it('围栏内形似标题行不索引（CodeState 过滤模拟）', () => {
    const lines = [
      '# 真标题',
      '```',
      '# 围栏内假标题',
      '```',
      '## 真标题二',
    ];
    // 模拟引擎侧：第 1-3 行处于代码态（code/fence 行）→ 过滤
    const codeAware: HeadingExtractor = (line, raw) => {
      if (line >= 1 && line <= 3) return null; // 围栏区间
      const h = extractHeading(raw);
      return h ? { line, level: h.level, text: h.text } : null;
    };
    const idx = new HeadingIndex();
    idx.rebuild(lines.length, codeAware, (i) => lines[i]);
    expect([...idx.getEntries()]).toEqual([
      { line: 0, level: 1, text: '真标题' },
      { line: 4, level: 2, text: '真标题二' },
    ]);
    // 编辑落在围栏外：增量路径同样遵守过滤
    idx.applyLines(5, 0, ['# 追加标题'], codeAware);
    expect([...idx.getEntries()]).toEqual([
      { line: 0, level: 1, text: '真标题' },
      { line: 4, level: 2, text: '真标题二' },
      { line: 5, level: 1, text: '追加标题' },
    ]);
  });
});
