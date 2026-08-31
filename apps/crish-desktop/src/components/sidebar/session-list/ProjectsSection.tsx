import React from 'react';
import type { SessionState } from '../../../store/types';
import type { ProjectEntry } from '../../../api/projectStore';
import { openProject } from '../../../api/projectStore';
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

export interface ProjectsSectionData {
  projects: ProjectEntry[];
  collapsedProjects: Record<string, boolean>;
  projectsSectionCollapsed: boolean;
  byProjectId: Record<string, SessionState[]>;
  expandedProjectFolders: Record<string, boolean>;
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
  onToggleExpandedProjectFolder: (id: string) => void;
  renderSessionItem: (
    s: SessionState,
    isDraggable?: boolean
  ) => React.ReactNode;
}

export interface ProjectsSectionProps {
  /** 数据组（projects/折叠态/byProjectId/文件夹展开） */
  data: ProjectsSectionData;
  /** 回调组（折叠/打开/移动/渲染） */
  actions: ProjectsSectionActions;
}

export function ProjectsSection({
  data,
  actions,
}: ProjectsSectionProps) {
  const {
    projects,
    collapsedProjects,
    projectsSectionCollapsed,
    byProjectId,
    expandedProjectFolders,
  } = data;
  const {
    onToggleProjectsSection,
    onToggleProjectCollapsed,
    onOpenProject,
    onMoveSessionRealtime: _onMoveSessionRealtime,
    onToggleExpandedProjectFolder,
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
              className={projectsSectionCollapsed ? styles.chevCollapsed : ''}
              aria-hidden
            />
          </button>
        </div>
        <div className={styles.sectionLabelRight}>
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
                      openProject(p.id);
                      onOpenProject(p.id);
                      onToggleProjectCollapsed(p.id);
                    }}
                  >
                    {open ? (
                      <FolderOpen size={16} strokeWidth={1.75} aria-hidden />
                    ) : (
                      <Folder size={16} strokeWidth={1.75} aria-hidden />
                    )}
                    <span className={styles.folderName}>{p.name}</span>
                  </button>
                  <Tooltip content="在此项目新建对话">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={styles.folderNewSession}
                      aria-label={`在 ${p.name} 新建对话`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openProject(p.id);
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
                <div
                  className={styles.accordionWrapper}
                  data-expanded={open ? 'true' : 'false'}
                  hidden={!open || undefined}
                >
                  <div className={styles.accordionInner}>
                    {sess.length > 0 ? (
                      <ul
                        className={`${styles.pinnedList} ${styles.folderSessions}`}
                        role="tree"
                        aria-label={`${p.name} 会话`}
                      >
                        {sess.length <= 6 ? (
                          sess.map((s) => renderSessionItem(s, true))
                        ) : (
                          <>
                            {/*
                              展开时主列表渲染全量；收起时主列表仅前 6 条，
                              溢出条只在收起态挂到折叠手风琴（与 GeneralSection 一致）。
                              禁止展开态同时 render sess 与 sess.slice(6) — 会双重渲染同一 session。
                            */}
                            {(isExpanded ? sess : sess.slice(0, 6)).map((s) =>
                              renderSessionItem(s, true)
                            )}
                            {!isExpanded ? (
                              <div
                                className={styles.accordionWrapper}
                                data-expanded="false"
                              >
                                <div className={styles.accordionInner}>
                                  <ul
                                    className={`${styles.pinnedList} ${styles.folderSessions}`}
                                    style={{ paddingTop: 3 }}
                                  >
                                    {sess
                                      .slice(6)
                                      .map((s) => renderSessionItem(s, true))}
                                  </ul>
                                </div>
                              </div>
                            ) : null}
                            <li className={styles.sessionItemWrap}>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={`${styles.sessionItem} ${styles.sessionItemFoldBtn}`}
                                style={{ color: 'var(--text-tertiary)' }}
                                onClick={() => {
                                  onToggleExpandedProjectFolder(p.id);
                                }}
                              >
                                {isExpanded
                                  ? '收起'
                                  : `查看全部 (${sess.length})`}
                              </Button>
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
