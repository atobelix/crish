/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSourceIndexFromPoint, getDOMPointFromIndex, syncDOMSelection,
  domSelectionMatchesModel, disposeContainerMeasurementCache,
} from '../../src/core/measure';

/**
 * 原 8 个场景全部保留。坐标命中改由宿主原生 API 提供，
 * 断言源码映射及边界含义，不再把字符二分实现本身当作正确性。
 */
describe('行定位：原生命中与可见源码边界', () => {
  let rowEl: HTMLElement;
  let positionDescriptor: PropertyDescriptor | undefined;
  let rangeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    rowEl = document.createElement('div');
    rowEl.className = 'virtual-row';
    rowEl.getBoundingClientRect = () => new DOMRect(10, 0, 400, 28);
    document.body.appendChild(rowEl);
    positionDescriptor = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
    rangeDescriptor = Object.getOwnPropertyDescriptor(document, 'caretRangeFromPoint');
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: undefined });
    Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: undefined });
  });

  afterEach(() => {
    disposeContainerMeasurementCache(rowEl);
    window.getSelection()?.removeAllRanges();
    if (positionDescriptor) Object.defineProperty(document, 'caretPositionFromPoint', positionDescriptor);
    else Reflect.deleteProperty(document, 'caretPositionFromPoint');
    if (rangeDescriptor) Object.defineProperty(document, 'caretRangeFromPoint', rangeDescriptor);
    else Reflect.deleteProperty(document, 'caretRangeFromPoint');
    document.body.innerHTML = '';
  });

  function textLine(lineStart: number, lineLength: number, tokenStart: number, text: string): Text {
    rowEl.setAttribute('data-line-start', String(lineStart));
    rowEl.setAttribute('data-line-length', String(lineLength));
    const span = document.createElement('span');
    span.setAttribute('data-token-start', String(tokenStart));
    span.setAttribute('data-token-length', String(text.length));
    span.textContent = text;
    rowEl.appendChild(span);
    return span.firstChild as Text;
  }

  function nativeHit(node: Node, offset: number) {
    const hit = vi.fn(() => ({ offsetNode: node, offset }));
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: hit });
    return hit;
  }

  it('空行只有唯一源码边界，严格返回 lineStart', () => {
    rowEl.dataset.lineStart = '50';
    rowEl.dataset.lineLength = '0';
    rowEl.append(document.createElement('br'));
    nativeHit(rowEl, 0);
    expect(getSourceIndexFromPoint(100, 14, rowEl)).toBe(50);
  });

  it('无可见编辑节点但 lineLen > 0 时返回 null，不制造几何回退', () => {
    rowEl.dataset.lineStart = '50';
    rowEl.dataset.lineLength = '10';
    nativeHit(rowEl, 0);
    expect(getSourceIndexFromPoint(100, 14, rowEl)).toBeNull();
  });

  it('点击普通文本行右侧空白区域，命中包含尾随空格的真实行末', () => {
    // 原夹具 lineLen=15 却只渲染11字符；补齐真实尾随空格，保留行末115断言。
    const node = textLine(100, 15, 100, 'hello world    ');
    const hit = nativeHit(node, 15);
    expect(getSourceIndexFromPoint(150, 14, rowEl)).toBe(115);
    expect(hit).toHaveBeenCalledWith(150, 14);
  });

  it('行尾含隐藏格式语法时，命中可见末端且完整源码行末与它投影等价', () => {
    const node = textLine(200, 8, 202, 'bold');
    nativeHit(node, 4);
    expect(getSourceIndexFromPoint(100, 14, rowEl)).toBe(206);
    const fullSourceEnd = getDOMPointFromIndex(208, rowEl)!;
    expect(fullSourceEnd.node).toBe(node);
    expect(fullSourceEnd.offset).toBe(4);
    // 完整源码选区仍保留208→200，不能因可见末端206而丢失闭合标记。
    syncDOMSelection(rowEl, 208, 200);
    expect(domSelectionMatchesModel(rowEl, 208, 200)).toBe(true);
  });

  it('代码块起始围栏行，点击空白处命中语言标识末端与真实行末', () => {
    // 六个围栏字符加 python：源码长度12，语言标识从306起。
    const node = textLine(300, 12, 306, 'python');
    nativeHit(node, 6);
    expect(getSourceIndexFromPoint(150, 14, rowEl)).toBe(312);
  });

  it('点击首字符左侧时落到可见首字符，不跳回折叠标题前缀', () => {
    const node = textLine(400, 9, 404, 'Title');
    nativeHit(node, 0);
    expect(getSourceIndexFromPoint(20, 14, rowEl)).toBe(404);
  });

  it('折行文本顶部内边距点击，由原生布局命中首视觉行相应字符', () => {
    const node = textLine(500, 10, 500, '0123456789');
    const hit = nativeHit(node, 2);
    expect(getSourceIndexFromPoint(125, 2, rowEl)).toBe(502);
    expect(hit).toHaveBeenCalledWith(125, 2);
  });

  it('折行文本底部内边距点击，由原生布局命中末视觉行相应字符', () => {
    const node = textLine(600, 10, 600, '0123456789');
    const hit = nativeHit(node, 7);
    expect(getSourceIndexFromPoint(125, 75, rowEl)).toBe(607);
    expect(hit).toHaveBeenCalledWith(125, 75);
  });

  it('宿主仅提供 caretRangeFromPoint 时仍使用同一源码投影', () => {
    const node = textLine(700, 5, 700, 'hello');
    const hit = vi.fn(() => {
      const range = document.createRange();
      range.setStart(node, 3);
      range.collapse(true);
      return range;
    });
    Object.defineProperty(document, 'caretRangeFromPoint', { configurable: true, value: hit });
    expect(getSourceIndexFromPoint(42, 12, rowEl)).toBe(703);
    expect(hit).toHaveBeenCalledWith(42, 12);
  });

  it('原生命中在其他行或编辑器上时，不能越过传入行的边界', () => {
    textLine(800, 5, 800, 'hello');
    const other = document.createElement('span');
    other.dataset.tokenStart = '800';
    other.dataset.tokenLength = '5';
    other.textContent = 'other';
    document.body.appendChild(other);
    nativeHit(other.firstChild!, 2);
    expect(getSourceIndexFromPoint(30, 14, rowEl)).toBeNull();
  });

  it('宿主无原生命中能力时，包围盒存在也不能成为猜列入口', () => {
    textLine(900, 5, 900, 'hello');
    expect(getSourceIndexFromPoint(35, 14, rowEl)).toBeNull();
  });
});
