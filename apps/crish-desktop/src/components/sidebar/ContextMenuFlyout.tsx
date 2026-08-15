import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { Menu } from '../ui';
import { calculateMenuPosition, measureMenu } from '../ui/Menu/position';
import styles from './SidebarContextMenus.module.css';

type FlyKey = 'sort' | 'group' | 'filter' | null;

/** 排序下拉 flyout 行（sort/group/filter 三行同构基件） */
const FlyoutRow: React.FC<{
  type: NonNullable<FlyKey>;
  label: string;
  open: boolean;
  flyoutRef: (el: HTMLDivElement | null) => void;
  rowRef: (el: HTMLDivElement | null) => void;
  onFlyEnter: () => void;
  onFlyLeave: () => void;
  onFlyoutEnter: () => void;
  onFlyoutLeave: () => void;
  onRowKeyDown: (e: React.KeyboardEvent) => void;
  onFlyoutKeyDown: (e: React.KeyboardEvent) => void;
  children: React.ReactNode;
}> = ({
  type,
  label,
  open,
  flyoutRef,
  rowRef,
  onFlyEnter,
  onFlyLeave,
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
    const flyoutWidth = localFlyoutElRef.current?.offsetWidth || 148;
    const flyoutHeight = localFlyoutElRef.current?.offsetHeight || 100;
    const pos = calculateMenuPosition({
      anchor: {
        x: rowRect.right,
        y: rowRect.top,
        width: rowRect.width,
        height: rowRect.height,
      },
      menu: { width: flyoutWidth, height: flyoutHeight },
      preferredSide: 'right',
      preferredAlign: 'start',
    });
    setFlipLeft(
      pos.isFlippedX || rowRect.right + flyoutWidth > window.innerWidth - 8
    );
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
      onKeyDown={onRowKeyDown}
    >
      <span className={styles.sortFilterRowLabel}>{label}</span>
      <ChevronRight
        size={14}
        strokeWidth={1.75}
        className={styles.sortFilterChev}
        aria-hidden
      />
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
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={`${styles.sortFilterOption} ${checked ? styles.isOn : ''}`}
      onClick={onSelect}
    >
      <span>{children}</span>
      {checked ? (
        <Check
          size={16}
          strokeWidth={2}
          className={styles.sortFilterCheck}
          aria-hidden
        />
      ) : null}
    </button>
  );
};

/**
 * 排序/分组/过滤下拉（ui/Menu 基座 + 自研 flyout 状态机）。
 * flyout 状态机 + 键盘漫游（ArrowRight/ArrowLeft/Esc）+ 宽限期关闭语义
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

  const handleFlyEnter = useCallback((type: FlyKey) => {
    clearTimeout(flyTimerRef.current.leave);
    flyTimerRef.current.enter = window.setTimeout(() => {
      setFly(type);
    }, 80);
  }, []);

  // F7-F12：flyout 关闭语义——鼠标移出行/飞层后经宽限期关闭；
  // 宽限期内移入飞层内部（onMouseEnter 取消）不误关
  const handleFlyLeave = useCallback((type: FlyKey) => {
    clearTimeout(flyTimerRef.current.enter);
    flyTimerRef.current.leave = window.setTimeout(() => {
      setFly((prev) => (prev === type ? null : prev));
    }, 150);
  }, []);

  const cancelFlyLeave = useCallback(() => {
    clearTimeout(flyTimerRef.current.leave);
  }, []);

  // F7-F12：flyout/入口行 DOM 引用（键盘导航焦点落点；sortMenuRef 由
  // 外部持有但未挂载到元素，不可依赖）
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

  // F7-F12：ArrowRight 打开 flyout 并聚焦首项；ArrowLeft/Esc 关闭
  // flyout 并聚焦回入口行（行 role=menuitem + tabIndex=0，键盘可达）
  const handleRowKeyDown = useCallback(
    (type: NonNullable<FlyKey>, e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        setFly(type);
        requestAnimationFrame(() => {
          const first = flyoutRefs.current[type]?.querySelector<HTMLElement>(
            '[role="menuitemradio"]'
          );
          first?.focus();
        });
      }
    },
    []
  );

  const handleFlyoutKeyDown = useCallback(
    (type: NonNullable<FlyKey>, e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setFly(null);
        rowRefs.current[type]?.focus();
      }
    },
    []
  );

  // 排序菜单同样钳位（真实尺寸由基座浮层实测后统一走 position.ts）
  useLayoutEffect(() => {
    if (!sortDropdownOpen || !sortDropdownCoords || !sortMenuRef.current)
      return;
    const el = sortMenuRef.current;
    const next = measureMenu(el, sortDropdownCoords.x, sortDropdownCoords.y);
    el.style.left = `${next.x}px`;
    el.style.top = `${next.y}px`;
    el.style.transformOrigin = next.transformOrigin;
  }, [sortDropdownOpen, sortDropdownCoords, sortMenuRef]);

  const sortDropdownRestoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!sortDropdownOpen || !sortMenuRef.current) return;
    sortDropdownRestoreRef.current =
      document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const first = sortMenuRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    });
  }, [sortDropdownOpen, sortMenuRef]);

  useEffect(() => {
    if (!sortDropdownOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // F7-F12：flyout 展开时 Esc 只关 flyout（不关整个排序菜单），
        // 并聚焦回入口行
        if (fly !== null) {
          e.stopImmediatePropagation();
          setFly(null);
          rowRefs.current[fly]?.focus();
          return;
        }
        e.stopPropagation();
        onCloseSortDropdown();
        const target =
          sortTriggerRef?.current || sortDropdownRestoreRef.current;
        requestAnimationFrame(() => target?.focus());
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [sortDropdownOpen, onCloseSortDropdown, sortTriggerRef, sortMenuRef, fly]);

  if (!sortDropdownOpen) return null;

  return (
    <Menu
      open={sortDropdownOpen}
      onOpenChange={(open) => {
        if (!open) onCloseSortDropdown();
      }}
      anchor={sortTriggerRef}
      align="start"
      side="bottom"
      sideOffset={4}
      contentClassName={`${styles.sortFilterMenu} ${styles.open} no-drag`}
      contentStyle={
        !sortTriggerRef?.current && sortDropdownCoords
          ? {
              position: 'fixed',
              left: sortDropdownCoords.x,
              top: sortDropdownCoords.y,
            }
          : undefined
      }
    >
      <div className={styles.sortFilterMenuTitle} id="sort-filter-title">
        排序与过滤
      </div>

      <FlyoutRow
        type="sort"
        label="排序方式"
        open={fly === 'sort'}
        flyoutRef={(el) => {
          flyoutRefs.current.sort = el;
        }}
        rowRef={(el) => {
          rowRefs.current.sort = el;
        }}
        onFlyEnter={() => handleFlyEnter('sort')}
        onFlyLeave={() => handleFlyLeave('sort')}
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
        open={fly === 'group'}
        flyoutRef={(el) => {
          flyoutRefs.current.group = el;
        }}
        rowRef={(el) => {
          rowRefs.current.group = el;
        }}
        onFlyEnter={() => handleFlyEnter('group')}
        onFlyLeave={() => handleFlyLeave('group')}
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
        open={fly === 'filter'}
        flyoutRef={(el) => {
          flyoutRefs.current.filter = el;
        }}
        rowRef={(el) => {
          rowRefs.current.filter = el;
        }}
        onFlyEnter={() => handleFlyEnter('filter')}
        onFlyLeave={() => handleFlyLeave('filter')}
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
