// =============================================================================
// apps/crish-desktop/src/test-utils/MockPhysicalGeometryEngine.ts
// 物理几何仿真引擎（工业级高精加固版，支持 CJK 多字节行盒仿真与严格数值校验）
// 垫片实现细节拆分至 mockGeometryShims.ts（纯结构性重构，行为零变更）
// =============================================================================

import {
  installRangeShim,
  installElementShim,
  installOffsetShim,
} from './mockGeometryShims';

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

  // 拆分后由 mockGeometryShims 直接读取（同包友元访问），保持行为不变
  public elementRectMap = new WeakMap<Element, DOMRect>();
  public selectorRectMap = new Map<string, DOMRect>();
  public currentViewport: TestViewportConfig = {
    width: 1200,
    height: 800,
    scrollX: 0,
    scrollY: 0,
    devicePixelRatio: 1,
  };

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
    if (!this.originalRangeGetBoundingClientRect) {
      const installed = installRangeShim(this, (original, originalRects) => {
        this.originalRangeGetBoundingClientRect = original;
        this.originalRangeGetClientRects = originalRects;
      });
      if (installed) {
        // 垫片已写入 Range 原型；若未安装（无 Range），保持原值不变
      }
    }

    if (!this.originalElementGetBoundingClientRect) {
      installElementShim(this, (original) => {
        this.originalElementGetBoundingClientRect = original;
      });
    }

    installOffsetShim();
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
