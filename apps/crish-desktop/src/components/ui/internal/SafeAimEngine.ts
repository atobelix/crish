/**
 * apps/crish-desktop/src/components/ui/internal/SafeAimEngine.ts
 *
 * SafeAimEngine - Zero-Canvas SVG Polygon Safe-Triangle Hover Protection Engine
 * 严格对齐 reference/smart-expandable-panel/js/safe-aim.js 与 02-pixel-perfect-implementation-plan.md §7.2 规范：
 * 1. 维护单例 SVG 虚拟多边形碰撞检测层（#sepSafeAimOverlay），零 Canvas 额外渲染开销；
 * 2. 追踪鼠标轨迹历史（4 帧队列），计算光标运动趋势向量；
 * 3. 采用重心坐标（Barycentric Coordinates）与 2D 叉积算法 O(1) 判定光标是否在 Safe Triangle 保护区；
 * 4. 支持四向方位 (left / right / top / bottom) 级联展开与动态多边形渲染；
 * 5. 支持级联子菜单堆栈（SubmenuStack）与速度矢量反向判定（v · d <= 0 立即释放）；
 * 6. 支持 300ms 停顿安全超时熔断，彻底消除鼠标斜向划入二级级联子菜单时的闪烁与误关闭；
 * 7. destroy() 彻底清理 DOM、监听器并置空 instance 单例。
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface SafeAimOptions {
  enabled?: boolean;
  debug?: boolean;
  timeoutMs?: number;
}

export type SubmenuPlacement = 'left' | 'right' | 'top' | 'bottom';

export interface SubmenuStackEntry {
  triggerEl: HTMLElement;
  submenuEl: HTMLElement;
}

export class SafeAimEngine {
  private static instance: SafeAimEngine | null = null;

  public enabled: boolean;
  public debug: boolean;
  public readonly timeoutMs: number;
  public activeSubmenu: HTMLElement | null = null;
  public activeTriggerItem: HTMLElement | null = null;
  public activePlacement: SubmenuPlacement | null = null;
  private submenuStack: SubmenuStackEntry[] = [];
  private mouseHistory: Point2D[] = [];
  private readonly MAX_MOUSE_HISTORY = 4;
  private safeZoneEntryTimestamp: number | null = null;

  private svgOverlay: SVGSVGElement | null = null;
  private polygonEl: SVGPolygonElement | null = null;
  private isListening = false;
  private container: HTMLElement | null = null;

  constructor(options: SafeAimOptions = {}, container?: HTMLElement | null) {
    this.enabled = options.enabled ?? true;
    this.debug = options.debug ?? false;
    this.timeoutMs = options.timeoutMs ?? 300;
    this.container = container || null;
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

  public initSvgOverlay(): void {
    if (typeof document === 'undefined') return;
    let svg = document.getElementById('sepSafeAimOverlay') as unknown as SVGSVGElement | null;
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'sepSafeAimOverlay';
      svg.classList.add('sep-safe-aim-overlay');
      if (this.debug) svg.classList.add('sep-debug-visible');

      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      svg.appendChild(poly);
      const parent = this.container || document.body;
      if (parent) {
        parent.appendChild(svg);
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

  public onMouseMove(e: { clientX: number; clientY: number }): void {
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

  public setSubmenu(
    triggerItemEl: HTMLElement | null,
    submenuEl: HTMLElement | null,
    placement?: SubmenuPlacement
  ): void {
    if (!triggerItemEl || !submenuEl) {
      this.clearSubmenu();
      return;
    }
    this.activeTriggerItem = triggerItemEl;
    this.activeSubmenu = submenuEl;
    this.activePlacement = placement ?? null;
    this.submenuStack = [{ triggerEl: triggerItemEl, submenuEl }];
    this.safeZoneEntryTimestamp = null;
    this.updatePolygon();
  }

  public clearSubmenu(): void {
    this.activeTriggerItem = null;
    this.activeSubmenu = null;
    this.activePlacement = null;
    this.submenuStack = [];
    this.safeZoneEntryTimestamp = null;
    this.mouseHistory = [];
    this.clearPolygon();
  }

  public reset(): void {
    this.clearSubmenu();
  }

  public pushSubmenu(triggerEl: HTMLElement, submenuEl: HTMLElement): void {
    this.submenuStack.push({ triggerEl, submenuEl });
    this.activeTriggerItem = triggerEl;
    this.activeSubmenu = submenuEl;
    this.safeZoneEntryTimestamp = null;
    this.updatePolygon();
  }

  public popSubmenu(): void {
    this.submenuStack.pop();
    const active = this.getActiveSubmenu();
    this.activeTriggerItem = active?.triggerEl ?? null;
    this.activeSubmenu = active?.submenuEl ?? null;
    this.safeZoneEntryTimestamp = null;
    this.updatePolygon();
  }

  public getActiveSubmenu(): SubmenuStackEntry | null {
    if (this.submenuStack.length === 0) return null;
    return this.submenuStack[this.submenuStack.length - 1] ?? null;
  }

  public setPolygonPoints(p1: Point2D, p2: Point2D, p3: Point2D): void {
    if (!this.polygonEl) {
      this.initSvgOverlay();
    }
    if (this.polygonEl) {
      this.polygonEl.setAttribute(
        'points',
        `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`
      );
    }
  }

  public clearPolygon(): void {
    if (this.polygonEl) {
      this.polygonEl.removeAttribute('points');
    }
  }

  public updatePolygon(): void {
    if (!this.enabled) {
      this.clearPolygon();
      return;
    }

    const targetSubmenu = this.activeSubmenu || this.getActiveSubmenu()?.submenuEl;
    if (!targetSubmenu) {
      this.clearPolygon();
      return;
    }

    const subRect = targetSubmenu.getBoundingClientRect();
    if (subRect.width === 0 || subRect.height === 0) {
      this.clearPolygon();
      return;
    }

    const mouse = this.getRecentMousePos();
    const placement = this.activePlacement;

    let pTop: Point2D;
    let pBottom: Point2D;

    if (placement === 'bottom') {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.top };
    } else if (placement === 'top') {
      pTop = { x: subRect.left, y: subRect.bottom };
      pBottom = { x: subRect.right, y: subRect.bottom };
    } else if (placement === 'left') {
      pTop = { x: subRect.right, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.bottom };
    } else if (placement === 'right') {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.left, y: subRect.bottom };
    } else {
      // 缺省自适应判定
      const isSubmenuOnRight = subRect.left >= mouse.x;
      if (isSubmenuOnRight) {
        pTop = { x: subRect.left, y: subRect.top };
        pBottom = { x: subRect.left, y: subRect.bottom };
      } else {
        pTop = { x: subRect.right, y: subRect.top };
        pBottom = { x: subRect.right, y: subRect.bottom };
      }
    }

    this.setPolygonPoints(mouse, pTop, pBottom);
  }

  public isPointerInSafeZone(
    point: Point2D,
    placement?: SubmenuPlacement
  ): boolean {
    if (!this.enabled) return false;
    const targetSubmenu = this.activeSubmenu || this.getActiveSubmenu()?.submenuEl;
    if (!targetSubmenu) return false;

    const subRect = targetSubmenu.getBoundingClientRect();
    if (subRect.width === 0 || subRect.height === 0) return false;

    const mouse = this.getRecentMousePos();
    const prevMouse = this.getPreviousMousePos();

    // 速度矢量导数判定 (v · d > 0)
    const vx = mouse.x - prevMouse.x;
    const vy = mouse.y - prevMouse.y;
    const targetCenterX = subRect.left + subRect.width / 2;
    const targetCenterY = subRect.top + subRect.height / 2;
    const dx = targetCenterX - mouse.x;
    const dy = targetCenterY - mouse.y;
    const dotProduct = vx * dx + vy * dy;

    // 若光标反向远离目标子菜单，立即释放安全区
    if (this.mouseHistory.length > 1 && (vx !== 0 || vy !== 0) && dotProduct <= 0) {
      this.safeZoneEntryTimestamp = null;
      return false;
    }

    const resolvedPlacement = placement ?? this.activePlacement;
    let pTop: Point2D;
    let pBottom: Point2D;

    if (resolvedPlacement === 'bottom') {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.top };
    } else if (resolvedPlacement === 'top') {
      pTop = { x: subRect.left, y: subRect.bottom };
      pBottom = { x: subRect.right, y: subRect.bottom };
    } else if (resolvedPlacement === 'left') {
      pTop = { x: subRect.right, y: subRect.top };
      pBottom = { x: subRect.right, y: subRect.bottom };
    } else if (resolvedPlacement === 'right') {
      pTop = { x: subRect.left, y: subRect.top };
      pBottom = { x: subRect.left, y: subRect.bottom };
    } else {
      const isSubmenuOnRight = subRect.left >= prevMouse.x;
      if (isSubmenuOnRight) {
        pTop = { x: subRect.left, y: subRect.top };
        pBottom = { x: subRect.left, y: subRect.bottom };
      } else {
        pTop = { x: subRect.right, y: subRect.top };
        pBottom = { x: subRect.right, y: subRect.bottom };
      }
    }

    const inTriangle = this.pointInTriangle(point, prevMouse, pTop, pBottom);
    if (!inTriangle) {
      this.safeZoneEntryTimestamp = null;
      return false;
    }

    // 停顿安全超时熔断
    const now = Date.now();
    if (this.safeZoneEntryTimestamp === null) {
      this.safeZoneEntryTimestamp = now;
      return true;
    }
    if (now - this.safeZoneEntryTimestamp > this.timeoutMs) {
      this.safeZoneEntryTimestamp = null;
      return false;
    }

    return true;
  }

  /**
   * 重心坐标系 (Barycentric Coordinates) 三角形内点判定
   * 采用 float epsilon 容差（1e-6），确保边界点与顶点判定稳定
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
    if (Math.abs(denom) < 1e-9) return false;

    const invDenom = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
    const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

    const eps = 1e-6;
    return u >= -eps && v >= -eps && u + v <= 1 + eps;
  }

  public destroy(): void {
    this.detach();
    this.mouseHistory = [];
    this.submenuStack = [];
    this.safeZoneEntryTimestamp = null;
    if (this.svgOverlay && this.svgOverlay.parentNode) {
      this.svgOverlay.parentNode.removeChild(this.svgOverlay);
      this.svgOverlay = null;
      this.polygonEl = null;
    }
    if (SafeAimEngine.instance === this) {
      SafeAimEngine.instance = null;
    }
  }
}
