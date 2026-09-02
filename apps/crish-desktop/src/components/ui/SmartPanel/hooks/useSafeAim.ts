import { useEffect, useRef, useCallback } from 'react';
import type { Point2D, SafeAimOptions } from '../types';

export interface SubmenuAimEntry {
  triggerEl: HTMLElement;
  submenuEl: HTMLElement;
}

function isPointInTriangle(p: Point2D, a: Point2D, b: Point2D, c: Point2D): boolean {
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

  const invDenom = 1 / (dot00 * dot11 - dot01 * dot01 || 1e-6);
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;

  return u >= 0 && v >= 0 && u + v < 1;
}

export function useSafeAim(options: SafeAimOptions = {}) {
  const enabled = options.enabled ?? true;
  const timeoutMs = options.timeoutMs ?? options.safetyTimeoutMs ?? 300;

  const submenuStackRef = useRef<SubmenuAimEntry[]>([]);
  const mouseHistoryRef = useRef<Point2D[]>([]);
  const safeZoneEntryTimeRef = useRef<number | null>(null);
  const svgOverlayRef = useRef<SVGSVGElement | null>(null);
  const polygonElRef = useRef<SVGPolygonElement | null>(null);

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:var(--z-popover);';

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.style.cssText = options.debug
      ? 'fill:rgba(16,185,129,0.15);stroke:hsl(160,84%,39%);stroke-width:1px;'
      : 'fill:transparent;stroke:transparent;';

    svg.appendChild(poly);
    document.body.appendChild(svg);
    svgOverlayRef.current = svg;
    polygonElRef.current = poly;

    const handleMouseMove = (e: MouseEvent) => {
      mouseHistoryRef.current.push({ x: e.clientX, y: e.clientY });
      if (mouseHistoryRef.current.length > 4) {
        mouseHistoryRef.current.shift();
      }
      updatePolygon();
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (svg.parentNode) {
        svg.parentNode.removeChild(svg);
      }
      svgOverlayRef.current = null;
      polygonElRef.current = null;
    };
  }, [enabled, options.debug]);

  const updatePolygon = useCallback(() => {
    if (!enabled || submenuStackRef.current.length === 0 || !polygonElRef.current) {
      polygonElRef.current?.removeAttribute('points');
      return;
    }

    const active = submenuStackRef.current[submenuStackRef.current.length - 1];
    if (!active) return;
    const subRect = active.submenuEl.getBoundingClientRect();
    if (subRect.width === 0 || subRect.height === 0) return;

    const mouse = mouseHistoryRef.current[mouseHistoryRef.current.length - 1] ?? { x: 0, y: 0 };
    const isRight = subRect.left >= mouse.x;
    const pTop: Point2D = isRight ? { x: subRect.left, y: subRect.top } : { x: subRect.right, y: subRect.top };
    const pBottom: Point2D = isRight ? { x: subRect.left, y: subRect.bottom } : { x: subRect.right, y: subRect.bottom };

    polygonElRef.current.setAttribute(
      'points',
      `${mouse.x},${mouse.y} ${pTop.x},${pTop.y} ${pBottom.x},${pBottom.y}`
    );
  }, [enabled]);

  const isPointerInSafeZone = useCallback(
    (point: Point2D): boolean => {
      if (!enabled || submenuStackRef.current.length === 0) return false;
      const active = submenuStackRef.current[submenuStackRef.current.length - 1];
      if (!active) return false;

      const subRect = active.submenuEl.getBoundingClientRect();
      const mouse = mouseHistoryRef.current[mouseHistoryRef.current.length - 1] ?? point;
      const prevMouse = mouseHistoryRef.current[0] ?? mouse;

      // 速度矢量导数判定 (v · d > 0)
      const vx = mouse.x - prevMouse.x;
      const vy = mouse.y - prevMouse.y;
      const targetCenterX = subRect.left + subRect.width / 2;
      const targetCenterY = subRect.top + subRect.height / 2;
      const dx = targetCenterX - mouse.x;
      const dy = targetCenterY - mouse.y;

      if (vx * dx + vy * dy <= 0 && (vx !== 0 || vy !== 0)) {
        return false;
      }

      const isRight = subRect.left >= mouse.x;
      const pTop: Point2D = isRight ? { x: subRect.left, y: subRect.top } : { x: subRect.right, y: subRect.top };
      const pBottom: Point2D = isRight ? { x: subRect.left, y: subRect.bottom } : { x: subRect.right, y: subRect.bottom };

      const inside = isPointInTriangle(point, mouse, pTop, pBottom);
      if (inside) {
        const now = Date.now();
        if (safeZoneEntryTimeRef.current === null) {
          safeZoneEntryTimeRef.current = now;
        } else if (now - safeZoneEntryTimeRef.current > timeoutMs) {
          return false;
        }
        return true;
      }

      safeZoneEntryTimeRef.current = null;
      return false;
    },
    [enabled, timeoutMs]
  );

  const setSubmenu = useCallback((triggerEl: HTMLElement | null, submenuEl: HTMLElement | null) => {
    if (!triggerEl || !submenuEl) {
      submenuStackRef.current = [];
      safeZoneEntryTimeRef.current = null;
      polygonElRef.current?.removeAttribute('points');
      return;
    }
    submenuStackRef.current = [{ triggerEl, submenuEl }];
    safeZoneEntryTimeRef.current = null;
    updatePolygon();
  }, [updatePolygon]);

  const clearSubmenu = useCallback(() => {
    submenuStackRef.current = [];
    safeZoneEntryTimeRef.current = null;
    polygonElRef.current?.removeAttribute('points');
  }, []);

  return {
    isPointerInSafeZone,
    setSubmenu,
    clearSubmenu,
    updatePolygon,
  };
}
