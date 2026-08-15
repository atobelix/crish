import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './SettingsPanel.module.css';
import { Button, Tooltip } from '../ui';
import type { TabMeta, TabType } from '../settingsTabsMeta';

export interface SettingsSidebarProps {
  baseId: string;
  items: TabMeta[];
  activeId: TabType;
  rovingId: TabType;
  tablistId: string;
  searchId: string;
  statusId: string;
  panelId: string;
  searchQuery: string;
  filterStatusText: string;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  tablistRef: React.RefObject<HTMLDivElement | null>;
  onBack?: () => void;
  onSearchChange: (q: string) => void;
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onTablistKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (
    tab: TabType,
    opts?: { focusTab?: boolean; focusPanel?: boolean }
  ) => void;
  onFocusTab: (tab: TabType) => void;
}

export const SettingsSidebar: React.FC<SettingsSidebarProps> = React.memo(
  ({
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
      <nav
        className={styles.coverNav}
        aria-label="设置导航"
        data-density="compact"
        data-testid="settings-sidebar"
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
              icon={
                <Lucide.ArrowLeft size={16} strokeWidth={1.75} aria-hidden />
              }
            >
              返回应用
            </Button>
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
                  <div
                    className={styles.navGroup}
                    role="presentation"
                    aria-hidden="true"
                  >
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

        {/* 读屏播报当前页 / 筛选结果（视觉隐藏） */}
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
  }
);

SettingsSidebar.displayName = 'SettingsSidebar';
