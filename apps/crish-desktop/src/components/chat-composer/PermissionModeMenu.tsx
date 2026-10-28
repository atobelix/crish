import React, { useCallback, useRef, useState } from 'react';

import styles from './PermissionModeMenu.module.css';
import { Button, Menu, Tooltip } from '@/components/ui';
import { toggleExclusiveMenu } from '@/components/ui';
import { useI18n } from '../../i18n';
import {
  PERMISSION_MODES,
  coercePermissionMode,
  type PermissionMode,
} from '../../api/permissionModes';
import { AppIcon } from '@/components/ui/icons';

export interface PermissionModeMenuProps {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
}

interface ModeConfig {
  id: PermissionMode;
  iconName: 'shield' | 'shield-check' | 'zap';
  label: string;
  description: string;
  isRecommended?: boolean;
}

// 三态文案唯一真理源 = api/permissionModes；本组件只做渲染，禁止本地再抄一份
const MODE_CONFIGS: readonly ModeConfig[] = PERMISSION_MODES.map((m) => ({
  id: m.id,
  iconName: m.iconName,
  label: m.label,
  description: m.description,
  ...(m.isRecommended ? { isRecommended: true } : {}),
}));

const MODE_CONFIG_MAP: Record<PermissionMode, ModeConfig> = Object.fromEntries(
  MODE_CONFIGS.map((m) => [m.id, m])
) as Record<PermissionMode, ModeConfig>;

/**
 * 权限模式菜单（显式 Anchor + 加号同构互斥）：
 * - 纯三态收敛：每次询问 (ask) / 智能放行 (smart，推荐) / 完全允许 (full)；
 * - 极简药丸：28px 高度、14px 圆角胶囊端点，无冗余形态分支；
 * - 坐标/Esc/外点关闭由 Menu 基座接管，side="top"；
 * - 键盘漫游由 Menu 基座 options 模式驱动。
 */
export const PermissionModeMenu: React.FC<PermissionModeMenuProps> = ({
  mode: modeRaw,
  onChange,
}) => {
  const { t } = useI18n();
  const mode = coercePermissionMode(modeRaw);
  const currentMeta = MODE_CONFIG_MAP[mode] ?? MODE_CONFIG_MAP.smart;
  const [open, setOpen] = useState(false);
  const pillBtnRef = useRef<HTMLButtonElement>(null);

  const selectMode = useCallback(
    (next: PermissionMode) => {
      if (next !== mode) {
        onChange(next);
      }
      setOpen(false);
    },
    [mode, onChange]
  );

  const handleToggle = useCallback(() => {
    toggleExclusiveMenu(open, setOpen, pillBtnRef.current);
  }, [open]);

  const options = MODE_CONFIGS.map((item) => ({
    id: item.id,
    label: item.label,
    onClick: () => selectMode(item.id),
  }));

  const tooltipContent = t('chat.permission.tooltip', {
    mode: currentMeta.label,
    hint: currentMeta.description,
    desc: currentMeta.description,
  });

  const pillAriaLabel = t('chat.permission.ariaLabel', {
    mode: currentMeta.label,
  });

  return (
    <div className={styles.permModeWrap}>
      <Tooltip content={tooltipContent} disabled={open} side="top">
        <Button
          ref={pillBtnRef}
          type="button"
          variant="ghost"
          className={`${styles.permPill} ${open ? styles.isOpen : ''}`}
          data-perm-mode={mode}
          onClick={handleToggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={pillAriaLabel}
        >
          <span className={styles.permIcon} aria-hidden="true">
            <AppIcon name={currentMeta.iconName} size={14} />
          </span>
          <span className={styles.permLabel}>{currentMeta.label}</span>
          <AppIcon
            name="chevron-down"
            size={11}
            className={styles.permPillChev}
            aria-hidden="true"
          />
        </Button>
      </Tooltip>

      {open && (
        <Menu
          openState={{
            open,
            onOpenChange: (nextOpen) => {
              if (!nextOpen) setOpen(false);
            },
          }}
          anchor={pillBtnRef}
          options={options}
          position={{ side: 'top', align: 'start', sideOffset: 6 }}
          panel={{ contentClassName: styles.permMenu }}
          renderItem={(opt) => {
            const itemMeta =
              MODE_CONFIG_MAP[opt.id as PermissionMode] ??
              MODE_CONFIG_MAP.smart;
            const isSelected = opt.id === mode;
            return (
              <Button
                key={opt.id}
                bare
                type="button"
                className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
                role="menuitem"
                onClick={opt.onClick}
              >
                <span className={styles.iconWrapper} aria-hidden="true">
                  <AppIcon name={itemMeta.iconName} size={16} />
                </span>
                <div className={styles.labelCol}>
                  <div className={styles.titleRow}>
                    <span className={styles.title}>{itemMeta.label}</span>
                    {itemMeta.isRecommended && (
                      <span className={styles.recommendBadge}>推荐</span>
                    )}
                  </div>
                  <span className={styles.itemDesc}>
                    {itemMeta.description}
                  </span>
                </div>
                {isSelected && (
                  <AppIcon
                    name="check"
                    size={14}
                    className={styles.checkIcon}
                    aria-hidden="true"
                  />
                )}
              </Button>
            );
          }}
        />
      )}
    </div>
  );
};
