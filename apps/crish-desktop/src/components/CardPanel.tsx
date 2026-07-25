import React from 'react';
import { useLayoutStore } from '../store/layoutStore';
import styles from './CardPanel.module.css';
import { useSessionStore, selectActiveSession } from '../store/sessionStore';
import { useTabDrag } from '../hooks/useTabDrag';
import { getPanelTitle } from '../store/layoutHelpers';
import type { ShowToastFn } from '../hooks/useToastQueue';
import { GENERAL_FOLDER, getActiveProject } from '../api/projectStore';
import {
  sessionListDisplayTitle,
  EMPTY_SESSION_TITLE,
} from '../api/sessionTitle';
import type { LayoutStore, WorkspaceState } from '../store/layoutStore';

import { CardPanelHeader } from './card-panel/CardPanelHeader';
import { CardPanelLayout, KNOWN_BODY_IDS } from './card-panel/CardPanelLayout';
import { useCardPanelTabs } from './card-panel/useCardPanelTabs';

interface CardPanelProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: ShowToastFn;
  heightRatio?: number;
}

export const CardPanel: React.FC<CardPanelProps> = React.memo(
  ({ wsId, colIdx, groupIdx, onShowToast, heightRatio }) => {
    const wsSelector = React.useMemo(
      () => (s: LayoutStore) =>
        s.workspaces.find((w: WorkspaceState) => w.id === wsId),
      [wsId]
    );
    const ws = useLayoutStore(wsSelector);
    const shellChrome = useLayoutStore((s) => s.shellChromeMode || 'classic');
    const chatMainSurface = useLayoutStore((s) => s.chatMainSurface || 'chat');
    const activeSession = useSessionStore(selectActiveSession);
    const draggedTab = useLayoutStore((s) => s.draggedTab);

    const reactId = React.useId();
    const tabIdPrefix = `cp-tab-${reactId}`;
    const panelBodyId = `cp-body-${reactId}`;
    const tabAddMenuId = `cp-add-menu-${reactId}`;

    const col = ws?.columns[colIdx];
    const group = col?.groups[groupIdx];

    const {
      dockOverlayStyle,
      activeCardId,
      cardsLen,
      tabAddOpen,
      tabAddPos,
      setTabAddOpen,
      setTabAddPos,
      tabsBarRef,
      tabAddBtnRef,
      tabAddMenuRef,
      handleGlobalTabClick,
      handleTabClick,
      closeToolTab,
      resolveFocusAfterClose,
      onTabKeyDown,
      onAddMenuKeyDown,
    } = useCardPanelTabs({
      wsId,
      colIdx,
      groupIdx,
      group,
    });

    const { handleTabPointerDown } = useTabDrag({
      wsId,
      groupId: group?.id ?? '',
      cardsLength: cardsLen,
    });

    const hasMountedRef = React.useRef<Record<string, boolean>>({});

    const insetChatChrome = shellChrome === 'inset' && activeCardId === 'chat';
    const scheduledChrome =
      activeCardId === 'chat' && chatMainSurface === 'scheduled';

    if (!ws || !col || !group) return null;

    const isDraggingThisGroup =
      draggedTab &&
      draggedTab.sourceGroupId === group.id &&
      (!draggedTab.isTabDrag || group.cards.length === 1);

    const activeTitle = getPanelTitle(activeCardId);
    const folderRaw = (activeSession?.folder || '').trim();
    const folderLabel =
      folderRaw && folderRaw !== GENERAL_FOLDER
        ? folderRaw
        : getActiveProject()?.name || GENERAL_FOLDER;
    const sessionLabel =
      (activeSession
        ? sessionListDisplayTitle(activeSession) || activeSession.title
        : ''
      )?.trim() || EMPTY_SESSION_TITLE;
    const regionLabel =
      activeCardId === 'chat' ? `对话 · ${sessionLabel}` : `${activeTitle}面板`;
    const hasKnownBody = KNOWN_BODY_IDS.has(activeCardId);
    const isEmptyGroup = cardsLen === 0;

    const isEmptyChat =
      activeCardId === 'chat' &&
      (!activeSession ||
        (activeSession.messages.length === 0 && !activeSession.isPinned));

    return (
      <div
        className={`${styles.card} workspace-card ${activeCardId === 'chat' ? 'flat-layout' : ''} ${isDraggingThisGroup ? 'drag-ghost-hidden' : ''} ${insetChatChrome ? 'workspace-card--no-chat-chrome' : ''}`}
        data-group-id={group.id}
        data-col-idx={colIdx}
        data-group-idx={groupIdx}
        data-active-card={activeCardId}
        data-hide-chat-chrome={insetChatChrome ? '1' : undefined}
        role="region"
        aria-label={regionLabel}
        style={{
          height: `${(heightRatio !== undefined ? heightRatio : group.heightRatio) * 100}%`,
        }}
      >
        <CardPanelHeader
          activeCardId={activeCardId}
          group={group}
          activeSession={activeSession}
          sessionLabel={sessionLabel}
          folderLabel={folderLabel}
          insetChatChrome={insetChatChrome}
          scheduledChrome={scheduledChrome}
          isEmptyChat={isEmptyChat}
          tabsBarRef={tabsBarRef}
          tabAddBtnRef={tabAddBtnRef}
          tabAddMenuRef={tabAddMenuRef}
          tabIdPrefix={tabIdPrefix}
          panelBodyId={panelBodyId}
          tabAddMenuId={tabAddMenuId}
          draggedTab={draggedTab}
          handleTabClick={handleTabClick}
          handleTabPointerDown={handleTabPointerDown}
          onTabKeyDown={onTabKeyDown}
          closeToolTab={closeToolTab}
          resolveFocusAfterClose={resolveFocusAfterClose}
          handleGlobalTabClick={handleGlobalTabClick}
          tabAddOpen={tabAddOpen}
          tabAddPos={tabAddPos}
          setTabAddOpen={setTabAddOpen}
          setTabAddPos={setTabAddPos}
          onAddMenuKeyDown={onAddMenuKeyDown}
        />

        <CardPanelLayout
          wsId={wsId}
          colIdx={colIdx}
          groupIdx={groupIdx}
          activeCardId={activeCardId}
          group={group}
          panelBodyId={panelBodyId}
          tabIdPrefix={tabIdPrefix}
          isEmptyGroup={isEmptyGroup}
          hasKnownBody={hasKnownBody}
          activeTitle={activeTitle}
          onShowToast={onShowToast}
          handleGlobalTabClick={handleGlobalTabClick}
          closeToolTab={closeToolTab}
          resolveFocusAfterClose={resolveFocusAfterClose}
          hasMountedRef={hasMountedRef}
        />

        {dockOverlayStyle && (
          <div style={dockOverlayStyle} aria-hidden="true" />
        )}
      </div>
    );
  }
);
CardPanel.displayName = 'CardPanel';
