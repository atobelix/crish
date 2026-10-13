import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { Button, Menu } from '../ui';
import styles from './SidebarContextMenus.module.css';
import { AppIcon } from '../ui/icons/index';

type FlyKey = 'sort' | 'group' | 'filter' | null;

const FLY_ORDER: NonNullable<FlyKey>[] = ['sort', 'group', 'filter'];

/** 排序下拉 flyout 行（sort/group/filter 三行同构基件） */
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
    setFlipLeft(rowRect.right + flyoutWidth + 10 > window.innerWidth - 8);
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

/** flyout 单选选项（role=menuitemradio + Check 勾选） */
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

/**
 * 排序/分组/过滤下拉（ui/Menu 基座 + 自研 flyout 状态机）。
 * flyout 状态机 + 键盘漫游（ArrowRight/ArrowLeft/ArrowUp/ArrowDown/Esc）+ 宽限期关闭语义
 * 全部内聚于本基件（03-detail T10 拆分）。
 */
export const ContextMenuFlyout: React.FC<{
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
}> = ({
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

  // F7-F12：flyout 关闭语义——鼠标移出行/飞层后经宽限期关闭；
  // 宽限期内移入飞层内部（onMouseEnter 取消）不误关
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

  // F7-F12：flyout/入口行 DOM 引用
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

  // F7-F12：ArrowRight/Enter/Space 打开 flyout 并聚焦首项；ArrowUp/ArrowDown 在父行间导航
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

  const sortDropdownRestoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!sortDropdownOpen) return;
    sortDropdownRestoreRef.current =
      document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const first =
        rowRefs.current.sort ??
        sortMenuRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
      first?.focus();
    });
  }, [sortDropdownOpen, sortMenuRef]);

  const sortValueLabel = sortType === 'name' ? '按名称' : '按最近活跃';
  const groupValueLabel = groupType === 'none' ? '平铺列表' : '按项目分组';
  const filterValueLabel = filterType === 'pinned' ? '仅置顶' : '全部会话';

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
      <div className={styles.sortFilterMenuTitle} id="sort-filter-title">
        排序与过滤
      </div>

      <FlyoutRow
        type="sort"
        label="排序方式"
        valueLabel={sortValueLabel}
        open={fly === 'sort'}
        flyoutRef={(el) => {
          flyoutRefs.current.sort = el;
        }}
        rowRef={(el) => {
          rowRefs.current.sort = el;
        }}
        onFlyEnter={() => handleFlyEnter('sort')}
        onFlyLeave={() => handleFlyLeave('sort')}
        onFlyClick={() => handleFlyClick('sort')}
        onFlyoutEnter={cancelFlyLeave}
        onFlyoutLeave={() => handleFlyLeave('sort')}
        onRowKeyDown={(e) => handleRowKeyDown('sort', e)}
        onFlyoutKeyDown={(e) => handleFlyoutKeyDown('sort', e)}
      >
        <FlyoutOption
          checked={sortType === 'active'}
          onSelect={() => {
            onSetSortType('active');
            onCloseSortDropdown();
          }}
        >
          按最近活跃
        </FlyoutOption>
        <FlyoutOption
          checked={sortType === 'name'}
          onSelect={() => {
            onSetSortType('name');
            onCloseSortDropdown();
          }}
        >
          按名称
        </FlyoutOption>
      </FlyoutRow>

      <FlyoutRow
        type="group"
        label="分组方式"
        valueLabel={groupValueLabel}
        open={fly === 'group'}
        flyoutRef={(el) => {
          flyoutRefs.current.group = el;
        }}
        rowRef={(el) => {
          rowRefs.current.group = el;
        }}
        onFlyEnter={() => handleFlyEnter('group')}
        onFlyLeave={() => handleFlyLeave('group')}
        onFlyClick={() => handleFlyClick('group')}
        onFlyoutEnter={cancelFlyLeave}
        onFlyoutLeave={() => handleFlyLeave('group')}
        onRowKeyDown={(e) => handleRowKeyDown('group', e)}
        onFlyoutKeyDown={(e) => handleFlyoutKeyDown('group', e)}
      >
        <FlyoutOption
          checked={groupType === 'folder'}
          onSelect={() => {
            onSetGroupType('folder');
            onCloseSortDropdown();
          }}
        >
          按项目分组
        </FlyoutOption>
        <FlyoutOption
          checked={groupType === 'none'}
          onSelect={() => {
            onSetGroupType('none');
            onCloseSortDropdown();
          }}
        >
          平铺列表
        </FlyoutOption>
      </FlyoutRow>

      <FlyoutRow
        type="filter"
        label="列表范围"
        valueLabel={filterValueLabel}
        open={fly === 'filter'}
        flyoutRef={(el) => {
          flyoutRefs.current.filter = el;
        }}
        rowRef={(el) => {
          rowRefs.current.filter = el;
        }}
        onFlyEnter={() => handleFlyEnter('filter')}
        onFlyLeave={() => handleFlyLeave('filter')}
        onFlyClick={() => handleFlyClick('filter')}
        onFlyoutEnter={cancelFlyLeave}
        onFlyoutLeave={() => handleFlyLeave('filter')}
        onRowKeyDown={(e) => handleRowKeyDown('filter', e)}
        onFlyoutKeyDown={(e) => handleFlyoutKeyDown('filter', e)}
      >
        <FlyoutOption
          checked={filterType === 'all'}
          onSelect={() => {
            onSetFilterType('all');
            onCloseSortDropdown();
          }}
        >
          全部会话
        </FlyoutOption>
        <FlyoutOption
          checked={filterType === 'pinned'}
          onSelect={() => {
            onSetFilterType('pinned');
            onCloseSortDropdown();
          }}
        >
          仅置顶
        </FlyoutOption>
      </FlyoutRow>
    </Menu>
  );
};
