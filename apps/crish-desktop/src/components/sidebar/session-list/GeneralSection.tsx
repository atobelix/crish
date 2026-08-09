import React from 'react';
import type { SessionState } from '../../../store/layoutStore';
import { GENERAL_FOLDER } from '../../../api/projectStore';
import { emitUiEvent } from '../../../api/uiEvents';
import { getCompositionRoot } from '../../../app/compositionRoot';
import type { SessionListWindowRange } from '../../../api/sessionListWindow';
import { WindowedSessionUl } from './WindowedSessionUl';
import { Tooltip } from '../../ui';
import styles from '../SidebarSessionList.module.css';
import { ChevronDown, ChevronsUpDown, MessageCirclePlus } from 'lucide-react';

export interface GeneralSectionProps {
  generalSessions: SessionState[];
  generalCollapsed: boolean;
  generalWindowEnabled: boolean;
  generalRenderRange: SessionListWindowRange;
  generalListRef: React.RefObject<HTMLUListElement | null>;
  showAllGeneralSessions: boolean;
  onToggleGeneral: () => void;
  onSortBtnClick: (e: React.MouseEvent) => void;
  onToggleShowAllGeneralSessions: () => void;
  /** Kept for SidebarSessionList API; reorder is pointer drop-only via SessionRow. */
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  renderSessionItem: (s: SessionState) => React.ReactNode;
}

export function GeneralSection({
  generalSessions,
  generalCollapsed,
  generalWindowEnabled,
  generalRenderRange,
  generalListRef,
  showAllGeneralSessions,
  onToggleGeneral,
  onSortBtnClick,
  onToggleShowAllGeneralSessions,
  onMoveSessionRealtime: _onMoveSessionRealtime,
  renderSessionItem,
}: GeneralSectionProps) {
  void _onMoveSessionRealtime;
  const visibleSessions =
    showAllGeneralSessions || generalSessions.length <= 10
      ? generalSessions
      : generalSessions.slice(0, 10);

  return (
    <section className={styles.section} aria-label="对话">
      <div
        className={styles.sectionLabelRow}
        onClick={onToggleGeneral}
        style={{ cursor: 'pointer' }}
      >
        <div className={styles.sectionLabelLeft}>
          <button
            type="button"
            className={styles.sectionLabel}
            onClick={(e) => {
              e.stopPropagation();
              onToggleGeneral();
            }}
            aria-expanded={!generalCollapsed}
          >
            <span>对话</span>
            <ChevronDown
              size={14}
              className={generalCollapsed ? styles.chevCollapsed : ''}
              aria-hidden
            />
          </button>
          <Tooltip content="排序与过滤">
            <button
              type="button"
              className={styles.sectionSort}
              aria-label="排序与过滤"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                onSortBtnClick(e);
              }}
            >
              <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        </div>
        <div className={styles.sectionLabelRight}>
          <Tooltip content="新建常规对话">
            <button
              type="button"
              className={styles.sectionNew}
              aria-label="新建常规对话"
              onClick={(e) => {
                e.stopPropagation();
                getCompositionRoot().shell.openNewDraftTab(GENERAL_FOLDER);
                emitUiEvent('open-chat');
              }}
            >
              <MessageCirclePlus
                size={14}
                strokeWidth={1.75}
                aria-hidden
              />
            </button>
          </Tooltip>
        </div>
      </div>
      <div
        className={styles.accordionWrapper}
        data-expanded={!generalCollapsed ? 'true' : 'false'}
        hidden={generalCollapsed || undefined}
      >
        <div
          className={styles.accordionInner}
          data-drop-zone="general"
          data-folder-name={GENERAL_FOLDER}
        >
          {generalSessions.length > 0 ? (
            <>
              {generalWindowEnabled ? (
                <WindowedSessionUl
                  sessions={visibleSessions}
                  range={generalRenderRange}
                  listRef={generalListRef}
                  className={`${styles.pinnedList} ${styles.folderSessions}`}
                  renderRow={renderSessionItem}
                  ariaLabel="对话列表"
                />
              ) : (
                <ul
                  className={`${styles.pinnedList} ${styles.folderSessions}`}
                  role="tree"
                  aria-label="对话列表"
                  data-windowed="0"
                  data-window-count={generalSessions.length}
                  data-drop-zone="general"
                  data-folder-name={GENERAL_FOLDER}
                >
                  {visibleSessions.map((s) => renderSessionItem(s))}
                </ul>
              )}
              {generalSessions.length > 10 && !showAllGeneralSessions && (
                <div
                  className={styles.accordionWrapper}
                  data-expanded={
                    showAllGeneralSessions ? 'true' : 'false'
                  }
                >
                  <div className={styles.accordionInner}>
                    <ul
                      className={`${styles.pinnedList} ${styles.folderSessions}`}
                      style={{ paddingTop: 3 }}
                    >
                      {generalSessions
                        .slice(10)
                        .map((s) => renderSessionItem(s))}
                    </ul>
                  </div>
                </div>
              )}
              {generalSessions.length > 10 && (
                <div
                  style={{
                    paddingLeft: 10,
                    paddingRight: 8,
                    marginTop: 4,
                  }}
                >
                  <button
                    type="button"
                    className={`${styles.sessionItem} ${styles.sessionItemFoldBtn}`}
                    style={{ color: 'var(--text-tertiary)' }}
                    onClick={onToggleShowAllGeneralSessions}
                  >
                    {showAllGeneralSessions
                      ? '收起'
                      : `查看全部 (${generalSessions.length})`}
                  </button>
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
