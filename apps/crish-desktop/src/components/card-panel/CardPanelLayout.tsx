import React, { lazy, Suspense } from 'react';
import styles from '../CardPanel.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { ChatCard } from '../ChatCard';
import { TerminalCard } from '../TerminalCard';
import { focusOrOpenPanel, openSettings } from '../../api/storeAccess';
import { LayoutPanelLeft } from 'lucide-react';
import { getPanelTitle } from '../../store/layoutHelpers';
import type { CardState, GroupState } from '../../store/layoutStore';
import type { ShowToastFn } from '../../hooks/useToastQueue';

const PreviewCard = lazy(() =>
  import('../PreviewCard').then((m) => ({ default: m.PreviewCard }))
);
const OverviewCard = lazy(() =>
  import('../OverviewCard').then((m) => ({ default: m.OverviewCard }))
);
const FilesCard = lazy(() =>
  import('../FilesCard').then((m) => ({ default: m.FilesCard }))
);
const DiffCard = lazy(() =>
  import('../DiffCard').then((m) => ({ default: m.DiffCard }))
);
const RuntimePanel = lazy(() =>
  import('../RuntimePanel').then((m) => ({ default: m.RuntimePanel }))
);
const AgentCard = lazy(() =>
  import('../AgentCard').then((m) => ({ default: m.AgentCard }))
);

export function PanelLazyFallback() {
  return (
    <div
      className="skel-shimmer"
      style={{ height: '100%', minHeight: 48, borderRadius: 6 }}
      aria-hidden="true"
    />
  );
}

export const KNOWN_BODY_IDS = new Set([
  'chat',
  'preview',
  'overview',
  'files',
  'diff',
  'terminal',
  'settings',
  'runtime',
  'agent',
]);

export function SettingsLegacyRedirect() {
  React.useEffect(() => {
    openSettings();
  }, []);
  return (
    <div className="panel-legacy-redirect" role="status" aria-live="polite">
      <span>正在打开设置…</span>
    </div>
  );
}

export function PlanLegacyRedirect({ wsId }: { wsId: string }) {
  React.useEffect(() => {
    focusOrOpenPanel(wsId, 'overview');
  }, [wsId]);
  return (
    <div className="panel-legacy-redirect" role="status" aria-live="polite">
      <span>已自动跳转到项目总览…</span>
    </div>
  );
}

export function PanelBodyEmpty({
  title,
  hint,
  onOpenOverview,
}: {
  title: string;
  hint: string;
  onOpenOverview: () => void;
}) {
  return (
    <div
      className={`${styles.empty} panel-body-empty`}
      role="status"
      aria-live="polite"
    >
      <LayoutPanelLeft
        size={22}
        strokeWidth={1.5}
        aria-hidden
        className={styles.emptyIcon}
      />
      <div className={styles.emptyTitle}>{title}</div>
      <div className={styles.emptyHint}>{hint}</div>
      <button
        type="button"
        className={`${styles.emptyBtn} card-action-btn`}
        onClick={onOpenOverview}
        aria-label="打开总览侧栏"
      >
        打开总览
      </button>
    </div>
  );
}

export function getDockOverlayStyle(
  showDockOverlay: boolean,
  dropPreview: { direction: 'merge' | 'top' | 'bottom' } | null
): React.CSSProperties | null {
  if (!showDockOverlay || !dropPreview) return null;
  const { direction } = dropPreview;
  if (direction === 'merge') {
    return {
      position: 'absolute',
      top: '6px',
      left: '10px',
      right: '10px',
      height: '32px',
      borderRadius: '6px',
      backgroundColor:
        'color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)',
      border:
        '1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent)',
      animation: 'pulse-merge-highlight 1.5s infinite ease-in-out',
      pointerEvents: 'none',
      zIndex: 'var(--z-drag-highlight)',
    };
  } else if (direction === 'top') {
    return {
      position: 'absolute',
      top: '48px',
      left: '10px',
      right: '10px',
      height: 'calc((100% - 58px) / 2)',
      borderRadius: '6px',
      backgroundColor:
        'color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)',
      border:
        '1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent)',
      animation: 'pulse-merge-highlight 1.5s infinite ease-in-out',
      pointerEvents: 'none',
      zIndex: 'var(--z-drag-highlight)',
    };
  } else if (direction === 'bottom') {
    return {
      position: 'absolute',
      top: 'calc(48px + (100% - 58px) / 2)',
      bottom: '10px',
      left: '10px',
      right: '10px',
      borderRadius: '6px',
      backgroundColor:
        'color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)',
      border:
        '1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent)',
      animation: 'pulse-merge-highlight 1.5s infinite ease-in-out',
      pointerEvents: 'none',
      zIndex: 'var(--z-drag-highlight)',
    };
  }
  return null;
}

export interface CardPanelLayoutProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  activeCardId: string;
  group: GroupState;
  panelBodyId: string;
  tabIdPrefix: string;
  isEmptyGroup: boolean;
  hasKnownBody: boolean;
  activeTitle: string;
  onShowToast: ShowToastFn;
  handleGlobalTabClick: (cardId: string) => void;
  closeToolTab: (cardId: string, focusAfter: string | null) => void;
  resolveFocusAfterClose: (cardId: string) => string;
  hasMountedRef: React.MutableRefObject<Record<string, boolean>>;
}

export const CardPanelLayout: React.FC<CardPanelLayoutProps> = React.memo(
  ({
    wsId,
    colIdx,
    groupIdx,
    activeCardId,
    group,
    panelBodyId,
    tabIdPrefix,
    isEmptyGroup,
    hasKnownBody,
    activeTitle,
    onShowToast,
    handleGlobalTabClick,
    closeToolTab,
    resolveFocusAfterClose,
    hasMountedRef,
  }) => {
    return (
      <div
        className="card-body"
        id={panelBodyId}
        role={activeCardId === 'chat' ? undefined : 'tabpanel'}
        aria-label={
          activeCardId === 'chat' ? undefined : `${activeTitle}内容`
        }
        aria-labelledby={
          activeCardId === 'chat'
            ? undefined
            : `${tabIdPrefix}-${activeCardId}`
        }
      >
        <AppErrorBoundary compact>
          {isEmptyGroup && (
            <PanelBodyEmpty
              title="暂无面板"
              hint="从 + 添加面板"
              onOpenOverview={() => handleGlobalTabClick('overview')}
            />
          )}
          {!isEmptyGroup && activeCardId === 'chat' && (
            <ChatCard
              wsId={wsId}
              colIdx={colIdx}
              groupIdx={groupIdx}
              onShowToast={onShowToast}
              handleGlobalTabClick={handleGlobalTabClick}
            />
          )}
          {!isEmptyGroup &&
            group.cards
              .filter((c: CardState) => c.id !== 'chat')
              .map((c: CardState) => {
                const id = c.id;
                const active = id === activeCardId;
                const known = KNOWN_BODY_IDS.has(id);
                if (active) hasMountedRef.current[id] = true;
                const shouldMount =
                  id === 'terminal' || !!hasMountedRef.current[id];
                if (!shouldMount) return null;
                return (
                  <div
                    key={id}
                    className={`${styles.pane} card-body-pane`}
                    data-panel-id={id}
                    data-active={active ? '1' : '0'}
                    hidden={!active}
                    aria-hidden={!active}
                  >
                    <Suspense fallback={<PanelLazyFallback />}>
                      {id === 'preview' ? (
                        <PreviewCard wsId={wsId} onShowToast={onShowToast} />
                      ) : null}
                      {id === 'overview' ? (
                        <OverviewCard
                          wsId={wsId}
                          onOpenPanel={handleGlobalTabClick}
                          onShowToast={onShowToast}
                        />
                      ) : null}
                      {id === 'files' ? (
                        <FilesCard onShowToast={onShowToast} />
                      ) : null}
                      {id === 'diff' ? (
                        <DiffCard onShowToast={onShowToast} />
                      ) : null}
                      {id === 'runtime' ? (
                        <RuntimePanel wsId={wsId} onShowToast={onShowToast} />
                      ) : null}
                      {id === 'agent' ? (
                        <div className="agent-panel-shell">
                          <AgentCard
                            onClose={() => {
                              closeToolTab(
                                'agent',
                                resolveFocusAfterClose('agent')
                              );
                            }}
                          />
                        </div>
                      ) : null}
                    </Suspense>
                    {id === 'tasks' ? (
                      <PlanLegacyRedirect wsId={wsId} />
                    ) : null}
                    {id === 'terminal' ? <TerminalCard /> : null}
                    {id === 'settings' ? <SettingsLegacyRedirect /> : null}
                    {id === 'plan' ? (
                      <PlanLegacyRedirect wsId={wsId} />
                    ) : null}
                    {!known && active ? (
                      <PanelBodyEmpty
                        title={`无法显示「${getPanelTitle(id)}」`}
                        hint="从标签栏关闭后重新添加"
                        onOpenOverview={() =>
                          handleGlobalTabClick('overview')
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
          {!isEmptyGroup &&
            activeCardId !== 'chat' &&
            !group.cards.some((c: CardState) => c.id === activeCardId) &&
            !hasKnownBody && (
              <PanelBodyEmpty
                title={`无法显示「${activeTitle}」`}
                hint="从标签栏关闭后重新添加"
                onOpenOverview={() => handleGlobalTabClick('overview')}
              />
            )}
        </AppErrorBoundary>
      </div>
    );
  }
);

CardPanelLayout.displayName = 'CardPanelLayout';
