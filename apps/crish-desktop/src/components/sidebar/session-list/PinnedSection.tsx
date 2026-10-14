import React from 'react';
import type { SessionState } from '../../../store/types';
import { Button, Tooltip } from '../../ui';
import styles from '../SidebarSessionList.module.css';
import { AppIcon } from '../../ui/icons/index';

export interface PinnedSectionProps {
  pinnedSessions: SessionState[];
  pinnedCollapsed: boolean;
  pinnedZoneRef: React.RefObject<HTMLDivElement | null>;
  dragOverPinned: boolean;
  filterType: 'all' | 'pinned';
  onTogglePinned: () => void;
  onSortBtnClick?: (e: React.MouseEvent) => void;
  sortTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  sortDropdownOpen?: boolean;
  /** Kept for SidebarSessionList API; reorder is pointer drop-only via SessionRow. */
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  renderSessionItem: (s: SessionState) => React.ReactNode;
}

export function PinnedSection({
  pinnedSessions,
  pinnedCollapsed,
  pinnedZoneRef,
  dragOverPinned,
  filterType,
  onTogglePinned,
  onSortBtnClick,
  sortTriggerRef,
  sortDropdownOpen = false,
  onMoveSessionRealtime: _onMoveSessionRealtime,
  renderSessionItem,
}: PinnedSectionProps) {
  void _onMoveSessionRealtime;
  return (
    <section className={styles.section} aria-label="置顶会话">
      <div
        className={styles.sectionLabelRow}
        onClick={onTogglePinned}
        style={{ cursor: 'pointer' }}
      >
        <div className={styles.sectionLabelLeft}>
          <Button
            variant="ghost"
            type="button"
            className={styles.sectionLabel}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePinned();
            }}
            aria-expanded={!pinnedCollapsed}
            aria-controls="sb-pinned-zone"
          >
            <span>置顶</span>
            <AppIcon
              name="chevron-down"
              size={16}
              className={pinnedCollapsed ? styles.chevCollapsed : ''}
              aria-hidden
            />
          </Button>
        </div>
        {filterType === 'pinned' && onSortBtnClick ? (
          <div className={styles.sectionLabelRight}>
            <Tooltip content="排序与过滤">
              <Button
                ref={sortTriggerRef}
                type="button"
                variant="ghost"
                size="sm"
                className={styles.sectionSortBtn}
                aria-label="排序与过滤"
                aria-expanded={sortDropdownOpen}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  onSortBtnClick(e);
                }}
                icon={<AppIcon name="chevrons-up-down" size={16} aria-hidden />}
              />
            </Tooltip>
          </div>
        ) : null}
      </div>
      <div
        className={styles.accordionWrapper}
        data-expanded={!pinnedCollapsed ? 'true' : 'false'}
      >
        <div className={styles.accordionInner}>
          <div
            id="sb-pinned-zone"
            ref={pinnedZoneRef}
            data-drop-zone="pinned"
            className={`${styles.pinnedDropZone} ${dragOverPinned ? styles.dragOver : ''}`}
          >
            {pinnedSessions.length > 0 ? (
              <ul
                className={`${styles.pinnedList} ${styles.folderSessions}`}
                role="tree"
                aria-label="置顶会话列表"
              >
                {pinnedSessions.map((s) => renderSessionItem(s))}
              </ul>
            ) : (
              <div
                className={`${styles.emptyHint} ${styles.subtle}`}
                role="status"
              >
                {filterType === 'pinned'
                  ? '还没有置顶的对话'
                  : '置顶的对话会出现在这里'}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
