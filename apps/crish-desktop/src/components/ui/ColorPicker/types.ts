import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useId,
} from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';
import {
  animate,
  useMotionValue,
  useTransform,
  type MotionValue,
  type Transition,
} from 'motion/react';
import type { ColorFormat, Hsva, Rgba } from '../../../utils/color/colorMath';
import { clamp, round, formatColor } from '../../../utils/color/colorMath';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';

export type { ColorFormat, Hsva, Rgba };

export interface ColorSwatch {
  id: string;
  color: string;
}

export interface ColorPickerProps {
  /** Any color the picker can read: hex, rgb(), hsl(), or oklch(). */
  value?: string;
  defaultValue?: string;
  /** Receives the color as hex, with two alpha digits when it is not opaque. */
  onValueChange?: (hex: string) => void;
  /** The background the color will sit on, for the contrast readout. */
  background?: string;
  /** Name shown on the swatch, such as "Accent". */
  label?: string;
  swatches?: ColorSwatch[];
  defaultSwatches?: ColorSwatch[];
  onSwatchesChange?: (swatches: ColorSwatch[]) => void;
  /** Most saved swatches. Saving past it drops the oldest. */
  maxSwatches?: number;
  defaultFormat?: ColorFormat;
  className?: string;
  style?: CSSProperties;
}

export const FORMATS: ColorFormat[] = ['hex', 'rgb', 'hsl', 'oklch'];
export const FORMAT_NAMES: Record<ColorFormat, string> = {
  hex: 'Hex',
  rgb: 'RGB',
  hsl: 'HSL',
  oklch: 'OKLCH',
};

export const physical = (
  visualDuration: number,
  bounce: number
): Transition => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return {
    type: 'spring',
    stiffness: root * root,
    damping: 2 * (1 - bounce) * root,
    mass: 1,
    restDelta: 0.0005,
    restSpeed: 0.005,
  };
};

export const thumbSpring = physical(0.26, 0);
export const dragSpring = physical(0.1, 0);
export const openSpring = physical(0.42, 0.1);
export const closeSpring = physical(0.3, 0);
export const instant: Transition = { duration: 0 };

const subscribe = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  );
}

export function useEyeDropperAvailable(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && 'EyeDropper' in window,
    () => false
  );
}

let swatchIdCounter = 0;
export const createSwatchId = () =>
  `swatch-${Date.now().toString(36)}-${swatchIdCounter++}`;

export function useFollow(
  target: number,
  reduced: boolean,
  dragging = false
): MotionValue<number> {
  const value = useMotionValue(target);
  useEffect(() => {
    if (reduced) {
      value.jump(target);
      return;
    }
    const controls = animate(
      value,
      target,
      dragging ? dragSpring : thumbSpring
    );
    return () => controls.stop();
  }, [dragging, reduced, target, value]);
  return value;
}

export function useSurfaceAnimation({
  shown,
  open,
  reduced,
  openNow,
  setShown,
  panelRef,
  triggerRef,
}: {
  shown: boolean;
  open: boolean;
  reduced: boolean;
  openNow: RefObject<boolean>;
  setShown: (val: boolean) => void;
  panelRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const progress = useMotionValue(0);
  const fade = useMotionValue(0);
  const size = {
    W: useMotionValue(300),
    H: useMotionValue(420),
    w: useMotionValue(160),
    h: useMotionValue(38),
  };

  const clipPath = useTransform(() => {
    const q = clamp(progress.get());
    const r = (size.W.get() - size.w.get()) * (1 - q);
    const b = (size.H.get() - size.h.get()) * (1 - q);
    return `inset(0px ${round(r, 2)}px ${round(b, 2)}px 0px round ${round(20 + 4 * q, 2)}px)`;
  });

  const contentOpacity = useTransform(progress, [0.35, 0.9], [0, 1]);
  const contentY = useTransform(progress, [0, 1], [-10, 0]);

  useLayoutEffect(() => {
    if (!shown) return;
    const p = panelRef.current;
    const t = triggerRef.current;
    if (!p || !t) return;
    const measure = () => {
      size.W.set(p.offsetWidth || 300);
      size.H.set(p.offsetHeight || 420);
      size.w.set(t.offsetWidth || 160);
      size.h.set(t.offsetHeight || 38);
    };
    measure();
    const ro = ResizeObserverManager.getInstance();
    ro.observe(p, measure);
    return () => ro.unobserve(p, measure);
  }, [shown, panelRef, triggerRef]);

  useEffect(() => {
    if (!shown) return;
    if (reduced) {
      progress.jump(open ? 1 : 0);
      fade.jump(open ? 1 : 0);
      if (!open && !openNow.current) setShown(false);
      return;
    }
    fade.jump(1);
    const ctrl = animate(
      progress,
      open ? 1 : 0,
      open ? openSpring : closeSpring
    );
    if (!open) {
      ctrl.then(() => {
        if (!openNow.current) setShown(false);
      });
    }
    return () => ctrl.stop();
  }, [open, shown, reduced, openNow, setShown, progress, fade]);

  return { clipPath, fade, contentOpacity, contentY };
}

export function useDismissListener(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  onDismiss: (returnFocus?: boolean) => void
) {
  const layerId = useId();
  useLayerRegistration(
    {
      id: layerId,
      type: 'popover',
      elementRef: rootRef,
      dismissible: true,
      onDismiss: (reason) => {
        onDismiss(reason === 'escape');
      },
      onEscapeKeyDown: () => {
        onDismiss(true);
        return true;
      },
    },
    Boolean(open)
  );
}

export function useFormatMorph(
  kind: ColorFormat,
  setKind: (kind: ColorFormat) => void,
  text: string,
  hsva: Hsva,
  reduced: boolean,
  onResetDraft: () => void
) {
  const [morph, setMorph] = useState<{
    id: number;
    from: string;
    to: string;
    phase: 0 | 1;
  } | null>(null);

  useEffect(() => {
    if (!morph || morph.phase === 1) return;
    const frame = requestAnimationFrame(() =>
      setMorph((cur) =>
        cur && cur.id === morph.id ? { ...cur, phase: 1 } : cur
      )
    );
    return () => cancelAnimationFrame(frame);
  }, [morph]);

  useEffect(() => {
    if (!morph || morph.phase === 0) return;
    const timer = window.setTimeout(
      () => setMorph((cur) => (cur?.id === morph.id ? null : cur)),
      620
    );
    return () => window.clearTimeout(timer);
  }, [morph]);

  const cycleFormat = () => {
    const next = FORMATS[(FORMATS.indexOf(kind) + 1) % FORMATS.length]!;
    setKind(next);
    onResetDraft();
    if (!reduced) {
      setMorph({
        id: Date.now(),
        from: text,
        to: formatColor(hsva, next),
        phase: 0,
      });
    }
  };

  return { morph, cycleFormat };
}

export function usePad(
  onMove: (x: number, y: number) => void,
  onActive: (active: boolean) => void
) {
  const pointer = useRef<number | null>(null);

  const read = (event: ReactPointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const w = box.width || 1;
    const h = box.height || 1;
    onMove(
      clamp((event.clientX - box.left) / w),
      clamp((event.clientY - box.top) / h)
    );
  };

  return {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || pointer.current !== null) return;
      pointer.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* swallow-ok: pointer capture failure is non-fatal */
      }
      onActive(true);
      read(event);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerId === pointer.current) read(event);
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerId !== pointer.current) return;
      pointer.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* swallow-ok: pointer capture release failure is non-fatal */
      }
      onActive(false);
    },
    onPointerCancel(event: ReactPointerEvent<HTMLElement>) {
      if (event.pointerId !== pointer.current) return;
      pointer.current = null;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        /* swallow-ok: pointer capture release failure is non-fatal */
      }
      onActive(false);
    },
  };
}

export function stepFor(
  event: ReactKeyboardEvent,
  axis: 'x' | 'y' | 'both'
): [number, number] | null {
  const big = event.shiftKey || event.key.startsWith('Page');
  const size = big ? 10 : 1;
  const map: Record<string, [number, number]> = {
    ArrowRight: [size, 0],
    ArrowLeft: [-size, 0],
    ArrowUp: axis === 'both' ? [0, size] : [size, 0],
    ArrowDown: axis === 'both' ? [0, -size] : [-size, 0],
    PageUp: [10, 0],
    PageDown: [-10, 0],
  };
  return map[event.key] ?? null;
}
