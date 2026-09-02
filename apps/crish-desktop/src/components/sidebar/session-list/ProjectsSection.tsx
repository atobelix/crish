import React, { useState } from 'react';
import type { SessionState } from '../../../store/types';
import type { ProjectEntry } from '../../../api/projectStore';
import { emitUiEvent } from '../../../api/uiEvents';
import { getCompositionRoot } from '../../../app/compositionRoot';
import { Button, Tooltip } from '../../ui';
import styles from '../SidebarSessionList.module.css';
import {
  ChevronDown,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
} from 'lucide-react';

const PROJECT_FOLD_LIMIT = 6;

export interface ProjectsSectionData {
  projects: ProjectEntry[];
  collapsedProjects: Record<string, boolean>;
  projectsSectionCollapsed: boolean;
  byProjectId: Record<string, SessionState[]>;
}

export interface ProjectsSectionActions {
  onToggleProjectsSection: () => void;
  onToggleProjectCollapsed: (id: string) => void;
  onOpenProject: (id: string) => void;
  /** Kept for SidebarSessionList API; reorder is pointer drop-only via SessionRow. */
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  renderSessionItem: (
    s: SessionState,
    isDraggable?: boolean
  ) => React.ReactNode;
}

export interface ProjectsSectionProps {
  /** 数据组（projects/折叠态/byProjectId） */
  data: ProjectsSectionData;
  /** 回调组（折叠/打开/移动/渲染） */
  actions: ProjectsSectionActions;
}

export function ProjectsSection({
  data,
  actions,
}: ProjectsSectionProps) {
  const [expandedProjectFolders, setExpandedProjectFolders] = useState<
    Record<string, boolean>
  >({});
  void setExpandedProjectFolders;

  const {
    projects,
    collapsedProjects,
    projectsSectionCollapsed,
    byProjectId,
  } = data;
  const {
    onToggleProjectsSection,
    onToggleProjectCollapsed,
    onOpenProject,
    onMoveSessionRealtime: _onMoveSessionRealtime,
    renderSessionItem,
  } = actions;
  void _onMoveSessionRealtime;

  return (
    <section className={styles.section} aria-label="项目">
      <div
        className={styles.sectionLabelRow}
        onClick={onToggleProjectsSection}
        style={{ cursor: 'pointer' }}
      >
        <button
          type="button"
          className={styles.sectionLabel}
          onClick={(e) => {
            e.stopPropagation();
            onToggleProjectsSection();
          }}
          aria-expanded={!projectsSectionCollapsed}
        >
          <span>项目</span>
          <ChevronDown
            size={13}
            className={projectsSectionCollapsed ? styles.chevCollapsed : ''}
            aria-hidden
          />
        </button>
        <Tooltip content="管理与选择项目">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.sectionNew}
            aria-label="管理与选择项目"
            onClick={(e) => {
              e.stopPropagation();
              emitUiEvent('open-project-picker');
            }}
            icon={<FolderPlus size={14} strokeWidth={1.75} aria-hidden />}
          />
        </Tooltip>
      </div>
      <div
        className={styles.accordionWrapper}
        data-expanded={!projectsSectionCollapsed ? 'true' : 'false'}
        hidden={projectsSectionCollapsed || undefined}
      >
        <div className={styles.accordionInner}>
          {projects.map((p) => {
            const open = !collapsedProjects[p.id];
            const sess = byProjectId[p.id] || [];

            return (
              <div
                key={p.id}
                className={styles.folderGroup}
                data-folder-name={p.id}
              >
                <div className={styles.folderHeaderRow}>
                  <div
                    className={styles.folderHeader}
                    onClick={() => onToggleProjectCollapsed(p.id)}
                    aria-expanded={open}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onToggleProjectCollapsed(p.id);
                      }
                    }}
                  >
                    <span className={styles.folderIcon} aria-hidden>
                      {open ? (
                        <FolderOpen size={14} strokeWidth={1.75} />
                      ) : (
                        <Folder size={14} strokeWidth={1.75} />
                      )}
                    </span>
                    <Tooltip content={p.path}>
                      <span className={styles.folderName}>
                        {p.name}
                      </span>
                    </Tooltip>
                  </div>
                  {open ? (
                    <div className={styles.folderActions}>
                      <Tooltip content="在本项目新建对话">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className={styles.folderNewBtn}
                          aria-label={`在 ${p.name} 新建对话`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenProject(p.id);
                            getCompositionRoot().shell.openNewDraftTab(p.id);
                            emitUiEvent('open-chat');
                          }}
                          icon={
                            <FilePlus2 size={14} strokeWidth={1.75} aria-hidden />
                          }
                        />
                      </Tooltip>
                    </div>
                  ) : null}
                </div>
                <div
                  className={styles.accordionWrapper}
                  data-expanded={open ? 'true' : 'false'}
                  hidden={!open || undefined}
                >
                  <div className={styles.accordionInner}>
                    {sess.length > 0 ? (
                      <>
                        <ul
                          className={`${styles.pinnedList} ${styles.folderSessions}`}
                          role="tree"
                          aria-label={`${p.name} 会话`}
                          data-drop-zone="project"
                          data-folder-name={p.id}
                        >
                          {(expandedProjectFolders[p.id]
                            ? sess
                            : sess.slice(0, PROJECT_FOLD_LIMIT)
                          ).map((s) => renderSessionItem(s, true))}
                        </ul>
                        {sess.length > PROJECT_FOLD_LIMIT && (
                          <div className={styles.foldToggleRow}>
                            <button
                              type="button"
                              className={styles.foldToggleBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedProjectFolders((prev) => ({
                                  ...prev,
                                  [p.id]: !prev[p.id],
                                }));
                              }}
                              aria-expanded={Boolean(expandedProjectFolders[p.id])}
                            >
                              {expandedProjectFolders[p.id]
                                ? '收起'
                                : `查看全部 (${sess.length})`}
                            </button>
                          </div>
                        )}
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
          {projects.length === 0 && (
            <div
              className={`${styles.emptyHint} ${styles.subtle}`}
              role="status"
            >
              点击分区旁 + 添加本地项目
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
