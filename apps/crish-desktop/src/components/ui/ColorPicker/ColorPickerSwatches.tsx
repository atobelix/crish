import React, { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, Reorder } from 'motion/react';
import type { ColorSwatch } from './types';
import { instant, physical } from './types';
import styles from './ColorPicker.module.css';

export interface ColorPickerSwatchesProps {
  swatches: ColorSwatch[];
  currentHex: string;
  onSelect: (color: string) => void;
  onReorder: (swatches: ColorSwatch[]) => void;
  onAdd: () => void;
  reduced: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

const swatchSpring = physical(0.26, 0);
const layoutSpring = physical(0.4, 0);

function Chip({ color, className }: { color: string; className?: string }) {
  return (
    <span className={`${styles.chip} ${className ?? ''}`}>
      <span style={{ background: color }} />
    </span>
  );
}

/**
 * 预设与自定义色板管理组件
 * 支持 Reorder 手势拖拽重排、Alt + 方向键键盘微调移动与 Delete 移除
 */
export function ColorPickerSwatches({
  swatches,
  currentHex,
  onSelect,
  onReorder,
  onAdd,
  reduced,
  inputRef,
}: ColorPickerSwatchesProps) {
  const [focusSwatch, setFocusSwatch] = useState<string | null>(null);
  const swatchRefs = useRef(new Map<string, HTMLButtonElement>());
  const dragged = useRef(false);

  const swatchTab = swatches.some((entry) => entry.id === focusSwatch)
    ? focusSwatch
    : swatches[0]?.id;

  const onSwatchKey = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const item = swatches[index]!;
    const move =
      event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      const next = swatches.filter((entry) => entry.id !== item.id);
      onReorder(next);
      const neighbor = next[Math.min(index, next.length - 1)];
      setFocusSwatch(neighbor?.id ?? null);
      requestAnimationFrame(() => {
        if (neighbor) {
          swatchRefs.current.get(neighbor.id)?.focus({ preventScroll: true });
        } else {
          inputRef?.current?.focus({ preventScroll: true });
        }
      });
      return;
    }

    if (!move && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();

    if (move && event.altKey) {
      const to = index + move;
      if (to < 0 || to >= swatches.length) return;
      const next = [...swatches];
      next.splice(index, 1);
      next.splice(to, 0, item);
      onReorder(next);
      requestAnimationFrame(() => {
        swatchRefs.current.get(item.id)?.focus({ preventScroll: true });
      });
      return;
    }

    const target =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? swatches.length - 1
          : (index + move + swatches.length) % swatches.length;
    const targetItem = swatches[target];
    if (targetItem) {
      setFocusSwatch(targetItem.id);
      swatchRefs.current.get(targetItem.id)?.focus({ preventScroll: true });
    }
  };

  return (
    <div className={styles.swatches}>
      <button
        type="button"
        className={styles.add}
        onClick={onAdd}
        aria-label={`Save ${currentHex}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 12h14" />
          <path d="M12 5v14" />
        </svg>
      </button>

      <Reorder.Group
        as="div"
        axis="x"
        values={swatches}
        onReorder={onReorder}
        className={styles.swatchList}
        role="listbox"
        aria-label="Saved colors"
        aria-orientation="horizontal"
      >
        <AnimatePresence initial={false}>
          {swatches.map((entry, index) => {
            const isSelected =
              entry.color.toUpperCase() === currentHex.toUpperCase();
            return (
              <Reorder.Item
                key={entry.id}
                value={entry}
                as="div"
                className={styles.swatchSlot}
                dragElastic={0.12}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={
                  reduced
                    ? { opacity: 0 }
                    : { opacity: 0, scale: 0.4, transition: { duration: 0.16 } }
                }
                transition={
                  reduced ? instant : { ...swatchSpring, layout: layoutSpring }
                }
                whileDrag={reduced ? undefined : { scale: 1.15, zIndex: 2 }}
                onDragStart={() => {
                  dragged.current = true;
                }}
                onDragEnd={() =>
                  requestAnimationFrame(() => {
                    dragged.current = false;
                  })
                }
              >
                <button
                  ref={(node) => {
                    if (node) swatchRefs.current.set(entry.id, node);
                    else swatchRefs.current.delete(entry.id);
                  }}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={styles.swatch}
                  data-current={isSelected || undefined}
                  aria-label={`${entry.color}. Alt and arrow keys to move, Delete to remove`}
                  tabIndex={entry.id === swatchTab ? 0 : -1}
                  onFocus={() => setFocusSwatch(entry.id)}
                  onKeyDown={(event) => onSwatchKey(event, index)}
                  onClick={() => {
                    if (dragged.current) return;
                    onSelect(entry.color);
                  }}
                >
                  <Chip color={entry.color} className={styles.swatchChip} />
                </button>
              </Reorder.Item>
            );
          })}
        </AnimatePresence>
      </Reorder.Group>
    </div>
  );
}

export default ColorPickerSwatches;
