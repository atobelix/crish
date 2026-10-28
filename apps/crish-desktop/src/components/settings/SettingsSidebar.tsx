import React, { useRef, useState, useEffect, useCallback } from 'react';

import styles from './SettingsPanel.module.css';
import { Button, Input, Tooltip } from '@/components/ui';
import type { TabMeta, TabType } from '../settingsTabsMeta';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

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
  /** 指针移入侧栏通知（用于分区分离滚动条悬停感知） */
  onPointerEnter?: () => void;
}

export function getTabLabel(
  tab: TabMeta,
  tOrLegacy?: boolean | ((key: string, fallback?: string) => string),
  maybeT?: (key: string, fallback?: string) => string
): string {
  const translateFn = typeof tOrLegacy === 'function' ? tOrLegacy : maybeT;
  if (translateFn) {
    return translateFn(`settings.tabs.${tab.id}`, tab.label);
  }
  return tab.label;
}

export function getGroupLabel(
  group: string,
  tabId: string,
  tOrLegacy?: boolean | ((key: string, fallback?: string) => string),
  maybeT?: (key: string, fallback?: string) => string
): string {
  const translateFn = typeof tOrLegacy === 'function' ? tOrLegacy : maybeT;
  if (translateFn) {
    return translateFn(`settings.groups.${tabId}`, group);
  }
  return group;
}

interface SidebarTabItemProps {
  tab: TabMeta;
  tabLabel: string;
  isTabActive: boolean;
  isRoving: boolean;
  tabBtnId: string;
  panelId: string;
  groupLabel: string;
  onSelect: (id: TabType) => void;
  onFocusTab: (id: TabType) => void;
}

const SidebarTabItem: React.FC<SidebarTabItemProps> = ({
  tab,
  tabLabel,
  isTabActive,
  isRoving,
  tabBtnId,
  panelId,
  groupLabel,
  onSelect,
  onFocusTab,
}) => {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const checkTruncation = useCallback(() => {
    const el = labelRef.current;
    if (el) {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
  }, []);

  useEffect(() => {
    checkTruncation();
  }, [tabLabel, checkTruncation]);

  const buttonElement = (
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
      aria-label={`${groupLabel} · ${tabLabel}`}
      onClick={() => onSelect(tab.id)}
      onFocus={() => onFocusTab(tab.id)}
      onPointerEnter={checkTruncation}
      className={`${styles.sidebarTab} ${isTabActive ? styles.active : ''}`}
    >
      <span className={styles.sidebarTabIco} aria-hidden>
        <AppIcon name={tab.icon} size={16} aria-hidden />
      </span>
      <span ref={labelRef} className={styles.sidebarTabLabel}>
        {tabLabel}
      </span>
    </Button>
  );

  return (
    <Tooltip content={tabLabel} disabled={!isTruncated} delayShow={300}>
      {buttonElement}
    </Tooltip>
  );
};

export const SettingsSidebar: React.FC<SettingsSidebarProps> = React.memo(
  ({
    items,
    activeId,
    rovingId,
    onTablistKeyDown,
    onSelect,
    onFocusTab,
    aria,
    search,
    onPointerEnter,
  }) => {
    const { t } = useI18n();

    const { baseId, tablistId, searchId, statusId, panelId, tablistRef } = aria;
    const {
      searchQuery,
      filterStatusText,
      searchInputRef,
      onSearchChange,
      onSearchKeyDown,
    } = search;

    return (
      <nav
        className={styles.settingsNav}
        aria-label={t('workspace.settingsNav', '设置导航')}
        data-testid="settings-sidebar"
        data-settings-nav="true"
        data-scrollbar-hover-host="nav"
        onPointerEnter={onPointerEnter}
      >
        <div className={styles.sidebarTopActions}>
          <div
            className={styles.searchWrap}
            role="search"
            aria-label={t('settings.frame.searchAria', '设置搜索')}
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
              placeholder={t('settings.frame.searchPlaceholder', '搜索设置…')}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={onSearchKeyDown}
              aria-label={t('settings.sidebar.searchCategoriesAria')}
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
                aria-label={t('settings.frame.clearSearch', '清空搜索')}
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
          data-nav-scroll="true"
          data-scrollbar-visibility="hover"
          role="tablist"
          aria-label={t('settings.nav.categories', '设置分类')}
          aria-orientation="vertical"
          onKeyDown={onTablistKeyDown}
        >
          {items.map((tab, idx, arr) => {
            const isTabActive = activeId === tab.id;
            const isRoving = rovingId === tab.id;
            const showGroup = idx === 0 || arr[idx - 1]?.group !== tab.group;
            const tabBtnId = `${baseId}-tab-${tab.id}`;
            const tabLabel = getTabLabel(tab, t);
            const groupLabel = getGroupLabel(tab.group, tab.id, t);

            return (
              <React.Fragment key={tab.id}>
                {showGroup ? (
                  <div
                    className={styles.navGroup}
                    role="presentation"
                    aria-hidden="true"
                  >
                    {groupLabel}
                  </div>
                ) : null}
                <SidebarTabItem
                  tab={tab}
                  tabLabel={tabLabel}
                  isTabActive={isTabActive}
                  isRoving={isRoving}
                  tabBtnId={tabBtnId}
                  panelId={panelId}
                  groupLabel={groupLabel}
                  onSelect={onSelect}
                  onFocusTab={onFocusTab}
                />
              </React.Fragment>
            );
          })}
          {items.length === 0 ? (
            <div className={styles.navEmpty} role="status">
              {t('settings.frame.emptyResult', '未找到匹配项')}
            </div>
          ) : null}
        </div>

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
