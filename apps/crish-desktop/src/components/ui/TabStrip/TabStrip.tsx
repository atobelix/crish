/**
 * ui/TabStrip 原子标签条（T-C 批次 5.2 · T12）
 *
 * 蓝本：UnitSessionTabStrip（S4.5 a11y 完整实现），提炼为通用受控标签条：
 * - role=tablist/tab + aria-selected + roving tabindex + Arrow/Home/End 键盘漫游，
 *   Enter/Space 激活、Delete/Backspace 关闭（可关闭项）；
 * - 溢出 fade：滚动容器读 data-overflow-start/end（消费方 CSS 接线渐变）；
 * - 受控 items 协议：tabs/activeId/onActiveChange/onClose；
 * - renderTab 插槽：关闭钮/badge/拖拽手柄/图标由消费方定制；
 * - leading/trailing 插槽：滚动容器内、标签前/后（新建按钮、收起按钮等）；
 * - onTabPointerDown：拖拽入口（消费方提供拖拽算法，基座只给插槽位）。
 *
 * 扩展点：
 * - 新增能力先问「是否有 2 个消费点」再扩 prop（原则二）；
 * - className 覆盖只允许布局类；颜色语义归 tokens。
 *
 * 不支持的场景：
 * - 垂直 tab/侧边导航：另行组件（本基座 aria-orientation 恒为 horizontal）；
 * - tab 内嵌复杂工具栏：组合而非扩 prop；
 * - 拖拽领域算法：域内 hook（useTopBarDrag 等），基座只提供 onTabPointerDown 插槽；
 * - 上下文菜单：业务封装层组合（如 PaneHeader 的会话菜单）。
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ResizeObserverManager } from '../../../utils/ResizeObserverManager';
import styles from './TabStrip.module.css';

export interface TabStripItem {
  /** 稳定唯一 id（激活/关闭回调载荷） */
  id: string;
  /** 标签展示文案 */
  label: string;
  /** 可关闭：Delete/Backspace 键盘关闭判定（onClose 存在时默认可关） */
  closable?: boolean;
  /** per-tab 自定义数据属性（data-* 透传：业务埋点/测试定位） */
  data?: Record<string, string | boolean | number | undefined>;
  /** per-tab 额外类名（如置顶态 is-pinned 等状态类） */
  className?: string;
}

export interface TabStripRenderCtx {
  /** 当前 tab 是否为激活项 */
  active: boolean;
}

export interface TabStripAppearance {
  /** tablist 无障碍名（aria-label） */
  ariaLabel?: string;
  /** 外层 wrap 类（滚动容器之外；承载 data-overflow-* 渐变接线） */
  className?: string;
  /** 滚动容器（role=tablist）类 */
  scrollClassName?: string;
  /** tab 元素基础类（消费方形态样式） */
  tabClassName?: string;
  /** tab 元素激活态追加类 */
  tabActiveClassName?: string;
  /** wrap 层自定义数据属性 */
  data?: Record<string, string | boolean | number | undefined>;
  /** wrap 层语义角色（如 navigation 包裹场景，PaneHeader） */
  wrapRole?: string;
  /** wrap 层无障碍名（与 wrapRole 搭配） */
  wrapAriaLabel?: string;
}

export interface TabStripSlots {
  /** tab 内容插槽（关闭钮/badge/图标；缺省渲染 label 文本） */
  renderTab?: (
    tab: TabStripItem,
    index: number,
    ctx: TabStripRenderCtx
  ) => React.ReactNode;
  /** 滚动容器内、标签之前的内容（如收起按钮） */
  leading?: React.ReactNode;
  /** 滚动容器内、标签之后的内容（如新建加号按钮） */
  trailing?: React.ReactNode;
  /** wrap 内、滚动容器之后的内容（如多 unit 内联工具条） */
  wrapTrailing?: React.ReactNode;
  /** tab 指针按下回调（拖拽入口；消费方提供拖拽算法） */
  onTabPointerDown?: (id: string, e: React.PointerEvent) => void;
}

export interface TabStripProps {
  /** 标签数据模型（受控 items 协议） */
  tabs: TabStripItem[];
  /** 激活项 id；null = 无激活（如草稿态不点亮任何标签） */
  activeId: string | null;
  /** 激活变更回调（点击 / Enter / Space / 方向键激活均经此上报） */
  onActiveChange: (id: string) => void;
  /** 关闭回调（关闭钮 / Delete / Backspace）；缺省 = 标签不可关 */
  onClose?: (id: string, e: React.MouseEvent | React.KeyboardEvent) => void;
  /** 外观与无障碍属性组（类名/aria/data/role） */
  appearance?: TabStripAppearance;
  /** 插槽组（renderTab/leading/trailing/wrapTrailing/拖拽入口） */
  slots?: TabStripSlots;
}

/** 读滚动容器溢出边（S4.5 data-overflow-* 契约） */
export function readStripOverflow(el: HTMLElement): {
  start: boolean;
  end: boolean;
} {
  const maxScroll = el.scrollWidth - el.clientWidth;
  if (maxScroll <= 1) {
    return { start: false, end: false };
  }
  const left = el.scrollLeft;
  return {
    start: left > 1,
    end: left < maxScroll - 1,
  };
}

function defaultRenderTab(tab: TabStripItem): React.ReactNode {
  return <span className={styles.tabLabel}>{tab.label}</span>;
}

/**
 * 受控标签条：内部只管理 roving tabindex 与溢出状态，数据与激活完全受控。
 */
export const TabStrip: React.FC<TabStripProps> = ({
  tabs,
  activeId,
  onActiveChange,
  onClose,
  appearance,
  slots,
}) => {
  const {
    ariaLabel,
    className,
    scrollClassName,
    tabClassName,
    tabActiveClassName,
    data: wrapData,
    wrapRole,
    wrapAriaLabel,
  } = appearance ?? {};
  const {
    renderTab = defaultRenderTab,
    leading,
    trailing,
    wrapTrailing,
    onTabPointerDown,
  } = slots ?? {};
  // ── roving tabindex（对齐蓝本 S4.5） ──────────────────────
  const [rovingIndex, setRovingIndex] = useState(0);
  const tabElsRef = useRef<Array<HTMLDivElement | null>>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflowStart, setOverflowStart] = useState(false);
  const [overflowEnd, setOverflowEnd] = useState(false);

  const activeIndex = useMemo(() => {
    if (tabs.length === 0) return -1;
    const byId = tabs.findIndex((t) => t.id === activeId);
    return byId;
  }, [tabs, activeId]);

  // 活动 tab 变化时把 roving 锚到活动项（列表变短时钳制）
  useEffect(() => {
    if (tabs.length === 0) {
      setRovingIndex(0);
      return;
    }
    const next =
      activeIndex >= 0
        ? Math.min(activeIndex, tabs.length - 1)
        : Math.min(rovingIndex, tabs.length - 1);
    setRovingIndex(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rovingIndex 由本效应自洽写入，纳入依赖会引入无意义二次收敛
  }, [tabs.length, activeIndex]);

  const focusTabAt = useCallback(
    (index: number, activate: boolean) => {
      if (tabs.length === 0) return;
      const i = Math.max(0, Math.min(index, tabs.length - 1));
      setRovingIndex(i);
      const el = tabElsRef.current[i];
      if (el) {
        try {
          el.focus({ preventScroll: false });
        } catch {
          /* jsdom / 不可聚焦节点 */
        }
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
      }
      if (activate) {
        const tab = tabs[i];
        if (tab) onActiveChange(tab.id);
      }
    },
    [tabs, onActiveChange]
  );

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const n = tabs.length;
      if (n === 0) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          e.preventDefault();
          focusTabAt((index + 1) % n, true);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          e.preventDefault();
          focusTabAt((index - 1 + n) % n, true);
          break;
        case 'Home':
          e.preventDefault();
          focusTabAt(0, true);
          break;
        case 'End':
          e.preventDefault();
          focusTabAt(n - 1, true);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          {
            const tab = tabs[index];
            if (tab) onActiveChange(tab.id);
          }
          break;
        case 'Delete':
        case 'Backspace':
          {
            const tab = tabs[index];
            if (tab && tab.closable !== false && onClose) {
              e.preventDefault();
              onClose(tab.id, e);
            }
          }
          break;
        default:
          break;
      }
    },
    [tabs, focusTabAt, onActiveChange, onClose]
  );

  // ── 溢出 fade（对齐蓝本 data-overflow-* 接线） ─────────────
  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setOverflowStart(false);
      setOverflowEnd(false);
      return;
    }
    const { start, end } = readStripOverflow(el);
    setOverflowStart((prev) => (prev === start ? prev : start));
    setOverflowEnd((prev) => (prev === end ? prev : end));
  }, []);

  useLayoutEffect(() => {
    updateOverflow();
  }, [tabs.length, tabs, updateOverflow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    el.addEventListener('scroll', updateOverflow, { passive: true });
    const ro = ResizeObserverManager.getInstance();
    ro.observe(el, updateOverflow);

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY && !e.deltaX) {
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      el.removeEventListener('scroll', updateOverflow);
      el.removeEventListener('wheel', onWheel);
      ro.unobserve(el, updateOverflow);
    };
  }, [updateOverflow, tabs.length]);

  return (
    <div
      className={className}
      role={wrapRole}
      aria-label={wrapAriaLabel}
      data-overflow-start={overflowStart ? 'true' : undefined}
      data-overflow-end={overflowEnd ? 'true' : undefined}
      {...wrapData}
    >
      <div
        ref={scrollRef}
        className={scrollClassName}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
      >
        {leading}
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const isRovingStop = index === rovingIndex;
          const tabClasses = [
            tabClassName,
            active ? tabActiveClassName : null,
            tab.className,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={tab.id}
              ref={(node) => {
                tabElsRef.current[index] = node;
              }}
              role="tab"
              aria-selected={active}
              tabIndex={isRovingStop ? 0 : -1}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
              onFocus={() => setRovingIndex(index)}
              onClick={(e) => {
                const t = e.target as HTMLElement | null;
                if (t?.closest?.('[data-tab-close]')) return;
                onActiveChange(tab.id);
              }}
              onPointerDown={
                onTabPointerDown
                  ? (e) => onTabPointerDown(tab.id, e)
                  : undefined
              }
              className={tabClasses || undefined}
              {...tab.data}
            >
              {renderTab(tab, index, { active })}
            </div>
          );
        })}
        {trailing}
      </div>
      {wrapTrailing}
    </div>
  );
};

TabStrip.displayName = 'TabStrip';
