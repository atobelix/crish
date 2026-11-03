/**
 * apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx
 *
 * 侧栏排序/分组/过滤级联菜单（ui/Menu 的 Base UI 原语装配）。
 *
 * 收敛说明（2026-11-02 右键菜单收敛批）：原手写级联引擎（FlyoutRow/FlyoutOption、
 * 80/150ms 悬停定时器、ArrowKey 漫游、flipLeft 几何测量）全部退役，改由
 * Base UI SubmenuRoot/SubmenuTrigger/RadioGroup 原生承担悬停意图、安全悬停路径、
 * 碰撞翻转与键盘导航；LayerStack 登记与 Esc 分层语义保持收敛前契约：
 * 子菜单打开时 Esc 只收子菜单并回焦行触发器，第二次 Esc 才关整个菜单。
 */

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { Menu, useLayerRegistration, LayerProvider } from '@/components/ui';
import { DialogOverlayContext } from '../ui/Dialog/dialogOverlayContext';
import menuStyles from '../ui/Menu/Menu.module.css';
import styles from './SidebarContextMenus.module.css';
import { AppIcon } from '@/components/ui/icons';
import { t } from '../../i18n';

type FlyKey = 'sort' | 'group' | 'filter';
type SortType = 'active' | 'name';
type GroupType = 'folder' | 'none';
type FilterType = 'all' | 'pinned';

export interface ContextMenuFlyoutProps {
  sortMenuRef: React.RefObject<HTMLDivElement | null>;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: SortType;
  groupType: GroupType;
  filterType: FilterType;
  onSetSortType: (v: SortType) => void;
  onSetGroupType: (v: GroupType) => void;
  onSetFilterType: (v: FilterType) => void;
  onCloseSortDropdown: () => void;
  sortTriggerRef?: React.RefObject<HTMLElement | null>;
}

interface FlyoutSection<V extends string> {
  type: FlyKey;
  label: string;
  valueLabel: string;
  value: V;
  options: { value: V; label: string }[];
  onPick: (v: V) => void;
}

/**
 * 排序/分组/过滤级联下拉主组件
 */
export const ContextMenuFlyout: React.FC<ContextMenuFlyoutProps> = ({
  sortMenuRef,
  sortDropdownOpen,
  sortDropdownCoords,
  sortType,
  groupType,
  filterType,
  onSetSortType,
  onSetGroupType,
  onSetFilterType,
  onCloseSortDropdown,
  sortTriggerRef,
}) => {
  const [fly, setFly] = React.useState<FlyKey | null>(null);
  const layerId = React.useId();
  const dialogOverlay = useContext(DialogOverlayContext);

  const popupRefObj = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Record<FlyKey, HTMLElement | null>>({
    sort: null,
    group: null,
    filter: null,
  });

  const mergedPopupRef = useCallback(
    (el: HTMLDivElement | null) => {
      popupRefObj.current = el;
      sortMenuRef.current = el;
    },
    [sortMenuRef]
  );

  useEffect(() => {
    if (!sortDropdownOpen) setFly(null);
  }, [sortDropdownOpen]);

  // 开菜单初始焦点落首行（与收敛前行为一致，键盘用户可直接漫游）
  useEffect(() => {
    if (!sortDropdownOpen) return;
    const raf = requestAnimationFrame(() => {
      rowRefs.current.sort?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [sortDropdownOpen]);

  useLayerRegistration(
    {
      id: layerId,
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: () => {
        onCloseSortDropdown();
      },
      onEscapeKeyDown: (event) => {
        if (fly !== null) {
          event.preventDefault();
          const current = fly;
          setFly(null);
          rowRefs.current[current]?.focus();
        }
      },
      elementRef: popupRefObj,
      anchorRef: sortTriggerRef,
    },
    sortDropdownOpen
  );

  const handleRootOpenChange = useCallback(
    (
      next: boolean,
      details: Parameters<
        NonNullable<React.ComponentProps<typeof Menu.Root>['onOpenChange']>
      >[1]
    ) => {
      if (next) return;
      if (details.reason === 'outside-press') {
        const target = (details.event as Event | undefined)
          ?.target as Node | null;
        const triggerEl = sortTriggerRef?.current;
        // 点在排序按钮上：由按钮侧 toggle 语义裁决（与 ui/Menu 锚点模式同一守卫）
        if (triggerEl && target && triggerEl.contains(target)) return;
        const popupEl = popupRefObj.current;
        if (popupEl && target && popupEl.contains(target)) return;
      }
      onCloseSortDropdown();
    },
    [onCloseSortDropdown, sortTriggerRef]
  );

  const positionerAnchor = useMemo(() => {
    if (sortTriggerRef) return sortTriggerRef;
    if (sortDropdownCoords) {
      const { x, y } = sortDropdownCoords;
      return {
        getBoundingClientRect: () =>
          ({
            x,
            y,
            width: 0,
            height: 0,
            top: y,
            left: x,
            right: x,
            bottom: y,
            toJSON: () => ({}),
          }) as DOMRect,
      };
    }
    return undefined;
  }, [sortTriggerRef, sortDropdownCoords]);

  const sections: FlyoutSection<string>[] = [
    {
      type: 'sort',
      label: t('sidebar.sortMenuSort', '排序方式'),
      valueLabel:
        sortType === 'name'
          ? t('sidebar.sortMenuSortName', '按名称')
          : t('sidebar.sortMenuSortActive', '按最近活跃'),
      value: sortType,
      options: [
        {
          value: 'active',
          label: t('sidebar.sortMenuSortActive', '按最近活跃'),
        },
        { value: 'name', label: t('sidebar.sortMenuSortName', '按名称') },
      ],
      onPick: (v) => {
        onSetSortType(v as SortType);
        onCloseSortDropdown();
      },
    },
    {
      type: 'group',
      label: t('sidebar.sortMenuGroup', '分组方式'),
      valueLabel:
        groupType === 'none'
          ? t('sidebar.sortMenuGroupNone', '平铺列表')
          : t('sidebar.sortMenuGroupProject', '按项目分组'),
      value: groupType,
      options: [
        {
          value: 'folder',
          label: t('sidebar.sortMenuGroupProject', '按项目分组'),
        },
        {
          value: 'none',
          label: t('sidebar.sortMenuGroupNone', '平铺列表'),
        },
      ],
      onPick: (v) => {
        onSetGroupType(v as GroupType);
        onCloseSortDropdown();
      },
    },
    {
      type: 'filter',
      label: t('sidebar.sortMenuFilter', '列表范围'),
      valueLabel:
        filterType === 'pinned'
          ? t('sidebar.sortMenuFilterPinned', '仅置顶')
          : t('sidebar.sortMenuFilterAll', '全部会话'),
      value: filterType,
      options: [
        {
          value: 'all',
          label: t('sidebar.sortMenuFilterAll', '全部会话'),
        },
        {
          value: 'pinned',
          label: t('sidebar.sortMenuFilterPinned', '仅置顶'),
        },
      ],
      onPick: (v) => {
        onSetFilterType(v as FilterType);
        onCloseSortDropdown();
      },
    },
  ];

  // 常驻挂载、由 open 状态驱动：关闭时 Base UI 退场动画（data-ending-style）
  // 完整播放后再卸载 Popup，与全仓触发式菜单的动效衔接一致，不做瞬时消失。
  return (
    <LayerProvider layerId={layerId} tier="popover">
      <Menu.Root
        open={sortDropdownOpen}
        onOpenChange={handleRootOpenChange}
        modal={false}
      >
        <Menu.Portal container={dialogOverlay ?? undefined}>
          <Menu.Positioner
            anchor={
              positionerAnchor as React.ComponentProps<
                typeof Menu.Positioner
              >['anchor']
            }
            side="bottom"
            align="start"
            sideOffset={4}
            className={menuStyles.positioner}
          >
            <Menu.Popup
              ref={mergedPopupRef}
              className={`${menuStyles.menuContent} ${styles.sortFilterMenu} no-drag`}
              style={{ minWidth: 212 }}
            >
              {sections.map((sec) => {
                const subOpen = fly === sec.type;
                return (
                  <Menu.SubmenuRoot
                    key={sec.type}
                    open={subOpen}
                    onOpenChange={(next) => {
                      if (next) {
                        setFly(sec.type);
                      } else {
                        setFly((prev) => (prev === sec.type ? null : prev));
                      }
                    }}
                  >
                    <Menu.SubmenuTrigger
                      ref={(el: HTMLElement | null) => {
                        rowRefs.current[sec.type] = el;
                      }}
                      delay={80}
                      closeDelay={150}
                      className={`${styles.sortFilterRow} ${subOpen ? styles.isOpen : ''}`}
                      data-fly-row={sec.type}
                    >
                      <span className={styles.sortFilterRowLabel}>
                        {sec.label}
                      </span>
                      <span className={styles.sortFilterRowRight}>
                        <span className={styles.sortFilterRowValue}>
                          {sec.valueLabel}
                        </span>
                        <AppIcon
                          name="chevron-right"
                          size={14}
                          className={styles.sortFilterChev}
                          aria-hidden
                        />
                      </span>
                    </Menu.SubmenuTrigger>
                    <Menu.Portal container={dialogOverlay ?? undefined}>
                      <Menu.Positioner
                        side="right"
                        align="start"
                        sideOffset={-5}
                        className={menuStyles.positioner}
                      >
                        <Menu.Popup
                          className={menuStyles.menuContent}
                          style={{ minWidth: 152 }}
                        >
                          <Menu.RadioGroup
                            value={sec.value}
                            onValueChange={(v) => sec.onPick(v as string)}
                          >
                            {sec.options.map((opt) => {
                              const checked = opt.value === sec.value;
                              return (
                                <Menu.RadioItem
                                  key={opt.value}
                                  value={opt.value}
                                  className={`${styles.sortFilterOption} ${checked ? styles.isOn : ''}`}
                                >
                                  <span>{opt.label}</span>
                                  {checked ? (
                                    <AppIcon
                                      name="check"
                                      size={14}
                                      className={styles.sortFilterCheck}
                                      aria-hidden
                                    />
                                  ) : null}
                                </Menu.RadioItem>
                              );
                            })}
                          </Menu.RadioGroup>
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.SubmenuRoot>
                );
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </LayerProvider>
  );
};
