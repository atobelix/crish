// =============================================================================
// apps/crish-desktop/src/test-utils/MockPhysicalGeometryEngine.ts
// 物理几何仿真引擎（工业级高精加固版，支持 CJK 多字节行盒仿真与严格数值校验）
// =============================================================================

export interface TestViewportConfig {
  width: number;
  height: number;
  scrollX?: number;
  scrollY?: number;
  devicePixelRatio?: number;
}

export interface ElementGeometryConfig {
  x?: number;
  y?: number;
  top?: number;
  left?: number;
  width: number;
  height: number;
}

export class MockPhysicalGeometryEngine {
  private static instance: MockPhysicalGeometryEngine | null = null;

  private currentViewport: TestViewportConfig = {
    width: 1200,
    height: 800,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
  };

  private elementRectMap = new WeakMap<Element, DOMRect>();
  private selectorRectMap = new Map<string, DOMRect>();

  // 默认物理文字排版行盒参数
  public defaultLineHeight = 20.3;
  public defaultCharWidth = 8.5; // ASCII 拉丁字符宽度
  public cjkCharWidth = 14; // CJK 中文字符宽度

  private originalRangeGetBoundingClientRect:
    typeof Range.prototype.getBoundingClientRect | null = null;
  private originalRangeGetClientRects:
    typeof Range.prototype.getClientRects | null = null;
  private originalElementGetBoundingClientRect:
    typeof Element.prototype.getBoundingClientRect | null = null;

  private constructor() {}

  public static getInstance(): MockPhysicalGeometryEngine {
    if (!MockPhysicalGeometryEngine.instance) {
      MockPhysicalGeometryEngine.instance = new MockPhysicalGeometryEngine();
    }
    return MockPhysicalGeometryEngine.instance;
  }

  public static setViewport(w: number, h: number): void {
    MockPhysicalGeometryEngine.getInstance().setViewport({
      width: w,
      height: h,
    });
  }

  public static reset(): void {
    MockPhysicalGeometryEngine.getInstance().reset();
  }

  /**
   * 设置测试视口尺寸与滚动量
   */
  public setViewport(config: Partial<TestViewportConfig>): void {
    this.currentViewport = {
      ...this.currentViewport,
      ...config,
    };

    if (typeof window !== 'undefined') {
      // 同步更新 window.innerWidth / innerHeight 与 visualViewport
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: this.currentViewport.width,
      });
      Object.defineProperty(window, 'innerHeight', {
        writable: true,
        configurable: true,
        value: this.currentViewport.height,
      });
      Object.defineProperty(window, 'scrollX', {
        writable: true,
        configurable: true,
        value: this.currentViewport.scrollX ?? 0,
      });
      Object.defineProperty(window, 'scrollY', {
        writable: true,
        configurable: true,
        value: this.currentViewport.scrollY ?? 0,
      });
      Object.defineProperty(window, 'devicePixelRatio', {
        writable: true,
        configurable: true,
        value: this.currentViewport.devicePixelRatio ?? 1,
      });

      Object.defineProperty(window, 'visualViewport', {
        writable: true,
        configurable: true,
        value: {
          width: this.currentViewport.width,
          height: this.currentViewport.height,
          offsetLeft: 0,
          offsetTop: 0,
          pageLeft: this.currentViewport.scrollX ?? 0,
          pageTop: this.currentViewport.scrollY ?? 0,
          scale: 1,
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      });
    }
  }

  /**
   * 为特定 DOM 元素注册真实的物理测量尺寸
   */
  public registerElementRect(el: Element, rect: ElementGeometryConfig): void {
    const top = rect.top ?? rect.y ?? 0;
    const left = rect.left ?? rect.x ?? 0;
    const domRect = new DOMRect(left, top, rect.width, rect.height);
    this.elementRectMap.set(el, domRect);
  }

  /**
   * 为特定选择器（如 .menuContent、[role="dialog"]）注册预设尺寸
   */
  public registerSelectorRect(
    selector: string,
    rect: ElementGeometryConfig
  ): void {
    const top = rect.top ?? rect.y ?? 0;
    const left = rect.left ?? rect.x ?? 0;
    const domRect = new DOMRect(left, top, rect.width, rect.height);
    this.selectorRectMap.set(selector, domRect);
  }

  /**
   * 获取当前视口配置
   */
  public getViewport(): TestViewportConfig {
    return { ...this.currentViewport };
  }

  /**
   * 安装物理排版仿真垫片（接管 Range 与 Element 的测量能力）
   */
  public install(): void {
    if (
      typeof Range !== 'undefined' &&
      !this.originalRangeGetBoundingClientRect
    ) {
      this.originalRangeGetBoundingClientRect =
        Range.prototype.getBoundingClientRect;
      this.originalRangeGetClientRects = Range.prototype.getClientRects;

      Range.prototype.getBoundingClientRect = function (): DOMRect {
        const engine = MockPhysicalGeometryEngine.getInstance();
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
    }

    if (
      typeof Element !== 'undefined' &&
      !this.originalElementGetBoundingClientRect
    ) {
      this.originalElementGetBoundingClientRect =
        Element.prototype.getBoundingClientRect;

      Element.prototype.getBoundingClientRect = function (): DOMRect {
        const engine = MockPhysicalGeometryEngine.getInstance();
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
    }

    if (typeof HTMLElement !== 'undefined') {
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
  }

  /**
   * 重置引擎状态（清除注册的尺寸、恢复默认视口 1200x800）
   */
  public reset(): void {
    this.elementRectMap = new WeakMap();
    this.selectorRectMap.clear();
    this.setViewport({
      width: 1200,
      height: 800,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
    });
  }

  /**
   * 卸载垫片，彻底恢复原生原型
   */
  public uninstall(): void {
    if (this.originalRangeGetBoundingClientRect) {
      Range.prototype.getBoundingClientRect =
        this.originalRangeGetBoundingClientRect;
      Range.prototype.getClientRects = this.originalRangeGetClientRects!;
      this.originalRangeGetBoundingClientRect = null;
      this.originalRangeGetClientRects = null;
    }
    if (this.originalElementGetBoundingClientRect) {
      Element.prototype.getBoundingClientRect =
        this.originalElementGetBoundingClientRect;
      this.originalElementGetBoundingClientRect = null;
    }
    this.reset();
  }
}
