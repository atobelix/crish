import React from 'react';
import type { SessionState } from '../../../store/types';
import { GENERAL_FOLDER } from '../../../api/projectStore';
import { navigateToNewDraft } from '../../../store/storeAccess';
import type { SessionListWindowRange } from '../../../api/sessionListWindow';
import { WindowedSessionUl } from './WindowedSessionUl';
import { resolveActualScrollHost } from './useSessionListWindow';
import { Button, Tooltip } from '../../ui';
import styles from '../SidebarSessionList.module.css';
import { AppIcon } from '../../ui/icons/index';

export interface GeneralSectionProps {
  generalSessions: SessionState[];
  generalCollapsed: boolean;
  generalWindowEnabled: boolean;
  generalRenderRange: SessionListWindowRange;
  generalListRef: React.RefObject<HTMLUListElement | null>;
  onToggleGeneral: () => void;
  onSortBtnClick: (e: React.MouseEvent) => void;
  sortTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  /** Kept for SidebarSessionList API; reorder is pointer drop-only via SessionRow. */
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  renderSessionItem: (s: SessionState) => React.ReactNode;
}

const GENERAL_FOLD_LIMIT = 10;

export function GeneralSection({
  generalSessions,
  generalCollapsed,
  generalWindowEnabled,
  generalRenderRange,
  generalListRef,
  onToggleGeneral,
  onSortBtnClick,
  sortTriggerRef,
  onMoveSessionRealtime: _onMoveSessionRealtime,
  renderSessionItem,
}: GeneralSectionProps) {
  void _onMoveSessionRealtime;
  const [isExpanded, setIsExpanded] = React.useState(false);

  React.useEffect(() => {
    const listEl = generalListRef.current;
    if (!listEl) return;
    const host = resolveActualScrollHost(null, listEl);
    host?.dispatchEvent(new Event('scroll'));
  }, [isExpanded, generalWindowEnabled, generalListRef]);

  const displayedSessions = isExpanded
    ? generalSessions
    : generalSessions.slice(0, GENERAL_FOLD_LIMIT);

  return (
    <section className={styles.section} aria-label="对话">
      <div
        className={styles.sectionLabelRow}
        onClick={onToggleGeneral}
        style={{ cursor: 'pointer' }}
      >
        <div className={styles.sectionLabelLeft}>
          <Button
            variant="ghost"
            type="button"
            className={styles.sectionLabel}
            onClick={(e) => {
              e.stopPropagation();
              onToggleGeneral();
            }}
            aria-expanded={!generalCollapsed}
          >
            <span>对话</span>
            <AppIcon
              name="chevron-down"
              size={16}
              className={generalCollapsed ? styles.chevCollapsed : ''}
              aria-hidden
            />
          </Button>
          <Tooltip content="排序与过滤">
            <Button
              ref={sortTriggerRef}
              type="button"
              variant="ghost"
              size="sm"
              className={styles.sectionSortBtn}
              aria-label="排序与过滤"
              onClick={(e) => {
                e.stopPropagation();
                onSortBtnClick(e);
              }}
              icon={<AppIcon name="chevrons-up-down" size={16} aria-hidden />}
            />
          </Tooltip>
        </div>
        <Tooltip content="新建常规对话">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.sectionNew}
            aria-label="新建常规对话"
            onClick={(e) => {
              e.stopPropagation();
              navigateToNewDraft(GENERAL_FOLDER);
            }}
            icon={<AppIcon name="message-circle-plus" size={16} aria-hidden />}
          />
        </Tooltip>
      </div>
      <div
        className={styles.accordionWrapper}
        data-expanded={!generalCollapsed ? 'true' : 'false'}
      >
        <div
          className={styles.accordionInner}
          data-drop-zone="general"
          data-folder-name={GENERAL_FOLDER}
        >
          {generalSessions.length > 0 ? (
            <>
              {generalWindowEnabled && isExpanded ? (
                <WindowedSessionUl
                  sessions={generalSessions}
                  range={generalRenderRange}
                  listRef={generalListRef}
                  className={`${styles.pinnedList} ${styles.folderSessions}`}
                  renderRow={renderSessionItem}
                  ariaLabel="对话列表"
                />
              ) : (
                <ul
                  ref={generalListRef}
                  className={`${styles.pinnedList} ${styles.folderSessions}`}
                  role="tree"
                  aria-label="对话列表"
                  data-windowed="0"
                  data-window-count={displayedSessions.length}
                  data-drop-zone="general"
                  data-folder-name={GENERAL_FOLDER}
                >
                  {displayedSessions.map((s) => renderSessionItem(s))}
                </ul>
              )}
              {generalSessions.length > GENERAL_FOLD_LIMIT && (
                <div className={styles.foldToggleRow}>
                  <Button
                    variant="ghost"
                    type="button"
                    className={styles.foldToggleBtn}
                    onClick={() => setIsExpanded((prev) => !prev)}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded
                      ? '收起'
                      : `查看全部 (${generalSessions.length})`}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div
              className={`${styles.emptyHint} ${styles.subtle}`}
              role="status"
            >
              不在项目中的对话会出现在这里
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
