import React from 'react';
import type { SessionState } from '../../../store/layoutStore';
import type { ProjectEntry } from '../../../api/projectStore';
import { openProject } from '../../../api/projectStore';
import { enterDraftMode } from '../../../api/storeAccess';
import { emitUiEvent } from '../../../api/uiEvents';
import { DragReorderSection } from './DragReorderSection';
import { Tooltip } from '../../settings/SettingsUI';
import styles from '../SidebarSessionList.module.css';
import { ChevronDown, FilePlus2, Folder, FolderOpen, FolderPlus } from 'lucide-react';

export interface ProjectsSectionProps {
  projects: ProjectEntry[];
  collapsedProjects: Record<string, boolean>;
  projectsSectionCollapsed: boolean;
  byProjectId: Record<string, SessionState[]>;
  expandedProjectFolders: Record<string, boolean>;
  onToggleProjectsSection: () => void;
  onToggleProjectCollapsed: (id: string) => void;
  onOpenProject: (id: string) => void;
  onMoveSessionRealtime: (
    sessionId: string,
    targetSessionId: string | null,
    targetFolder: string,
    isPinned: boolean
  ) => void;
  onToggleExpandedProjectFolder: (id: string) => void;
  renderSessionItem: (s: SessionState, isDraggable?: boolean) => React.ReactNode;
}

export function ProjectsSection({
  projects,
  collapsedProjects,
  projectsSectionCollapsed,
  byProjectId,
  expandedProjectFolders,
  onToggleProjectsSection,
  onToggleProjectCollapsed,
  onOpenProject,
  onMoveSessionRealtime,
  onToggleExpandedProjectFolder,
  renderSessionItem,
}: ProjectsSectionProps) {
  return (
    <section className={styles.section} aria-label="项目">
      <div
        className={styles.sectionLabelRow}
        onClick={onToggleProjectsSection}
        style={{ cursor: 'pointer' }}
      >
        <div className={styles.sectionLabelLeft}>
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
              size={14}
              className={
                projectsSectionCollapsed ? styles.chevCollapsed : ''
              }
              aria-hidden
            />
          </button>
        </div>
        <div className={styles.sectionLabelRight}>
          <Tooltip content="管理与选择项目">
            <button
              type="button"
              className={styles.sectionNew}
              aria-label="管理与选择项目"
              onClick={(e) => {
                e.stopPropagation();
                emitUiEvent('open-project-picker');
              }}
            >
              <FolderPlus size={14} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>
      <div
        className={styles.accordionWrapper}
        data-expanded={!projectsSectionCollapsed ? 'true' : 'false'}
      >
        <div className={styles.accordionInner}>
          {projects.map((p) => {
            const open = !collapsedProjects[p.id];
            const sess = byProjectId[p.id] || [];
            const isExpanded = !!expandedProjectFolders[p.id];
            return (
              <div
                key={p.id}
                className={styles.folderGroup}
                data-folder-name={p.id}
              >
                <div className={styles.folderHeaderRow}>
                  <button
                    type="button"
                    className={styles.folderHeader}
                    aria-expanded={open}
                    onClick={() => {
                      onToggleProjectCollapsed(p.id);
                    }}
                  >
                    {open ? (
                      <FolderOpen
                        size={16}
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    ) : (
                      <Folder size={16} strokeWidth={1.75} aria-hidden />
                    )}
                    <span className={styles.folderName}>{p.name}</span>
                  </button>
                  <Tooltip content="在此项目新建对话">
                    <button
                      type="button"
                      className={styles.folderNewSession}
                      aria-label={`在 ${p.name} 新建对话`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openProject(p.id);
                        onOpenProject(p.id);
                        enterDraftMode(p.id);
                      }}
                    >
                      <FilePlus2
                        size={14}
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    </button>
                  </Tooltip>
                </div>
                <div
                  className={styles.accordionWrapper}
                  data-expanded={open ? 'true' : 'false'}
                >
                  <div className={styles.accordionInner}>
                    {sess.length > 0 ? (
                      <ul
                        className={`${styles.pinnedList} ${styles.folderSessions}`}
                        role="tree"
                        aria-label={`${p.name} 会话`}
                      >
                        {sess.length <= 6 ? (
                          <DragReorderSection
                            sessions={sess}
                            folderName={p.id}
                            onMoveSessionRealtime={onMoveSessionRealtime}
                            renderRow={(s) => renderSessionItem(s, true)}
                          />
                        ) : (
                          <>
                            <DragReorderSection
                              sessions={
                                isExpanded
                                  ? sess
                                  : sess.slice(0, 6)
                              }
                              folderName={p.id}
                              onMoveSessionRealtime={
                                onMoveSessionRealtime
                              }
                              renderRow={(s) =>
                                renderSessionItem(s, true)
                              }
                            />
                            <div
                              className={styles.accordionWrapper}
                              data-expanded={
                                isExpanded ? 'true' : 'false'
                              }
                            >
                              <div className={styles.accordionInner}>
                                <ul
                                  className={`${styles.pinnedList} ${styles.folderSessions}`}
                                  style={{ paddingTop: 3 }}
                                >
                                  {sess
                                    .slice(6)
                                    .map((s) =>
                                      renderSessionItem(s, true)
                                    )}
                                </ul>
                              </div>
                            </div>
                            <li className={styles.sessionItemWrap}>
                              <button
                                type="button"
                                className={`${styles.sessionItem} ${styles.sessionItemFoldBtn}`}
                                style={{ color: 'var(--text-tertiary)' }}
                                onClick={() => {
                                  onToggleExpandedProjectFolder(p.id);
                                }}
                              >
                                {isExpanded
                                  ? '收起'
                                  : `查看全部 (${sess.length})`}
                              </button>
                            </li>
                          </>
                        )}
                      </ul>
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
