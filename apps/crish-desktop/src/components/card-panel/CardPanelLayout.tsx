import React, { lazy, Suspense } from 'react';
import styles from '../CardPanel.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { ChatCard } from '../chat-card/ChatCard';
import { TerminalCard } from '../workspace/TerminalCard';
import { getPanelTitle } from '../../store/layoutHelpers';
import type { CardState, GroupState } from '../../store/layoutStore';
import type { ShowToastFn } from '../../hooks/useToastQueue';

import { PanelLazyFallback } from './PanelLazyFallback';
import { SettingsLegacyRedirect } from './SettingsLegacyRedirect';
import { PlanLegacyRedirect } from './PlanLegacyRedirect';
import { PanelBodyEmpty } from './PanelBodyEmpty';
import { KNOWN_BODY_IDS, getDockOverlayStyle } from './cardPanelHelpers';

export {
  PanelLazyFallback,
  SettingsLegacyRedirect,
  PlanLegacyRedirect,
  PanelBodyEmpty,
  KNOWN_BODY_IDS,
  getDockOverlayStyle,
};

const PreviewCard = lazy(() =>
  import('../workspace/PreviewCard').then((m) => ({ default: m.PreviewCard }))
);
const OverviewCard = lazy(() =>
  import('../overview/OverviewCard').then((m) => ({ default: m.OverviewCard }))
);
const FilesCard = lazy(() =>
  import('../files/FilesCard').then((m) => ({ default: m.FilesCard }))
);
const DiffCard = lazy(() =>
  import('../diff/DiffCard').then((m) => ({ default: m.DiffCard }))
);
const RuntimePanel = lazy(() =>
  import('../workspace/RuntimePanel').then((m) => ({ default: m.RuntimePanel }))
);
const AgentCard = lazy(() =>
  import('../agent-card/AgentCard').then((m) => ({ default: m.AgentCard }))
);

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
