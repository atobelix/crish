import React, { useCallback, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './PermissionModeMenu.module.css';
import { Menu, Tooltip } from '../ui';
import { toggleExclusiveMenu } from '../ui/Menu';
import {
  DESKTOP_PERMISSION_MODE_IDS,
  coercePermissionMode,
  permissionModeMeta,
  transitionPermissionMode,
  type PermissionMode,
} from '../../api/permissionModes';

type Props = {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
  /** 主对话网格：盾形 icon-only；侧栏/测试默认文字药丸 */
  iconOnly?: boolean;
};

/**
 * 权限模式菜单（显式 Anchor + 加号同构开关）：
 * - 药丸自管 pillBtnRef；关则写死 false，禁止 setOpen(prev => !prev) 与外点对打；
 * - 外点已关后同一 pointer 落到药丸不得再打开；
 * - 坐标/Esc/外点关闭由基座接管；side="top"；
 * - 键盘漫游由基座 options 模式提供；
 * - 每项 Tooltip 展示矩阵提示，选中态打勾。
 */
export const PermissionModeMenu: React.FC<Props> = ({
  mode: modeRaw,
  onChange,
  iconOnly = false,
}) => {
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

  return (
    <div
      className={styles.permModeWrap}
      data-density="compact"
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <Tooltip
        content={`当前权限模式：${meta.label} · ${meta.matrixHint}`}
        disabled={open}
        side="top"
      >
        <button
          ref={pillBtnRef}
          type="button"
          className={[
            styles.permPill,
            open ? styles.isOpen : null,
            iconOnly ? styles.iconOnly : null,
          ]
            .filter(Boolean)
            .join(' ')}
          data-perm-mode={mode}
          onClick={handleToggle}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={`当前权限模式：${meta.label}`}
        >
          {iconOnly ? (
            <Lucide.Shield size={14} strokeWidth={2} aria-hidden="true" />
          ) : null}
          <span>{meta.label}</span>
          {iconOnly ? null : (
            <Lucide.ChevronDown
              size={11}
              className={styles.permPillChev}
              aria-hidden="true"
            />
          )}
        </button>
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
            return (
              <Tooltip key={opt.id} content={itemMeta.matrixHint}>
                <button
                  type="button"
                  className={`${styles.permMenuItem} ${isSelected ? styles.isSelected : ''}`}
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    opt.onClick?.();
                  }}
                >
                  <span>{itemMeta.label}</span>
                  {isSelected ? (
                    <Lucide.Check
                      size={12}
                      style={{ marginLeft: 'auto', opacity: 0.8 }}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              </Tooltip>
            );
          }}
        />
      ) : null}
    </div>
  );
};
