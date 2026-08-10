/**
 * P2-A1 fence 单源化（任务 1 验收）：增量状态机与全量重扫收敛
 *
 * 背景：KNOWN-DEFECT（status-P2 现状盘点项 2 / cross-matrix.test.ts:160-243
 * 登记）——fence_end 行尾插入使行变 ` ```INS` 后，增量按
 * `trimmed.startsWith('```')` 布尔翻转仍判 fence_end，全量重扫按完整关闭
 * 条件（同字符 + run ≥ 开栏长度 + 仅尾随空白）判 code——两套状态机分歧。
 * 修复：parser.ts 导出 isFenceClose 共享函数，EditorStore 增量（
 * updateLinesIncremental / appendText 段状态机）镜像 parser 完整围栏语义
 * （开栏正则 FENCE_OPEN_RE + fenceState 携带 marker/length）。
 *
 * 断言核心：任意编辑/追加/撤销后，store.codeBlockState 与独立重扫
 * MarkdownParser.computeLineOffsets(getText()) 逐行一致 + fenceLines 与
 * 重扫 fence 行集合一致——增量与重扫的最强收敛不变量。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LineOffsetTree } from '../../src/core/SegmentTree';
import { useEditorStore } from '../../src/core/EditorStore';
import { MarkdownParser, isFenceClose } from '../../src/core/parser';

// —— fence 文档轴：覆盖反引号/波浪线/异长 run/块引用嵌套 ——
const FENCE_DOCS = {
  /** 基础三行围栏 + 尾段落 */
  basic: '```\ncode\n```\nnormal',
  /** 带 info 串的开栏（ts） */
  infoOpen: '```ts\nconst x = 1;\n```\n',
  /** 4 反引号开栏：块内 3 反引号行不能关闭（run 长度不足） */
  fourOpen: '````\ncode\n```\n````\nnormal',
  /** 波浪线围栏（旧增量 startsWith('```') 完全不识别，重扫识别——分歧源） */
  tilda: '~~~\ncode\n~~~\nnormal',
  /** 异字符：反引号块内波浪线行是 code（不关闭） */
  mixed: '```\ncode\n~~~\n```\n',
  /** 块引用内的围栏（判定输入 = 块引用剥离后 trim） */
  quoteFence: '> ```\n> code\n> ```\n',
  /** 波浪线开栏 4 run、反引号 3 run 关（异字符 + 波浪线 info） */
  tildaInfo: '~~~~\ncode\n~~~\n~~~~\n',
} as const;
type FenceDocKey = keyof typeof FENCE_DOCS;

/** 目标行（fence 文档中间行附近，覆盖 fence_end/fence_start/块内行） */
function lineStart(lineIdx: number): number {
  const s = useEditorStore.getState();
  return s.lineOffsets.getOffset(lineIdx);
}

/**
 * fence 单源收敛断言（全量）：文本一致 + verifyConsistency + 增量
 * codeBlockState / fenceLines 与独立全量重扫逐行一致（P2-A1 验收口径）。
 * 仅用于编辑路径（updateLinesIncremental 重算受影响区，fenceLines 精确）；
 * appendText 尾段路径见 assertStateSync 注释。
 */
function assertFenceSync(label: string, expectedText: string): void {
  assertStateSync(label, expectedText);
  const s = useEditorStore.getState();
  const rescan = MarkdownParser.computeLineOffsets(expectedText);
  // fenceLines 与重扫的 fence 行集合一致（fence 四态行索引）
  const expectedFences = rescan.codeBlockState
    .map((st, i) =>
      st === 'fence_start' ||
      st === 'fence_end' ||
      st === 'math_fence_start' ||
      st === 'math_fence_end'
        ? i
        : -1
    )
    .filter((i) => i >= 0);
  expect(s.fenceLines, `${label}: fenceLines 与重扫一致`).toEqual(
    expectedFences
  );
  expect(s.fenceLines, `${label}: fenceLines 单调`).toEqual(
    [...s.fenceLines].sort((a, b) => a - b)
  );
}

/**
 * 状态收敛断言（增量状态机核心不变量）：文本一致 + verifyConsistency +
 * codeBlockState 与独立全量重扫逐行一致。
 * appendText 尾段路径专用：尾段模型下 mainFenceLines 保留「被接管行」的
 * 旧 fence 记录（append 不重建主数组，合并行的旧边界记录随视图合并残留，
 * 消费方均安全——BlockRenderer 只查末位状态、编辑路径经 mergeTailInto
 * 自愈重建），故不做 fenceLines 全等断言（既有模型简化，非本修复引入）。
 */
function assertStateSync(label: string, expectedText: string): void {
  const s = useEditorStore.getState();
  expect(s.getText(), `${label}: 文本一致`).toBe(expectedText);
  expect(s.verifyConsistency(), `${label}: verifyConsistency`).toBe(true);
  const rescan = MarkdownParser.computeLineOffsets(expectedText);
  expect(s.codeBlockState, `${label}: 增量 codeBlockState 与重扫一致`).toEqual(
    rescan.codeBlockState
  );
}

describe('isFenceClose 纯函数（parser.ts 导出的完整关闭条件）', () => {
  it('同字符 + run ≥ 开栏长度 + 仅尾随空白才关闭', () => {
    expect(isFenceClose('```', '`', 3)).toBe(true);
    expect(isFenceClose('```   ', '`', 3)).toBe(true); // 尾随空白允许
    expect(isFenceClose('````', '`', 3)).toBe(true); // run 更长允许
    expect(isFenceClose('```', '`', 4)).toBe(false); // run 不足
    expect(isFenceClose('```INS', '`', 3)).toBe(false); // info 串不关闭
    expect(isFenceClose('``` js', '`', 3)).toBe(false); // info 串不关闭
    expect(isFenceClose('~~~', '`', 3)).toBe(false); // 异字符不关闭
    expect(isFenceClose('```', '~', 3)).toBe(false); // 异字符不关闭
    expect(isFenceClose('~~~', '~', 3)).toBe(true); // 波浪线同字符
    expect(isFenceClose('~~~  ', '~', 3)).toBe(true);
    expect(isFenceClose('~~', '~', 3)).toBe(false); // run 不足
    expect(isFenceClose('`', '`', 3)).toBe(false); // 单反引号不是围栏
    expect(isFenceClose('`` ``', '`', 3)).toBe(false); // 中间空白断开
    expect(isFenceClose('', '`', 3)).toBe(false); // 空行不关闭
  });
});

describe('P2-A1 fence 单源化：增量与重扫收敛', () => {
  beforeEach(() => {
    // 重置 store（与 cross-matrix 同模式），随后由用例 setText
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

  it('KNOWN-DEFECT 复现用例：fence_end 行尾插入 → 增量与重扫一致（code）', () => {
    // cross-matrix.test.ts:169-179 登记的精确场景：DOCS.fence 的 fence_end
    // 行（'```'，idx 3）行尾插入 INS → 行变 '```INS'。修复前增量判
    // fence_end、重扫判 code；修复后两套状态机同判 code。
    const doc = '```ts\nconst x = 1;\n// 注释\n```\n普通段落\n';
    useEditorStore.getState().setText(doc);
    const pos = lineStart(3) + '```'.length; // fence_end 行行尾
    useEditorStore.getState().setCursorPos(pos);
    useEditorStore.getState().insertText('INS');
    assertFenceSync('fence_end 行尾插入', '```ts\nconst x = 1;\n// 注释\n```INS\n普通段落\n');
    // 明确断言分歧点已收敛：该行应为 code（重扫语义），而非旧增量 fence_end
    const s = useEditorStore.getState();
    expect(s.codeBlockState[3]).toBe('code');
  });

  it('fence_start 行尾插入 info → 仍为开栏（增量与重扫一致）', () => {
    const store = useEditorStore.getState();
    store.setText('```ts\nconst x = 1;\n```\n');
    const pos = lineStart(0) + '```ts'.length; // fence_start 行行尾
    store.setCursorPos(pos);
    store.insertText('js');
    assertFenceSync('fence_start 行尾插入', '```tsjs\nconst x = 1;\n```\n');
    // 行 0 变成 '```tsjs' 仍是开栏（info 串含反引号才退化——'js' 无）
    expect(useEditorStore.getState().codeBlockState[0]).toBe('fence_start');
  });

  it('4 反引号开栏：块内 3 反引号行不关闭（fenceState 前缀恢复）', () => {
    // 编辑点在代码块内（fence_start 在编辑点之前）→ 增量须从旧 fence 行
    // 恢复 marker='`'、length=4，块内 '```'（3 run）不得关闭（parser 语义）。
    const store = useEditorStore.getState();
    store.setText('````\ncode\n```\n````\nnormal');
    const pos = lineStart(1) + 'code'.length; // 'code' 行行尾
    store.setCursorPos(pos);
    store.insertText('x');
    assertFenceSync('4 反引号开栏块内编辑', '````\ncodex\n```\n````\nnormal');
    const s = useEditorStore.getState();
    expect(s.codeBlockState[2]).toBe('code'); // 3 run 行仍是块内 code
    expect(s.codeBlockState[3]).toBe('fence_end');
  });

  it('波浪线围栏：编辑后增量与重扫一致（旧 startsWith 盲区修复）', () => {
    const store = useEditorStore.getState();
    store.setText(FENCE_DOCS.tilda);
    const pos = lineStart(1) + 'code'.length;
    store.setCursorPos(pos);
    store.insertText('x');
    assertFenceSync('波浪线块内编辑', '~~~\ncodex\n~~~\nnormal');
    const s = useEditorStore.getState();
    expect(s.codeBlockState[0]).toBe('fence_start');
    expect(s.codeBlockState[2]).toBe('fence_end');
  });

  it('异字符不关闭：反引号块内波浪线行保持 code', () => {
    const store = useEditorStore.getState();
    store.setText(FENCE_DOCS.mixed);
    const pos = lineStart(1) + 'code'.length;
    store.setCursorPos(pos);
    store.insertText('x');
    assertFenceSync('异字符围栏', '```\ncodex\n~~~\n```\n');
    const s = useEditorStore.getState();
    expect(s.codeBlockState[2]).toBe('code'); // '~~~' 在反引号块内是 code
  });

  it('块引用内围栏：编辑后增量与重扫一致', () => {
    const store = useEditorStore.getState();
    store.setText(FENCE_DOCS.quoteFence);
    const pos = lineStart(1) + '> code'.length; // 块内行行尾（'> code' 6 字符）
    store.setCursorPos(pos);
    store.insertText('x');
    assertFenceSync('块引用围栏', '> ```\n> codex\n> ```\n');
    const s = useEditorStore.getState();
    expect(s.codeBlockState[0]).toBe('fence_start');
    expect(s.codeBlockState[2]).toBe('fence_end');
  });

  it('undo/redo 重放 fence_end 行尾插入 → 每阶段与重扫一致', () => {
    const doc = FENCE_DOCS.basic; // '```\ncode\n```\nnormal'
    const store = useEditorStore.getState();
    store.setText(doc);
    const pos = lineStart(2) + 3; // fence_end 行行尾
    store.setCursorPos(pos);
    store.insertText('INS');
    const afterInsert = '```\ncode\n```INS\nnormal';
    assertFenceSync('插入后', afterInsert);
    expect(useEditorStore.getState().codeBlockState[2]).toBe('code');

    useEditorStore.getState().undo();
    assertFenceSync('undo 回退', doc);

    useEditorStore.getState().redo();
    assertFenceSync('redo 重放', afterInsert);
    expect(useEditorStore.getState().codeBlockState[2]).toBe('code');
  });

  it('appendText：fence_end 行尾追加 info → 合并行保持 code（与重扫一致）', () => {
    // 尾段状态机基线 = 旧行 [0, lastLineIdx) 回推（fence 行二分）：
    // lastLineIdx 是 fence_end 行（被合并替换），合并行 '```INS' 在代码块
    // 内（行 0 开栏未闭）→ close 判定失败 → code。断言口径 = 状态收敛
    // （assertStateSync：codeBlockState 与重扫逐行一致——KNOWN-DEFECT 的
    // 增量/重扫分歧核心；fenceLines 全等见 assertStateSync 尾段残留注释）。
    const store = useEditorStore.getState();
    store.setText('```\ncode\n```');
    store.appendText('INS');
    assertStateSync('append 到 fence_end 行', '```\ncode\n```INS');
    expect(useEditorStore.getState().codeBlockState[2]).toBe('code');
  });

  it('appendText：开栏行自身追加 info → 合并行仍为开栏（旧实现误判回归）', () => {
    // 旧实现按 lastLineIdx 自身状态（fence_start）推断 inCodeBlock=true，
    // 合并行 '```INS' 被误判 code/fence_end；正确基线 = < lastLineIdx 无
    // fence → 块外 → '```INS' 重新判定为 fence_start（与重扫一致）。
    const store = useEditorStore.getState();
    store.setText('```');
    store.appendText('INS');
    assertStateSync('append 到开栏行', '```INS');
    expect(useEditorStore.getState().codeBlockState[0]).toBe('fence_start');
  });

  it('appendText：代码块内追加 → 新行保持 code', () => {
    const store = useEditorStore.getState();
    store.setText('```\ncode');
    store.appendText('x');
    assertStateSync('append 到块内行', '```\ncodex');
    expect(useEditorStore.getState().codeBlockState[1]).toBe('code');
  });

  it('全量重扫基线自检：所有 fence 文档的初始状态即一致', () => {
    for (const key of Object.keys(FENCE_DOCS) as FenceDocKey[]) {
      const doc = FENCE_DOCS[key];
      useEditorStore.getState().setText(doc);
      assertFenceSync(`初始状态 ${key}`, doc);
    }
  });

  it('文档轴 × 删除/选区删除：增量与重扫一致', () => {
    for (const key of Object.keys(FENCE_DOCS) as FenceDocKey[]) {
      const doc = FENCE_DOCS[key];
      const store = useEditorStore.getState();
      store.setText(doc);
      const s = useEditorStore.getState();
      // 删除 fence_end 行行尾字符（把 '```' 变 '``'）
      const fenceEndIdx = s.fenceLines[1] ?? -1;
      if (fenceEndIdx < 0) continue;
      const pos = lineStart(fenceEndIdx) + 3;
      s.setCursorPos(pos);
      s.deleteText(true);
      const expected =
        doc.slice(0, pos - 1) + doc.slice(pos);
      assertFenceSync(`${key} fence_end 删字符`, expected);
    }
  });
});
