/**
 * 现代字体选择器：内嵌搜索过滤框 + 极简操作栏 + WAI-ARIA 1.2 + IME 组合锁
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import styles from './FontSelectField.module.css';
import { Menu, Tooltip } from '../ui';
import type { SelectOptionItem } from '../ui';
import {
  filterAndSortIndexedOptions,
  indexFontOptions,
  type IndexedFontOption,
} from './internal/fontPinyinMatcher';
import {
  SearchIcon,
  HardDriveIcon,
  RotateCcwIcon,
  CheckIcon,
  Loader2Icon,
  ChevronDownIcon,
} from './internal/fontIcons';
import { useFontKeyboardNav } from './internal/useFontKeyboardNav';

export type FontSelectOption = {
  value: string;
  label: string;
  group?: string | undefined;
  previewFamily?: string | undefined;
  hint?: string | undefined;
};

interface Props {
  value: string;
  options: FontSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  maxHeight?: number;
  className?: string;
  valuePreviewFamily?: string;
  onScanLocal?: () => Promise<void> | void;
  isScanning?: boolean;
  onResetDefault?: () => void;
  isDefault?: boolean;
  onApplyCustom?: (customName: string) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

export const FontSelectField: React.FC<Props> = ({
  value,
  options,
  onChange,
  disabled,
  placeholder = '选择字体…',
  maxHeight = 320,
  className,
  valuePreviewFamily,
  onScanLocal,
  isScanning = false,
  onResetDefault,
  isDefault = false,
  onApplyCustom,
  header,
  footer,
}) => {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined);

  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || placeholder;

  // 1. 预构建索引（带 Memoize）
  const indexedOptions = useMemo(() => indexFontOptions(options), [options]);

  // 2. 多维即时模糊过滤
  const filteredOptions = useMemo(() => {
    return filterAndSortIndexedOptions(indexedOptions, searchQuery);
  }, [indexedOptions, searchQuery]);

  // 3. 分组划分（预设与本机）
  const groupedList = useMemo(() => {
    const presets: IndexedFontOption[] = [];
    const locals: IndexedFontOption[] = [];

    for (const opt of filteredOptions) {
      if (opt.group === '本机' || opt.value.startsWith('local:')) {
        locals.push(opt);
      } else {
        presets.push(opt);
      }
    }
    return { presets, locals };
  }, [filteredOptions]);

  // 4. 测量触发器宽度
  const measureWidth = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuWidth(Math.min(Math.max(rect.width, 180), 320));
    }
  }, []);

  const handleSelect = useCallback(
    (val: string) => {
      onChange(val);
      setOpen(false);
    },
    [onChange]
  );

  const handleApplyCustomQuery = useCallback(() => {
    const q = searchQuery.trim();
    if (!q) return;
    if (onApplyCustom) {
      onApplyCustom(q);
      setOpen(false);
    }
  }, [searchQuery, onApplyCustom]);

  const {
    focusedIndex,
    setFocusedIndex,
    scrollContainerRef,
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyDown,
  } = useFontKeyboardNav({
    filteredCount: filteredOptions.length,
    onSelectCurrent: (idx) => {
      const opt = filteredOptions[idx];
      if (opt) handleSelect(opt.value);
    },
    onApplyCustom: handleApplyCustomQuery,
    onClose: () => {
      setOpen(false);
      triggerRef.current?.focus();
    },
  });

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        measureWidth();
        setSearchQuery('');
        setTimeout(() => searchInputRef.current?.focus(), 30);
      }
      setOpen(nextOpen);
    },
    [measureWidth]
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measureWidth);
    return () => window.removeEventListener('resize', measureWidth);
  }, [open, measureWidth]);

  const menuOptions: SelectOptionItem[] = useMemo(
    () => filteredOptions.map((opt) => ({ id: opt.value, label: opt.label })),
    [filteredOptions]
  );

  const hasDraftToApply =
    Boolean(onApplyCustom) &&
    searchQuery.trim().length > 0 &&
    searchQuery.trim() !== selected?.label;

  const activeDescendantId =
    focusedIndex >= 0 && focusedIndex < filteredOptions.length
      ? `${listboxId}-opt-${focusedIndex}`
      : undefined;

  let flatOptionCursor = 0;

  return (
    <div
      className={`${styles.settingsSelect} ${className || ''} ${disabled ? styles.disabled : ''}`}
    >
      <div className={styles.settingsSelectTriggerRow}>
        <Menu
          openState={{ open, onOpenChange: handleOpenChange }}
          options={menuOptions}
          onSelect={(idValue) => handleSelect(idValue)}
          position={{ side: 'bottom', align: 'start', sideOffset: 4 }}
          panel={{
            contentClassName: styles.settingsSelectMenu,
            contentStyle: { width: menuWidth, maxHeight },
          }}
          trigger={
            <button
              ref={triggerRef}
              type="button"
              className={styles.settingsSelectTrigger}
              disabled={disabled}
              aria-label={label}
              aria-haspopup="listbox"
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
              <ChevronDownIcon size={14} className={styles.settingsSelectChev} />
            </button>
          }
        >
          {/* 内嵌搜索头部 + 极简操作栏 */}
          <div
            className={styles.searchHeader}
            role="search"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className={styles.searchInputWrapper}>
              <SearchIcon size={13} className={styles.searchIcon} />
              <input
                ref={searchInputRef}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={listboxId}
                aria-activedescendant={activeDescendantId}
                aria-label="搜索或输入自定义字体名称"
                className={styles.searchInput}
                placeholder="搜索或输入字体..."
                value={searchQuery}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setSearchQuery(e.target.value)}
                onCompositionStart={handleCompositionStart}
                onCompositionEnd={handleCompositionEnd}
                onKeyDown={handleKeyDown}
              />
              {hasDraftToApply && (
                <Tooltip content="应用当前自定义字体 (Enter)">
                  <button
                    type="button"
                    className={styles.customApplyBtn}
                    onClick={handleApplyCustomQuery}
                    aria-label="应用当前自定义字体"
                  >
                    <CheckIcon size={12} />
                  </button>
                </Tooltip>
              )}
            </div>

            {onScanLocal && (
              <Tooltip content="全量扫描本机系统字体">
                <button
                  type="button"
                  className={styles.actionBtn}
                  disabled={disabled || isScanning}
                  onClick={() => void onScanLocal()}
                  aria-label="全量扫描本机系统字体"
                >
                  {isScanning ? (
                    <Loader2Icon size={13} className={styles.spinIcon} />
                  ) : (
                    <HardDriveIcon size={13} />
                  )}
                </button>
              </Tooltip>
            )}

            {onResetDefault && (
              <Tooltip content="恢复系统优化默认字体">
                <button
                  type="button"
                  className={styles.actionBtn}
                  disabled={disabled || isDefault}
                  onClick={onResetDefault}
                  aria-label="恢复系统优化默认字体"
                >
                  <RotateCcwIcon size={13} />
                </button>
              </Tooltip>
            )}
          </div>

          {header ? <div className={styles.headerArea}>{header}</div> : null}

          {/* 选项滚动列表 */}
          <div
            id={listboxId}
            ref={scrollContainerRef}
            role="listbox"
            aria-label="字体选项列表"
            className={styles.settingsSelectScroll}
          >
            {groupedList.presets.length > 0 && (
              <>
                <div role="presentation" className={styles.groupHeader}>
                  预设与内嵌
                </div>
                {groupedList.presets.map((opt) => {
                  const flatIdx = flatOptionCursor++;
                  const isSelected = opt.value === value;
                  const isFocused = flatIdx === focusedIndex;
                  return (
                    <button
                      key={opt.value}
                      id={`${listboxId}-opt-${flatIdx}`}
                      data-opt-index={flatIdx}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={isSelected}
                      className={`${styles.settingsSelectItem} ${
                        isSelected ? styles.isActive : ''
                      } ${isFocused ? styles.isFocused : ''}`}
                      onMouseEnter={() => setFocusedIndex(flatIdx)}
                      onClick={() => handleSelect(opt.value)}
                    >
                      <span
                        className={styles.settingsSelectItemLabel}
                        style={opt.previewFamily ? { fontFamily: opt.previewFamily } : undefined}
                      >
                        {opt.label}
                      </span>
                      {isSelected && <CheckIcon size={13} className={styles.checkIcon} />}
                    </button>
                  );
                })}
              </>
            )}

            {groupedList.locals.length > 0 && (
              <>
                <div role="presentation" className={styles.groupHeader}>
                  本机系统字体 ({groupedList.locals.length})
                </div>
                {groupedList.locals.map((opt) => {
                  const flatIdx = flatOptionCursor++;
                  const isSelected = opt.value === value;
                  const isFocused = flatIdx === focusedIndex;
                  return (
                    <button
                      key={opt.value}
                      id={`${listboxId}-opt-${flatIdx}`}
                      data-opt-index={flatIdx}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={isSelected}
                      className={`${styles.settingsSelectItem} ${
                        isSelected ? styles.isActive : ''
                      } ${isFocused ? styles.isFocused : ''}`}
                      onMouseEnter={() => setFocusedIndex(flatIdx)}
                      onClick={() => handleSelect(opt.value)}
                    >
                      <span
                        className={styles.settingsSelectItemLabel}
                        style={opt.previewFamily ? { fontFamily: opt.previewFamily } : undefined}
                      >
                        {opt.label}
                      </span>
                      {isSelected && <CheckIcon size={13} className={styles.checkIcon} />}
                    </button>
                  );
                })}
              </>
            )}

            {filteredOptions.length === 0 && (
              <div className={styles.emptyState}>
                <span>未找到匹配字体</span>
                <span className={styles.emptySub}>按 Enter 或点击对勾直接应用为自定义字体</span>
              </div>
            )}
          </div>

          {footer ? <div className={styles.footerArea}>{footer}</div> : null}
        </Menu>
      </div>
    </div>
  );
};
