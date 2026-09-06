/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { locateRowIndexByPhysicalBisection } from '../../src/core/measure';

describe('locateRowIndexByPhysicalBisection 物理二分与行尾空白点击防御', () => {
  let rowEl: HTMLElement;
  const originalGetBCR = Range.prototype.getBoundingClientRect;

  beforeEach(() => {
    document.body.innerHTML = '';
    rowEl = document.createElement('div');
    rowEl.className = 'virtual-row';
    document.body.appendChild(rowEl);
  });

  afterEach(() => {
    Range.prototype.getBoundingClientRect = originalGetBCR;
  });

  it('空行（lineLen <= 0）严格返回 lineStart', () => {
    const res = locateRowIndexByPhysicalBisection(rowEl, 100, 50, 0);
    expect(res).toBe(50);
  });

  it('无可见文本节点但 lineLen > 0 时返回 null，允许调用方走几何回退', () => {
    const res = locateRowIndexByPhysicalBisection(rowEl, 100, 50, 10);
    expect(res).toBeNull();
  });

  it('点击普通文本行右侧空白区域时，严格返回 lineStart + lineLen (行末)', () => {
    const lineStart = 100;
    const lineLen = 15;
    rowEl.setAttribute('data-line-start', String(lineStart));
    rowEl.setAttribute('data-line-length', String(lineLen));

    const span = document.createElement('span');
    span.setAttribute('data-token-start', String(lineStart));
    span.setAttribute('data-token-length', '11');
    const textNode = document.createTextNode('hello world');
    span.appendChild(textNode);
    rowEl.appendChild(span);

    Range.prototype.getBoundingClientRect = function (this: Range) {
      const start = this.startOffset;
      const end = this.endOffset;
      const left = 10 + start * 10;
      const right = 10 + end * 10;
      return { left, right, width: right - left, height: 20, top: 0, bottom: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };

    // 点击在文字右侧 (clientX 150 > lastRect.right 120)
    const res = locateRowIndexByPhysicalBisection(rowEl, 150, lineStart, lineLen);
    expect(res).toBe(lineStart + lineLen); // 必须是 115，而不是 111 (hello world 末端)
  });

  it('行尾含隐藏格式化语法（如 **bold**）时，点击空白处严格返回 lineStart + lineLen', () => {
    const lineStart = 200;
    const lineLen = 8; // **bold**
    rowEl.setAttribute('data-line-start', String(lineStart));
    rowEl.setAttribute('data-line-length', String(lineLen));

    // 仅 bold 文本节点可见，globalStart 为 202，长度 4
    const span = document.createElement('span');
    span.setAttribute('data-token-start', String(lineStart + 2));
    span.setAttribute('data-token-length', '4');
    const textNode = document.createTextNode('bold');
    span.appendChild(textNode);
    rowEl.appendChild(span);

    Range.prototype.getBoundingClientRect = function (this: Range) {
      const start = this.startOffset;
      const end = this.endOffset;
      const left = 20 + start * 10;
      const right = 20 + end * 10;
      return { left, right, width: right - left, height: 20, top: 0, bottom: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };

    // 点击在 bold 右侧 (clientX 100 > lastRect.right 60)
    const res = locateRowIndexByPhysicalBisection(rowEl, 100, lineStart, lineLen);
    expect(res).toBe(lineStart + lineLen); // 必须是 208 (**bold** 行末)，绝对不能是 206 (bold 之后、** 之前)
  });

  it('代码块起始围栏行（如 ```python），点击空白处严格返回行末 (lineStart + lineLen)', () => {
    const lineStart = 300;
    const lineLen = 12; // ```python
    rowEl.setAttribute('data-line-start', String(lineStart));
    rowEl.setAttribute('data-line-length', String(lineLen));

    // 仅 python 文本节点可见，globalStart 为 306，长度 6
    const span = document.createElement('span');
    span.setAttribute('data-token-start', String(lineStart + 6));
    span.setAttribute('data-token-length', '6');
    const textNode = document.createTextNode('python');
    span.appendChild(textNode);
    rowEl.appendChild(span);

    Range.prototype.getBoundingClientRect = function (this: Range) {
      const start = this.startOffset;
      const end = this.endOffset;
      const left = 30 + start * 10;
      const right = 30 + end * 10;
      return { left, right, width: right - left, height: 20, top: 0, bottom: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };

    // 点击在 python 右侧 (clientX 150 > lastRect.right 90)
    const res = locateRowIndexByPhysicalBisection(rowEl, 150, lineStart, lineLen);
    expect(res).toBe(lineStart + lineLen); // 必须是 312，而不是 312 之前的任意中间值
  });

  it('点击首字符左侧时，严格返回首字符起点（防跳回折叠语法前缀）', () => {
    const lineStart = 400;
    const lineLen = 10; // ### Title
    rowEl.setAttribute('data-line-start', String(lineStart));
    rowEl.setAttribute('data-line-length', String(lineLen));

    const span = document.createElement('span');
    span.setAttribute('data-token-start', String(lineStart + 4));
    span.setAttribute('data-token-length', '5');
    const textNode = document.createTextNode('Title');
    span.appendChild(textNode);
    rowEl.appendChild(span);

    Range.prototype.getBoundingClientRect = function (this: Range) {
      const start = this.startOffset;
      const end = this.endOffset;
      const left = 50 + start * 10;
      const right = 50 + end * 10;
      return { left, right, width: right - left, height: 20, top: 0, bottom: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    };

    // 点击在 Title 左侧 (clientX 20 <= firstRect.left 50)
    const res = locateRowIndexByPhysicalBisection(rowEl, 20, lineStart, lineLen);
    expect(res).toBe(lineStart + 4); // 锚定在 Title 首字母 404
  });

  it('折行文本在容器顶部内边距（clientY < firstRect.top）点击/拖选时，贴合首视觉行并按 clientX 物理二分定位', () => {
    const lineStart = 500;
    const lineLen = 10;
    rowEl.setAttribute('data-line-start', String(lineStart));
    rowEl.setAttribute('data-line-length', String(lineLen));

    const span = document.createElement('span');
    span.setAttribute('data-token-start', String(lineStart));
    span.setAttribute('data-token-length', String(lineLen));
    const textNode = document.createTextNode('0123456789');
    span.appendChild(textNode);
    rowEl.appendChild(span);

    // 模拟两行折行：0..4 在第一行 (top: 10, bottom: 30)，5..9 在第二行 (top: 40, bottom: 60)
    Range.prototype.getBoundingClientRect = function (this: Range) {
      const start = this.startOffset;
      const end = this.endOffset;
      if (start < 5) {
        const left = 100 + start * 10;
        const right = 100 + end * 10;
        return { left, right, width: right - left, height: 20, top: 10, bottom: 30, x: left, y: 10, toJSON: () => ({}) } as DOMRect;
      } else {
        const left = 100 + (start - 5) * 10;
        const right = 100 + (end - 5) * 10;
        return { left, right, width: right - left, height: 20, top: 40, bottom: 60, x: left, y: 40, toJSON: () => ({}) } as DOMRect;
      }
    };

    // clientY = 2 处于顶部 padding (firstRect.top 为 10)
    // clientX = 125 对应第一行第 2 个字符（'2'，globalPos 502）
    const res = locateRowIndexByPhysicalBisection(rowEl, 125, lineStart, lineLen, 2);
    // 绝不能被暴力 early return 降级为 500 (globalStart)
    expect(res).toBe(502);
  });

  it('折行文本在容器底部内边距（clientY > lastRect.bottom）点击/拖选时，贴合末视觉行并按 clientX 物理二分定位', () => {
    const lineStart = 600;
    const lineLen = 10;
    rowEl.setAttribute('data-line-start', String(lineStart));
    rowEl.setAttribute('data-line-length', String(lineLen));

    const span = document.createElement('span');
    span.setAttribute('data-token-start', String(lineStart));
    span.setAttribute('data-token-length', String(lineLen));
    const textNode = document.createTextNode('0123456789');
    span.appendChild(textNode);
    rowEl.appendChild(span);

    Range.prototype.getBoundingClientRect = function (this: Range) {
      const start = this.startOffset;
      const end = this.endOffset;
      if (start < 5) {
        const left = 100 + start * 10;
        const right = 100 + end * 10;
        return { left, right, width: right - left, height: 20, top: 10, bottom: 30, x: left, y: 10, toJSON: () => ({}) } as DOMRect;
      } else {
        const left = 100 + (start - 5) * 10;
        const right = 100 + (end - 5) * 10;
        return { left, right, width: right - left, height: 20, top: 40, bottom: 60, x: left, y: 40, toJSON: () => ({}) } as DOMRect;
      }
    };

    // clientY = 75 处于底部 padding (lastRect.bottom 为 60)
    // clientX = 125 对应第二行第 2 个字符（即 '7'，globalPos 607）
    const res = locateRowIndexByPhysicalBisection(rowEl, 125, lineStart, lineLen, 75);
    // 绝不能被暴力 early return 降级为 610 (lineStart + lineLen)
    expect(res).toBe(607);
  });
});
