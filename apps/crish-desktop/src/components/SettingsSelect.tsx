import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import { Tooltip } from './Tooltip';
import styles from './SettingsSelect.module.css';

export type SettingsSelectOption = {
  value: string;
  label: string;
  group?: string | undefined;
  previewFamily?: string | undefined;
  hint?: string | undefined;
};

interface Props {
  value: string;
  options: SettingsSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  maxHeight?: number;
  className?: string;
  footer?: React.ReactNode;
  trailing?: React.ReactNode;
  onOpen?: () => void;
  valuePreviewFamily?: string;
}

/**
 * 设置页通用 Select 下拉框：100% 精确还原原生精致 CSS 样式与交互。
 */
export const SettingsSelect: React.FC<Props> = ({
  value,
  options,
  onChange,
  disabled,
  placeholder = '选择…',
  maxHeight = 280,
  className,
  footer,
  trailing,
  onOpen,
  valuePreviewFamily,
}) => {
  const [open, setOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || placeholder;

  const toggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (disabled) return;
    if (!open) {
      onOpen?.();
      updateCoords();
    }
    setOpen((prev) => !prev);
  };

  const updateCoords = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const menuWidth = Math.min(Math.max(rect.width, 140), 220);
      setMenuCoords({
        top: rect.bottom + 4,
        left: rect.left,
        width: menuWidth,
      });
    }
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', updateCoords);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', updateCoords);
    };
  }, [open]);

  return (
    <div className={`${styles.settingsSelect} ${className || ''} ${disabled ? styles.disabled : ''}`} data-density="compact">
      <div className={styles.settingsSelectTriggerRow}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.settingsSelectTrigger}
          disabled={disabled}
          onClick={toggleOpen}
          aria-label={label}
          aria-expanded={open}
        >
          <span
            className={styles.settingsSelectValue}
            style={
              valuePreviewFamily
                ? { fontFamily: valuePreviewFamily }
                : selected?.previewFamily
                  ? { fontFamily: selected.previewFamily }
                  : undefined
            }
          >
            {label}
          </span>
          <Lucide.ChevronDown size={14} className={styles.settingsSelectChev} aria-hidden />
        </button>
        {trailing}
      </div>

      {open && menuCoords && createPortal(
        <div
          ref={menuRef}
          className={`${styles.settingsSelectMenu} no-drag`}
          style={{
            position: 'fixed',
            top: menuCoords.top,
            left: menuCoords.left,
            width: menuCoords.width,
            maxHeight,
            zIndex: 'var(--z-settings-tooltip, 99999)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div role="listbox" className={styles.settingsSelectScroll}>
            {options.map((opt) => {
              const isSelected = opt.value === value;
              const font = opt.previewFamily;
              const node = (
                <button
                  key={opt.value}
                  type="button"
                  className={`${styles.settingsSelectItem} ${isSelected ? styles.isActive : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <span className={styles.settingsSelectItemLabel} style={font ? { fontFamily: font } : undefined}>
                    {opt.label}
                  </span>
                  {isSelected ? (
                    <Lucide.Check size={13} className={styles.settingsSelectCheckIcon} aria-hidden />
                  ) : null}
                </button>
              );

              if (opt.hint) {
                return (
                  <Tooltip key={opt.value} content={opt.hint}>
                    {node}
                  </Tooltip>
                );
              }
              return node;
            })}
          </div>
          {footer ? <div className={styles.settingsSelectFooter}>{footer}</div> : null}
        </div>,
        document.body
      )}
    </div>
  );
};
