import React, { useCallback, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './PermissionModeMenu.module.css';
import { Menu, Tooltip } from '../ui';
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
};

/**
 * 权限模式菜单（T05.3.2 迁移到 ui/Menu 基座）：
 * - 坐标/Esc/外点关闭全部由基座 Radix Popover 接管（删除自算坐标
 *   与「预估高度 140」hack）；弹出方向 side="top" 对齐原「按钮上方」布局；
 * - 键盘漫游（↑↓/Enter）由基座 options 模式提供；
 * - 每项仍包 Tooltip 展示矩阵提示，选中态打勾。
 * - 枚举已统一为 api/permissionModes 单一真相源（40 方案 T2/T7）；
 *   coercePermissionMode 仍保留作为存储/旧值运行期防御。
 */
export const PermissionModeMenu: React.FC<Props> = ({
  mode: modeRaw,
  onChange,
}) => {
  const mode = coercePermissionMode(modeRaw);
  const meta = permissionModeMeta(mode);
  const [open, setOpen] = useState(false);

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
      <Menu
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Tooltip
            content={`当前权限模式：${meta.label} · ${meta.matrixHint}`}
            disabled={open}
          >
            <button
              type="button"
              className={`${styles.permPill} ${open ? styles.isOpen : ''}`}
              aria-label={`当前权限模式：${meta.label}`}
            >
              <span>{meta.label}</span>
              <Lucide.ChevronDown
                size={11}
                className={styles.permPillChev}
                aria-hidden
              />
            </button>
          </Tooltip>
        }
        options={options}
        side="top"
        align="start"
        sideOffset={6}
        contentClassName={styles.permMenu}
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
                    aria-hidden
                  />
                ) : null}
              </button>
            </Tooltip>
          );
        }}
      />
    </div>
  );
};
