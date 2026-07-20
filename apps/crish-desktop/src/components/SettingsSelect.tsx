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
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const focusedIdxRef = useRef(-1);
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
      setFocusedIdx(-1);
      return;
    }
    place();
    onOpen?.();
    if (options.length > 0) {
      const idx = options.findIndex((o) => o.value === value);
      const initIdx = idx >= 0 ? idx : 0;
      setFocusedIdx(initIdx);
      focusedIdxRef.current = initIdx;
    }
  }, [open]);

  useEffect(() => {
    if (focusedIdx < 0 || !open) return;
    const el = optionRefs.current[focusedIdx];
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [focusedIdx, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onReposition = () => place();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !options.length) return;
    const lastIdx = options.length - 1;
    if (focusedIdxRef.current > lastIdx) {
      focusedIdxRef.current = lastIdx;
      setFocusedIdx(lastIdx);
    }
  }, [options, open]);

  const toggle = () => {
    if (disabled) return;
    setOpen((v) => !v);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      setOpen(true);
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const lastIdx = options.length - 1;
    if (lastIdx < 0) return;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = Math.min(focusedIdxRef.current + 1, lastIdx);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const next = Math.max(focusedIdxRef.current - 1, 0);
        focusedIdxRef.current = next;
        setFocusedIdx(next);
        break;
      }
      case 'Home': {
        e.preventDefault();
        focusedIdxRef.current = 0;
        setFocusedIdx(0);
        break;
      }
      case 'End': {
        e.preventDefault();
        focusedIdxRef.current = lastIdx;
        setFocusedIdx(lastIdx);
        break;
      }
      case 'Enter': {
        e.preventDefault();
        const idx = focusedIdxRef.current;
        if (idx >= 0 && idx <= lastIdx) {
          onChange(options[idx].value);
          setOpen(false);
          triggerRef.current?.focus();
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      }
      case 'Tab': {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      }
    }
  };

  let lastGroup: string | undefined;

  const menu =
    open && pos
      ? createPortal(
          <div
            ref={menuRef}
            className={`${styles.settingsSelectMenu} ${styles.settingsSelectMenuPortal} settings-select-menu settings-select-menu--portal`}
            role="listbox"
            id={listId}
            onWheel={(e) => e.stopPropagation()}
            onKeyDown={handleMenuKeyDown}
            style={{
              position: 'fixed',
              top: pos.top,
              bottom: pos.bottom,
              left: pos.left,
              width: pos.width,
              maxHeight: pos.maxH,
              zIndex: 'var(--z-settings-tooltip)',
            }}
          >
            {footer ? <div className={styles.settingsSelectHeader}>{footer}</div> : null}
            <div
              className={styles.settingsSelectScroll}
              style={{ maxHeight: pos.maxH - (footer ? 38 : 8) }}
            >
              {options.map((opt, idx) => {
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
                        ref={(el) => { optionRefs.current[idx] = el; }}
                        type="button"
                        role="option"
                        aria-selected={active}
                        tabIndex={focusedIdx === idx ? 0 : -1}
                        className={`${styles.settingsSelectItem} settings-select-item${active ? ` ${styles.isActive} is-active` : ''}`}
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
          onKeyDown={handleTriggerKeyDown}
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
