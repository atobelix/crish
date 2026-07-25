import React, { useState, useEffect, useRef, useCallback, useMemo, useId, lazy, Suspense } from 'react';
import * as Lucide from 'lucide-react';
import styles from './SettingsPanel.module.css';
import { useLayoutStore } from '../store/layoutStore';
import { isDemoMode } from '../api/appMode';
import {
  getCachedCapabilities,
  refreshProductCapabilities,
} from '../api/capabilitiesStore';
import { AppErrorBoundary } from './AppErrorBoundary';
import { Tooltip } from './settings/SettingsUI';
import type { SettingsTabType } from '../store/types';
import { useAnimatedPresence } from '../hooks/useAnimatedPresence';

/**
 * 设置 tab 懒加载：设置页是低频入口，11 个 tab（含 873 行 SkillsSettingsTab /
 * 788 行 McpSettingsTab / 650 行 ModelsSettingsTab）不应全部进初始 bundle。
 * React.lazy + Suspense 按需加载，首屏只加载当前激活 tab。
 * 命名导出需 .then(m => ({ default: m.Xxx })) 适配 lazy 的 default 导出约定。
 */
const ModelsSettingsTab = lazy(() =>
  import('./ModelsSettingsTab').then((m) => ({ default: m.ModelsSettingsTab })),
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
  import('./SettingsExtensionsTab').then((m) => ({ default: m.SettingsExtensionsTab })),
);

/** tab 懒加载占位：与设置页骨架样式一致，避免加载抖动 */
const SettingsTabSuspenseFallback: React.FC<{ tabName: string }> = ({ tabName }) => (
  <div className="settings-tab-loading" role="status" aria-live="polite">
    <span className="settings-tab-loading-text">加载 {tabName}…</span>
  </div>
);

/** re-export：既有 `from './SettingsPanel'` 消费者保持可用 */
export type { SettingsTabType };

type TabType = SettingsTabType;

interface SettingsPanelProps {
  wsId: string;
  onShowToast: (msg: string, onUndo?: () => void) => void;
  onClose?: () => void;
  initialTab?: SettingsTabType;
  isOpen?: boolean;
}

/**
 * 侧栏可见 formal tabs。
 * 技能 / MCP / 插件仅在「扩展」一页；旧 id skills|mcp 仍合法，解析时归入 plugins。
 */
const FORMAL_TAB_IDS: TabType[] = [
  'profile',
  'appearance',
  'personalize',
  'models',
  'usage',
  'rules',
  'schedule',
  'plugins',
  'shortcuts',
  'security',
];

function allowedTabIds(_mcpAvailable: boolean): TabType[] {
  return [...FORMAL_TAB_IDS];
}

/** 深链/旧入口：skills|mcp → 扩展中心 */
function normalizeSettingsTabId(raw: string | null | undefined): TabType | null {
  if (!raw) return null;
  if (raw === 'skills' || raw === 'mcp') return 'plugins';
  if ((FORMAL_TAB_IDS as readonly string[]).includes(raw)) return raw as TabType;
  // 兼容：仍允许内部挂载 skills/mcp（扩展内嵌），但不在侧栏展示
  if (raw === 'plugins') return 'plugins';
  return null;
}

type TabMeta = {
  id: TabType;
  /** 中文侧栏标签 */
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  /** 中文分组 */
  group: string;
  /** 搜索别名：中文同义词 + 常见英文缩写，便于键盘/搜索定位 */
  keywords: string[];
  demoOnly?: boolean;
};

const TAB_META: TabMeta[] = [
  {
    id: 'profile',
    label: '账户',
    icon: Lucide.User,
    group: '个人',
    keywords: ['账户', '账号', '个人资料', '工作区', '导出', 'profile', 'account'],
  },
  {
    id: 'appearance',
    label: '外观',
    icon: Lucide.Palette,
    group: '个人',
    keywords: ['外观', '主题', '深色', '浅色', '字体', '密度', 'theme', 'appearance', 'font'],
  },
  {
    id: 'personalize',
    label: '通用设置',
    icon: Lucide.SlidersHorizontal,
    group: '个人',
    keywords: ['通用设置', '偏好', '交互', '标签页', 'personalize', 'preference', 'general'],
  },
  {
    id: 'models',
    label: '模型',
    icon: Lucide.Orbit,
    group: '智能',
    keywords: ['模型', '供应商', '密钥', 'API', 'llm', 'model', 'provider', 'openai', 'claude'],
  },
  {
    id: 'usage',
    label: '用量',
    icon: Lucide.PieChart,
    group: '智能',
    keywords: ['用量', '用量统计', 'token', '费用', 'usage', 'quota'],
  },
  {
    id: 'rules',
    label: '规则',
    icon: Lucide.FileText,
    group: '智能',
    keywords: ['规则', '指令', '系统提示', 'rules', 'prompt', 'agent'],
  },
  {
    id: 'schedule',
    label: '定时任务',
    icon: Lucide.Clock,
    group: '工作',
    keywords: ['定时', '定时任务', '计划', 'cron', 'schedule', '任务'],
  },
  {
    id: 'plugins',
    label: '扩展',
    icon: Lucide.Puzzle,
    group: '工作',
    keywords: [
      '扩展',
      '插件',
      'MCP',
      'mcp',
      '技能',
      'skill',
      'skills',
      '商店',
      '官方',
      '三方',
      'package',
      'plugin',
      'marketplace',
      '能力包',
    ],
  },
  {
    id: 'shortcuts',
    label: '快捷键',
    icon: Lucide.Command,
    group: '工作',
    keywords: ['快捷键', '键盘', '热键', 'shortcuts', 'hotkey', 'keymap'],
  },
  {
    id: 'security',
    label: '安全',
    icon: Lucide.Lock,
    group: '安全',
    keywords: ['安全', '权限', '白名单', '信任', 'security', 'permission', 'allowlist'],
  },
];

const FALLBACK_TAB_META: TabMeta = {
  id: 'profile',
  label: '账户',
  icon: Lucide.User,
  group: '个人',
  keywords: ['账户'],
};

function tabMatchesQuery(tab: TabMeta, q: string): boolean {
  if (!q) return true;
  if (tab.label.toLowerCase().includes(q)) return true;
  if (tab.group.toLowerCase().includes(q)) return true;
  if (tab.id.toLowerCase().includes(q)) return true;
  return tab.keywords.some((k) => k.toLowerCase().includes(q) || q.includes(k.toLowerCase()));
}

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
  const [navQuery, setNavQuery] = useState('');
  const [navFocusId, setNavFocusId] = useState<TabType | null>(null);

  const { state, isMounted } = useAnimatedPresence({ visible: isOpen ?? true, exitDurationMs: 300 });

  const baseId = useId();
  const tablistId = `${baseId}-tablist`;
  const searchId = `${baseId}-search`;
  const statusId = `${baseId}-status`;

  const rootRef = useRef<HTMLDivElement>(null);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const tablistRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // Esc: rules modal -> clear search -> close settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (rulesModalOpen) return;
      if (navQuery.trim()) {
        e.preventDefault();
        e.stopPropagation();
        setNavQuery('');
        searchInputRef.current?.focus();
        return;
      }
      if (!onClose) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, rulesModalOpen, navQuery]);

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

  useEffect(() => {
    void refreshProductCapabilities().then(() => {
      const c = getCachedCapabilities();
      setMcpAvailable(Boolean(c?.probe?.configured));
    });
  }, []);

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
    (visibleTabs.some((t) => t.id === safeActiveTab) ? safeActiveTab : visibleTabs[0]?.id) ||
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

  if (!isMounted) return null;

  const filterStatusText =
    navQuery.trim().length > 0
      ? visibleTabs.length === 0
        ? '无匹配设置项'
        : `找到 ${visibleTabs.length} 个设置项，当前「${activeLabel}」`
      : `设置 · ${activeLabel}`;

  return (
    <div
      ref={rootRef}
      className={`${styles.settingsPanel} ${styles.settingsCover} is-${state}`}
      data-density="compact"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onWheel={handleRootWheel}
    >
      {/* 顶栏极简：仅拖拽区 + 关闭；键盘 Esc 关闭（搜索有词时先清空） */}
      <header className={`${styles.coverHeader} ${styles.coverHeaderSlim}`} data-tauri-drag-region>
        <div className={styles.coverHeaderSpacer} data-tauri-drag-region />
        <div
          className="settings-cover-win no-drag"
          role="group"
          aria-label="窗口控制"
          data-tauri-drag-region="false"
        >
          <Tooltip content="最小化">
            <button
              type="button"
              className="win-btn no-drag"
              aria-label="最小化窗口"
              data-tauri-drag-region="false"
              onClick={() => {
                void (async () => {
                  try {
                    const mod = await import('@tauri-apps/api/window');
                    await mod.getCurrentWindow().minimize();
                  } catch {
                    /* browser */
                  }
                })();
              }}
            >
              <Lucide.Minus size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content="最大化">
            <button
              type="button"
              className="win-btn no-drag"
              aria-label="最大化或还原窗口"
              data-tauri-drag-region="false"
              onClick={() => {
                void (async () => {
                  try {
                    const mod = await import('@tauri-apps/api/window');
                    const win = mod.getCurrentWindow();
                    if (await win.isMaximized()) await win.unmaximize();
                    else await win.maximize();
                  } catch {
                    /* browser */
                  }
                })();
              }}
            >
              <Lucide.Square size={14} aria-hidden />
            </button>
          </Tooltip>
          {onClose ? (
            <Tooltip content="关闭设置 (Esc)">
              <button
                type="button"
                className="win-btn close no-drag"
                data-tauri-drag-region="false"
                onClick={onClose}
                aria-label="关闭设置"
                aria-keyshortcuts="Escape"
              >
                <Lucide.X size={16} strokeWidth={1.75} aria-hidden />
              </button>
            </Tooltip>
          ) : null}
        </div>
      </header>

      <div className={styles.coverBody} data-density="compact">
        <nav className={styles.coverNav} aria-label="设置导航" data-density="compact">
          {onClose ? (
            <Tooltip content="返回应用 (Esc)">
              <button
                type="button"
                className={`${styles.navBack} no-drag`}
                onClick={onClose}
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
              value={navQuery}
              onChange={(e) => setNavQuery(e.target.value)}
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
            {visibleTabs.map((tab, idx, arr) => {
              const isTabActive = safeActiveTab === tab.id;
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
                      data-settings-tab-id={tab.id}
                      aria-selected={isTabActive}
                      aria-controls={isTabActive ? panelId : undefined}
                      tabIndex={isRoving ? 0 : -1}
                      aria-label={`${tab.group} · ${tab.label}`}
                      onClick={() => selectTab(tab.id)}
                      onFocus={() => setNavFocusId(tab.id)}
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
            {visibleTabs.length === 0 ? (
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
  );
};
