/**
 * apps/crish-desktop/src/components/sidebar/ContextMenuFlyout.tsx
 *
 * 现代化侧栏排序/分组/过滤级联子菜单
 * 架构收敛：标准自研 5px 负重叠级联、无缝覆盖与全键盘无障碍漫游。
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, Menu } from '@/components/ui';
import styles from './SidebarContextMenus.module.css';
import { AppIcon } from '@/components/ui/icons';

type FlyKey = 'sort' | 'group' | 'filter' | null;

const FLY_ORDER: NonNullable<FlyKey>[] = ['sort', 'group', 'filter'];

/**
 * 级联下拉行（具 5px 负重叠几何自适应与按需避让翻转）
 */
const FlyoutRow: React.FC<{
  type: NonNullable<FlyKey>;
  label: string;
  valueLabel: string;
  open: boolean;
  flyoutRef: (el: HTMLDivElement | null) => void;
  rowRef: (el: HTMLDivElement | null) => void;
  onFlyEnter: () => void;
  onFlyLeave: () => void;
  onFlyClick: () => void;
  onFlyoutEnter: () => void;
  onFlyoutLeave: () => void;
  onRowKeyDown: (e: React.KeyboardEvent) => void;
  onFlyoutKeyDown: (e: React.KeyboardEvent) => void;
  children: React.ReactNode;
}> = ({
  type,
  label,
  valueLabel,
  open,
  flyoutRef,
  rowRef,
  onFlyEnter,
  onFlyLeave,
  onFlyClick,
  onFlyoutEnter,
  onFlyoutLeave,
  onRowKeyDown,
  onFlyoutKeyDown,
  children,
}) => {
  const localRowElRef = useRef<HTMLDivElement | null>(null);
  const localFlyoutElRef = useRef<HTMLDivElement | null>(null);
  const [flipLeft, setFlipLeft] = useState(false);

  const handleRowRef = useCallback(
    (el: HTMLDivElement | null) => {
      localRowElRef.current = el;
      rowRef(el);
    },
    [rowRef]
  );

  const handleFlyoutRef = useCallback(
    (el: HTMLDivElement | null) => {
      localFlyoutElRef.current = el;
      flyoutRef(el);
    },
    [flyoutRef]
  );

  useLayoutEffect(() => {
    if (!open || !localRowElRef.current) return;
    const rowRect = localRowElRef.current.getBoundingClientRect();
    const flyoutWidth = localFlyoutElRef.current?.offsetWidth || 156;
    // 5px 负重叠几何判定：贴合右侧，若溢出视口则翻转至左侧
    setFlipLeft(rowRect.right + flyoutWidth - 5 > window.innerWidth - 8);
  }, [open]);

  return (
    <div
      className={`${styles.sortFilterRow} ${open ? styles.isOpen : ''}`}
      role="menuitem"
      tabIndex={0}
      data-fly-row={type}
      ref={handleRowRef}
      aria-haspopup="true"
      aria-expanded={open}
      onMouseEnter={onFlyEnter}
      onMouseLeave={onFlyLeave}
      onClick={(e) => {
        if (
          localFlyoutElRef.current &&
          e.target instanceof Node &&
          localFlyoutElRef.current.contains(e.target)
        ) {
          return;
        }
        onFlyClick();
      }}
      onKeyDown={onRowKeyDown}
    >
      <span className={styles.sortFilterRowLabel}>{label}</span>
      <span className={styles.sortFilterRowRight}>
        <span className={styles.sortFilterRowValue}>{valueLabel}</span>
        <AppIcon
          name="chevron-right"
          size={14}
          className={styles.sortFilterChev}
          aria-hidden
        />
      </span>
      {open ? (
        <div
          ref={handleFlyoutRef}
          className={`${styles.sortFilterFlyout} ${flipLeft ? styles.flipLeft : ''}`}
          role="group"
          aria-label={label}
          onMouseEnter={onFlyoutEnter}
          onMouseLeave={onFlyoutLeave}
          onKeyDown={onFlyoutKeyDown}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
};

/**
 * 级联子菜单单选项
 */
const FlyoutOption: React.FC<{
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}> = ({ checked, onSelect, children }) => {
  return (
    <Button
      bare
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={`${styles.sortFilterOption} ${checked ? styles.isOn : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      <span>{children}</span>
      {checked ? (
        <AppIcon
          name="check"
          size={14}
          className={styles.sortFilterCheck}
          aria-hidden
        />
      ) : null}
    </Button>
  );
};

export interface ContextMenuFlyoutProps {
  sortMenuRef: React.RefObject<HTMLDivElement | null>;
  sortDropdownOpen: boolean;
  sortDropdownCoords: { x: number; y: number } | null;
  sortType: 'active' | 'name';
  groupType: 'folder' | 'none';
  filterType: 'all' | 'pinned';
  onSetSortType: (v: 'active' | 'name') => void;
  onSetGroupType: (v: 'folder' | 'none') => void;
  onSetFilterType: (v: 'all' | 'pinned') => void;
  onCloseSortDropdown: () => void;
  sortTriggerRef?: React.RefObject<HTMLElement | null>;
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
  const [fly, setFly] = useState<FlyKey>(null);
  const flyTimerRef = useRef<{ enter?: number; leave?: number }>({});

  const clearFlyTimers = useCallback(() => {
    clearTimeout(flyTimerRef.current.enter);
    clearTimeout(flyTimerRef.current.leave);
  }, []);

  useEffect(() => {
    if (!sortDropdownOpen) {
      clearFlyTimers();
      setFly(null);
    }
    return clearFlyTimers;
  }, [sortDropdownOpen, clearFlyTimers]);

  const handleFlyEnter = useCallback((type: FlyKey) => {
    clearTimeout(flyTimerRef.current.leave);
    clearTimeout(flyTimerRef.current.enter);
    flyTimerRef.current.enter = window.setTimeout(() => {
      setFly(type);
    }, 80);
  }, []);

  const handleFlyLeave = useCallback((type: FlyKey) => {
    clearTimeout(flyTimerRef.current.enter);
    clearTimeout(flyTimerRef.current.leave);
    flyTimerRef.current.leave = window.setTimeout(() => {
      setFly((prev) => (prev === type ? null : prev));
    }, 150);
  }, []);

  const cancelFlyLeave = useCallback(() => {
    clearTimeout(flyTimerRef.current.leave);
  }, []);

  const handleFlyClick = useCallback(
    (type: NonNullable<FlyKey>) => {
      clearFlyTimers();
      setFly(type);
    },
    [clearFlyTimers]
  );

  const flyoutRefs = useRef<Record<NonNullable<FlyKey>, HTMLDivElement | null>>(
    {
      sort: null,
      group: null,
      filter: null,
    }
  );
  const rowRefs = useRef<Record<NonNullable<FlyKey>, HTMLDivElement | null>>({
    sort: null,
    group: null,
    filter: null,
  });

  const handleRowKeyDown = useCallback(
    (type: NonNullable<FlyKey>, e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        clearFlyTimers();
        setFly(type);
        requestAnimationFrame(() => {
          const first = flyoutRefs.current[type]?.querySelector<HTMLElement>(
            '[role="menuitemradio"]'
          );
          first?.focus();
        });
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const idx = FLY_ORDER.indexOf(type);
        const nextIdx =
          (idx + (e.key === 'ArrowDown' ? 1 : -1) + FLY_ORDER.length) %
          FLY_ORDER.length;
        const nextType = FLY_ORDER[nextIdx]!;
        setFly(null);
        rowRefs.current[nextType]?.focus();
      }
    },
    [clearFlyTimers]
  );

  const handleFlyoutKeyDown = useCallback(
    (type: NonNullable<FlyKey>, e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        clearFlyTimers();
        setFly(null);
        rowRefs.current[type]?.focus();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const container = flyoutRefs.current[type];
        if (!container) return;
        const radios = Array.from(
          container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
        );
        if (radios.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        const activeIdx = radios.indexOf(document.activeElement as HTMLElement);
        const nextIdx =
          activeIdx < 0
            ? 0
            : (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + radios.length) %
              radios.length;
        radios[nextIdx]?.focus();
      }
    },
    [clearFlyTimers]
  );

  useEffect(() => {
    if (!sortDropdownOpen) return;
    requestAnimationFrame(() => {
      const first =
        rowRefs.current.sort ??
        sortMenuRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
      first?.focus();
    });
  }, [sortDropdownOpen, sortMenuRef]);

  const sections = useMemo(
    () => [
      {
        type: 'sort' as const,
        label: '排序方式',
        valueLabel: sortType === 'name' ? '按名称' : '按最近活跃',
        options: [
          {
            label: '按最近活跃',
            checked: sortType === 'active',
            onSelect: () => {
              onSetSortType('active');
              onCloseSortDropdown();
            },
          },
          {
            label: '按名称',
            checked: sortType === 'name',
            onSelect: () => {
              onSetSortType('name');
              onCloseSortDropdown();
            },
          },
        ],
      },
      {
        type: 'group' as const,
        label: '分组方式',
        valueLabel: groupType === 'none' ? '平铺列表' : '按项目分组',
        options: [
          {
            label: '按项目分组',
            checked: groupType === 'folder',
            onSelect: () => {
              onSetGroupType('folder');
              onCloseSortDropdown();
            },
          },
          {
            label: '平铺列表',
            checked: groupType === 'none',
            onSelect: () => {
              onSetGroupType('none');
              onCloseSortDropdown();
            },
          },
        ],
      },
      {
        type: 'filter' as const,
        label: '列表范围',
        valueLabel: filterType === 'pinned' ? '仅置顶' : '全部会话',
        options: [
          {
            label: '全部会话',
            checked: filterType === 'all',
            onSelect: () => {
              onSetFilterType('all');
              onCloseSortDropdown();
            },
          },
          {
            label: '仅置顶',
            checked: filterType === 'pinned',
            onSelect: () => {
              onSetFilterType('pinned');
              onCloseSortDropdown();
            },
          },
        ],
      },
    ],
    [
      sortType,
      groupType,
      filterType,
      onSetSortType,
      onSetGroupType,
      onSetFilterType,
      onCloseSortDropdown,
    ]
  );

  return (
    <Menu
      openState={{
        open: sortDropdownOpen,
        onOpenChange: (open) => {
          if (!open) onCloseSortDropdown();
        },
      }}
      outsideHandlers={{
        onEscapeKeyDown: (event) => {
          if (fly !== null) {
            event.preventDefault();
            clearFlyTimers();
            setFly(null);
            rowRefs.current[fly]?.focus();
          }
        },
      }}
      anchor={sortTriggerRef}
      position={{ align: 'start', side: 'bottom', sideOffset: 4 }}
      panel={{
        contentClassName: `${styles.sortFilterMenu} ${styles.open} no-drag`,
        contentStyle:
          !sortTriggerRef?.current && sortDropdownCoords
            ? {
                position: 'fixed',
                left: sortDropdownCoords.x,
                top: sortDropdownCoords.y,
              }
            : undefined,
      }}
    >
      {sections.map((sec) => (
        <FlyoutRow
          key={sec.type}
          type={sec.type}
          label={sec.label}
          valueLabel={sec.valueLabel}
          open={fly === sec.type}
          flyoutRef={(el) => {
            flyoutRefs.current[sec.type] = el;
          }}
          rowRef={(el) => {
            rowRefs.current[sec.type] = el;
          }}
          onFlyEnter={() => handleFlyEnter(sec.type)}
          onFlyLeave={() => handleFlyLeave(sec.type)}
          onFlyClick={() => handleFlyClick(sec.type)}
          onFlyoutEnter={cancelFlyLeave}
          onFlyoutLeave={() => handleFlyLeave(sec.type)}
          onRowKeyDown={(e) => handleRowKeyDown(sec.type, e)}
          onFlyoutKeyDown={(e) => handleFlyoutKeyDown(sec.type, e)}
        >
          {sec.options.map((opt) => (
            <FlyoutOption
              key={opt.label}
              checked={opt.checked}
              onSelect={opt.onSelect}
            >
              {opt.label}
            </FlyoutOption>
          ))}
        </FlyoutRow>
      ))}
    </Menu>
  );
};
