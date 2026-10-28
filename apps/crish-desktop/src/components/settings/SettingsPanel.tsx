import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useId,
  lazy,
  Suspense,
} from 'react';
import styles from './SettingsPanel.module.css';
import { useSettingsUiStore } from '../../store/storeAccess';
import {
  getCachedCapabilities,
  refreshProductCapabilities,
} from '../../api/capabilitiesStore';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Button, Dialog, Tooltip } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import {
  normalizeSettingsTabId,
  allowedTabIds,
  type TabType,
} from '../settingsTabsMeta';
import { useSettingsNav } from '../useSettingsNav';
import { SettingsSidebar } from './SettingsSidebar';
import { useI18n } from '../../i18n';

/** 设置 tab 懒加载：按需加载，首屏只加载当前激活 tab */
const ModelsSettingsTab = lazy(() =>
  import('../settings-models/ModelsSettingsTab').then((m) => ({
    default: m.ModelsSettingsTab,
  }))
);
const SettingsScheduleTab = lazy(() =>
  import('./SettingsScheduleTab').then((m) => ({
    default: m.SettingsScheduleTab,
  }))
);
const SettingsRulesTab = lazy(() =>
  import('./SettingsRulesTab').then((m) => ({ default: m.SettingsRulesTab }))
);
const SettingsSecurityTab = lazy(() =>
  import('./SettingsSecurityTab').then((m) => ({
    default: m.SettingsSecurityTab,
  }))
);
const SettingsProfileTab = lazy(() =>
  import('./SettingsProfileTab').then((m) => ({
    default: m.SettingsProfileTab,
  }))
);
const SettingsAppearanceTab = lazy(() =>
  import('./SettingsAppearanceTab').then((m) => ({
    default: m.SettingsAppearanceTab,
  }))
);
const SettingsUsageTab = lazy(() =>
  import('./SettingsUsageTab').then((m) => ({ default: m.SettingsUsageTab }))
);
const SettingsDevicesTab = lazy(() =>
  import('./SettingsDevicesTab').then((m) => ({
    default: m.SettingsDevicesTab,
  }))
);
const SettingsShortcutsTab = lazy(() =>
  import('./SettingsShortcutsTab').then((m) => ({
    default: m.SettingsShortcutsTab,
  }))
);
const SettingsPersonalizeTab = lazy(() =>
  import('./SettingsPersonalizeTab').then((m) => ({
    default: m.SettingsPersonalizeTab,
  }))
);
const SettingsArchiveTab = lazy(() =>
  import('./SettingsArchiveTab').then((m) => ({
    default: m.SettingsArchiveTab,
  }))
);
const SettingsExtensionsTab = lazy(() =>
  import('../settings-extensions/SettingsExtensionsTab').then((m) => ({
    default: m.SettingsExtensionsTab,
  }))
);
const StatusDiagnosticsPanel = lazy(() =>
  import('./StatusDiagnosticsPanel').then((m) => ({
    default: m.StatusDiagnosticsPanel,
  }))
);
const SettingsBrowserTab = lazy(() =>
  import('./SettingsBrowserTab').then((m) => ({
    default: m.SettingsBrowserTab,
  }))
);
const SettingsAboutTab = lazy(() =>
  import('./SettingsAboutTab').then((m) => ({
    default: m.SettingsAboutTab,
  }))
);

type TabComponentProps = {
  onBlockingOverlayChange?: (open: boolean) => void;
  _onBlockingOverlayChange?: (open: boolean) => void;
};

const TAB_COMPONENTS: Record<
  TabType,
  { labelKey: string; Component: React.ComponentType<TabComponentProps> }
> = {
  profile: { labelKey: 'settings.tabs.profile', Component: SettingsProfileTab },
  appearance: {
    labelKey: 'settings.tabs.appearance',
    Component: SettingsAppearanceTab,
  },
  personalize: {
    labelKey: 'settings.tabs.personalize',
    Component: SettingsPersonalizeTab,
  },
  archive: { labelKey: 'settings.tabs.archive', Component: SettingsArchiveTab },
  models: { labelKey: 'settings.tabs.models', Component: ModelsSettingsTab },
  plugins: {
    labelKey: 'settings.tabs.plugins',
    Component: SettingsExtensionsTab,
  },
  skills: {
    labelKey: 'settings.tabs.plugins',
    Component: SettingsExtensionsTab,
  },
  mcp: { labelKey: 'settings.tabs.plugins', Component: SettingsExtensionsTab },
  usage: { labelKey: 'settings.tabs.usage', Component: SettingsUsageTab },
  devices: { labelKey: 'settings.tabs.devices', Component: SettingsDevicesTab },
  schedule: {
    labelKey: 'settings.tabs.schedule',
    Component: SettingsScheduleTab,
  },
  rules: { labelKey: 'settings.tabs.rules', Component: SettingsRulesTab },
  shortcuts: {
    labelKey: 'settings.tabs.shortcuts',
    Component: SettingsShortcutsTab,
  },
  browser: { labelKey: 'settings.tabs.browser', Component: SettingsBrowserTab },
  security: {
    labelKey: 'settings.tabs.security',
    Component: SettingsSecurityTab,
  },
  diagnostics: {
    labelKey: 'settings.tabs.diagnostics',
    Component: StatusDiagnosticsPanel,
  },
  about: { labelKey: 'settings.tabs.about', Component: SettingsAboutTab },
};

/** tab 懒加载占位：与设置页骨架样式一致，避免加载抖动 */
const SettingsTabSuspenseFallback: React.FC<{
  tabName: string;
}> = ({ tabName }) => {
  const { t } = useI18n();
  return (
    <div className="settings-tab-loading" role="status" aria-live="polite">
      <span className="settings-tab-loading-text">
        {t('common.loading')} {tabName}
      </span>
    </div>
  );
};

/** re-export：既有 `from './SettingsPanel'` 消费者保持可用 */
import type { SettingsTabType } from '../../store/types';

export type { SettingsTabType };

interface SettingsPanelProps {
  wsId?: string;
  /** 关闭设置（Esc / 点遮罩 / 标题行 X 收敛于此） */
  onClose: () => void;
  initialTab?: SettingsTabType;
  /** 受控开关：置 false 时先播退场动画，结束后由 Dialog 卸载内容 */
  isOpen: boolean;
}

/**
 * 设置弹窗：ui/Dialog 居中模态 + 左侧导航（SettingsSidebar）+ 顶部标题行（设置 / 当前分类 + 关闭）
 * + 内容区（懒加载 Suspense 分支）。不含窗口按钮与拖拽区：窗口按钮只有主顶栏一组。
 */
export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  wsId: _wsId,
  onClose,
  initialTab,
}) => {
  const { t } = useI18n();

  const storeTab = useSettingsUiStore((s) => s.settingsActiveTab);
  const setSettingsActiveTab = useSettingsUiStore(
    (s) => s.setSettingsActiveTab
  );
  const [mcpAvailable, setMcpAvailable] = useState(false);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [navFocusId, setNavFocusId] = useState<TabType | null>(null);
  const [hoverPane, setHoverPane] = useState<'nav' | 'main' | null>(null);

  const handleShellPointerOver = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(`.${styles.settingsNav}`)) {
        setHoverPane((prev) => (prev === 'nav' ? prev : 'nav'));
      } else if (target.closest(`.${styles.settingsMain}`)) {
        setHoverPane((prev) => (prev === 'main' ? prev : 'main'));
      }
    },
    []
  );

  const baseId = useId();
  const tablistId = `${baseId}-tablist`;
  const searchId = `${baseId}-search`;
  const statusId = `${baseId}-status`;

  const rootRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);

  const resolveTab = useCallback(
    (raw?: string | null): TabType => {
      const n = normalizeSettingsTabId(raw ?? undefined);
      if (n) return n;
      if (raw && (allowedTabIds(mcpAvailable) as string[]).includes(raw))
        return raw as TabType;
      return 'profile';
    },
    [mcpAvailable]
  );

  const [activeTab, setActiveTab] = useState<TabType>(() =>
    resolveTab(initialTab || storeTab)
  );

  // Deep-link: follow store when settings open with a target tab
  useEffect(() => {
    setActiveTab(resolveTab(initialTab || storeTab));
  }, [initialTab, storeTab, resolveTab]);

  const selectTab = useCallback(
    (tab: TabType, opts?: { focusTab?: boolean; focusPanel?: boolean }) => {
      setActiveTab(tab);
      setSettingsActiveTab(tab);
      setNavFocusId(tab);
      if (opts?.focusTab) {
        requestAnimationFrame(() => {
          const el = tablistRef.current?.querySelector<HTMLElement>(
            `[data-settings-tab-id="${tab}"]`
          );
          el?.focus();
        });
      } else if (opts?.focusPanel) {
        requestAnimationFrame(() => {
          contentAreaRef.current?.focus({ preventScroll: true });
        });
      }
    },
    [setSettingsActiveTab]
  );

  const safeActiveTab: TabType = resolveTab(activeTab);
  const currentTabDef = TAB_COMPONENTS[safeActiveTab] ?? TAB_COMPONENTS.profile;
  const ActiveTabComponent = currentTabDef.Component;
  const activeLabel = t(currentTabDef.labelKey);
  const panelId = `${baseId}-panel-${safeActiveTab}`;
  const activeTabBtnId = `${baseId}-tab-${safeActiveTab}`;

  useEffect(() => {
    void refreshProductCapabilities().then(() => {
      const c = getCachedCapabilities();
      setMcpAvailable(Boolean(c?.probe?.configured));
    });
  }, []);

  const nav = useSettingsNav({
    mcpAvailable,
    safeActiveTab,
    onClose,
    rulesModalOpen,
    selectTab,
    navFocusId,
  });

  return (
    // dismissible=false：LayerStack 不对设置做「外部点击即退栈」（portal 进 overlay 的下拉、
    // 嵌套弹窗遮罩上的点击不会级联关掉设置）；Esc 走 onEscapeKeyDown（栈顶优先，先清搜索再关），
    // 点设置自己的遮罩由 closeOnBackdropClick 关闭。
    <Dialog
      open={isOpen}
      onClose={onClose}
      dismissible={false}
      closeOnBackdropClick
      ariaLabel={t('settings.title')}
      initialFocusRef={nav.searchInputRef}
      onEscapeKeyDown={nav.handleSettingsEscape}
      classNames={{
        panel: styles.settingsModal,
        overlay: styles.settingsModalOverlay,
        body: styles.settingsModalBody,
      }}
    >
      <div
        ref={rootRef}
        className={styles.settingsShell}
        data-testid="settings-panel"
        data-hover-pane={hoverPane ?? undefined}
        onPointerOver={handleShellPointerOver}
        onPointerLeave={() => setHoverPane(null)}
      >
        <SettingsSidebar
          aria={{
            baseId,
            tablistId,
            searchId,
            statusId,
            panelId,
            tablistRef,
          }}
          search={{
            searchQuery: nav.navQuery,
            filterStatusText: nav.filterStatusText,
            searchInputRef: nav.searchInputRef,
            onSearchChange: nav.setNavQuery,
            onSearchKeyDown: nav.onSearchKeyDown,
          }}
          items={nav.visibleTabs}
          activeId={safeActiveTab}
          rovingId={nav.rovingId}
          onTablistKeyDown={nav.onTablistKeyDown}
          onSelect={selectTab}
          onFocusTab={setNavFocusId}
          onPointerEnter={() => setHoverPane('nav')}
        />

        <div
          className={styles.settingsMain}
          data-settings-main="true"
          data-scrollbar-hover-host="main"
          onPointerEnter={() => setHoverPane('main')}
        >
          {/* 顶栏标题与同心圆角关闭按钮：样式见 SettingsPanel.module.css (.settingsHeader / .settingsClose) */}
          <header className={styles.settingsHeader}>
            <h2 className={styles.settingsTitle} data-testid="settings-title">
              <span>{t('settings.title')}</span>
              <span className={styles.settingsTitleSep} aria-hidden="true">
                /
              </span>
              <span className={styles.settingsTitleCurrent}>{activeLabel}</span>
            </h2>
            <Tooltip content={t('settings.frame.closeWithEsc')} delayShow={300}>
              <Button
                bare
                type="button"
                className={styles.settingsClose}
                data-testid="settings-close-button"
                aria-label={t('settings.frame.close')}
                onClick={onClose}
              >
                <AppIcon name="x" size={16} aria-hidden />
              </Button>
            </Tooltip>
          </header>

          <div
            ref={contentAreaRef}
            id={panelId}
            role="tabpanel"
            tabIndex={0}
            className={styles.coverContent}
            aria-label={activeLabel}
            aria-labelledby={activeTabBtnId}
            data-cover-content="true"
            data-scrollbar-visibility="hover"
            data-settings-tab={safeActiveTab}
          >
            <Suspense
              key={`tab-${safeActiveTab}-suspense`}
              fallback={<SettingsTabSuspenseFallback tabName={activeLabel} />}
            >
              <AppErrorBoundary
                key={`tab-${safeActiveTab}`}
                compact
                title={t('common.error')}
              >
                <ActiveTabComponent
                  {...(safeActiveTab === 'rules' ||
                  safeActiveTab === 'archive' ||
                  safeActiveTab === 'plugins' ||
                  safeActiveTab === 'skills' ||
                  safeActiveTab === 'mcp'
                    ? { onBlockingOverlayChange: setRulesModalOpen }
                    : {})}
                />
              </AppErrorBoundary>
            </Suspense>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
