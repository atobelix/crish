import React, { useCallback, useRef, useState } from 'react';

import styles from './PermissionModeMenu.module.css';
import { Button, Menu, Tooltip } from '../ui';
import { toggleExclusiveMenu } from '../ui/Menu';
import { useI18n } from '../../i18n';
import {
  DESKTOP_PERMISSION_MODE_IDS,
  coercePermissionMode,
  permissionModeMeta,
  transitionPermissionMode,
  type PermissionMode,
} from '../../api/permissionModes';
import { AppIcon } from '../ui/icons/index';

const MODE_ICON_MAP: Record<PermissionMode, React.ReactNode> = {
  ask: <AppIcon name="shield-check" size={14} />,
  deep: <AppIcon name="search" size={14} />,
  plan: <AppIcon name="target" size={14} />,
  full: <AppIcon name="alert-circle" size={14} />,
};

type Props = {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
  /** 主对话网格：盾形 icon-only；侧栏/测试默认文字药丸 */
  iconOnly?: boolean;
  /** 隐藏折叠展开箭头（单行融合胶囊左段时使用） */
  hideChevron?: boolean;
  /** 药丸形态变体：default 独立药丸；fused 左半融入三段式胶囊 */
  variant?: 'default' | 'fused';
};

/**
 * 权限模式菜单（显式 Anchor + 加号同构开关）：
 * - 药丸自管 pillBtnRef；关则写死 false，禁止 setOpen(prev => !prev) 与外点对打；
 * - 外点已关后同一 pointer 落到药丸不得再打开；
 * - 坐标/Esc/外点关闭由基座接管；side="top"；
 * - 键盘漫游由基座 options 模式提供；
 * - 每项 Tooltip 展示矩阵提示，专属语义图标 + 11px 次级描述，选中态翡翠绿打勾。
 */
export const PermissionModeMenu: React.FC<Props> = ({
  mode: modeRaw,
  onChange,
  iconOnly = false,
  hideChevron = false,
  variant = 'default',
}) => {
  const { t } = useI18n();
  const mode = coercePermissionMode(modeRaw);
  const meta = permissionModeMeta(mode);
  const [open, setOpen] = useState(false);
  const pillBtnRef = useRef<HTMLButtonElement>(null);

  const selectMode = useCallback(
    (nextRaw: unknown) => {
      const next = transitionPermissionMode(mode, nextRaw);
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

  const options = DESKTOP_PERMISSION_MODE_IDS.map((m) => ({
    id: m,
    label: permissionModeMeta(m).label,
    onClick: () => selectMode(m),
  }));

  const tooltipContent = t('chat.permission.tooltip', {
    mode: meta.label,
    hint: meta.matrixHint,
  });

  const pillAriaLabel = t('chat.permission.ariaLabel', {
    mode: meta.label,
  });

  return (
    <div
      className={styles.permModeWrap}
      data-density="compact"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <Tooltip content={tooltipContent} disabled={open} side="top">
        <Button
          ref={pillBtnRef}
          type="button"
          variant="ghost"
          className={[
            styles.permPill,
            styles.trigger,
            open ? styles.isOpen : null,
            iconOnly ? styles.iconOnly : null,
            variant === 'fused' ? styles.fused : null,
          ]
            .filter(Boolean)
            .join(' ')}
          data-perm-mode={mode}
          onClick={handleToggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={pillAriaLabel}
        >
          <span className={styles.permIcon} aria-hidden="true">
            {MODE_ICON_MAP[mode] ?? <AppIcon name="shield" size={14} />}
          </span>
          <span className={styles.permLabel}>{meta.label}</span>
          {!hideChevron && (
            <AppIcon
              name="chevron-down"
              size={11}
              className={styles.permPillChev}
              aria-hidden="true"
            />
          )}
        </Button>
      </Tooltip>

      {open ? (
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
            const itemMeta = permissionModeMeta(opt.id);
            const isSelected = opt.id === mode;
            const icon = MODE_ICON_MAP[opt.id as PermissionMode] ?? (
              <AppIcon name="shield" size={14} />
            );
            return (
              <Button
                key={opt.id}
                bare
                type="button"
                className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
                role="menuitem"
                onClick={() => {
                  opt.onClick?.();
                }}
              >
                <span className={styles.iconWrapper} aria-hidden="true">
                  {icon}
                </span>
                <div className={styles.labelRow}>
                  <span className={styles.title}>{itemMeta.label}</span>
                  {itemMeta.matrixHint ? (
                    <span className={styles.itemDesc}>
                      {itemMeta.matrixHint}
                    </span>
                  ) : null}
                </div>
                {isSelected ? (
                  <AppIcon
                    name="check"
                    size={13}
                    className={styles.checkIcon}
                    aria-hidden="true"
                  />
                ) : null}
              </Button>
            );
          }}
        />
      ) : null}
    </div>
  );
};
