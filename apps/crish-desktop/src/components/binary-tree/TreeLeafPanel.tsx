import { AppIcon } from '@/components/ui/icons';
import { Button, Tooltip } from '@/components/ui';
/**
 * 二叉树叶子面板 — 声明式微内核叶子容器。
 *
 * 架构契约：
 * - 纯几何叶子空间容器，100% 剥离 switch(panelId) 静态硬编码；
 * - 依据 Rule G-08 规约，通过 tabViewAdapter 动态映射 UnifiedTab 视图；
 * - 内部右坞完全委托给 DockSplitWorkspace（含 LeafToolTabStrip）渲染二叉空间分屏树；
 * - 仍禁止复活 ChatHeader / UnitSessionTabStrip / GlobalSessionTabBar。
 * 未提交的新对话不占标签；画面会话 = 本叶选中 tab，否则为本叶草稿哨兵。
 */

import React, {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { UnitChromeActions } from '../chat-card/UnitChromeActions';
import { LeafDockResizer } from './LeafDockResizer';
import { PaneHeader } from './PaneHeader';
import { computePaneEdges } from './paneEdgeGeometry';
import { DockSplitWorkspace } from './DockSplitWorkspace';
import { useEntranceReveal } from '../motion/useEntranceReveal';
import styles from './BinaryTreeWorkspace.module.css';
import {
  openToolInLeaf,
  updateLeafDock,
  useLayoutStore,
  useSessionStore,
  useLayoutTreeStore,
  isPendingDraft,
  findSpatialNode,
  type DockLeaf,
} from '../../store/storeAccess';
import { getCompositionRoot } from '../../app/compositionRoot';
import { LeafScopeProvider } from '../../contexts/LeafScopeContext';
import { resolveTabView } from './tabViewAdapter';
import {
  COLLAPSED_DOCK,
  leafPropsEqual,
  readActiveTab,
  readActiveTabId,
  readLeafTabs,
  rectPropsEqual,
  resolveLeafSessionId,
  sessionShell,
  type TreeLeafPanelProps,
} from './treeLeafPanelModel';
import {
  viewRegistry,
  SlotOutlet,
  type ViewRenderContext,
} from '../../services/view-registry';
import { useI18n } from '../../i18n';

/**
 * 叶子内「关闭类」控件识别：仅消费稳定的 data-* 结构标记。
 * 严禁回退到 aria-label/title 文本嗅探——文案会随 i18n 翻译漂移，
 * 结构标记才是单一真源（data-tab-close / data-pane-close /
 * data-prevent-leaf-activate 分别由各自组件声明）。
 */
const CLOSE_TARGET_SELECTOR =
  '[data-tab-close], [data-pane-close], [data-prevent-leaf-activate="true"]';

const isCloseTarget = (e?: React.SyntheticEvent) =>
  Boolean(
    e?.target &&
    'closest' in (e.target as HTMLElement) &&
    (e.target as HTMLElement).closest(CLOSE_TARGET_SELECTOR)
  );

/** 抽屉开合 / 最大化过渡时长（ms），与 CSS --duration-normal (200ms) 同值同族 */
const DOCK_DRAWER_ANIM_MS = 200;

export const TreeLeafPanel: React.FC<TreeLeafPanelProps> = React.memo(
  ({ leaf, rect, isActive, isDragSource }) => {
    const { t } = useI18n();
    const leafElRef = useRef<HTMLDivElement>(null);
    const leafBodyRef = useRef<HTMLDivElement>(null);
    // 窗格入场走统一入场通道（S7 · L1 收敛）：叶按 leaf.id 键控稳定挂载，
    // 挂载本身即实况事件（分栏 / 新建窗格），故 liveOnMount 判定；呈现
    // 记忆保证同叶同会话只播一次。退场侧待 S4 通道退场判定层，本处不
    // 自创私有退场。根 style 只携带 --reveal-delay 自定义属性，几何键
    // 永不进 React style（几何仍由下方 layoutEffect 直写 DOM）。
    const {
      entering: paneEntering,
      delayMs: paneDelayMs,
      handleAnimationEnd: paneAnimationEnd,
      rootRef: paneRootRef,
    } = useEntranceReveal({
      key: `pane:${leaf.id}`,
      variant: 'fade',
      liveOnMount: true,
    });
    const setLeafEl = useCallback(
      (el: HTMLDivElement | null) => {
        leafElRef.current = el;
        paneRootRef(el);
      },
      [paneRootRef]
    );
    const chatMainSurface = useLayoutStore((s) => s.chatMainSurface) ?? 'chat';
    const isChatSurface = chatMainSurface === 'chat';

    const globalActiveSessionId = useSessionStore((s) => s.activeSessionId);
    const rawActiveTab = readActiveTab(leaf);
    const isLeafDraft =
      !rawActiveTab ||
      ((!rawActiveTab.kind || rawActiveTab.kind === 'chat') &&
        isPendingDraft(rawActiveTab.sessionId));
    const activeTab =
      isLeafDraft && !rawActiveTab?.sessionId ? undefined : rawActiveTab;

    const tabResolution = useMemo(
      () => resolveTabView(activeTab),
      [
        activeTab?.tabId,
        activeTab?.kind,
        activeTab?.sessionId,
        activeTab?.terminalKey,
        activeTab?.cwd,
        activeTab?.url,
      ]
    );

    const fallbackSessionId = resolveLeafSessionId(leaf, {
      isFocused: isActive,
      globalActiveSessionId,
    });
    const effectiveSessionId = tabResolution.sessionId ?? fallbackSessionId;
    const sessionForPanel = effectiveSessionId;
    const dock = activeTab?.dock ?? leaf.dock ?? COLLAPSED_DOCK;
    const isTerminalTab = activeTab?.kind === 'terminal';
    const isBrowserTab = activeTab?.kind === 'browser';
    const isStandaloneTab = isTerminalTab || isBrowserTab;
    const dockCapable = isChatSurface && !isLeafDraft && !isStandaloneTab;
    const dockOpen = dockCapable && dock.collapsed !== true;

    const [isMaximized, setIsMaximized] = useState(false);

    /*
     * 抽屉关闭保活（S11 · 2026-11-06）：开合动画本体在 CSS（外层
     * .leafDockDrawer 的 width 单挂点过渡，照左栏 S2 配方）。关闭时
     * 内容多挂一拍过渡时长、待 width 收完再卸载；重开立即取消保活。
     */
    const [dockClosing, setDockClosing] = useState(false);
    const dockWasOpenRef = useRef(false);
    useEffect(() => {
      if (dockOpen) {
        dockWasOpenRef.current = true;
        setDockClosing(false);
        return;
      }
      if (!dockWasOpenRef.current) return;
      dockWasOpenRef.current = false;
      setDockClosing(true);
      const timer = window.setTimeout(
        () => setDockClosing(false),
        DOCK_DRAWER_ANIM_MS + 60
      );
      return () => window.clearTimeout(timer);
    }, [dockOpen]);

    /*
     * 最大化 / 还原动画（S11）：isMaximized 保持「目标态」即时翻转
     * （类名 / data-maximized 契约不变）；几何由瞬态 maximizing 壳 +
     * inline left/width 两段翻转承担——首帧钉当前实测几何
     * （transition: none），次帧翻到目标几何，.maximizing 的 CSS
     * 过渡播完后由定时器清瞬态。动画中途再点按，按实测几何重定向。
     */
    const [maxAnim, setMaxAnim] = useState<{
      left: number;
      width: number;
      go: boolean;
    } | null>(null);
    const maxAnimTargetRef = useRef<{ left: number; width: number } | null>(
      null
    );
    const maxAnimTimerRef = useRef<number | null>(null);
    const drawerRef = useRef<HTMLDivElement | null>(null);

    const clearMaxAnimTimer = useCallback(() => {
      if (maxAnimTimerRef.current !== null) {
        window.clearTimeout(maxAnimTimerRef.current);
        maxAnimTimerRef.current = null;
      }
    }, []);

    useEffect(() => {
      return () => clearMaxAnimTimer();
    }, [clearMaxAnimTimer]);

    useLayoutEffect(() => {
      if (!maxAnim || maxAnim.go) return;
      const raf = requestAnimationFrame(() => {
        const to = maxAnimTargetRef.current;
        if (!to) return;
        setMaxAnim({ left: to.left, width: to.width, go: true });
      });
      return () => cancelAnimationFrame(raf);
    }, [maxAnim]);

    const handleToggleMaximize = useCallback(() => {
      const next = !isMaximized;
      setIsMaximized(next);
      const body = leafBodyRef.current;
      const el = drawerRef.current;
      if (!body || !el) {
        clearMaxAnimTimer();
        setMaxAnim(null);
        return;
      }
      const bodyRect = body.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      const from = { left: rect.left - bodyRect.left, width: rect.width };
      const dockPx =
        parseFloat(
          getComputedStyle(body).getPropertyValue('--leaf-dock-width')
        ) || rect.width;
      const to = next
        ? { left: 0, width: bodyRect.width }
        : { left: bodyRect.width - dockPx, width: dockPx };
      clearMaxAnimTimer();
      maxAnimTargetRef.current = to;
      setMaxAnim({ left: from.left, width: from.width, go: false });
      maxAnimTimerRef.current = window.setTimeout(() => {
        maxAnimTimerRef.current = null;
        setMaxAnim(null);
      }, DOCK_DRAWER_ANIM_MS + 60);
    }, [isMaximized, clearMaxAnimTimer]);

    useEffect(() => {
      if (!dockOpen && isMaximized) {
        setIsMaximized(false);
      }
      if (!dockOpen && maxAnim) {
        clearMaxAnimTimer();
        setMaxAnim(null);
      }
    }, [dockOpen, isMaximized, maxAnim, clearMaxAnimTimer]);

    const handleCaptureActivate = useCallback(
      (e: React.SyntheticEvent) => {
        if (isCloseTarget(e) || chatMainSurface !== 'chat') return;

        // 幂等短路守卫（Guard-2）：若当前叶子已是全局激活叶且 activeSessionId 已对齐，立即 return
        const currentActiveLeafId = useLayoutTreeStore.getState().activeLeafId;
        const currentActiveSessionId =
          useSessionStore.getState().activeSessionId;
        if (
          isActive &&
          currentActiveLeafId === leaf.id &&
          currentActiveSessionId === effectiveSessionId
        ) {
          return;
        }

        if (!isActive) {
          useLayoutTreeStore.getState().setActiveLeaf(leaf.id);
          // 🔒 铁律：只有 ChatTab 才允许触碰 sessionStore 状态机！
          // 独立终端与独立浏览器绝不调用 setActiveSessionId 或 enterDraftMode，杜绝聊天会话指针污染
          if (!isStandaloneTab) {
            const sessionStore = useSessionStore.getState();
            if (isPendingDraft(effectiveSessionId)) {
              if (!isPendingDraft(sessionStore.activeSessionId)) {
                sessionStore.enterDraftMode(
                  sessionStore.draftFolder || undefined,
                  {
                    draftSessionId: effectiveSessionId,
                  }
                );
              }
            } else {
              sessionStore.setActiveSessionId(effectiveSessionId);
            }
          }
          const tabId = readActiveTabId(leaf);
          if (tabId) {
            sessionShell().activateTab(leaf.id, tabId);
          } else {
            getCompositionRoot().shell.focusLeaf(leaf.id);
          }
        }
      },
      [chatMainSurface, effectiveSessionId, isActive, isStandaloneTab, leaf]
    );

    const handleActivate = useCallback(
      (e?: React.PointerEvent) => {
        if (isCloseTarget(e) || chatMainSurface !== 'chat') return;
        const tabId = readActiveTabId(leaf);
        if (tabId) {
          sessionShell().activateTab(leaf.id, tabId);
        } else {
          getCompositionRoot().shell.focusLeaf(leaf.id);
        }
      },
      [leaf, chatMainSurface]
    );

    /**
     * 几何由 layoutEffect 写 DOM，不用 React style prop。
     * live resize（body.tree-resizing）期间 useTreeResize 直接刷 leaf 几何；
     * 若此处用 style={}，任意 re-render 会把两侧面板拽回 store 旧 rect，
     * 表现为「拖 sash 时右侧不跟手」。
     */
    useLayoutEffect(() => {
      const el = leafElRef.current;
      if (!el || document.body.classList.contains('tree-resizing')) return;
      el.style.top = `${rect.y * 100}%`;
      el.style.left = `${rect.x * 100}%`;
      el.style.width = `${rect.width * 100}%`;
      el.style.height = `${rect.height * 100}%`;
    }, [rect.x, rect.y, rect.width, rect.height]);

    useLayoutEffect(() => {
      const el = leafBodyRef.current;
      if (!el || !dockOpen) return;
      const w = el.clientWidth;
      if (w <= 0) return;
      const px = Math.max(200, Math.min(w * 0.7, (dock.widthRatio || 0.5) * w));
      el.style.setProperty('--leaf-dock-width', `${px}px`);
    }, [dockOpen, dock.widthRatio]);

    const handleOpenTool = useCallback(
      (panelId: string) => {
        openToolInLeaf(leaf.id, panelId);
      },
      [leaf.id]
    );

    const handleCommitDockRatio = useCallback(
      (ratio: number) => {
        updateLeafDock(leaf.id, { widthRatio: ratio });
      },
      [leaf.id]
    );

    const handleToggleDock = useCallback(() => {
      if (!isChatSurface || isStandaloneTab) return;
      if (dockOpen) {
        updateLeafDock(leaf.id, { collapsed: true });
        return;
      }
      updateLeafDock(leaf.id, { collapsed: false });
    }, [dockOpen, isChatSurface, isStandaloneTab, leaf.id]);

    const registryVersion = useSyncExternalStore(
      (cb) => viewRegistry.subscribe(cb),
      () => viewRegistry.getVersion()
    );
    void registryVersion;

    const mainViewId = tabResolution.viewId;
    const mainResolved = viewRegistry.resolveView(mainViewId);

    const mainParams = useMemo(() => {
      if (!mainResolved.params && !tabResolution.params) return undefined;
      return { ...mainResolved.params, ...tabResolution.params };
    }, [mainResolved.params, tabResolution.params]);

    const mainCtx: ViewRenderContext = useMemo(
      () => ({
        panelId: mainViewId,
        leafId: leaf.id,
        sessionId: tabResolution.sessionId ?? sessionForPanel ?? undefined,
        isActive,
        openView: handleOpenTool,
        params: mainParams,
      }),
      [
        mainViewId,
        leaf.id,
        tabResolution.sessionId,
        sessionForPanel,
        isActive,
        handleOpenTool,
        mainParams,
      ]
    );

    const activeDockViewId = useMemo(() => {
      if (!dock.tree) return null;
      const activeLeafId = dock.tree.activeDockLeafId;
      if (!activeLeafId) return null;
      const leafNode = findSpatialNode(dock.tree.root, activeLeafId);
      if (!leafNode || !('tabs' in leafNode)) return null;
      const dLeaf = leafNode as DockLeaf;
      const tab = dLeaf.tabs.find((t) => t.tabId === dLeaf.activeTabId);
      return tab?.viewId ?? null;
    }, [dock.tree]);

    const edges = useMemo(() => computePaneEdges(rect), [rect]);
    const tabCount = readLeafTabs(leaf).length;

    return (
      <div
        ref={setLeafEl}
        className={`${styles.leaf}${paneEntering ? ' crish-entrance-fade' : ''}`}
        data-entering={paneEntering ? 'true' : undefined}
        onAnimationEnd={paneAnimationEnd}
        style={
          paneEntering
            ? ({ '--reveal-delay': `${paneDelayMs}ms` } as React.CSSProperties)
            : undefined
        }
        data-leaf-id={leaf.id}
        data-panel-id="chat"
        data-tab-count={tabCount}
        data-session-id={effectiveSessionId || undefined}
        data-active={isActive ? 'true' : 'false'}
        data-dragging-source={isDragSource ? 'true' : 'false'}
        data-has-strip="true"
        data-dock-open={dockOpen ? 'true' : 'false'}
        data-top-row={edges.isTopRow ? 'true' : undefined}
        data-left-edge={edges.isLeftEdge ? 'true' : undefined}
        data-right-edge={edges.isRightEdge ? 'true' : undefined}
        data-bottom-row={edges.isBottomRow ? 'true' : undefined}
        onPointerDownCapture={handleCaptureActivate}
        onFocusCapture={handleCaptureActivate}
        onPointerDown={handleActivate}
        role="region"
        aria-label={t('workspace.leaf.panelRegionLabel', {
          title: viewRegistry.getTitle(mainViewId, mainCtx),
        })}
      >
        <LeafScopeProvider
          leafId={leaf.id}
          sessionId={effectiveSessionId}
          isActive={isActive}
          leafRootRef={leafElRef}
          openTool={handleOpenTool}
        >
          <PaneHeader
            leaf={leaf}
            isActive={isActive}
            isChat
            isTopRow={edges.isTopRow}
          />
          <div
            ref={leafBodyRef}
            className={styles.leafBody}
            data-dock-open={dockOpen ? 'true' : 'false'}
            data-dock-present={dockOpen || dockClosing ? 'true' : 'false'}
          >
            <div className={styles.leafChatColumn}>
              {isChatSurface &&
                !isLeafDraft &&
                !isMaximized &&
                mainViewId === 'chat' && (
                  <UnitChromeActions
                    activeSessionId={sessionForPanel}
                    dockOpen={dockOpen}
                    dockPanelId={activeDockViewId}
                    onOpenPreview={() => handleOpenTool('preview')}
                    onOpenFiles={() => handleOpenTool('files')}
                  />
                )}
              <AppErrorBoundary
                compact
                title={t('workspace.leaf.panelRenderError', {
                  viewId: mainViewId,
                })}
              >
                <Suspense
                  fallback={
                    <div className={styles.emptyState}>
                      {t('workspace.dock.loading')}
                    </div>
                  }
                >
                  {mainResolved.definition ? (
                    <SlotOutlet
                      slotKey="workspace.leaf.panel"
                      context={mainCtx}
                      entryKey={mainResolved.definition.id}
                      fallback={
                        <div className={styles.emptyState}>
                          {t('workspace.leaf.unknownPanelType', {
                            viewId: mainViewId,
                          })}
                        </div>
                      }
                    />
                  ) : (
                    <div className={styles.emptyState}>
                      {t('workspace.leaf.unknownPanelType', {
                        viewId: mainViewId,
                      })}
                    </div>
                  )}
                </Suspense>
              </AppErrorBoundary>
            </div>
            {dockOpen && !isMaximized && !maxAnim && (
              <LeafDockResizer
                leafBodyRef={leafBodyRef}
                widthRatio={dock.widthRatio || 0.5}
                onCommitRatio={handleCommitDockRatio}
              />
            )}
            {dockCapable && (
              <div
                ref={drawerRef}
                className={`${styles.leafDockDrawer} ${
                  isMaximized ? styles.maximized : ''
                } ${maxAnim ? styles.maximizing : ''} chat-side-panel`}
                data-drawer-strip="true"
                data-leaf-dock-drawer="true"
                data-maximized={isMaximized ? 'true' : 'false'}
                style={
                  maxAnim
                    ? {
                        left: maxAnim.left,
                        width: maxAnim.width,
                        ...(maxAnim.go ? {} : { transition: 'none' }),
                      }
                    : undefined
                }
              >
                {(dockOpen || dockClosing) && (
                  <div className={styles.leafDockDrawerInner}>
                    <DockSplitWorkspace
                      leafId={leaf.id}
                      sessionId={sessionForPanel}
                      dock={dock}
                      isMaximized={isMaximized}
                      onToggleMaximize={handleToggleMaximize}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
          {isChatSurface && !isLeafDraft && !isStandaloneTab && (
            <Tooltip
              content={t(
                dockOpen
                  ? 'workspace.dock.collapseSidePanel'
                  : 'workspace.dock.expandSidePanel'
              )}
              side="bottom"
            >
              <Button
                type="button"
                variant="ghost"
                className={`${styles.topSidePanelBtn} top-action-btn top-side-panel-btn`}
                data-testid="top-quick-dock-btn"
                data-active={dockOpen ? 'true' : 'false'}
                aria-label={t(
                  dockOpen
                    ? 'workspace.dock.collapseSidePanel'
                    : 'workspace.dock.expandSidePanel'
                )}
                onClick={handleToggleDock}
              >
                <AppIcon name="sidebar-right" size={16} aria-hidden />
              </Button>
            </Tooltip>
          )}
        </LeafScopeProvider>
      </div>
    );
  },
  (prev, next) =>
    leafPropsEqual(prev.leaf, next.leaf) &&
    rectPropsEqual(prev.rect, next.rect) &&
    prev.isActive === next.isActive &&
    prev.isDragSource === next.isDragSource
);
TreeLeafPanel.displayName = 'TreeLeafPanel';
