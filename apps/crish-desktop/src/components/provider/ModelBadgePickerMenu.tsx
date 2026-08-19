import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ModelBadgePickerMenu.module.css';
import { activateProfileModel } from '../../api/providerProfiles';
import {
  formatModelDisplayName,
  getModelMeta,
  listPickerProfiles,
} from '../../api/modelCatalog';
import { openSettings } from '../../api/storeAccess';
import { Menu } from '../ui';

type Props = {
  activeModel?: string | null;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  side?: 'top' | 'bottom';
  /** 真实可见徽标，作 Radix Anchor；禁止再走 Popover.Trigger */
  anchor: React.RefObject<HTMLElement | null>;
};

/**
 * 模型徽标下拉（Anchor + 受控 open，与加号同构）：
 * - 无 Popover.Trigger；开关由宿主按钮写绝对值，onOpenChange 只收 false；
 * - 打开态单一真源：expandedProfileId（取代 hoveredProfileId）；
 * - hover 定时器仅作增强路径，卸载 / 关闭时清理；
 * - Esc 逐级关闭（子菜单 → 行按钮 → 基座）。
 */
export const ModelBadgePickerMenu: React.FC<Props> = ({
  activeModel,
  onClose,
  onOpenChange,
  open = false,
  side = 'bottom',
  anchor,
}) => {
  const [expandedProfileId, setExpandedProfileId] = useState<string | null>(
    null
  );
  const enterTimerRef = useRef<number | undefined>(undefined);
  const leaveTimerRef = useRef<number | undefined>(undefined);
  const rowRefsRef = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    return () => {
      if (enterTimerRef.current != null) clearTimeout(enterTimerRef.current);
      if (leaveTimerRef.current != null) clearTimeout(leaveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!open) setExpandedProfileId(null);
  }, [open]);

  const handleRowEnter = useCallback((profileId: string) => {
    if (leaveTimerRef.current != null) clearTimeout(leaveTimerRef.current);
    enterTimerRef.current = window.setTimeout(() => {
      setExpandedProfileId(profileId);
    }, 80);
  }, []);

  const handleRowLeave = useCallback(() => {
    if (enterTimerRef.current != null) clearTimeout(enterTimerRef.current);
    leaveTimerRef.current = window.setTimeout(() => {
      setExpandedProfileId(null);
    }, 150);
  }, []);

  const profiles = listPickerProfiles().filter((p) => p.enabled !== false);

  if (!open) return null;

  return (
    <Menu
      openState={{
        open,
        onOpenChange: (nextOpen) => {
          if (!nextOpen) {
            onOpenChange?.(false);
            onClose();
          }
        },
      }}
      anchor={anchor}
      position={{ side, align: 'start', sideOffset: 4 }}
      panel={{ contentClassName: styles.mbMenu }}
      outsideHandlers={{
        onEscapeKeyDown: (event) => {
          // 逐级关闭第一环：子菜单打开时 Esc 只关子菜单（Radix document 捕获
          // 阶段，preventDefault 阻止整层关闭），并归还行按钮焦点；
          // 子菜单已关时放行 → Radix 关闭整体并归还 trigger
          if (expandedProfileId != null) {
            event.preventDefault();
            setExpandedProfileId(null);
            rowRefsRef.current[expandedProfileId]?.focus();
          }
        },
      }}
    >
      {profiles.length === 0 ? (
        <div className={styles.mbEmpty}>暂无可用服务商</div>
      ) : (
        profiles.map((p, profileIndex) => {
          const models = (p.models || []).filter((m) => {
            const meta = getModelMeta(p.id, m);
            return meta.enabled !== false;
          });
          const hasModels = models.length > 0;
          const isExpanded = expandedProfileId === p.id;

          return (
            <div
              key={p.id}
              className={styles.mbRowContainer}
              onMouseEnter={() => handleRowEnter(p.id)}
              onMouseLeave={handleRowLeave}
            >
              <button
                ref={(el) => {
                  rowRefsRef.current[p.id] = el;
                }}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={hasModels ? isExpanded : undefined}
                className={`${styles.mbRow}${isExpanded ? ` ${styles.isExpanded}` : ''}`}
                data-testid={`profile-item-${p.id}`}
                autoFocus={profileIndex === 0}
                onClick={() => {
                  if (!hasModels) return;
                  setExpandedProfileId(isExpanded ? null : p.id);
                }}
              >
                <span className={styles.mbRowText}>{p.name}</span>
                {hasModels && (
                  <Lucide.ChevronLeft size={14} className={styles.mbChevron} />
                )}
              </button>

              {isExpanded && hasModels && (
                <div
                  className={styles.mbSubMenu}
                  role="menu"
                  aria-label={`${p.name} 模型列表`}
                  onKeyDown={(e) => {
                    // 子菜单内漫游：↑↓ 循环 / Home / End（Esc 走 Menu onEscapeKeyDown
                    // 捕获通道，见上——bubble 阶段 stopPropagation 挡不住 Radix）
                    const items = Array.from(
                      e.currentTarget.querySelectorAll<HTMLButtonElement>(
                        '[role="menuitem"]'
                      )
                    );
                    if (items.length === 0) return;
                    if (
                      e.key === 'ArrowDown' ||
                      e.key === 'ArrowUp' ||
                      e.key === 'Home' ||
                      e.key === 'End'
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      const active = document.activeElement;
                      const cur =
                        active instanceof HTMLButtonElement
                          ? items.indexOf(active)
                          : -1;
                      let next: number;
                      if (e.key === 'ArrowDown')
                        next = cur < 0 ? 0 : (cur + 1) % items.length;
                      else if (e.key === 'ArrowUp')
                        next =
                          cur < 0
                            ? items.length - 1
                            : (cur - 1 + items.length) % items.length;
                      else if (e.key === 'Home') next = 0;
                      else next = items.length - 1;
                      items[next]?.focus();
                    }
                  }}
                >
                  {models.map((m, modelIndex) => {
                    const isSelected = m === activeModel;
                    return (
                      <button
                        key={m}
                        type="button"
                        role="menuitem"
                        autoFocus={modelIndex === 0}
                        className={`${styles.mbSubRow}${isSelected ? ` ${styles.isSelected}` : ''}`}
                        data-testid={`model-option-${m}`}
                        onClick={async () => {
                          await activateProfileModel(p.id, m);
                          onClose();
                        }}
                      >
                        <span className={styles.mbSubRowText}>
                          {formatModelDisplayName(p.id, m)}
                        </span>
                        {isSelected && (
                          <Lucide.Check size={14} className={styles.mbCheck} />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
      <div className={styles.mbDivider} />
      <button
        type="button"
        role="menuitem"
        className={styles.mbManageBtn}
        onClick={() => {
          openSettings('models');
          onClose();
        }}
      >
        <Lucide.SlidersHorizontal size={12} className={styles.mbManageIcon} />
        <span>模型管理...</span>
      </button>
    </Menu>
  );
};
