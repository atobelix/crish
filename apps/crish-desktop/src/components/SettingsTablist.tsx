/**
 * 设置侧栏导航：返回按钮 + 搜索框 + roving tablist（方向键/Home/End 由
 * useSettingsNav 提供）+ 过滤空态 + 读屏状态播报。
 * 纯渲染：一切键盘/过滤状态由 useSettingsNav 注入。
 */
import React from 'react';

import styles from './settings/SettingsPanel.module.css';
import { Button, Input, Tooltip } from './ui';
import type { TabMeta, TabType } from './settingsTabsMeta';
import { AppIcon } from './ui/icons/index';

export interface SettingsTablistAria {
  baseId: string;
  tablistId: string;
  searchId: string;
  statusId: string;
  panelId: string;
  tablistRef: React.RefObject<HTMLDivElement | null>;
}

export interface SettingsTablistSearch {
  searchQuery: string;
  filterStatusText: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (q: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export type SettingsTablistProps = {
  items: TabMeta[];
  activeId: TabType;
  rovingId: TabType;
  onBack?: () => void;
  onTablistKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (
    tab: TabType,
    opts?: { focusTab?: boolean; focusPanel?: boolean }
  ) => void;
  onFocusTab: (tab: TabType) => void;
  /** aria/id/DOM 引用组 */
  aria: SettingsTablistAria;
  /** 搜索相关组 */
  search: SettingsTablistSearch;
};

export const SettingsTablist: React.FC<SettingsTablistProps> = ({
  items,
  activeId,
  rovingId,
  onBack,
  onTablistKeyDown,
  onSelect,
  onFocusTab,
  aria,
  search,
}) => {
  const {
    baseId,
    tablistId,
    searchId,
    statusId,
    panelId,
    tablistRef,
  } = aria;
  const {
    searchQuery,
    filterStatusText,
    searchInputRef,
    onSearchChange,
    onSearchKeyDown,
  } = search;
  return (
    <nav
      className={styles.coverNav}
      aria-label="设置导航"
      data-density="compact"
    >
      {onBack ? (
        <Tooltip content="返回应用 (Esc)">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`${styles.navBack} no-drag`}
            onClick={onBack}
            aria-label="返回应用，关闭设置"
            icon={<AppIcon name="arrow-left" size={16} aria-hidden />}
          >
            返回应用
          </Button>
        </Tooltip>
      ) : null}

      <div className={styles.searchWrap}>
        <AppIcon name="search" size={14}
          className={styles.searchIco}
          aria-hidden />
        <Input
          bare
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
          const iconName = tab.icon;
          const showGroup = idx === 0 || arr[idx - 1]?.group !== tab.group;
          const tabBtnId = `${baseId}-tab-${tab.id}`;

          return (
            <React.Fragment key={tab.id}>
              {showGroup ? (
                <div
                  className={styles.navGroup}
                  role="presentation"
                  aria-hidden="true"
                >
                  {tab.group}
                </div>
              ) : null}
              <Tooltip content={tab.keywords.slice(0, 4).join(' · ')}>
                <Button
                  variant="ghost"
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
                    <AppIcon name={iconName} size={16} aria-hidden />
                  </span>
                  <span>{tab.label}</span>
                </Button>
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
