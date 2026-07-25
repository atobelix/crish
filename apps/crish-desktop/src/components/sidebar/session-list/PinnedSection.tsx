import React from 'react';
import type { SessionState } from '../../../store/layoutStore';
import { DragReorderSection } from './DragReorderSection';
import styles from '../SidebarSessionList.module.css';
import { ChevronDown } from 'lucide-react';

export interface PinnedSectionProps {
  pinnedSessions: SessionState[];
  pinnedCollapsed: boolean;
  pinnedZoneRef: React.RefObject<HTMLDivElement | null>;
  dragOverPinned: boolean;
  filterType: 'all' | 'pinned';
  onTogglePinned: () => void;
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
  onMoveSessionRealtime,
  renderSessionItem,
}: PinnedSectionProps) {
  return (
    <section className={styles.section} aria-label="置顶会话">
      <button
        type="button"
        className={styles.sectionLabel}
        onClick={onTogglePinned}
        aria-expanded={!pinnedCollapsed}
        aria-controls="sb-pinned-zone"
        style={{ width: '100%', cursor: 'pointer' }}
      >
        <span>置顶</span>
        <ChevronDown
          size={14}
          className={pinnedCollapsed ? styles.chevCollapsed : ''}
          aria-hidden
        />
      </button>
      <div
        className={styles.accordionWrapper}
        data-expanded={!pinnedCollapsed ? 'true' : 'false'}
      >
        <div className={styles.accordionInner}>
          <div
            id="sb-pinned-zone"
            ref={pinnedZoneRef}
            className={`${styles.pinnedDropZone} ${dragOverPinned ? styles.dragOver : ''}`}
          >
            {pinnedSessions.length > 0 ? (
              <ul
                className={`${styles.pinnedList} ${styles.folderSessions}`}
                role="tree"
                aria-label="置顶会话列表"
              >
                <DragReorderSection
                  sessions={pinnedSessions}
                  isPinned
                  onMoveSessionRealtime={onMoveSessionRealtime}
                  renderRow={(s) => renderSessionItem(s)}
                />
              </ul>
            ) : (
              <div
                className={`${styles.emptyHint} ${styles.subtle}`}
                role="status"
              >
                {filterType === 'pinned'
                  ? '还没有置顶 of 对话'
                  : '置顶的对话会出现在这里'}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
