/**
 * 设置侧栏导航：返回按钮 + 搜索框 + roving tablist（方向键/Home/End 由
 * useSettingsNav 提供）+ 过滤空态 + 读屏状态播报。
 * 纯渲染：一切键盘/过滤状态由 useSettingsNav 注入。
 */
import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './settings/SettingsPanel.module.css';
import { Tooltip } from './Tooltip';
import type { TabMeta, TabType } from './settingsTabsMeta';

export type SettingsTablistProps = {
  /** tab 按钮 id 前缀（useId 生成，防重复） */
  baseId: string;
  items: TabMeta[];
  activeId: TabType;
  rovingId: TabType;
  tablistId: string;
  searchId: string;
  statusId: string;
  /** 当前页 panel id（aria-controls 仅活跃 tab 挂） */
  panelId: string;
  searchQuery: string;
  filterStatusText: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  /** tablist DOM 容器（壳层 selectTab 的 focusTab 定位用） */
  tablistRef: React.RefObject<HTMLDivElement | null>;
  onBack?: () => void;
  onSearchChange: (q: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onTablistKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (tab: TabType, opts?: { focusTab?: boolean; focusPanel?: boolean }) => void;
  onFocusTab: (tab: TabType) => void;
};

export const SettingsTablist: React.FC<SettingsTablistProps> = ({
  baseId,
  items,
  activeId,
  rovingId,
  tablistId,
  searchId,
  statusId,
  panelId,
  searchQuery,
  filterStatusText,
  searchInputRef,
  tablistRef,
  onBack,
  onSearchChange,
  onSearchKeyDown,
  onTablistKeyDown,
  onSelect,
  onFocusTab,
}) => {
  return (
    <nav className={styles.coverNav} aria-label="设置导航" data-density="compact">
      {onBack ? (
        <Tooltip content="返回应用 (Esc)">
          <button
            type="button"
            className={`${styles.navBack} no-drag`}
            onClick={onBack}
            aria-label="返回应用，关闭设置"
          >
            <Lucide.ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
            <span>返回应用</span>
          </button>
        </Tooltip>
      ) : null}

      <div className={styles.searchWrap}>
        <Lucide.Search
          size={14}
          strokeWidth={1.75}
          className={styles.searchIco}
          aria-hidden
        />
        <input
          ref={searchInputRef}
          id={searchId}
          type="search"
          className={styles.search}
          placeholder="搜索设置…"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="搜索设置分类"
          aria-controls={tablistId}
          aria-describedby={statusId}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
      </div>

      <div
        id={tablistId}
        ref={tablistRef}
        className={styles.navScroll}
        role="tablist"
        aria-label="设置分类"
        aria-orientation="vertical"
        onKeyDown={onTablistKeyDown}
      >
        {items.map((tab, idx, arr) => {
          const isTabActive = activeId === tab.id;
          const isRoving = rovingId === tab.id;
          const Icon = tab.icon;
          const showGroup = idx === 0 || arr[idx - 1]?.group !== tab.group;
          const tabBtnId = `${baseId}-tab-${tab.id}`;

          return (
            <React.Fragment key={tab.id}>
              {showGroup ? (
                <div className={styles.navGroup} role="presentation" aria-hidden="true">
                  {tab.group}
                </div>
              ) : null}
              <Tooltip content={tab.keywords.slice(0, 4).join(' · ')}>
                <button
                  type="button"
                  id={tabBtnId}
                  role="tab"
                  data-testid={`settings-tab-${tab.id}`}
                  data-settings-tab-id={tab.id}
                  aria-selected={isTabActive}
                  aria-controls={isTabActive ? panelId : undefined}
                  tabIndex={isRoving ? 0 : -1}
                  aria-label={`${tab.group} · ${tab.label}`}
                  onClick={() => onSelect(tab.id)}
                  onFocus={() => onFocusTab(tab.id)}
                  className={`${styles.sidebarTab} ${isTabActive ? styles.active : ''}`}
                >
                  <span className={styles.sidebarTabIco} aria-hidden>
                    <Icon size={16} strokeWidth={1.75} />
                  </span>
                  <span>{tab.label}</span>
                </button>
              </Tooltip>
            </React.Fragment>
          );
        })}
        {items.length === 0 ? (
          <div className={styles.navEmpty} role="status">
            无匹配项
          </div>
        ) : null}
      </div>

      {/* 读屏播报当前页 / 筛选结果（视觉隐藏，不依赖 settings.css） */}
      <div
        id={statusId}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {filterStatusText}
      </div>
    </nav>
  );
};
