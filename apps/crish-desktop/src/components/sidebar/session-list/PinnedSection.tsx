import React from 'react';
import type { SessionState } from '../../../store/layoutStore';
import styles from '../SidebarSessionList.module.css';
import { ChevronDown } from 'lucide-react';

export interface PinnedSectionProps {
  pinnedSessions: SessionState[];
  pinnedCollapsed: boolean;
  pinnedZoneRef: React.RefObject<HTMLDivElement | null>;
  dragOverPinned: boolean;
  filterType: 'all' | 'pinned';
  onTogglePinned: () => void;
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
          <button
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
            <ChevronDown
              size={14}
              className={pinnedCollapsed ? styles.chevCollapsed : ''}
              aria-hidden
            />
          </button>
        </div>
      </div>
      <div
        className={styles.accordionWrapper}
        data-expanded={!pinnedCollapsed ? 'true' : 'false'}
        hidden={pinnedCollapsed || undefined}
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
