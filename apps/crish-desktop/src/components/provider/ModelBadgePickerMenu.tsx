import React, {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactDOM from 'react-dom';
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
import { MenuContext } from '../ui/Menu/Menu';
import {
  calculateSubmenuPosition,
  type SubmenuPlacementResult,
} from '../ui/Menu/position';
import { SafeTriangleTracker } from '../ui/internal/SafeTriangle';
import { useLayerRegistration } from '../ui/internal/layer-registration/useLayerRegistration';
import { DialogOverlayContext } from '../ui/Dialog/dialogOverlayContext';

type Props = {
  activeModel?: string | null;
  onClose: () => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  side?: 'top' | 'bottom';
  /** 真实可见徽标，作 Radix Anchor；禁止再走 Popover.Trigger */
  anchor: React.RefObject<HTMLElement | null>;
};

interface SubmenuProps {
  profileId: string;
  profileName: string;
  models: string[];
  activeModel?: string | null;
  position: SubmenuPlacementResult;
  onCloseAll: () => void;
  onDismiss: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  parentRowRef: React.RefObject<HTMLButtonElement | null>;
  modelRefsRef: React.MutableRefObject<Record<string, HTMLButtonElement | null>>;
  submenuRef: React.RefObject<HTMLDivElement | null>;
}

const ModelBadgeSubmenuPortal: React.FC<SubmenuProps> = ({
  profileId,
  profileName,
  models,
  activeModel,
  position,
  onCloseAll,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
  parentRowRef,
  modelRefsRef,
  submenuRef,
}) => {
  const { menuId } = useContext(MenuContext);
  const dialogOverlay = useContext(DialogOverlayContext);
  const generatedId = useId();

  useLayerRegistration(
    {
      id: `${menuId ?? 'menu'}-submenu-${generatedId}`,
      type: 'cascade-submenu',
      parentId: menuId ?? undefined,
      dismissible: true,
      elementRef: submenuRef,
      anchorRef: parentRowRef,
      onDismiss,
      onEscapeKeyDown: (e) => {
        e.preventDefault();
        onDismiss();
        parentRowRef.current?.focus({ preventScroll: true });
      },
    },
    true
  );

  const container =
    dialogOverlay ?? (typeof document !== 'undefined' ? document.body : null);
  if (!container) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    );
    if (items.length === 0) return;

    if (
      (position.side === 'left' && e.key === 'ArrowRight') ||
      (position.side === 'right' && e.key === 'ArrowLeft') ||
      e.key === 'Escape'
    ) {
      e.preventDefault();
      e.stopPropagation();
      onDismiss();
      parentRowRef.current?.focus({ preventScroll: true });
      return;
    }

    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const cur =
        document.activeElement instanceof HTMLButtonElement
          ? items.indexOf(document.activeElement)
          : -1;
      let next = 0;
      if (e.key === 'ArrowDown') next = cur < 0 ? 0 : (cur + 1) % items.length;
      else if (e.key === 'ArrowUp')
        next =
          cur < 0
            ? items.length - 1
            : (cur - 1 + items.length) % items.length;
      else if (e.key === 'End') next = items.length - 1;
      items[next]?.focus({ preventScroll: true });
    }
  };

  return ReactDOM.createPortal(
    <div
      ref={submenuRef}
      role="menu"
      aria-label={`${profileName} 模型列表`}
      className={styles.mbSubMenuFloating}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        transformOrigin: position.transformOrigin,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={handleKeyDown}
    >
      {models.map((m) => {
        const isSelected = m === activeModel;
        return (
          <button
            key={m}
            ref={(el) => {
              modelRefsRef.current[m] = el;
            }}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`${styles.mbSubRow}${isSelected ? ` ${styles.isSelected}` : ''}`}
            data-testid={`model-option-${m}`}
            onClick={async () => {
              await activateProfileModel(profileId, m);
              onCloseAll();
            }}
          >
            <span className={styles.mbSubRowText}>
              {formatModelDisplayName(profileId, m)}
            </span>
            {isSelected && (
              <Lucide.Check size={14} className={styles.mbCheck} />
            )}
          </button>
        );
      })}
    </div>,
    container
  );
};

/**
 * 模型徽标下拉（Anchor + 受控 open，与加号同构）：
 * - 无 Popover.Trigger；开关由宿主按钮写绝对值，onOpenChange 只收 false；
 * - 打开态单一真源：expandedProfileId + calculateSubmenuPosition 视口双向钳位；
 * - SafeTriangleTracker 轨迹保护 + 代际递增 Token，消除相邻行掠过闪烁；
 * - 模态感知焦点控制（彻底清除 autoFocus，Hover 不抢焦，Keyboard 受控聚焦）；
 * - Portal 独立挂载至 DialogOverlay / Document.Body，逃逸包含块裁剪；
 * - LayerStack 拓扑注册，放行子孙点击防误杀父菜单；
 * - 主菜单滚动自动收起子菜单防脱轨悬空；
 * - window.blur / visibilitychange RAII 全生命周期自愈清理。
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
  const [submenuPos, setSubmenuPos] =
    useState<SubmenuPlacementResult | null>(null);

  const timerTokenRef = useRef(0);
  const enterTimerRef = useRef<number | undefined>(undefined);
  const leaveTimerRef = useRef<number | undefined>(undefined);
  const safeTrackerRef = useRef(new SafeTriangleTracker(300));

  const rowRefsRef = useRef<Record<string, HTMLButtonElement | null>>({});
  const modelRefsRef = useRef<Record<string, HTMLButtonElement | null>>({});
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  const dismissSubmenu = useCallback(() => {
    setExpandedProfileId(null);
    setSubmenuPos(null);
    safeTrackerRef.current.reset();
  }, []);

  const clearTimers = useCallback(() => {
    if (enterTimerRef.current != null) clearTimeout(enterTimerRef.current);
    if (leaveTimerRef.current != null) clearTimeout(leaveTimerRef.current);
  }, []);

  useEffect(() => {
    return () => {
      clearTimers();
      safeTrackerRef.current.reset();
    };
  }, [clearTimers]);

  useEffect(() => {
    if (!open) {
      clearTimers();
      dismissSubmenu();
    }
  }, [open, clearTimers, dismissSubmenu]);

  useEffect(() => {
    const handleBlur = () => {
      clearTimers();
      dismissSubmenu();
    };
    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleBlur);
    return () => {
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleBlur);
    };
  }, [clearTimers, dismissSubmenu]);

  useEffect(() => {
    const scrollContainer =
      listContainerRef.current?.closest(`.${styles.mbMenu}`) ||
      listContainerRef.current;
    if (!scrollContainer) return;
    const handleScroll = () => {
      if (expandedProfileId != null) dismissSubmenu();
    };
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollContainer.removeEventListener('scroll', handleScroll);
  }, [expandedProfileId, dismissSubmenu]);

  const expandAndFocus = useCallback(
    (profileId: string) => {
      const rowEl = rowRefsRef.current[profileId];
      if (rowEl) {
        setSubmenuPos(calculateSubmenuPosition(rowEl.getBoundingClientRect()));
      }
      setExpandedProfileId(profileId);
      safeTrackerRef.current.reset();
      requestAnimationFrame(() => {
        const activeBtn = activeModel
          ? modelRefsRef.current[activeModel]
          : null;
        const targetBtn =
          activeBtn ||
          submenuRef.current?.querySelector<HTMLButtonElement>(
            '[role="menuitem"]'
          );
        targetBtn?.focus({ preventScroll: true });
      });
    },
    [activeModel]
  );

  const handleRowEnter = useCallback(
    (profileId: string, e: React.MouseEvent) => {
      if (leaveTimerRef.current != null) clearTimeout(leaveTimerRef.current);
      if (
        expandedProfileId &&
        expandedProfileId !== profileId &&
        safeTrackerRef.current.isGraceActive()
      ) {
        if (safeTrackerRef.current.check({ x: e.clientX, y: e.clientY })) return;
      }
      if (enterTimerRef.current != null) clearTimeout(enterTimerRef.current);
      const currentToken = ++timerTokenRef.current;
      enterTimerRef.current = window.setTimeout(() => {
        if (timerTokenRef.current !== currentToken) return;
        const rowEl = rowRefsRef.current[profileId];
        if (rowEl) {
          setSubmenuPos(calculateSubmenuPosition(rowEl.getBoundingClientRect()));
          setExpandedProfileId(profileId);
        }
      }, 80);
    },
    [expandedProfileId]
  );

  const handleRowLeave = useCallback(
    (profileId: string, e: React.MouseEvent) => {
      if (enterTimerRef.current != null) clearTimeout(enterTimerRef.current);
      if (expandedProfileId === profileId && submenuRef.current) {
        const subRect = submenuRef.current.getBoundingClientRect();
        safeTrackerRef.current.enter(
          { x: e.clientX, y: e.clientY },
          {
            left: subRect.left,
            top: subRect.top,
            right: subRect.right,
            bottom: subRect.bottom,
          },
          submenuPos?.side ?? 'left'
        );
      }
      const currentToken = ++timerTokenRef.current;
      leaveTimerRef.current = window.setTimeout(() => {
        if (timerTokenRef.current !== currentToken) return;
        dismissSubmenu();
      }, 150);
    },
    [expandedProfileId, submenuPos?.side, dismissSubmenu]
  );

  const handleSubmenuEnter = useCallback(() => {
    if (leaveTimerRef.current != null) clearTimeout(leaveTimerRef.current);
    safeTrackerRef.current.reach();
  }, []);

  const handleSubmenuLeave = useCallback(() => {
    const currentToken = ++timerTokenRef.current;
    leaveTimerRef.current = window.setTimeout(() => {
      if (timerTokenRef.current !== currentToken) return;
      dismissSubmenu();
    }, 150);
  }, [dismissSubmenu]);

  const profiles = listPickerProfiles().filter((p) => p.enabled !== false);
  const currentProfile = profiles.find((p) => p.id === expandedProfileId);
  const currentModels = useMemo(() => {
    if (!currentProfile) return [];
    return (currentProfile.models || []).filter(
      (m) => getModelMeta(currentProfile.id, m).enabled !== false
    );
  }, [currentProfile]);

  const focusedParentRowRef = useRef<HTMLButtonElement | null>(null);
  focusedParentRowRef.current = expandedProfileId
    ? rowRefsRef.current[expandedProfileId] ?? null
    : null;

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
          if (expandedProfileId != null) {
            event.preventDefault();
            const pid = expandedProfileId;
            dismissSubmenu();
            rowRefsRef.current[pid]?.focus({ preventScroll: true });
          }
        },
      }}
    >
      <div
        ref={listContainerRef}
        className={styles.mbRowContainer}
        onScroll={() => expandedProfileId && dismissSubmenu()}
      >
        {profiles.length === 0 ? (
          <div className={styles.mbEmpty}>暂无可用服务商</div>
        ) : (
          profiles.map((p) => {
            const models = (p.models || []).filter(
              (m) => getModelMeta(p.id, m).enabled !== false
            );
            const hasModels = models.length > 0;
            const isExpanded = expandedProfileId === p.id;
            const currentSide =
              isExpanded && submenuPos ? submenuPos.side : 'left';

            return (
              <div
                key={p.id}
                className={styles.mbRowContainer}
                onMouseEnter={(e) => handleRowEnter(p.id, e)}
                onMouseLeave={(e) => handleRowLeave(p.id, e)}
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
                  onClick={() => {
                    if (!hasModels) return;
                    if (isExpanded) dismissSubmenu();
                    else expandAndFocus(p.id);
                  }}
                  onKeyDown={(e) => {
                    if (
                      (currentSide === 'left' && e.key === 'ArrowLeft') ||
                      (currentSide === 'right' && e.key === 'ArrowRight') ||
                      e.key === 'Enter' ||
                      e.key === ' '
                    ) {
                      if (!hasModels) return;
                      e.preventDefault();
                      e.stopPropagation();
                      expandAndFocus(p.id);
                    }
                  }}
                >
                  <span className={styles.mbRowText}>{p.name}</span>
                  {hasModels &&
                    (currentSide === 'right' ? (
                      <Lucide.ChevronRight
                        size={14}
                        className={styles.mbChevron}
                      />
                    ) : (
                      <Lucide.ChevronLeft
                        size={14}
                        className={styles.mbChevron}
                      />
                    ))}
                </button>
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
      </div>

      {expandedProfileId &&
        currentProfile &&
        currentModels.length > 0 &&
        submenuPos && (
          <ModelBadgeSubmenuPortal
            profileId={currentProfile.id}
            profileName={currentProfile.name}
            models={currentModels}
            activeModel={activeModel}
            position={submenuPos}
            onCloseAll={() => {
              dismissSubmenu();
              onClose();
            }}
            onDismiss={dismissSubmenu}
            onMouseEnter={handleSubmenuEnter}
            onMouseLeave={handleSubmenuLeave}
            parentRowRef={focusedParentRowRef}
            modelRefsRef={modelRefsRef}
            submenuRef={submenuRef}
          />
        )}
    </Menu>
  );
};
