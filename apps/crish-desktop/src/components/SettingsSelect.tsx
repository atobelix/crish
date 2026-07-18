import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import { Tooltip } from './settings/SettingsUI';
import styles from './SettingsSelect.module.css';

export type SettingsSelectOption = {
  value: string;
  label: string;
  group?: string;
  previewFamily?: string;
  hint?: string;
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
 * 设置下拉：portal + fixed 定位，上下翻转、水平钳制，避免被裁切。
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
  const [pos, setPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    width: number;
    maxH: number;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || placeholder;

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 160), Math.min(280, window.innerWidth - 16));
    let left = r.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;

    const spaceBelow = window.innerHeight - r.bottom - 8;
    const spaceAbove = r.top - 8;
    const preferDown = spaceBelow >= 120 || spaceBelow >= spaceAbove;
    const maxH = Math.min(maxHeight, preferDown ? spaceBelow : spaceAbove, 360);

    if (preferDown) {
      setPos({ top: r.bottom + 4, left, width, maxH: Math.max(120, maxH) });
    } else {
      setPos({
        bottom: window.innerHeight - r.top + 4,
        left,
        width,
        maxH: Math.max(120, maxH),
      });
    }
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    onOpen?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onReposition = () => place();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, pos]);




  const toggle = () => {
    if (disabled) return;
    setOpen((v) => !v);
  };

  let lastGroup: string | undefined;

  const menu =
    open && pos
      ? createPortal(
          <div
            ref={menuRef}
            className={`${styles.settingsSelectMenu} ${styles.settingsSelectMenuPortal}`}
            role="listbox"
            id={listId}
            onWheel={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxH,
              zIndex: 20050,
            }}
          >
            {footer ? <div className={styles.settingsSelectHeader}>{footer}</div> : null}
            <div className={styles.settingsSelectScroll} style={{ maxHeight: pos.maxH - (footer ? 38 : 8) }}>
              {options.map((opt) => {
                const showGroup = opt.group && opt.group !== lastGroup;
                if (opt.group) lastGroup = opt.group;
                const active = opt.value === value;
                return (
                  <React.Fragment key={opt.value}>
                    {showGroup ? (
                      <div className={styles.settingsSelectGroup}>{opt.group}</div>
                    ) : null}
                    <Tooltip content={opt.hint} disabled={!opt.hint}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`${styles.settingsSelectItem}${active ? ` ${styles.isActive}` : ''}`}
                        onClick={() => {
                          onChange(opt.value);
                          setOpen(false);
                        }}
                      >
                        <span
                          className={styles.settingsSelectItemLabel}
                          style={opt.previewFamily ? { fontFamily: opt.previewFamily } : undefined}
                        >
                          {opt.label}
                        </span>
                        {active ? (
                          <Lucide.Check size={14} className={styles.settingsSelectCheck} />
                        ) : null}
                      </button>
                    </Tooltip>
                  </React.Fragment>
                );
              })}
              {!options.length ? (
                <div className={styles.settingsSelectEmpty}>暂无选项</div>
              ) : null}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      className={`${styles.settingsSelect}${open ? ` ${styles.isOpen}` : ''} ${className || ''}`}
      ref={rootRef}
    >
      <div className={styles.settingsSelectTriggerRow}>
        <button
          ref={triggerRef}
          type="button"
          className={styles.settingsSelectTrigger}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
        >
          <span
            className={styles.settingsSelectValue}
            style={
              valuePreviewFamily || selected?.previewFamily
                ? { fontFamily: valuePreviewFamily || selected?.previewFamily }
                : undefined
            }
          >
            {label}
          </span>
          <Lucide.ChevronDown size={14} className={styles.settingsSelectChev} />
        </button>
        {trailing}
      </div>
      {menu}
    </div>
  );
};
