import React, { useState, useEffect, useRef, useCallback, useMemo, useId, lazy, Suspense } from 'react';
import styles from './SettingsPanel.module.css';
import { useLayoutStore } from '../../store/layoutStore';
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
import { SettingsTablist } from '../SettingsTablist';
import { SettingsWindowControls } from '../SettingsWindowControls';

/**
 * 设置 tab 懒加载：设置页是低频入口，11 个 tab（含 873 行 SkillsSettingsTab /
 * 788 行 McpSettingsTab / 650 行 ModelsSettingsTab）不应全部进初始 bundle。
 * React.lazy + Suspense 按需加载，首屏只加载当前激活 tab。
 * 命名导出需 .then(m => ({ default: m.Xxx })) 适配 lazy 的 default 导出约定。
 */
const ModelsSettingsTab = lazy(() =>
  import('../settings-models/ModelsSettingsTab').then((m) => ({ default: m.ModelsSettingsTab })),
);
const SettingsScheduleTab = lazy(() =>
  import('./SettingsScheduleTab').then((m) => ({ default: m.SettingsScheduleTab })),
);
const SettingsRulesTab = lazy(() =>
  import('./SettingsRulesTab').then((m) => ({ default: m.SettingsRulesTab })),
);
const SettingsSecurityTab = lazy(() =>
  import('./SettingsSecurityTab').then((m) => ({ default: m.SettingsSecurityTab })),
);
const SettingsProfileTab = lazy(() =>
  import('./SettingsProfileTab').then((m) => ({ default: m.SettingsProfileTab })),
);
const SettingsAppearanceTab = lazy(() =>
  import('./SettingsAppearanceTab').then((m) => ({ default: m.SettingsAppearanceTab })),
);
const SettingsUsageTab = lazy(() =>
  import('./SettingsUsageTab').then((m) => ({ default: m.SettingsUsageTab })),
);
const SettingsShortcutsTab = lazy(() =>
  import('./SettingsShortcutsTab').then((m) => ({ default: m.SettingsShortcutsTab })),
);
const SettingsPersonalizeTab = lazy(() =>
  import('./SettingsPersonalizeTab').then((m) => ({ default: m.SettingsPersonalizeTab })),
);
const SettingsExtensionsTab = lazy(() =>
  import('../settings-extensions/SettingsExtensionsTab').then((m) => ({ default: m.SettingsExtensionsTab })),
);

/** tab 懒加载占位：与设置页骨架样式一致，避免加载抖动 */
const SettingsTabSuspenseFallback: React.FC<{ tabName: string }> = ({ tabName }) => (
  <div className="settings-tab-loading" role="status" aria-live="polite">
    <span className="settings-tab-loading-text">加载 {tabName}…</span>
  </div>
);

/** re-export：既有 `from './SettingsPanel'` 消费者保持可用 */
import type { SettingsTabType } from '../../store/types';

export type { SettingsTabType };

interface SettingsPanelProps {
  wsId: string;
  onShowToast: (msg: string, onUndo?: () => void) => void;
  onClose?: () => void;
  initialTab?: SettingsTabType;
  isOpen?: boolean;
}

/**
 * 设置壳组件：顶栏窗口控制 + 侧栏导航（SettingsTablist）+ 内容区（10 个懒加载
 * Suspense 分支）。tab 元数据见 settingsTabsMeta；搜索/roving/Esc/快捷键见
 * useSettingsNav；窗口控制见 SettingsWindowControls。
 */
export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  wsId: _wsId,
  onShowToast,
  onClose,
  initialTab,
}) => {
  const storeTab = useLayoutStore((s) => s.settingsActiveTab);
  const setSettingsActiveTab = useLayoutStore((s) => s.setSettingsActiveTab);
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
      if (raw && (allowedTabIds(mcpAvailable) as string[]).includes(raw)) return raw as TabType;
      return 'profile';
    },
    [mcpAvailable],
  );

  const [activeTab, setActiveTab] = useState<TabType>(() =>
    resolveTab(initialTab || storeTab),
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
            `[data-settings-tab-id="${tab}"]`,
          );
          el?.focus();
        });
      } else if (opts?.focusPanel) {
        requestAnimationFrame(() => {
          contentAreaRef.current?.focus({ preventScroll: true });
        });
      }
    },
    [setSettingsActiveTab],
  );

  /** 永远走合法 tab；未知 id 回退 profile，保证默认页可挂载 */
  const safeActiveTab: TabType = resolveTab(activeTab);
  /** 当前页元信息；永远有 fallback，避免渲染期未定义变量导致设置打不开 */
  const activeTabMeta =
    TAB_META.find((t) => t.id === safeActiveTab) ?? TAB_META[0] ?? FALLBACK_TAB_META;
  const activeLabel = activeTabMeta.label || '设置';
  const panelId = `${baseId}-panel-${safeActiveTab}`;
  const activeTabBtnId = `${baseId}-tab-${safeActiveTab}`;

  const handleRootWheel = (e: React.WheelEvent) => {
    if (contentAreaRef.current) {
      const target = e.target as HTMLElement;
      if (target.closest('textarea') || target.closest('pre') || target.closest('select')) {
        return;
      }
      if (contentAreaRef.current.contains(target) && target !== contentAreaRef.current) {
        return;
      }
      contentAreaRef.current.scrollTop += e.deltaY;
    }
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

  // 全屏盖层（PE-05 T05.2 #5）：收敛到 ui/Dialog 基座——
  // 遮罩/焦点圈定/焦点归还/动画由基座接管；dismissible=false 使 Esc 仍走
  // useSettingsNav 的三层优先级（清搜索 → 关设置），rulesModalOpen 为
  // 规则编辑器打开时的第一层守卫；初始聚焦搜索框。
  return (
    <Dialog
      open={isOpen ?? true}
      onClose={onClose ?? (() => {})}
      dismissible={false}
      variant="fullscreen"
      ariaLabel="设置"
      initialFocusRef={nav.searchInputRef}
      className={styles.settingsCover}
      overlayClassName={styles.settingsCoverOverlay}
    >
      <div
        ref={rootRef}
        className={`${styles.settingsPanel} ${styles.settingsDialogBody}`}
        data-testid="settings-panel"
        data-density="compact"
        onWheel={handleRootWheel}
      >
        {/* 顶栏极简：仅拖拽区 + 关闭；键盘 Esc 关闭（搜索有词时先清空） */}
        <header className={`${styles.coverHeader} ${styles.coverHeaderSlim}`} data-tauri-drag-region>
          <div className={styles.coverHeaderSpacer} data-tauri-drag-region />
          <SettingsWindowControls onClose={onClose} />
        </header>

      <div className={styles.coverBody} data-density="compact">
        <SettingsTablist
          baseId={baseId}
          items={nav.visibleTabs}
          activeId={safeActiveTab}
          rovingId={nav.rovingId}
          tablistId={tablistId}
          searchId={searchId}
          statusId={statusId}
          panelId={panelId}
          searchQuery={nav.navQuery}
          filterStatusText={nav.filterStatusText}
          searchInputRef={nav.searchInputRef}
          tablistRef={tablistRef}
          onBack={onClose}
          onSearchChange={nav.setNavQuery}
          onSearchKeyDown={nav.onSearchKeyDown}
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
          {/* 每页独立 ErrorBoundary + Suspense：单页崩溃不拖垮整个设置层；
              React.lazy 按需加载，首屏只加载当前 tab。
              key 切换时重置错误态 + Suspense 重新挂载 */}
          {safeActiveTab === 'profile' && (
            <Suspense key="tab-profile-suspense" fallback={<SettingsTabSuspenseFallback tabName="个人资料" />}>
              <AppErrorBoundary key="tab-profile" compact title="设置页面出错">
                <SettingsProfileTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'appearance' && (
            <Suspense key="tab-appearance-suspense" fallback={<SettingsTabSuspenseFallback tabName="外观" />}>
              <AppErrorBoundary key="tab-appearance" compact title="设置页面出错">
                <SettingsAppearanceTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'personalize' && (
            <Suspense key="tab-personalize-suspense" fallback={<SettingsTabSuspenseFallback tabName="通用设置" />}>
              <AppErrorBoundary key="tab-personalize" compact title="设置页面出错">
                <SettingsPersonalizeTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'models' && (
            <Suspense key="tab-models-suspense" fallback={<SettingsTabSuspenseFallback tabName="模型" />}>
              <AppErrorBoundary key="tab-models" compact title="设置页面出错">
                <ModelsSettingsTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'plugins' && (
            <Suspense
              key="tab-plugins-suspense"
              fallback={<SettingsTabSuspenseFallback tabName="扩展" />}
            >
              <AppErrorBoundary key="tab-plugins" compact title="设置页面出错">
                <SettingsExtensionsTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'usage' && (
            <Suspense key="tab-usage-suspense" fallback={<SettingsTabSuspenseFallback tabName="用量" />}>
              <AppErrorBoundary key="tab-usage" compact title="设置页面出错">
                <SettingsUsageTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'schedule' && (
            <Suspense key="tab-schedule-suspense" fallback={<SettingsTabSuspenseFallback tabName="定时任务" />}>
              <AppErrorBoundary key="tab-schedule" compact title="设置页面出错">
                <SettingsScheduleTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'rules' && (
            <Suspense key="tab-rules-suspense" fallback={<SettingsTabSuspenseFallback tabName="规则" />}>
              <AppErrorBoundary key="tab-rules" compact title="设置页面出错">
                <SettingsRulesTab
                  onShowToast={onShowToast}
                  onBlockingOverlayChange={setRulesModalOpen}
                />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'shortcuts' && (
            <Suspense key="tab-shortcuts-suspense" fallback={<SettingsTabSuspenseFallback tabName="快捷键" />}>
              <AppErrorBoundary key="tab-shortcuts" compact title="设置页面出错">
                <SettingsShortcutsTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}

          {safeActiveTab === 'security' && (
            <Suspense key="tab-security-suspense" fallback={<SettingsTabSuspenseFallback tabName="安全" />}>
              <AppErrorBoundary key="tab-security" compact title="设置页面出错">
                <SettingsSecurityTab onShowToast={onShowToast} />
              </AppErrorBoundary>
            </Suspense>
          )}
        </div>
      </div>
      </div>
    </Dialog>
  );
};
