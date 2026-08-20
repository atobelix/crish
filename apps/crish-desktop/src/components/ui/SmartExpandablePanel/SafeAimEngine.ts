import type { Point2D, SafeAimOptions } from './types';

export interface SubmenuStackEntry {
  triggerEl: HTMLElement;
  submenuEl: HTMLElement;
}

export class SafeAimEngine {
  private static defaultInstance: SafeAimEngine | null = null;
  private enabled: boolean;
  private debug: boolean;
  private readonly timeoutMs: number;
  private submenuStack: SubmenuStackEntry[] = [];
  private mouseHistory: Point2D[] = [];
  private readonly MAX_MOUSE_HISTORY = 4;
  private safeZoneEntryTimestamp: number | null = null;
  private svgOverlay: SVGSVGElement | null = null;
  private polygonEl: SVGPolygonElement | null = null;
  private container: HTMLElement | null = null;

  public static getInstance(options: SafeAimOptions = {}): SafeAimEngine {
    if (!SafeAimEngine.defaultInstance) {
      SafeAimEngine.defaultInstance = new SafeAimEngine(options);
    }
    return SafeAimEngine.defaultInstance;
  }

  constructor(options: SafeAimOptions = {}, container?: HTMLElement | null) {
    this.enabled = options.enabled ?? true;
    this.debug = options.debug ?? false;
    this.timeoutMs = options.timeoutMs ?? 300;
    this.container = container || null;
    this.onMouseMove = this.onMouseMove.bind(this);

    if (typeof document !== 'undefined') {
      this.initSvgOverlay();
      window.addEventListener('mousemove', this.onMouseMove, { passive: true });
    }
  }

  private initSvgOverlay(): void {
    const parent = this.container || (typeof document !== 'undefined' ? document.body : null);
    if (!parent) return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2005;';
    if (this.debug) {
      svg.style.background = 'rgba(16, 185, 129, 0.05)';
    }

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.style.cssText = this.debug
      ? 'fill:rgba(16,185,129,0.15);stroke:hsl(160,84%,39%);stroke-width:1px;'
      : 'fill:transparent;stroke:transparent;';

    svg.appendChild(poly);
    parent.appendChild(svg);
    this.svgOverlay = svg;
    this.polygonEl = poly;
  }

  private onMouseMove(e: MouseEvent): void {
    this.mouseHistory.push({ x: e.clientX, y: e.clientY });
    if (this.mouseHistory.length > this.MAX_MOUSE_HISTORY) {
      this.mouseHistory.shift();
    }
    this.updatePolygon();
  }

  public getRecentMousePos(): Point2D {
    return this.mouseHistory.length > 0
      ? this.mouseHistory[this.mouseHistory.length - 1] ?? { x: 0, y: 0 }
      : { x: 0, y: 0 };
  }

  public getPreviousMousePos(): Point2D {
    return this.mouseHistory.length > 1
      ? this.mouseHistory[0] ?? this.getRecentMousePos()
      : this.getRecentMousePos();
  }

  public pushSubmenu(triggerEl: HTMLElement, submenuEl: HTMLElement): void {
    this.submenuStack.push({ triggerEl, submenuEl });
    this.safeZoneEntryTimestamp = null;
    this.updatePolygon();
  }

  public popSubmenu(): void {
    this.submenuStack.pop();
    this.safeZoneEntryTimestamp = null;
    this.updatePolygon();
  }

  public setSubmenu(triggerEl: HTMLElement | null, submenuEl: HTMLElement | null, _side?: string): void {
    if (!triggerEl || !submenuEl) {
      this.clearSubmenu();
      return;
    }
    this.submenuStack = [{ triggerEl, submenuEl }];
    this.safeZoneEntryTimestamp = null;
    this.updatePolygon();
  }

  public clearSubmenu(): void {
    this.submenuStack = [];
    this.safeZoneEntryTimestamp = null;
    if (this.polygonEl) this.polygonEl.removeAttribute('points');
  }

  public getActiveSubmenu(): SubmenuStackEntry | null {
    if (this.submenuStack.length === 0) return null;
    return this.submenuStack[this.submenuStack.length - 1] ?? null;
  }

  public updatePolygon(): void {
    if (!this.enabled || this.submenuStack.length === 0 || !this.polygonEl) {
      if (this.polygonEl) this.polygonEl.removeAttribute('points');
      return;
    }

    const active = this.getActiveSubmenu();
    if (!active) return;
    const subRect = active.submenuEl.getBoundingClientRect();
    if (subRect.width === 0 || subRect.height === 0) return;

    const mouse = this.getRecentMousePos();
    const isRight = subRect.left >= mouse.x;
    const pTop: Point2D = isRight ? { x: subRect.left, y: subRect.top } : { x: subRect.right, y: subRect.top };
    const pBottom: Point2D = isRight ? { x: subRect.left, y: subRect.bottom } : { x: subRect.right, y: subRect.bottom };

    this.polygonEl.setAttribute('points', `${mouse.x},${mouse.y} ${pTop.x},${pTop.y} ${pBottom.x},${pBottom.y}`);
  }

  public isPointerInSafeZone(point: Point2D, _side?: string): boolean {
    if (!this.enabled || this.submenuStack.length === 0) return false;
    const active = this.getActiveSubmenu();
    if (!active) return false;

    const subRect = active.submenuEl.getBoundingClientRect();
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

    const isRight = subRect.left >= prevMouse.x;
    const pTop: Point2D = isRight ? { x: subRect.left, y: subRect.top } : { x: subRect.right, y: subRect.top };
    const pBottom: Point2D = isRight ? { x: subRect.left, y: subRect.bottom } : { x: subRect.right, y: subRect.bottom };

    const inTriangle = this.pointInTriangle(point, prevMouse, pTop, pBottom);
    if (!inTriangle) {
      this.safeZoneEntryTimestamp = null;
      return false;
    }

    // 300ms 停顿安全超时熔断
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

  private pointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
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

    const inv = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * inv;
    const v = (dot00 * dot12 - dot01 * dot02) * inv;
    return u >= 0 && v >= 0 && u + v <= 1;
  }

  public destroy(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.onMouseMove);
    }
    if (this.svgOverlay && this.svgOverlay.parentNode) {
      this.svgOverlay.parentNode.removeChild(this.svgOverlay);
    }
    this.svgOverlay = null;
    this.polygonEl = null;
  }
}
