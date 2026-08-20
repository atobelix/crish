import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './FontSelectField.module.css';
import { Menu, Tooltip } from '../ui';
import type { SelectOptionItem } from '../ui';

/**
 * FontSelectField — 字体选择字段（T-C 批次 5.2 · T13 业务封装）
 *
 * SettingsSelect 退役后，FontSettingsSection 的专属能力（字体预览 previewFamily、
 * 自定义 footer 头部、valuePreviewFamily、分组 group 字段）不升格 ui/Select
 * （单消费点专属形态，遵循「2 个消费点才升格」原则），以本业务封装层组合实现：
 * 基座仍是 ui/Menu（listbox 语义 + 键盘漫游 + Esc/外点关闭），仅保留
 * 「面板宽度贴合触发器」测量与字体渲染定制。
 *
 * 消费点：仅 FontSettingsSection（ui 字体 / 代码字体两处）。
 */
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
  header?: React.ReactNode;
  footer?: React.ReactNode;
  valuePreviewFamily?: string;
}

export const FontSelectField: React.FC<Props> = ({
  value,
  options,
  onChange,
  disabled,
  placeholder = '选择…',
  maxHeight = 280,
  className,
  header,
  footer,
  valuePreviewFamily,
}) => {
  const [open, setOpen] = useState(false);
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || placeholder;

  // 面板宽度贴合触发器宽度（[140,280] 钳制；位置由基座负责）
  const measureWidth = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuWidth(Math.min(Math.max(rect.width, 160), 280));
    }
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        measureWidth();
      }
      setOpen(nextOpen);
    },
    [measureWidth],
  );

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measureWidth);
    return () => window.removeEventListener('resize', measureWidth);
  }, [open, measureWidth]);

  const handleSelect = useCallback(
    (idValue: string) => {
      onChange(idValue);
      setOpen(false);
    },
    [onChange],
  );

  // 键盘漫游用：选项数组与 children 渲染顺序保持一致
  const menuOptions: SelectOptionItem[] = options.map((opt) => ({
    id: opt.value,
    label: opt.label,
  }));

  return (
    <div
      className={`${styles.settingsSelect} ${className || ''} ${disabled ? styles.disabled : ''}`}
      data-density="compact"
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
              <Lucide.ChevronDown
                size={14}
                className={styles.settingsSelectChev}
                aria-hidden
              />
            </button>
          }
        >
          {header ? <div className={styles.settingsSelectHeader}>{header}</div> : null}
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
                    handleSelect(opt.value);
                  }}
                >
                  <span
                    className={styles.settingsSelectItemLabel}
                    style={font ? { fontFamily: font } : undefined}
                  >
                    {opt.label}
                  </span>
                  {isSelected ? (
                    <Lucide.Check
                      size={13}
                      className={styles.settingsSelectCheckIcon}
                      aria-hidden
                    />
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
        </Menu>
      </div>
    </div>
  );
};
