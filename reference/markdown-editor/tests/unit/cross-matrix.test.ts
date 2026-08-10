/**
 * X1 交叉矩阵（G10，unit 侧落地）
 *
 * 依据：docs/analysis/03-测试门禁体系.md §11（文档 × 操作 × 模式三轴全积
 * 抽样 24 组 LHS 正交表）与任务书 X1 要点；e2e 版（真实键盘/DOM 交互）在
 * tests/e2e 域，本文件为 store/parser 层黑箱正交矩阵。
 *
 * 三轴定义（unit 版）：
 * - 文档轴 6 类：表格 / 围栏代码 / 公式块 / 嵌套列表 / 嵌套块引用 /
 *   混合全语法（CJK + emoji + 超长行 + 行内语法）；
 * - 操作轴 6 类：插入 / 删除 / 选区删除 / undo / redo / append；
 * - 光标轴 3 类：行首 / 行中（code point 安全）/ 行尾。
 * 全积 6×6×3=108 组合，抽样 24 组（每操作 4 组、每光标位 8 组、每文档 4 组）。
 *
 * 每组断言（复用 codestate 交叉模式）：
 * 1. 文本一致：操作后 getText() == 独立参考模型（纯字符串模拟同一操作）；
 * 2. verifyConsistency()（树偏移 vs 逻辑行逐行对齐）；
 * 3. codeBlockState 与独立重扫 MarkdownParser.computeLineOffsets(getText())
 *    逐行一致（增量收敛 vs 全量重扫的最强不变量）；
 * 4. fenceLines 单调且不越界。
 *
 * 参考模型独立性：对文本的插入/删除/选区/追加均为纯字符串操作，与被测
 * store 无关；undo/redo 用「插入 → 回退 → 重放」的三段文本快照对比。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import { useEditorStore } from '../../src/core/EditorStore';
import { MarkdownParser } from '../../src/core/parser';

/** 文档轴：6 类文档形态（UTF-8 中文 + emoji + 超长行覆盖混合场景） */
const DOCS = {
  table: '| a | b |\n| :- | ---: |\n| 1 | 2 |\n| 3\\|x | 4 |',
  fence: '```ts\nconst x = 1;\n// 注释\n```\n普通段落\n',
  math: '$$\nE = mc^2\n$$\n行内 $x^2$ 与中文\n',
  list: '- 一级\n  - 二级\n1. 数字\n- [ ] 任务',
  quote: '> 引用第一层\n> > 嵌套引用\n> 回到第一层',
  mixed:
    '# 标题\n\n**加粗** *斜体* `code`\n\n| 表 | 格 |\n| - | - |\n| 甲 | 乙 |\n\n```\ncode\n```\n\n$$e^x$$ 与 emoji 🚀 混合\n\n> 引用\n\n- 列表\n' +
    '超长行' +
    'x'.repeat(6000) +
    '\n',
} as const;
type DocKey = keyof typeof DOCS;

type Op = 'insert' | 'delete' | 'selection' | 'undo' | 'redo' | 'append';
type CursorPos = 'start' | 'mid' | 'end';

/**
 * 24 组 LHS 正交抽样（6 文档 × 4 组）：
 * 操作 6 类各 4 组；光标 3 类各 8 组；同文档内 4 种操作互不重复。
 */
const MATRIX: Array<[DocKey, Op, CursorPos]> = [
  // 表格
  ['table', 'insert', 'start'],
  ['table', 'delete', 'mid'],
  ['table', 'selection', 'end'],
  ['table', 'undo', 'mid'],
  // 围栏代码
  ['fence', 'insert', 'end'],
  ['fence', 'delete', 'start'],
  ['fence', 'append', 'mid'],
  ['fence', 'redo', 'end'],
  // 公式块
  ['math', 'insert', 'mid'],
  ['math', 'selection', 'start'],
  ['math', 'redo', 'start'],
  ['math', 'append', 'end'],
  // 嵌套列表
  ['list', 'delete', 'end'],
  ['list', 'selection', 'mid'],
  ['list', 'undo', 'start'],
  ['list', 'append', 'mid'],
  // 嵌套块引用
  ['quote', 'insert', 'start'],
  ['quote', 'selection', 'end'],
  ['quote', 'undo', 'mid'],
  ['quote', 'redo', 'end'],
  // 混合全语法
  ['mixed', 'delete', 'mid'],
  ['mixed', 'undo', 'end'],
  ['mixed', 'append', 'start'],
  ['mixed', 'redo', 'start'],
];

const INS_TEXT = 'INS';
const APPEND_TEXT = '\nAPPEND';

/** 行中光标位：按 code point 取行中点（避免劈开代理对/组合序列） */
function cpMid(line: string): number {
  const cps = [...line];
  return [...cps.slice(0, Math.floor(cps.length / 2))].join('').length;
}

/** 在已 setText 的 store 上计算目标行的光标绝对位置 */
function cursorPosFor(lineIdx: number, pos: CursorPos): number {
  const s = useEditorStore.getState();
  const offset = s.lineOffsets.getOffset(lineIdx);
  const line = s.getLine(lineIdx);
  if (pos === 'start') return offset;
  if (pos === 'end') return offset + line.length;
  return offset + cpMid(line);
}

// —— 独立参考模型（纯字符串操作，不依赖被测 store）——
const refInsert = (t: string, p: number, ins: string): string =>
  t.slice(0, p) + ins + t.slice(p);
/** 删除光标前一个 code point（与 deleteText(true) 的图素语义在 ASCII/CJK 上等价） */
const refDeleteBackward = (t: string, p: number): string => {
  if (p <= 0) return t;
  const before = [...t.slice(0, p)];
  before.pop();
  return before.join('') + t.slice(p);
};
const refDeleteRange = (t: string, a: number, b: number): string =>
  t.slice(0, a) + t.slice(b);

/** 黑箱收敛断言（含 codeBlockState 与重扫逐行一致——KNOWN-DEFECT 登记
 *  分支已随 P2-A1 fence 单源化修复删除，全量收敛断言恢复） */
function assertConverged(label: string, expectedText: string): void {
  const s = useEditorStore.getState();
  expect(s.getText(), `${label}: 文本一致`).toBe(expectedText);
  expect(s.verifyConsistency(), `${label}: verifyConsistency`).toBe(true);
  const rescan = MarkdownParser.computeLineOffsets(expectedText);
  expect(s.codeBlockState, `${label}: codeBlockState 与独立重扫一致`).toEqual(
    rescan.codeBlockState
  );
  for (let i = 1; i < s.fenceLines.length; i++) {
    expect(s.fenceLines[i], `${label}: fenceLines 单调`).toBeGreaterThan(
      s.fenceLines[i - 1]
    );
  }
  expect(s.fenceLines.length, `${label}: fenceLines 不越界`).toBeLessThanOrEqual(
    s.getLineCount()
  );
}

describe('X1 交叉矩阵（unit 版：6 文档 × 6 操作 × 3 光标，24 组 LHS 抽样）', () => {
  beforeEach(() => {
    // 重置 store（与 codestate-convergence 同模式），随后由用例 setText
    useEditorStore.setState({
      lines: [''],
      lineOffsets: new LineOffsetTree([0]),
      codeBlockState: ['none'],
      textLength: 0,
      fenceLines: [],
      undoStack: [],
      redoStack: [],
      streamTail: [],
      streamTailCodeState: [],
      streamTailFenceLines: [],
    });
  });

  it.each(MATRIX)('%s × %s @ %s', (docKey, op, cursor) => {
    const doc = DOCS[docKey];
    const store = useEditorStore.getState();
    store.setText(doc);
    const s = useEditorStore.getState();
    // 目标行取文档中部（避开首末行边缘），光标按三轴位置换算
    const lineIdx = Math.floor(s.getLineCount() / 2);
    const pos = cursorPosFor(lineIdx, cursor);

    // —— KNOWN-DEFECT 已修复（P2-A1 fence 单源化）——
    // 原登记（R6-A 终验轮）：fence 文档中间行恰为 fence_end 行（'```'）；
    // 光标落在其行尾时插入使该行变为 '```INS'（带 info 串，不再满足
    // parser 的闭合条件）。旧增量按 `trimmed.startsWith('```')` 布尔翻转
    // 仍判 fence_end，独立重扫按完整关闭条件（同字符 + run 长度 ≥ 开栏 +
    // 无 info 串）判 code——两套状态机分歧。修复：parser.ts 导出
    // isFenceClose 共享函数，增量状态机（updateLinesIncremental /
    // appendText 段状态机）镜像 parser 完整围栏语义，增量与重扫收敛为
    // 同一判定（fence-sync.test.ts 专项覆盖）。登记分支已删除，恢复
    // assertConverged 全量收敛断言（含 codeBlockState 与重扫逐行一致）。

    if (op === 'insert') {
      useEditorStore.getState().setCursorPos(pos);
      useEditorStore.getState().insertText(INS_TEXT);
      assertConverged(`${docKey} 插入`, refInsert(doc, pos, INS_TEXT));
    } else if (op === 'delete') {
      useEditorStore.getState().setCursorPos(pos);
      useEditorStore.getState().deleteText(true);
      assertConverged(`${docKey} 删除`, refDeleteBackward(doc, pos));
    } else if (op === 'selection') {
      const a = pos;
      const b = Math.min(s.textLength, pos + 4);
      useEditorStore.getState().setSelection(a, b);
      useEditorStore.getState().deleteSelection(a, b);
      assertConverged(`${docKey} 选区删除`, refDeleteRange(doc, a, b));
    } else if (op === 'append') {
      useEditorStore.getState().appendText(APPEND_TEXT);
      assertConverged(`${docKey} 追加`, doc + APPEND_TEXT);
    } else {
      // undo / redo：插入 → （undo）→ （redo）三段快照逐阶段收敛
      useEditorStore.getState().setCursorPos(pos);
      useEditorStore.getState().insertText(INS_TEXT);
      const afterInsert = refInsert(doc, pos, INS_TEXT);
      assertConverged(`${docKey} 插入(undo/redo 前置)`, afterInsert);

      useEditorStore.getState().undo();
      assertConverged(`${docKey} undo 回退`, doc);

      useEditorStore.getState().redo();
      assertConverged(`${docKey} redo 重放`, afterInsert);
    }
  });
});
