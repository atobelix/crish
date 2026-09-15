// @vitest-environment jsdom
/**
 * B2 词级跳选（Ctrl+Arrow / 双击选词）单元测试
 *
 * 覆盖：
 * 1. wordNavigation（HiddenInput.tsx 导出）：行内词边界 + 行边界
 *    显式跨行（行首向左 → 上一行行尾、行尾向右 → 下一行行首）+
 *    文档边界原地不动——Ctrl+Arrow 的存储侧目标计算；
 * 2. doubleClickWordSelection（HiddenInput.tsx 导出）：词字符双击
 *    返回词段区间（字母段/中文段/混合）、空白/符号段返回 null、
 *    行边界钳制；
 * 3. store 集成：真实 EditorStore 上词级目标 + Shift 扩展
 *    （moveHead：anchor 不动 head 到词边界）的端到端语义。
 */
import { afterEach, describe, it, expect } from 'vitest';
import { createEditorStore } from '../../src/core/EditorStore';
import {
  wordNavigation,
  doubleClickWordSelection,
} from '../../src/components/HiddenInput';
import { wordBoundary } from '../../src/core/search';
import { revealEditorLine } from '../../src/core/editorViewport';
import { viewportFixture, type ViewportFixture } from './viewport-fixture';

describe('wordNavigation（Ctrl+Arrow 行级目标计算）', () => {
  // 三行文档：行 0 'hello world' [0,11) 行 1 '渲染引擎' [12,16)
  // 行 2 'a+b' [17,20)；全局偏移 = 行首 + 行内偏移
  const text = 'hello world\n渲染引擎\na+b';

  function nav(pos: number, dir: 'left' | 'right'): number {
    // 行偏移树由 store 构造（与引擎同一权威结构）；此处用纯函数
    // 数据层：getLine 直接返回行文本
    const store = createEditorStore();
    store.getState().setText(text);
    const s = store.getState();
    return wordNavigation(
      pos,
      dir,
      (i) => s.getLine(i) ?? '',
      s.lineOffsets,
      s.textLength
    );
  }

  it('行内词级移动：段首/段尾（字母段）', () => {
    // 'hello world'：光标在 'world' 中（pos 8）→ 左到 6（world 段首）
    expect(nav(8, 'left')).toBe(6);
    // 光标在 'hello' 中（pos 2）→ 左到 0
    expect(nav(2, 'left')).toBe(0);
    // 光标在 'hello' 后（pos 5）→ 右越过 'world' 段到 11（行尾）
    expect(nav(5, 'right')).toBe(11);
    // 光标在 'world' 中（pos 8）→ 右到 11
    expect(nav(8, 'right')).toBe(11);
  });

  it('行内词级移动：中文段整体跳过', () => {
    // '渲染引擎' [12,16)：pos 14（引擎中）→ 左到 12（段首）
    expect(nav(14, 'left')).toBe(12);
    // pos 13 → 右到 16（段尾）
    expect(nav(13, 'right')).toBe(16);
  });

  it('行内词级移动：符号段独立', () => {
    // 'a+b' [17,20)：pos 19（b 后）→ 左到 18（b 段首）
    expect(nav(19, 'left')).toBe(18);
    // pos 18（+ 段）→ 左到 17
    expect(nav(18, 'left')).toBe(17);
    // pos 18（+ 段）→ 右到 19
    expect(nav(18, 'right')).toBe(19);
  });

  it('行边界显式跨行：行首向左 → 上一行行尾；行尾向右 → 下一行行首', () => {
    // 行 1 行首（pos 12）→ 左 = 上一行行尾（11，'hello world' 尾）
    expect(nav(12, 'left')).toBe(11);
    // 行 0 行尾（pos 11）→ 右 = 下一行行首 12
    expect(nav(11, 'right')).toBe(12);
    // 行 1 行尾（pos 16）→ 右 = 行 2 行首 17
    expect(nav(16, 'right')).toBe(17);
    // 行 2 行首（pos 17）→ 左 = 行 1 行尾 16
    expect(nav(17, 'left')).toBe(16);
  });

  it('文档边界原地不动：首行行首 / 末行行尾', () => {
    expect(nav(0, 'left')).toBe(0);
    expect(nav(text.length, 'right')).toBe(text.length);
  });

  it('空白段越过（词间空格不落点）', () => {
    // pos 5 是 'hello' 与 'world' 之间（'hello| world' 空格前）→
    // 左 = 'hello' 段首 0
    expect(nav(5, 'left')).toBe(0);
    // pos 6（'hello |world'）→ 左 = 0（越过空格）
    expect(nav(6, 'left')).toBe(0);
    // pos 6 右 → 越过 'world' 到 11
    expect(nav(6, 'right')).toBe(11);
  });
});

describe('doubleClickWordSelection（双击词选区间）', () => {
  it('字母段双击：返回词段 [start, end)（行内偏移）', () => {
    expect(doubleClickWordSelection('hello world', 2)).toEqual({ start: 0, end: 5 });
    expect(doubleClickWordSelection('hello world', 7)).toEqual({ start: 6, end: 11 });
    // 词首 / 词尾双击同样圈住整词
    expect(doubleClickWordSelection('hello world', 0)).toEqual({ start: 0, end: 5 });
    expect(doubleClickWordSelection('hello world', 10)).toEqual({ start: 6, end: 11 });
  });

  it('中文段双击：整段圈选（连续汉字）', () => {
    expect(doubleClickWordSelection('高性能渲染', 3)).toEqual({ start: 0, end: 5 });
    expect(doubleClickWordSelection('高性能渲染', 0)).toEqual({ start: 0, end: 5 });
  });

  it('混合段：双击字母/汉字各圈各段，互不越界', () => {
    // '渲染x引擎'：渲[0]染[1]x[2]引[3]擎[4]
    expect(doubleClickWordSelection('渲染x引擎', 1)).toEqual({ start: 0, end: 2 });
    expect(doubleClickWordSelection('渲染x引擎', 2)).toEqual({ start: 2, end: 3 });
    expect(doubleClickWordSelection('渲染x引擎', 3)).toEqual({ start: 3, end: 5 });
  });

  it('符号段/空白段双击 → null（保持光标定位语义）', () => {
    expect(doubleClickWordSelection('a + b', 2)).toBeNull(); // 空格
    expect(doubleClickWordSelection('a+b', 1)).toBeNull(); // '+'
    expect(doubleClickWordSelection('hello world', 5)).toBeNull(); // 词间空格
  });

  it('越界位置 → null（行尾 / 行外）', () => {
    expect(doubleClickWordSelection('abc', 3)).toBeNull(); // 行尾字符位
    expect(doubleClickWordSelection('abc', -1)).toBeNull();
    expect(doubleClickWordSelection('', 0)).toBeNull();
  });
});

describe('store 集成：词级移动与 Shift 扩展', () => {
  it('Ctrl+Left/Right 落点与选区收敛（无 Shift）', () => {
    const store = createEditorStore();
    store.getState().setText('foo bar 引擎 x');
    // 'foo bar 引擎 x'：f0 o1 o2 ' '3 b4 a5 r6 ' '7 引8 擎9 ' '10 x11
    let s = store.getState();
    s.setCursorPos(6);
    s = store.getState();
    const left = wordNavigation(s.cursorPos, 'left', (i) => s.getLine(i) ?? '', s.lineOffsets, s.textLength);
    expect(left).toBe(4); // 'bar' 段首
    s.setCursorPos(left);
    s = store.getState();
    expect(s.cursorPos).toBe(4);
    const right = wordNavigation(s.cursorPos, 'right', (i) => s.getLine(i) ?? '', s.lineOffsets, s.textLength);
    expect(right).toBe(7); // 'bar' 段尾
    s.setCursorPos(right);
    s = store.getState();
    expect(s.cursorPos).toBe(7);
    // 中文段：光标在 '引擎' 中 → 左到 8（段首）
    s.setCursorPos(9);
    s = store.getState();
    const cnLeft = wordNavigation(s.cursorPos, 'left', (i) => s.getLine(i) ?? '', s.lineOffsets, s.textLength);
    expect(cnLeft).toBe(8);
    s.setCursorPos(cnLeft);
    s = store.getState();
    // 选区收敛：移动后无选区
    expect(s.selectionStart).toBe(s.selectionEnd);
  });

  it('Shift+Ctrl+Arrow 词级扩展：anchor 不动、head 到词边界（moveHead 语义）', () => {
    const store = createEditorStore();
    store.getState().setText('foo bar baz');
    // anchor 在 'foo' 首（0），光标在 'bar' 中（5）→ Shift+Ctrl+Left
    // 扩展 head 到 'bar' 段首（4），anchor 保持 0
    store.getState().setSelection(0, 5);
    let s = store.getState();
    const target = wordNavigation(s.cursorPos, 'left', (i) => s.getLine(i) ?? '', s.lineOffsets, s.textLength);
    expect(target).toBe(4);
    s.moveHead(target);
    s = store.getState();
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(4);
    expect(s.anchorPos).toBe(0);
    expect(s.headPos).toBe(4);
    // 反向扩展：head 4 → Shift+Ctrl+Right 到 'bar' 段尾（7），anchor 仍 0
    const right = wordNavigation(s.cursorPos, 'right', (i) => s.getLine(i) ?? '', s.lineOffsets, s.textLength);
    expect(right).toBe(7);
    s.moveHead(right);
    s = store.getState();
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(7);
    expect(s.anchorPos).toBe(0);
    // 再右扩：'baz' 段尾（11）
    const right2 = wordNavigation(s.cursorPos, 'right', (i) => s.getLine(i) ?? '', s.lineOffsets, s.textLength);
    expect(right2).toBe(11);
    s.moveHead(right2);
    s = store.getState();
    expect(s.selectionEnd).toBe(11);
  });

  it('词级目标与 moveGrapheme 行文本模式同构（不触发物化视图）', () => {
    // 回归防护：词级导航走 getLine 访问器（双段统一读取），
    // 与 R6-P1 方向键根治同一架构约束——此处验证访问器路径
    // 在双段（append 流式尾段）下的语义正确（append 后重新取
    // 快照——textLength/lineOffsets 必须是最新权威状态）
    const store = createEditorStore();
    store.getState().setText('base\n');
    store.getState().appendText('tail word');
    const s = store.getState();
    // 尾段行 1 = 'tail word' [5,14)：光标在 'r' 处（pos 12）→
    // 左到 'word' 段首（inLine 5 → 全局 10）
    const target = wordNavigation(12, 'left', (i) => s.getLine(i) ?? '', s.lineOffsets, s.textLength);
    expect(target).toBe(10);
    expect(s.getLine(1)).toBe('tail word');
  });
});

describe('词边界函数与搜索全词判定共用同一模型（单源）', () => {
  it('wordBoundary 在导航与全词匹配间行为一致（字母段边界）', () => {
    // 'foo foo'：f0 o1 o2 ' '3 f4 o5 o6
    expect(wordBoundary('foo foo', 3, 'left')).toBe(0); // 'foo| foo' → foo 段首
    expect(wordBoundary('foo foo', 4, 'left')).toBe(0); // 越过空格到前词段首
    // 行首/行尾边界（无字符 = 边界，与全词判定的行边界一致）
    expect(wordBoundary('foo', 3, 'right')).toBe(3);
    expect(wordBoundary('foo', 0, 'left')).toBe(0);
  });
});

describe('越视口滚入：权威宿主 revealLine', () => {
  const fixtures: ViewportFixture[] = [];
  function make(count: number, heights?: number[]) {
    const fixture = viewportFixture(Array(count).fill('x').join('\n'), { heights, height: 280, mounted: [] });
    fixtures.push(fixture);
    return fixture;
  }
  afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); });

  it('目标行已在视口内时保持滚动位置，仍由同一宿主处理', () => {
    const fixture = make(200);
    fixture.container.scrollTop = 2800;
    revealEditorLine(fixture.container, 105);
    expect(fixture.container.scrollTop).toBe(2800);
    expect(fixture.viewport.revealLine).toHaveBeenCalledWith(105);
  });

  it('视口下方远端目标按真实高度表对齐，不从最后挂载行外推', () => {
    const fixture = make(19000, Array.from({ length: 19000 }, (_, i) => i % 7 === 0 ? 45 : 28));
    fixture.container.scrollTop = 2800;
    revealEditorLine(fixture.container, 18805);
    expect(fixture.viewport.revealLine).toHaveBeenCalledWith(18805);
    expect(fixture.container.scrollTop).toBe(fixture.heights.getOffset(18806) - 280);
  });

  it('视口上方目标直接使用行顶部，不额外添加 40px 补偿', () => {
    const fixture = make(200);
    fixture.container.scrollTop = 2800;
    revealEditorLine(fixture.container, 50);
    expect(fixture.container.scrollTop).toBe(fixture.heights.getOffset(50));
  });

  it('文档首目标由宿主精确定位到 0，不出现负滚动', () => {
    const fixture = make(200);
    fixture.container.scrollTop = 2800;
    revealEditorLine(fixture.container, 0);
    expect(fixture.container.scrollTop).toBe(0);
  });

  it('滚动范围由宿主钳制，输入层不自行推算越界像素', () => {
    const fixture = make(15);
    revealEditorLine(fixture.container, 1000);
    expect(fixture.container.scrollTop).toBe(140);
  });
});
