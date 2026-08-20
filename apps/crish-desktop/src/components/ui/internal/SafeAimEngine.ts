/**
 * apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts
 *
 * SafeAimEngine - Zero-Canvas SVG Polygon Safe-Triangle Hover Protection Engine
 * 严格对齐 reference/smart-expandable-panel/js/safe-aim.js 规范：
 * 1. 维护单例 SVG 虚拟多边形碰撞检测层（#sepSafeAimOverlay），零 Canvas 额外渲染开销；
 * 2. 追踪鼠标轨迹历史（4 帧队列），计算光标运动趋势向量；
 * 3. 采用重心坐标（Barycentric Coordinates）与 2D 叉积算法 O(1) 判定光标是否在 Safe Triangle 保护区；
 * 4. 彻底消除鼠标斜向划入二级级联子菜单时的闪烁与误关闭。
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface SafeAimOptions {
  enabled?: boolean;
  debug?: boolean;
}

export class SafeAimEngine {
  private static instance: SafeAimEngine | null = null;

  public enabled: boolean;
  public debug: boolean;
  public activeSubmenu: HTMLElement | null = null;
  public activeTriggerItem: HTMLElement | null = null;
  private mouseHistory: Point2D[] = [];
  private readonly MAX_MOUSE_HISTORY = 4;

  private svgOverlay: SVGSVGElement | null = null;
  private polygonEl: SVGPolygonElement | null = null;
  private isListening = false;

  constructor(options: SafeAimOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.debug = options.debug ?? false;
    this.onMouseMove = this.onMouseMove.bind(this);
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      this.initSvgOverlay();
      this.attach();
    }
  }

  public static getInstance(options?: SafeAimOptions): SafeAimEngine {
    if (!SafeAimEngine.instance) {
      SafeAimEngine.instance = new SafeAimEngine(options);
    } else if (options) {
      if (options.enabled !== undefined) SafeAimEngine.instance.enabled = options.enabled;
      if (options.debug !== undefined) SafeAimEngine.instance.setDebug(options.debug);
    }
    return SafeAimEngine.instance;
  }

  private initSvgOverlay(): void {
    if (typeof document === 'undefined') return;
    let svg = document.getElementById('sepSafeAimOverlay') as unknown as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'sepSafeAimOverlay';
      svg.classList.add('sep-safe-aim-overlay');
      if (this.debug) svg.classList.add('sep-debug-visible');

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      svg.appendChild(poly);
      if (document.body) {
        document.body.appendChild(svg);
      }
    }
    this.svgOverlay = svg;
    this.polygonEl = svg.querySelector('polygon');
  }

  public attach(): void {
    if (this.isListening || typeof window === 'undefined') return;
    window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    this.isListening = true;
  }

  public detach(): void {
    if (!this.isListening || typeof window === 'undefined') return;
    window.removeEventListener('mousemove', this.onMouseMove);
    this.isListening = false;
    this.clearPolygon();
  }

  public setDebug(visible: boolean): void {
    this.debug = visible;
    if (this.svgOverlay) {
      this.svgOverlay.classList.toggle('sep-debug-visible', this.debug);
    }
  }

  private onMouseMove(e: MouseEvent): void {
    this.mouseHistory.push({ x: e.clientX, y: e.clientY });
    if (this.mouseHistory.length > this.MAX_MOUSE_HISTORY) {
      this.mouseHistory.shift();
    }
    this.updatePolygon();
  }

  public getRecentMousePos(): Point2D {
    const last = this.mouseHistory[this.mouseHistory.length - 1];
    return last ? { x: last.x, y: last.y } : { x: 0, y: 0 };
  }

  public getPreviousMousePos(): Point2D {
    const first = this.mouseHistory[0];
    return this.mouseHistory.length > 1 && first
      ? { x: first.x, y: first.y }
      : this.getRecentMousePos();
  }

  public setSubmenu(triggerItemEl: HTMLElement | null, submenuEl: HTMLElement | null): void {
    this.activeTriggerItem = triggerItemEl;
    this.activeSubmenu = submenuEl;
    this.updatePolygon();
  }

  public clearSubmenu(): void {
    this.activeTriggerItem = null;
    this.activeSubmenu = null;
    this.clearPolygon();
  }

  private clearPolygon(): void {
    if (this.polygonEl) {
      this.polygonEl.removeAttribute('points');
    }
  }

  public updatePolygon(): void {
    if (!this.enabled || !this.activeSubmenu || !this.polygonEl) {
      this.clearPolygon();
      return;
    }

    const subRect = this.activeSubmenu.getBoundingClientRect();
    if (subRect.width === 0 || subRect.height === 0) {
      this.clearPolygon();
      return;
    }

    const mouse = this.getRecentMousePos();
    const isSubmenuOnRight = subRect.left >= mouse.x;

    let pTop: Point2D;
    let pBottom: Point2D;
    if (isSubmenuOnRight) {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.left, y: subRect.bottom };
    } else {
      pTop = { x: subRect.right, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.bottom };
    }

    const points = `${mouse.x},${mouse.y} ${pTop.x},${pTop.y} ${pBottom.x},${pBottom.y}`;
    this.polygonEl.setAttribute('points', points);
  }

  public isPointerInSafeZone(point: Point2D): boolean {
    if (!this.enabled || !this.activeSubmenu) return false;

    const subRect = this.activeSubmenu.getBoundingClientRect();
    const mouse = this.getPreviousMousePos();
    const isSubmenuOnRight = subRect.left >= mouse.x;

    let pTop: Point2D;
    let pBottom: Point2D;
    if (isSubmenuOnRight) {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.left, y: subRect.bottom };
    } else {
      pTop = { x: subRect.right, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.bottom };
    }

    return this.pointInTriangle(point, mouse, pTop, pBottom);
  }

  /**
   * 重心坐标系 (Barycentric Coordinates) 三角形内点判定
   */
  public pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
    const v0x = c.x - a.x;
    const v0y = c.y - a.y;
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = p.x - a.x;
    const v2y = p.y - a.y;

    const dot00 = v0x * v0x + v0y * v0y;
    const dot01 = v0x * v1x + v0y * v1y;
    const dot02 = v0x * v2x + v0y * v2y;
    const dot11 = v1x * v1x + v1y * v1y;
    const dot12 = v1x * v2x + v1y * v2y;

    const denom = dot00 * dot11 - dot01 * dot01;
    if (denom === 0) return false;

    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    return u >= 0 && v >= 0 && u + v <= 1;
  }

  public destroy(): void {
    this.detach();
    if (this.svgOverlay && this.svgOverlay.parentNode) {
      this.svgOverlay.parentNode.removeChild(this.svgOverlay);
      this.svgOverlay = null;
      this.polygonEl = null;
    }
  }
}
