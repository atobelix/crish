import React from 'react';

import styles from './SettingsPanel.module.css';
import { Button, Input, Tooltip } from '../ui';
import type { TabMeta, TabType } from '../settingsTabsMeta';
import { SidebarFooter } from '../sidebar/SidebarFooter';
import { AppIcon } from '../ui/icons/index';

export interface SettingsSidebarAria {
  baseId: string;
  tablistId: string;
  searchId: string;
  statusId: string;
  panelId: string;
  tablistRef: React.RefObject<HTMLDivElement | null>;
}

export interface SettingsSidebarSearch {
  searchQuery: string;
  filterStatusText: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (q: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export interface SettingsSidebarProps {
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
  /** aria/id/DOM 引用组（baseId/tablistId/searchId/statusId/panelId/tablistRef） */
  aria: SettingsSidebarAria;
  /** 搜索相关组（query/filterStatusText/ref/change/keyDown） */
  search: SettingsSidebarSearch;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = React.memo(
  ({
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
        data-testid="settings-sidebar"
      >
        <div className={styles.sidebarTopActions}>
          {onBack ? (
            <Tooltip content="返回应用 (Esc)">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.sidebarBackBtn} no-drag`}
                onClick={onBack}
                aria-label="返回应用，关闭设置"
                icon={
                  <AppIcon name="arrow-left" size={16} aria-hidden />
                }
              >
                返回应用
              </Button>
            </Tooltip>
          ) : null}

          <div
            className={`${styles.searchWrap} no-drag`}
            role="search"
            aria-label="设置搜索"
            onClick={() => searchInputRef.current?.focus()}
          >
            <span className={styles.searchIco} aria-hidden="true">
              <AppIcon name="search" size={16} />
            </span>
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
            {searchQuery ? (
              <Button
                bare
                type="button"
                className={styles.searchClear}
                onClick={(e) => {
                  e.stopPropagation();
                  onSearchChange('');
                  searchInputRef.current?.focus();
                }}
                aria-label="清空搜索"
              >
                <AppIcon name="x" size={12} />
              </Button>
            ) : null}
          </div>
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
                    bare
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

        {/* 侧栏底栏：左列 UserProfileCard + 右列 SettingsIconButton */}
        <SidebarFooter />

        {/* 读屏播报当前页 / 筛选结果（视觉隐藏） */}
        <div
          id={statusId}
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {filterStatusText}
        </div>
      </nav>
    );
  }
);

SettingsSidebar.displayName = 'SettingsSidebar';
