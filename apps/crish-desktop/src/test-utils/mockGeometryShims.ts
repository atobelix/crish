// =============================================================================
// apps/crish-desktop/src/test-utils/mockGeometryShims.ts
// 物理排版仿真垫片实现细节（Range / Element 原型接管与坐标解算）
// 从 MockPhysicalGeometryEngine.ts 拆出，纯结构性重构，行为零变更。
// =============================================================================

import type { MockPhysicalGeometryEngine } from './MockPhysicalGeometryEngine';

/**
 * 安装 Range 原型垫片：接管 getBoundingClientRect / getClientRects。
 * 支持三种解析路径：data-mock-rect 属性 → 弱引用注册表（CJK 多字节宽度解算）→ 默认行盒。
 */
export function installRangeShim(
  engine: MockPhysicalGeometryEngine,
  onRestore: (original: typeof Range.prototype.getBoundingClientRect, originalRects: typeof Range.prototype.getClientRects) => void
): boolean {
  if (typeof Range === 'undefined') return false;
  onRestore(
    Range.prototype.getBoundingClientRect,
    Range.prototype.getClientRects
  );

  Range.prototype.getBoundingClientRect = function (): DOMRect {
    const ancestor = this.commonAncestorContainer;
    const parentEl =
      ancestor instanceof Element ? ancestor : ancestor.parentElement;

    if (parentEl) {
      // 1. 检查节点或祖先是否有显式 data-mock-rect 属性注入（严格有限数字检验）
      const attr = parentEl.getAttribute('data-mock-rect');
      if (attr) {
        const [x, y, w, h] = attr.split(',').map(Number);
        if (
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          Number.isFinite(w) &&
          Number.isFinite(h)
        ) {
          return new DOMRect(x, y, w, h);
        }
      }
    }

    // 2. 检查弱引用注册表（支持 CJK 多字节排版宽度解算）
    if (parentEl && engine.elementRectMap.has(parentEl)) {
      const baseRect = engine.elementRectMap.get(parentEl)!;
      const startOffset = this.startOffset || 0;

      const textContent = ancestor.textContent || '';
      const textBeforeCaret = textContent.slice(0, startOffset);
      const cjkMatches = textBeforeCaret.match(/[\u4e00-\u9fa5]/g) || [];
      const cjkCount = cjkMatches.length;
      const latinCount = Math.max(0, startOffset - cjkCount);
      const computedCharOffset =
        latinCount * engine.defaultCharWidth +
        cjkCount * engine.cjkCharWidth;

      return new DOMRect(
        baseRect.left + computedCharOffset,
        baseRect.top,
        engine.defaultCharWidth,
        engine.defaultLineHeight
      );
    }

    // 3. 计算文本行盒 LineBox（默认具备 20.3px 真实物理行高，拒绝全 0 坍缩）
    const startOffset = this.startOffset || 0;
    const defaultX = 24 + startOffset * engine.defaultCharWidth;
    const defaultY = engine.currentViewport.height - 80; // 模拟底部输入框基准行
    return new DOMRect(
      defaultX,
      defaultY,
      engine.defaultCharWidth,
      engine.defaultLineHeight
    );
  };

  Range.prototype.getClientRects = function (): DOMRectList {
    const rect = this.getBoundingClientRect();
    return {
      0: rect,
      length: 1,
      item: (index: number) => (index === 0 ? rect : null),
      [Symbol.iterator]: function* () {
        yield rect;
      },
    } as unknown as DOMRectList;
  };
  return true;
}

/**
 * 安装 Element 原型垫片：接管 getBoundingClientRect。
 * 解析路径：未挂载/none → data-mock-rect → 弱引用 → 选择器规则 → 内联坐标（含 transform）→ 角色默认尺寸。
 */
export function installElementShim(
  engine: MockPhysicalGeometryEngine,
  onRestore: (original: typeof Element.prototype.getBoundingClientRect) => void
): boolean {
  if (typeof Element === 'undefined') return false;
  onRestore(Element.prototype.getBoundingClientRect);

  Element.prototype.getBoundingClientRect = function (): DOMRect {
    // 1. 若元素未挂载或处于 display: none，返回全 0（对齐真实浏览器规范）
    if (!this.isConnected) {
      return new DOMRect(0, 0, 0, 0);
    }
    if (this instanceof HTMLElement && this.style.display === 'none') {
      return new DOMRect(0, 0, 0, 0);
    }

    // 2. 显式 data-mock-rect 属性
    const attr = this.getAttribute('data-mock-rect');
    if (attr) {
      const [x, y, w, h] = attr.split(',').map(Number);
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(w) &&
        Number.isFinite(h)
      ) {
        return new DOMRect(x, y, w, h);
      }
    }

    // 3. 弱引用 Map 查找
    if (engine.elementRectMap.has(this)) {
      return engine.elementRectMap.get(this)!;
    }

    // 4. 选择器规则匹配查找
    for (const [sel, rect] of engine.selectorRectMap.entries()) {
      if (this.matches(sel)) {
        return rect;
      }
    }

    // 5. 解析 HTMLElement 内联坐标（如 Popper / Tooltip 注入的 style.top / style.left / transform）
    const tag = this.tagName.toLowerCase();
    const role = this.getAttribute('role');

    if (this instanceof HTMLElement) {
      let topVal: number | undefined;
      let leftVal: number | undefined;
      let widthVal: number | undefined;
      let heightVal: number | undefined;

      if (this.style.top && this.style.top.endsWith('px')) {
        topVal = parseFloat(this.style.top);
      }
      if (this.style.left && this.style.left.endsWith('px')) {
        leftVal = parseFloat(this.style.left);
      }
      if (this.style.width && this.style.width.endsWith('px')) {
        widthVal = parseFloat(this.style.width);
      }
      if (this.style.height && this.style.height.endsWith('px')) {
        heightVal = parseFloat(this.style.height);
      }

      const parent = this.parentElement;
      if (parent instanceof HTMLElement) {
        if (
          topVal === undefined &&
          parent.style.top &&
          parent.style.top.endsWith('px')
        ) {
          topVal = parseFloat(parent.style.top);
        }
        if (
          leftVal === undefined &&
          parent.style.left &&
          parent.style.left.endsWith('px')
        ) {
          leftVal = parseFloat(parent.style.left);
        }
        const tf =
          this.style.transform ||
          parent.style.transform ||
          this.style.getPropertyValue('--tooltip-translate') ||
          parent.style.getPropertyValue('--tooltip-translate');
        if (tf) {
          const match = tf.match(
            /translate(?:3d)?\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/
          );
          if (match) {
            leftVal = (leftVal ?? 0) + parseFloat(match[1]!);
            topVal = (topVal ?? 0) + parseFloat(match[2]!);
          }
          if (tf.includes('-50%')) {
            const w = widthVal ?? (role === 'tooltip' ? 80 : 100);
            leftVal = (leftVal ?? 0) - w / 2;
          }
          if (tf.includes('-100%')) {
            const h = heightVal ?? (role === 'tooltip' ? 24 : 30);
            topVal = (topVal ?? 0) - h;
          }
        }
      }

      if (topVal !== undefined || leftVal !== undefined) {
        const defaultW =
          role === 'dialog' ||
          role === 'menu' ||
          role === 'listbox' ||
          this.classList.contains('menuContent')
            ? 200
            : role === 'tooltip'
              ? 80
              : 100;
        const defaultH =
          role === 'dialog' ||
          role === 'menu' ||
          role === 'listbox' ||
          this.classList.contains('menuContent')
            ? 240
            : role === 'tooltip'
              ? 24
              : 30;
        let finalLeft = leftVal ?? 0;
        let finalTop = topVal ?? 0;

        const selfTf =
          this.style.transform ||
          this.style.getPropertyValue('--tooltip-translate');
        if (selfTf) {
          if (selfTf.includes('-50%'))
            finalLeft -= (widthVal ?? defaultW) / 2;
          if (selfTf.includes('-100%')) finalTop -= heightVal ?? defaultH;
        }

        return new DOMRect(
          finalLeft,
          finalTop,
          widthVal ?? defaultW,
          heightVal ?? defaultH
        );
      }
    }

    // 6. 根据 DOM 结构推断合理的默认尺寸（如 Dialog、Menu、Button、Input、Tooltip）
    if (
      role === 'dialog' ||
      role === 'menu' ||
      role === 'listbox' ||
      this.classList.contains('menuContent')
    ) {
      // 菜单/弹窗默认尺寸：宽 200px, 高 240px
      return new DOMRect(100, 100, 200, 240);
    }
    if (role === 'tooltip') {
      return new DOMRect(100, 100, 80, 24);
    }
    if (tag === 'button' || role === 'button') {
      return new DOMRect(50, 50, 80, 32);
    }
    if (
      this.classList.contains('ProseMirror') ||
      this.getAttribute('contenteditable') === 'true'
    ) {
      return new DOMRect(
        24,
        engine.currentViewport.height - 120,
        Math.max(100, engine.currentViewport.width - 48),
        60
      );
    }

    // 默认通用未设定尺寸元素盒（对齐 jsdom 原生行为，防止破坏未设宽高的元素）
    return new DOMRect(0, 0, 0, 0);
  };
  return true;
}

/**
 * 安装 HTMLElement 的 offsetWidth / offsetHeight 取值器，使其基于 getBoundingClientRect 解算。
 */
export function installOffsetShim(): void {
  if (typeof HTMLElement === 'undefined') return;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    get(this: HTMLElement) {
      const rect = this.getBoundingClientRect();
      return Math.round(rect.width);
    },
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) {
      const rect = this.getBoundingClientRect();
      return Math.round(rect.height);
    },
    configurable: true,
  });
}
