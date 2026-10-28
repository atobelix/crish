import React, { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { animate, m, useMotionValue, useReducedMotion } from 'motion/react';
import {
  clamp,
  round,
  toHex,
  formatColor,
  parseColor,
  computeWcagContrast,
  hsvToRgb,
  type ColorFormat,
  type Hsva,
} from '../../../utils/color/colorMath';
import { TextMorph } from '../TextMorph';
import {
  createSwatchId,
  useEyeDropperAvailable,
  useHydrated,
  useSurfaceAnimation,
  useDismissListener,
  useFormatMorph,
  FORMAT_NAMES,
  type ColorPickerProps,
  type ColorSwatch,
} from './types';
import { ColorPickerArea } from './ColorPickerArea';
import { ColorPickerSlider } from './ColorPickerSlider';
import { ColorPickerContrast } from './ColorPickerContrast';
import { ColorPickerSwatches } from './ColorPickerSwatches';
import styles from './ColorPicker.module.css';

function Chip({ color, className }: { color: string; className?: string }) {
  return (
    <span className={`${styles.chip} ${className ?? ''}`}>
      <span style={{ background: color }} />
    </span>
  );
}

/**
 * 专业级 ColorPicker 高精交互取色器
 * 解耦微架构主控制盒：弹层物理展开、格式切流伪装遮罩、全链路无障碍守卫
 */
export function ColorPicker({
  value,
  defaultValue = '#2F6BFF',
  onValueChange,
  background = '#FFFFFF',
  label = 'Color',
  swatches: swatchesProp,
  defaultSwatches,
  onSwatchesChange,
  maxSwatches = 7,
  defaultFormat = 'hex',
  className,
  style: styleProp,
}: ColorPickerProps) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const hydrated = useHydrated();
  const reduced = !!useReducedMotion() && hydrated;
  const canPick = useEyeDropperAvailable();

  const [hsva, setHsva] = useState<Hsva>(
    () => parseColor(value ?? defaultValue) ?? { h: 220, s: 0.8, v: 1, a: 1 }
  );
  const [synced, setSynced] = useState(value);

  if (value !== undefined && value !== synced) {
    setSynced(value);
    if (value.toUpperCase() !== toHex(hsva)) {
      const next = parseColor(value, hsva.h);
      if (next) setHsva(next);
    }
  }

  const [ownSwatches, setOwnSwatches] = useState<ColorSwatch[]>(
    defaultSwatches ?? []
  );
  const swatches = swatchesProp ?? ownSwatches;
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [kind, setKind] = useState<ColorFormat>(defaultFormat);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [active, setActive] = useState<'area' | 'hue' | 'alpha' | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const areaThumbRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fieldX = useMotionValue(0);
  const openNow = useRef(false);

  const hex = toHex(hsva);
  const rgb = hsvToRgb(hsva);
  const byteR = Math.round(clamp(rgb.r) * 255);
  const byteG = Math.round(clamp(rgb.g) * 255);
  const byteB = Math.round(clamp(rgb.b) * 255);
  const css = `rgb(${byteR} ${byteG} ${byteB} / ${round(hsva.a, 3)})`;
  const opaque = `rgb(${byteR} ${byteG} ${byteB})`;
  const pure = `hsl(${Math.round(hsva.h)} 100% 50%)`;

  const bgParsed = parseColor(background);
  const bgRgba = bgParsed ? hsvToRgb(bgParsed) : { r: 1, g: 1, b: 1, a: 1 };
  const ratio = computeWcagContrast(hsva, bgRgba);
  const text = formatColor(hsva, kind);

  const commit = (next: Hsva) => {
    setHsva(next);
    const nextHex = toHex(next);
    if (nextHex !== hex) onValueChange?.(nextHex);
  };

  const handleSetSwatches = (next: ColorSwatch[]) => {
    if (!swatchesProp) setOwnSwatches(next);
    onSwatchesChange?.(next);
  };

  const { clipPath, fade, contentOpacity, contentY } = useSurfaceAnimation({
    shown,
    open,
    reduced,
    openNow,
    setShown,
    panelRef,
    triggerRef,
  });

  const show = () => {
    openNow.current = true;
    setShown(true);
    setOpen(true);
  };

  const hide = (returnFocus = true) => {
    openNow.current = false;
    setOpen(false);
    setDraft(null);
    setInvalid(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  useDismissListener(open, rootRef, hide);

  const { morph, cycleFormat } = useFormatMorph(
    kind,
    setKind,
    text,
    hsva,
    reduced,
    () => {
      setDraft(null);
      setInvalid(false);
    }
  );

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() =>
        areaThumbRef.current?.focus({ preventScroll: true })
      );
    }
  }, [open]);

  const submitDraft = (): boolean => {
    if (draft === null) return true;
    const next = parseColor(draft, hsva.h);
    if (!next) {
      setInvalid(true);
      if (!reduced) animate(fieldX, [0, -5, 4, -2, 0], { duration: 0.32 });
      return false;
    }
    commit(next);
    setDraft(null);
    setInvalid(false);
    return true;
  };

  const pickFromScreen = () => {
    if (!canPick || typeof window === 'undefined') return;
    const EyeDropperClass = (window as unknown as { EyeDropper?: any })
      .EyeDropper;
    if (!EyeDropperClass) return;
    new EyeDropperClass()
      .open()
      .then((res: { sRGBHex: string }) => {
        const next = parseColor(res.sRGBHex, hsva.h);
        if (next) commit({ ...next, a: hsva.a });
      })
      .catch(() => {
        /* swallow-ok: user cancelled EyeDropper or permission denied */
      });
  };

  const saveSwatch = () => {
    const entry = { id: createSwatchId(), color: hex };
    handleSetSwatches([entry, ...swatches].slice(0, maxSwatches));
  };

  const computedStyle = {
    '--picker-color': css,
    '--picker-opaque': opaque,
    '--picker-hue': pure,
    '--picker-bg': background,
    ...styleProp,
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(' ')}
      style={computedStyle}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${uid}-panel` : undefined}
        onClick={() => (open ? hide() : show())}
      >
        <Chip color={css} />
        <span className={styles.triggerText}>
          <span className={styles.name}>{label}</span>
          <span className={styles.hex}>{hex}</span>
        </span>
      </button>

      {shown && (
        <div className={styles.float} data-open={open || undefined}>
          <m.div
            ref={panelRef}
            id={`${uid}-panel`}
            role="dialog"
            aria-label={`${label} color`}
            className={styles.panel}
            inert={!open ? true : undefined}
            style={{ clipPath, opacity: fade }}
          >
            <div className={styles.head}>
              <Chip color={css} />
              <span className={styles.triggerText}>
                <span className={styles.name}>{label}</span>
                <span className={styles.hex}>{hex}</span>
              </span>
              <m.span
                className={styles.headActions}
                style={{ opacity: contentOpacity }}
              >
                {canPick && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label="Pick a color from the screen"
                    onClick={pickFromScreen}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m14 7 3 3" />
                      <path d="M2 22s2-4 4-4l11-11a2.8 2.8 0 0 0-4-4L2 14c0 2-4 4-4 4" />
                    </svg>
                  </button>
                )}
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label="Done"
                  onClick={() => hide()}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
              </m.span>
            </div>

            <m.div
              className={styles.body}
              style={{ opacity: contentOpacity, y: contentY }}
            >
              <ColorPickerArea
                hsva={hsva}
                onChange={commit}
                active={active === 'area'}
                onActive={(on) => setActive(on ? 'area' : null)}
                reduced={reduced}
                thumbRef={areaThumbRef}
              />
              <ColorPickerSlider
                label="Hue"
                value={hsva.h}
                valueText={`${Math.round(hsva.h)} degrees`}
                max={360}
                unit={1}
                className={styles.hue}
                reduced={reduced}
                fill={pure}
                onChange={(h) => commit({ ...hsva, h: clamp(h, 0, 359.9) })}
                active={active === 'hue'}
                onActive={(on) => setActive(on ? 'hue' : null)}
              />
              <ColorPickerSlider
                label="Opacity"
                value={hsva.a * 100}
                valueText={`${Math.round(hsva.a * 100)}%`}
                max={100}
                unit={1}
                className={styles.alpha}
                reduced={reduced}
                fill={css}
                onChange={(a) => commit({ ...hsva, a: clamp(a / 100) })}
                active={active === 'alpha'}
                onActive={(on) => setActive(on ? 'alpha' : null)}
              />

              <m.div
                className={styles.field}
                data-invalid={invalid || undefined}
                style={{ x: fieldX }}
              >
                <button
                  type="button"
                  className={styles.format}
                  onClick={cycleFormat}
                  aria-label={`Format: ${FORMAT_NAMES[kind]}. Switch format`}
                >
                  <TextMorph>{FORMAT_NAMES[kind]}</TextMorph>
                </button>
                <span className={styles.inputWrap}>
                  <input
                    ref={inputRef}
                    className={styles.input}
                    value={draft ?? text}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={`${label} in ${FORMAT_NAMES[kind]}`}
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? `${uid}-error` : undefined}
                    data-morphing={morph ? '' : undefined}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setInvalid(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (submitDraft()) e.currentTarget.select();
                      }
                      if (e.key === 'Escape' && draft !== null) {
                        e.stopPropagation();
                        e.nativeEvent.stopImmediatePropagation();
                        setDraft(null);
                        setInvalid(false);
                      }
                    }}
                    onBlur={() => {
                      if (!submitDraft()) {
                        setDraft(null);
                        setInvalid(false);
                      }
                    }}
                  />
                  {morph && (
                    <span className={styles.morph} aria-hidden="true">
                      <TextMorph>
                        {morph.phase === 0 ? morph.from : morph.to}
                      </TextMorph>
                    </span>
                  )}
                </span>
              </m.div>
              <p
                id={`${uid}-error`}
                className={styles.error}
                aria-live="polite"
              >
                {invalid ? 'Enter a hex, RGB, HSL, or OKLCH color' : ''}
              </p>

              <ColorPickerContrast ratio={ratio} reduced={reduced} />

              <ColorPickerSwatches
                swatches={swatches}
                currentHex={hex}
                onSelect={(c) => {
                  const next = parseColor(c, hsva.h);
                  if (next) commit(next);
                }}
                onReorder={handleSetSwatches}
                onAdd={saveSwatch}
                reduced={reduced}
                inputRef={inputRef}
              />
            </m.div>
          </m.div>
        </div>
      )}
    </div>
  );
}

export default ColorPicker;
