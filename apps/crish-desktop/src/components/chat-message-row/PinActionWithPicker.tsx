import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import styles from './ChatMessageRow.module.css';
import { Button, Tooltip, Input } from '../ui';
import { pinToggleLabels } from './chatMessageRowUtils';
import {
  DEFAULT_PIN_COLOR,
  PRESET_PIN_COLORS,
  hsvToHex,
  hexToHsv,
  parseHexColor,
} from './colorPickerUtils';

export { DEFAULT_PIN_COLOR, PRESET_PIN_COLORS };
export type { PinColorOption } from './colorPickerUtils';
import { AppIcon } from '../ui/icons/index';

export interface PinActionWithPickerProps {
  isPinned: boolean;
  pinnedColor?: string;
  onTogglePin: (color?: string) => void;
  className?: string;
}

export const PinActionWithPicker: React.FC<PinActionWithPickerProps> = React.memo(
  function PinActionWithPicker({
    isPinned,
    pinnedColor,
    onTogglePin,
    className,
  }) {
    const [popoverOpen, setPopoverOpen] = useState(false);
    const [showCustom, setShowCustom] = useState(false);

    const activeColor = pinnedColor || DEFAULT_PIN_COLOR;
    const [hsv, setHsv] = useState(() => hexToHsv(activeColor));
    const [hexInput, setHexInput] = useState(() => activeColor.toUpperCase());

    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const paletteRef = useRef<HTMLDivElement | null>(null);
    const enterTimerRef = useRef<number | null>(null);
    const leaveTimerRef = useRef<number | null>(null);

    const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({
      top: 0,
      left: 0,
    });

    const pinLabels = pinToggleLabels(isPinned);

    const isPresetSelected = PRESET_PIN_COLORS.some(
      (c) => c.value.toLowerCase() === activeColor.toLowerCase()
    );
    const isCustomSelected = isPinned && !isPresetSelected;

    useEffect(() => {
      setHexInput(activeColor.toUpperCase());
      setHsv(hexToHsv(activeColor));
    }, [activeColor]);

    useEffect(() => {
      if (pinnedColor) {
        setHsv(hexToHsv(pinnedColor));
      }
    }, [pinnedColor]);

    const updatePosition = useCallback(() => {
      const triggerEl = wrapperRef.current;
      if (!triggerEl) return;
      const rect = triggerEl.getBoundingClientRect();
      const popoverEl = popoverRef.current;
      const width = showCustom ? 196 : (popoverEl?.offsetWidth || 180);
      const height = showCustom ? 180 : (popoverEl?.offsetHeight || 32);

      // 触发器若已滚出视口则自动隐藏
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        setPopoverOpen(false);
        return;
      }

      // 上下方空间评估：默认上方，空间不足则向下翻折
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;
      const placeTop = spaceAbove >= height + 8 || spaceAbove >= spaceBelow;

      let top = placeTop ? rect.top - height - 6 : rect.bottom + 6;
      if (top < 8) top = 8;
      if (top + height > window.innerHeight - 8) {
        top = Math.max(8, window.innerHeight - height - 8);
      }

      let left = rect.right - width;
      if (left + width > window.innerWidth - 8) {
        left = window.innerWidth - 8 - width;
      }
      if (left < 8) {
        left = 8;
      }

      setPopoverPos({ top, left });
    }, [showCustom]);

    useLayoutEffect(() => {
      if (popoverOpen) {
        updatePosition();
      }
    }, [popoverOpen, updatePosition]);

    useEffect(() => {
      if (!popoverOpen) return;
      const onScrollOrResize = () => {
        updatePosition();
      };
      window.addEventListener('scroll', onScrollOrResize, true);
      window.addEventListener('app:window-resize-settled', onScrollOrResize);
      return () => {
        window.removeEventListener('scroll', onScrollOrResize, true);
        window.removeEventListener('app:window-resize-settled', onScrollOrResize);
      };
    }, [popoverOpen, updatePosition]);

    const handleMouseEnter = useCallback(() => {
      if (leaveTimerRef.current != null) {
        window.clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      if (enterTimerRef.current == null) {
        enterTimerRef.current = window.setTimeout(() => {
          enterTimerRef.current = null;
          setPopoverOpen(true);
        }, 160);
      }
    }, []);

    const handleMouseLeave = useCallback(() => {
      if (enterTimerRef.current != null) {
        window.clearTimeout(enterTimerRef.current);
        enterTimerRef.current = null;
      }
      if (leaveTimerRef.current == null) {
        leaveTimerRef.current = window.setTimeout(() => {
          leaveTimerRef.current = null;
          setPopoverOpen(false);
          setShowCustom(false);
        }, 260);
      }
    }, []);

    useEffect(() => {
      return () => {
        if (enterTimerRef.current != null) window.clearTimeout(enterTimerRef.current);
        if (leaveTimerRef.current != null) window.clearTimeout(leaveTimerRef.current);
      };
    }, []);

    useEffect(() => {
      if (!popoverOpen) return;
      const onDocMouseDown = (e: MouseEvent) => {
        const target = e.target as Node;
        if (
          wrapperRef.current?.contains(target) ||
          popoverRef.current?.contains(target)
        ) {
          return;
        }
        setPopoverOpen(false);
        setShowCustom(false);
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setPopoverOpen(false);
          setShowCustom(false);
        }
      };
      document.addEventListener('mousedown', onDocMouseDown);
      document.addEventListener('keydown', onKeyDown);
      return () => {
        document.removeEventListener('mousedown', onDocMouseDown);
        document.removeEventListener('keydown', onKeyDown);
      };
    }, [popoverOpen]);

    const handleMainClick = useCallback(() => {
      setPopoverOpen(false);
      setShowCustom(false);
      if (isPinned) {
        onTogglePin();
      } else {
        onTogglePin(activeColor);
      }
    }, [activeColor, isPinned, onTogglePin]);

    const handleSelectColor = useCallback(
      (color: string) => {
        setHsv(hexToHsv(color));
        setHexInput(color.toUpperCase());
        onTogglePin(color);
      },
      [onTogglePin]
    );

    const updateFromPointer = useCallback(
      (clientX: number, clientY: number) => {
        if (!paletteRef.current) return;
        const rect = paletteRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
        const s = Math.round((x / rect.width) * 100);
        const v = Math.round((1 - y / rect.height) * 100);
        const next = { ...hsv, s, v };
        const hex = hsvToHex(next.h, s, v);
        setHsv(next);
        setHexInput(hex.toUpperCase());
        onTogglePin(hex);
      },
      [hsv, onTogglePin]
    );

    const handlePalettePointerDown = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        updateFromPointer(e.clientX, e.clientY);
      },
      [updateFromPointer]
    );

    const handlePalettePointerMove = useCallback(
      (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.buttons === 1) {
          updateFromPointer(e.clientX, e.clientY);
        }
      },
      [updateFromPointer]
    );

    const handleHueChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = Number(e.target.value);
        const next = { ...hsv, h: val };
        const hex = hsvToHex(val, next.s, next.v);
        setHsv(next);
        setHexInput(hex.toUpperCase());
        onTogglePin(hex);
      },
      [hsv, onTogglePin]
    );

    const handleResetDefault = useCallback(() => {
      const defaultHsv = hexToHsv(DEFAULT_PIN_COLOR);
      setHsv(defaultHsv);
      setHexInput(DEFAULT_PIN_COLOR.toUpperCase());
      onTogglePin(DEFAULT_PIN_COLOR);
    }, [onTogglePin]);

    const handleHexChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value.trim();
        setHexInput(val);
        const parsed = parseHexColor(val);
        if (parsed) {
          setHsv(hexToHsv(parsed));
          onTogglePin(parsed);
        }
      },
      [onTogglePin]
    );

    const handleHexBlur = useCallback(() => {
      setHexInput(activeColor.toUpperCase());
    }, [activeColor]);

    const handleHexKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        }
      },
      []
    );

    const buttonStyle = isPinned
      ? ({ '--active-pin-color': activeColor } as React.CSSProperties)
      : undefined;

    return (
      <div
        ref={wrapperRef}
        className={styles.pinPickerWrapper}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <Tooltip content={pinLabels.title} disabled={popoverOpen}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            style={buttonStyle}
            className={`${styles.iconBtn}${isPinned ? ` ${styles.isPinnedActive}` : ''}${className ? ` ${className}` : ''}`}
            aria-label={pinLabels.ariaLabel}
            aria-pressed={isPinned}
            onClick={handleMainClick}
            icon={isPinned ? <AppIcon name="pin-off" size={16} /> : <AppIcon name="pin" size={16} />}
          />
        </Tooltip>

        {popoverOpen && typeof document !== 'undefined'
          ? createPortal(
              <div
                ref={popoverRef}
                className={`${styles.pinPickerPopover}${showCustom ? ` ${styles.pinPickerExpanded}` : ''}`}
                style={{
                  position: 'fixed',
                  top: `${popoverPos.top}px`,
                  left: `${popoverPos.left}px`,
                }}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                role="toolbar"
                aria-label="固定管理与颜色选择"
              >
                {(() => {
                  const colorsRow = (isExpanded: boolean) => (
                    <div className={styles.pinColorsRow}>
                      {PRESET_PIN_COLORS.map((c) => {
                        const isSelected =
                          isPinned && activeColor.toLowerCase() === c.value.toLowerCase();
                        return (
                          <Tooltip key={c.value} content={c.label}>
                            <Button
                              type="button"
                              variant="ghost"
                              className={`${styles.pinColorDot}${isSelected ? ` ${styles.isSelected}` : ''}`}
                              style={{ backgroundColor: c.value }}
                              aria-label={c.label}
                              onClick={() => handleSelectColor(c.value)}
                            >
                              {isSelected ? (
                                <AppIcon name="check" size={10} color="#fff" />
                              ) : null}
                            </Button>
                          </Tooltip>
                        );
                      })}

                      <Tooltip content={isExpanded ? '收起自定义' : '自定义颜色'}>
                        <Button
                          type="button"
                          variant="ghost"
                          className={`${styles.pinCustomToggleBtn}${isExpanded || isCustomSelected ? ` ${styles.isSelected}` : ''}`}
                          onClick={() => setShowCustom(!isExpanded)}
                          aria-label={isExpanded ? '收起自定义颜色' : '自定义固定颜色'}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded || isCustomSelected ? (
                            <AppIcon name="check" size={10} color="#fff" />
                          ) : null}
                        </Button>
                      </Tooltip>
                    </div>
                  );

                  if (!showCustom) {
                    return colorsRow(false);
                  }

                  return (
                    <div className={styles.pinCustomPanel}>
                      {colorsRow(true)}

                      <div
                        ref={paletteRef}
                        className={styles.pinSatValPalette}
                        style={
                          {
                            '--palette-pure-hue': `hsl(${hsv.h} 100% 50%)`,
                          } as React.CSSProperties
                        }
                        onPointerDown={handlePalettePointerDown}
                        onPointerMove={handlePalettePointerMove}
                        role="slider"
                        aria-label="饱和度与明度选区"
                      >
                        <div
                          className={styles.pinSatValHandle}
                          style={{
                            left: `${hsv.s}%`,
                            top: `${100 - hsv.v}%`,
                            backgroundColor: activeColor,
                          }}
                        />
                      </div>

                      <Input
                        bare
                        type="range"
                        min="0"
                        max="360"
                        value={hsv.h}
                        onChange={handleHueChange}
                        className={styles.pinHueSlider}
                        aria-label="色相微调滑块"
                      />

                      <div className={styles.pinCustomBottomRow}>
                        <Tooltip content="重置为默认绿色">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className={styles.pinResetBtn}
                            onClick={handleResetDefault}
                            aria-label="重置为默认绿色"
                          >
                            <AppIcon name="rotate-ccw" size={11} />
                            <span>重置</span>
                          </Button>
                        </Tooltip>

                        <div className={styles.pinCustomValueRow}>
                          <span
                            className={styles.pinCustomPreviewDot}
                            style={{ backgroundColor: activeColor }}
                            aria-hidden
                          />
                          <Input
                            size="xs"
                            className={styles.pinCustomHexInput}
                            value={hexInput}
                            onChange={handleHexChange}
                            onBlur={handleHexBlur}
                            onKeyDown={handleHexKeyDown}
                            maxLength={7}
                            aria-label="十六进制色值"
                            placeholder={DEFAULT_PIN_COLOR.toUpperCase()}
                            spellCheck={false}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>,
              document.body
            )
          : null}
      </div>
    );
  }
);
PinActionWithPicker.displayName = 'PinActionWithPicker';
