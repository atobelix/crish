/**
 * 右坞分屏子窗格容器（Dock Split System Architecture V2）
 *
 * 遵循最高指导原则：
 * 1. tab.tabId 严密锁死为 React Key，消灭同类工具多开调和 Key 碰撞；
 * 2. SlotOutlet 渲染管线零字符串拆分：entryKey={tab.viewId}，context 传递 panelId: tab.tabId 与 params: tab.params；
 * 3. W3C 容器查询声明 + ResizeObserverManager 动态注入 data-width-tier / data-height-tier；
 * 4. 严守 AGENTS.md §13：克制激活边框（5% 微混），杜绝深黑粗框与厚重阴影。
 */

import React, {
  Suspense,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FlatDockLeaf } from './flattenDockTree';
import type { ToolViewId, ToolTab } from '../../store/layout-tree';
import { LeafToolTabStrip } from './LeafToolTabStrip';
import { AppErrorBoundary } from '../AppErrorBoundary';
import {
  SlotOutlet,
  type ViewRenderContext,
} from '../../services/view-registry';
import { ResizeObserverManager } from '../../utils/ResizeObserverManager';
import { AppIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/Button';
import { useI18n } from '../../i18n';
import styles from './DockPane.module.css';

export interface DockPaneProps {
  flatLeaf: FlatDockLeaf;
  leafId: string;
  sessionId?: string | null;
  isSolo?: boolean;
  isMaximized?: boolean;
  isOnlyPane?: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onAddTab?: (viewId: ToolViewId) => void;
  onSplitRight?: () => void;
  onSplitDown?: () => void;
  onToggleSolo?: () => void;
  onToggleMaximize?: () => void;
  onClosePane?: () => void;
  onFocusPane?: () => void;
}

export const DockPane: React.FC<DockPaneProps> = React.memo(
  ({
    flatLeaf,
    leafId: propLeafId,
    sessionId,
    isSolo = false,
    isMaximized = false,
    isOnlyPane = false,
    onSelectTab,
    onCloseTab,
    onAddTab,
    onSplitRight,
    onSplitDown,
    onToggleSolo,
    onToggleMaximize,
    onClosePane,
    onFocusPane,
  }) => {
    const { t } = useI18n();
    const paneId = propLeafId || flatLeaf.leafId;
    const paneBodyRef = useRef<HTMLDivElement>(null);

    // 尺寸量测与 Tier 状态
    const [widthTier, setWidthTier] = useState<'narrow' | 'compact' | 'normal'>(
      'normal'
    );
    const [heightTier, setHeightTier] = useState<
      'collapsed' | 'compact' | 'normal'
    >('normal');
    const [canSplitHorizontal, setCanSplitHorizontal] = useState(true);
    const [canSplitVertical, setCanSplitVertical] = useState(true);

    useLayoutEffect(() => {
      const el = paneBodyRef.current;
      if (!el) return;

      const updateDimensions = (width: number, height: number) => {
        const nextWidthTier =
          width < 260 ? 'narrow' : width < 340 ? 'compact' : 'normal';
        const nextHeightTier =
          height < 80 ? 'collapsed' : height < 180 ? 'compact' : 'normal';

        setWidthTier(nextWidthTier);
        setHeightTier(nextHeightTier);
        setCanSplitHorizontal(width >= 240);
        setCanSplitVertical(height >= 160);
      };

      const rect = el.getBoundingClientRect();
      const initialWidth = rect.width || el.clientWidth || 0;
      const initialHeight = rect.height || el.clientHeight || 0;
      if (initialWidth > 0 || initialHeight > 0) {
        updateDimensions(initialWidth, initialHeight);
      }

      const handleResize = (entry: ResizeObserverEntry) => {
        const w = entry.contentRect?.width ?? el.clientWidth ?? 0;
        const h = entry.contentRect?.height ?? el.clientHeight ?? 0;
        updateDimensions(w, h);
      };

      const ro = ResizeObserverManager.getInstance();
      ro.observe(el, handleResize, { paneId });

      return () => {
        ro.unobserve(el, handleResize);
      };
    }, [paneId]);

    const handlePointerDownCapture = useCallback(() => {
      if (!flatLeaf.isActive) {
        onFocusPane?.();
      }
    }, [flatLeaf.isActive, onFocusPane]);

    const paneStyle: React.CSSProperties = useMemo(() => {
      if (isSolo) {
        return {
          left: '0%',
          top: '0%',
          width: '100%',
          height: '100%',
          zIndex: 10,
        };
      }
      return {
        left: `${flatLeaf.rect.x * 100}%`,
        top: `${flatLeaf.rect.y * 100}%`,
        width: `${flatLeaf.rect.width * 100}%`,
        height: `${flatLeaf.rect.height * 100}%`,
      };
    }, [flatLeaf.rect, isSolo]);

    const handleAddDefaultTab = useCallback(
      (viewId: ToolViewId) => {
        onAddTab?.(viewId);
      },
      [onAddTab]
    );

    return (
      <div
        className={styles.pane}
        style={paneStyle}
        data-leaf-id={paneId}
        data-dock-leaf-id={paneId}
        data-active={flatLeaf.isActive ? 'true' : 'false'}
        data-solo={isSolo ? 'true' : 'false'}
        data-width-tier={widthTier}
        data-height-tier={heightTier}
        onPointerDownCapture={handlePointerDownCapture}
      >
        <LeafToolTabStrip
          paneId={paneId}
          leafId={paneId}
          sessionId={sessionId ?? null}
          tabs={flatLeaf.tabs}
          activeTabId={flatLeaf.activeTabId}
          canSplitHorizontal={canSplitHorizontal}
          canSplitVertical={canSplitVertical}
          isSolo={isSolo}
          isMaximized={isMaximized}
          canClosePane={true}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onAddTab={onAddTab}
          onSplitRight={onSplitRight}
          onSplitDown={onSplitDown}
          onToggleSolo={isOnlyPane ? undefined : onToggleSolo}
          onToggleMaximize={onToggleMaximize ?? onToggleSolo}
          onClosePane={onClosePane}
        />

        <div
          ref={paneBodyRef}
          className={styles.paneBody}
          data-width-tier={widthTier}
          data-height-tier={heightTier}
        >
          {flatLeaf.tabs.length === 0 ? (
            <div
              className={styles.emptyState}
              data-testid="dock-pane-empty-state"
            >
              <div className={styles.emptyStateTitle}>
                {t('workspace.dock.emptyTitle')}
              </div>
              <div className={styles.emptyStateDesc}>
                {t('workspace.dock.emptyDesc')}
              </div>
              {onAddTab && (
                <div className={styles.emptyActionGrid}>
                  <Button
                    variant="unstyled"
                    className={styles.emptyActionBtn}
                    onClick={() => handleAddDefaultTab('terminal')}
                  >
                    <AppIcon name="terminal" size={13} aria-hidden />
                    <span>{t('workspace.dock.toolTerminal')}</span>
                  </Button>
                  <Button
                    variant="unstyled"
                    className={styles.emptyActionBtn}
                    onClick={() => handleAddDefaultTab('preview')}
                  >
                    <AppIcon name="globe" size={13} aria-hidden />
                    <span>{t('workspace.dock.toolPreview')}</span>
                  </Button>
                  <Button
                    variant="unstyled"
                    className={styles.emptyActionBtn}
                    onClick={() => handleAddDefaultTab('files')}
                  >
                    <AppIcon name="folder" size={13} aria-hidden />
                    <span>{t('workspace.dock.toolFiles')}</span>
                  </Button>
                  <Button
                    variant="unstyled"
                    className={styles.emptyActionBtn}
                    onClick={() => handleAddDefaultTab('diff')}
                  >
                    <AppIcon name="code" size={13} aria-hidden />
                    <span>{t('workspace.dock.toolDiff')}</span>
                  </Button>
                </div>
              )}
            </div>
          ) : (
            flatLeaf.tabs.map((tab: ToolTab) => {
              const isPanelActive = tab.tabId === flatLeaf.activeTabId;
              const context: ViewRenderContext = {
                panelId: tab.tabId,
                leafId: paneId,
                sessionId: sessionId ?? undefined,
                isActive: isPanelActive,
                openView: (viewId: string) => onAddTab?.(viewId as ToolViewId),
                fallbackTitle: tab.title,
                params: tab.params as Record<string, unknown> | undefined,
              };

              return (
                <div
                  key={tab.tabId}
                  className={styles.toolOutletPane}
                  style={{ display: isPanelActive ? 'flex' : 'none' }}
                  data-tab-id={tab.tabId}
                  data-view-id={tab.viewId}
                  data-active-tab={isPanelActive ? 'true' : 'false'}
                  aria-hidden={!isPanelActive}
                >
                  <AppErrorBoundary
                    compact
                    title={t('workspace.dock.renderError')}
                  >
                    <Suspense
                      fallback={
                        <div className={styles.emptyState}>
                          {t('workspace.dock.loading')}
                        </div>
                      }
                    >
                      <SlotOutlet
                        slotKey="workspace.leaf.panel"
                        entryKey={tab.viewId}
                        context={context}
                        fallback={
                          <div className={styles.emptyState}>
                            {t('workspace.dock.loadFailed', {
                              name: tab.title ?? tab.viewId,
                            })}
                          </div>
                        }
                      />
                    </Suspense>
                  </AppErrorBoundary>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }
);

DockPane.displayName = 'DockPane';
