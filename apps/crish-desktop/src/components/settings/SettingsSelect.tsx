import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { Tooltip } from '../Tooltip';
import styles from './SettingsSelect.module.css';
import { Menu } from '../ui/Menu';
import type { SelectOptionItem } from '../ui/Menu/types';

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
 * 设置页通用 Select 下拉框（T05.3.2 迁移到 ui/Menu 基座）：
 * - 坐标/Esc/外点关闭/滚动避让由基座 Radix Popover 接管，删除自算坐标
 *   （updateCoords）与 createPortal/监听器；
 * - 保留 listbox/combobox 语义：触发器 role=combobox + aria-haspopup=listbox，
 *   选项区 role=listbox + role=option + aria-selected；
 * - 键盘漫游（↑↓/Enter）由基座 options 模式提供，焦点落在 role=option 上；
 * - 仅保留「面板宽度贴合触发器」的测量（[140,220] 钳制），位置不再手算。
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
  const [menuWidth, setMenuWidth] = useState<number | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 基座（Radix）触发器点击会经两条路径上报 open（clone 注入 + 内部 toggle），
  // 用该 ref 保证 onOpen 仅在「关闭 → 打开」时触发一次（与原实现一致）
  const wasOpenRef = useRef(false);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label || placeholder;

  // 面板宽度贴合触发器宽度（非坐标计算；位置由基座 Radix 负责）
  const measureWidth = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuWidth(Math.min(Math.max(rect.width, 140), 220));
    }
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && !wasOpenRef.current) {
        // 打开前先测触发器宽度，面板首帧即贴合
        measureWidth();
        onOpen?.();
      }
      wasOpenRef.current = nextOpen;
      setOpen(nextOpen);
    },
    [onOpen, measureWidth],
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
    <div className={`${styles.settingsSelect} ${className || ''} ${disabled ? styles.disabled : ''}`} data-density="compact">
      <div className={styles.settingsSelectTriggerRow}>
        <Menu
          open={open}
          onOpenChange={handleOpenChange}
          options={menuOptions}
          onSelect={(idValue) => handleSelect(idValue)}
          side="bottom"
          align="start"
          sideOffset={4}
          contentClassName={styles.settingsSelectMenu}
          contentStyle={{ width: menuWidth, maxHeight }}
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
              <Lucide.ChevronDown size={14} className={styles.settingsSelectChev} aria-hidden />
            </button>
          }
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
                    handleSelect(opt.value);
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
        </Menu>
        {trailing}
      </div>
    </div>
  );
};
