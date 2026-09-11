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
import { useLayoutStore, useSettingsUiStore } from '../../store/storeAccess';
import {
  getCachedCapabilities,
  refreshProductCapabilities,
} from '../../api/capabilitiesStore';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Dialog } from '../ui';
import {
  normalizeSettingsTabId,
  allowedTabIds,
  TAB_META,
  FALLBACK_TAB_META,
  type TabType,
} from '../settingsTabsMeta';
import { useSettingsNav } from '../useSettingsNav';
import { SettingsSidebar } from './SettingsSidebar';
import { WindowControls } from '../shell/WindowControls';

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

type TabComponentProps = {
  onBlockingOverlayChange?: (open: boolean) => void;
  _onBlockingOverlayChange?: (open: boolean) => void;
};

const TAB_COMPONENTS: Record<
  TabType,
  { label: string; Component: React.ComponentType<TabComponentProps> }
> = {
  profile: { label: '个人资料', Component: SettingsProfileTab },
  appearance: { label: '外观', Component: SettingsAppearanceTab },
  personalize: { label: '通用设置', Component: SettingsPersonalizeTab },
  models: { label: '模型', Component: ModelsSettingsTab },
  plugins: { label: '扩展', Component: SettingsExtensionsTab },
  skills: { label: '扩展', Component: SettingsExtensionsTab },
  mcp: { label: '扩展', Component: SettingsExtensionsTab },
  usage: { label: '用量', Component: SettingsUsageTab },
  devices: { label: '多端互通', Component: SettingsDevicesTab },
  schedule: { label: '定时任务', Component: SettingsScheduleTab },
  rules: { label: '规则', Component: SettingsRulesTab },
  shortcuts: { label: '快捷键', Component: SettingsShortcutsTab },
  browser: { label: '浏览器', Component: SettingsBrowserTab },
  security: { label: '安全', Component: SettingsSecurityTab },
  diagnostics: { label: '状态诊断', Component: StatusDiagnosticsPanel },
};

/** tab 懒加载占位：与设置页骨架样式一致，避免加载抖动 */
const SettingsTabSuspenseFallback: React.FC<{ tabName: string }> = ({
  tabName,
}) => (
  <div className="settings-tab-loading" role="status" aria-live="polite">
    <span className="settings-tab-loading-text">加载 {tabName}…</span>
  </div>
);

/** re-export：既有 `from './SettingsPanel'` 消费者保持可用 */
import type { SettingsTabType } from '../../store/types';

export type { SettingsTabType };

interface SettingsPanelProps {
  wsId?: string;
  onClose?: () => void;
  initialTab?: SettingsTabType;
  isOpen?: boolean;
}

/**
 * 设置壳组件：顶栏窗口控制 + 专属侧栏导航（SettingsSidebar）+ 内容区（懒加载 Suspense 分支）。
 */
export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  wsId: _wsId,
  onClose,
  initialTab,
}) => {
  const storeTab = useSettingsUiStore((s) => s.settingsActiveTab);
  const setSettingsActiveTab = useSettingsUiStore(
    (s) => s.setSettingsActiveTab
  );
  const [mcpAvailable, setMcpAvailable] = useState(false);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [navFocusId, setNavFocusId] = useState<TabType | null>(null);

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
  const activeTabMeta =
    TAB_META.find((t) => t.id === safeActiveTab) ??
    TAB_META[0] ??
    FALLBACK_TAB_META;
  const activeLabel = activeTabMeta.label || '设置';
  const panelId = `${baseId}-panel-${safeActiveTab}`;
  const activeTabBtnId = `${baseId}-tab-${safeActiveTab}`;

  /**
   * 有意功能：非内容区滚轮联动（非补丁）。
   * 用户在侧栏/顶栏等非内容区空白处滚动时，辅助滚动内容区 scrollTop。
   * 三步结构：① models 视口型 Tab 早退（自管滚动，严禁 JS 篡改 scrollTop）；
   * ② 内容区内滚轮 → 交浏览器原生管线（含 textarea/pre/select 原生自滚动）；
   * ③ 仅非内容区目标才辅助 scrollTop。
   * 注：contains 守卫已消除双倍速问题；本 handler 保留侧栏联动职责。
   */
  const handleRootWheel = (e: React.WheelEvent) => {
    // ① models 视口型 Tab：硬性早退，不干预其内部滚动
    if (safeActiveTab === 'models') {
      return;
    }

    const contentArea = contentAreaRef.current;
    if (!contentArea) return;

    // ② 内容区内滚轮（含 textarea/pre/select 原生自滚动与子元素/内边距空白）：
    //    交由浏览器原生渲染管线接管，JS 不叠加 scrollTop（避免双倍速）
    if (contentArea.contains(e.target as Node)) {
      return;
    }

    // ③ 非内容区目标（侧栏/顶栏空白）：辅助滚动内容区
    contentArea.scrollTop += e.deltaY;
  };

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

  if (isOpen === false) return null;

  const currentTabDef = TAB_COMPONENTS[safeActiveTab] ?? TAB_COMPONENTS.profile;
  const ActiveTabComponent = currentTabDef.Component;

  return (
    <Dialog
      open={isOpen ?? true}
      onClose={onClose ?? (() => {})}
      dismissible={false}
      variant="fullscreen"
      ariaLabel="设置"
      initialFocusRef={nav.searchInputRef}
      onEscapeKeyDown={nav.handleSettingsEscape}
      classNames={{ panel: styles.settingsCover, overlay: styles.settingsCoverOverlay }}
    >
      <div
        ref={rootRef}
        className={`${styles.settingsPanel} ${styles.settingsDialogBody}`}
        data-testid="settings-panel"
        data-density="compact"
        onWheel={handleRootWheel}
      >
        <header
          className={styles.coverHeader}
          data-tauri-drag-region
        >
          <div className={styles.coverHeaderSpacer} data-tauri-drag-region />
          <WindowControls onClose={onClose} />
        </header>

        <div className={styles.coverBody} data-density="compact">
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
            onBack={onClose}
            onTablistKeyDown={nav.onTablistKeyDown}
            onSelect={selectTab}
            onFocusTab={setNavFocusId}

          />

          <div
            ref={contentAreaRef}
            id={panelId}
            role="tabpanel"
            tabIndex={0}
            className={styles.coverContent}
            aria-label={activeLabel}
            aria-labelledby={activeTabBtnId}
            data-settings-tab={safeActiveTab}
            data-density="compact"
          >
            <Suspense
              key={`tab-${safeActiveTab}-suspense`}
              fallback={
                <SettingsTabSuspenseFallback tabName={currentTabDef.label} />
              }
            >
              <AppErrorBoundary
                key={`tab-${safeActiveTab}`}
                compact
                title="设置页面出错"
              >
                <ActiveTabComponent
                  {...(safeActiveTab === 'rules' ||
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
