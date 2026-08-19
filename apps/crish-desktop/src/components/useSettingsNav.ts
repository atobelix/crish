/**
 * 设置导航 hook：搜索过滤 + roving tablist 键盘漫游 + Esc 经 LayerStack
 * （栈顶下拉 → 清空搜索 → 关闭设置）+ `/` 与 Ctrl+F 聚焦搜索框快捷键。
 * 从 SettingsPanel.tsx 抽出；选中动作 selectTab 由壳层注入（联动 store 与焦点）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDemoMode } from '../api/appMode';
import {
  allowedTabIds,
  tabMatchesQuery,
  TAB_META,
  type TabType,
} from './settingsTabsMeta';

export type UseSettingsNavOptions = {
  mcpAvailable: boolean;
  /** 当前合法 tab（resolveTab 后）；用于过滤后 roving 焦点回落 */
  safeActiveTab: TabType;
  onClose?: () => void;
  /** rules 弹窗打开时 Esc / 快捷键全部让位 */
  rulesModalOpen: boolean;
  /** 选中 tab（壳层实现：写 store + 可选焦点移动） */
  selectTab: (tab: TabType, opts?: { focusTab?: boolean; focusPanel?: boolean }) => void;
  /** roving 焦点状态（壳层持有；selectTab / onFocusTab 写入） */
  navFocusId: TabType | null;
};

export type UseSettingsNavResult = {
  navQuery: string;
  setNavQuery: (v: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** 过滤后可见 tabs（搜索 + demoOnly + 白名单） */
  visibleTabs: typeof TAB_META;
  /** roving 焦点 id：优先 navFocusId，其次当前页，最后首项 */
  rovingId: TabType;
  /** 侧栏 tablist 方向键漫游 + Home/End */
  onTablistKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** 搜索框 ↓ 首项 / Enter 聚焦面板 */
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** 读屏播报文案：无匹配 / 找到 N 项 / 当前页 */
  filterStatusText: string;
  /**
   * 交给 Dialog/LayerStack 的 Esc：仅在本层成为栈顶时调用。
   * 先清搜索，再关设置；子层（Menu/规则弹层）由 LayerStack 先退。
   */
  handleSettingsEscape: (event: KeyboardEvent) => boolean;
};

export function useSettingsNav(opts: UseSettingsNavOptions): UseSettingsNavResult {
  const { mcpAvailable, safeActiveTab, onClose, rulesModalOpen, selectTab, navFocusId } = opts;
  const [navQuery, setNavQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Esc 不再 window 捕获关整页：由 LayerStack 先退栈顶，再到本钩子
  const handleSettingsEscape = useCallback(
    (e: KeyboardEvent): boolean => {
      if (rulesModalOpen) return true;
      if (navQuery.trim()) {
        e.preventDefault();
        setNavQuery('');
        searchInputRef.current?.focus();
        return true;
      }
      if (!onClose) return false;
      e.preventDefault();
      onClose();
      return true;
    },
    [onClose, rulesModalOpen, navQuery],
  );

  // / or Ctrl+F focuses sidebar search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (rulesModalOpen) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      ) {
        return;
      }
      const isFind = (e.key === 'f' || e.key === 'F') && (e.ctrlKey || e.metaKey);
      const isSlash = e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!isFind && !isSlash) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rulesModalOpen]);

  const visibleTabs = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    return TAB_META.filter((t) => {
      if (t.demoOnly && !isDemoMode()) return false;
      if (!(allowedTabIds(mcpAvailable) as string[]).includes(t.id)) return false;
      return tabMatchesQuery(t, q);
    });
  }, [navQuery, mcpAvailable]);

  // 过滤后若当前页不可见：仍保留内容，但 roving 焦点落到首项
  const rovingId: TabType =
    (navFocusId && visibleTabs.some((t) => t.id === navFocusId) && navFocusId) ||
    (visibleTabs.some((t) => t.id === safeActiveTab)
      ? safeActiveTab
      : visibleTabs[0]?.id) ||
    safeActiveTab;

  /** 侧栏 tablist：方向键漫游 + Home/End；Enter/Space 由 button 原生激活 */
  const onTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (visibleTabs.length === 0) return;
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(e.key)) return;

      const ids = visibleTabs.map((t) => t.id);
      const activeEl = document.activeElement as HTMLElement | null;
      const focusedId = (activeEl?.getAttribute?.('data-settings-tab-id') || '') as TabType | '';
      let idx = focusedId ? ids.indexOf(focusedId) : -1;
      if (idx < 0) {
        idx = ids.indexOf(rovingId);
        if (idx < 0) idx = 0;
      }

      let next = idx;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        next = (idx + 1) % ids.length;
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        next = (idx - 1 + ids.length) % ids.length;
      } else if (e.key === 'Home') {
        next = 0;
      } else if (e.key === 'End') {
        next = ids.length - 1;
      }
      e.preventDefault();
      const nextId = ids[next]!;
      // 方向键：移动焦点并选中（设置页切换应即时可见）
      selectTab(nextId, { focusTab: true });
    },
    [visibleTabs, rovingId, selectTab],
  );

  const onSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown' && visibleTabs.length > 0) {
        e.preventDefault();
        const first = visibleTabs[0]!.id;
        selectTab(first, { focusTab: true });
        return;
      }
      if (e.key === 'Enter' && visibleTabs.length > 0) {
        e.preventDefault();
        const hit =
          visibleTabs.find((t) => t.id === safeActiveTab)?.id ?? visibleTabs[0]!.id;
        selectTab(hit, { focusPanel: true });
      }
    },
    [visibleTabs, safeActiveTab, selectTab],
  );

  const activeLabel =
    TAB_META.find((t) => t.id === safeActiveTab)?.label || '设置';
  const filterStatusText =
    navQuery.trim().length > 0
      ? visibleTabs.length === 0
        ? '无匹配设置项'
        : `找到 ${visibleTabs.length} 个设置项，当前「${activeLabel}」`
      : `设置 · ${activeLabel}`;

  return {
    navQuery,
    setNavQuery,
    searchInputRef,
    visibleTabs,
    rovingId,
    onTablistKeyDown,
    onSearchKeyDown,
    filterStatusText,
    handleSettingsEscape,
  };
}
