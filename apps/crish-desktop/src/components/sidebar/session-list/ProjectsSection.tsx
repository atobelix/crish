import React, { useState } from 'react';
import type { SessionState } from '../../../store/types';
import type { ProjectEntry } from '../../../api/projectStore';
import { navigateToNewDraft } from '../../../store/storeAccess';
import { Button, Tooltip } from '../../ui';
import styles from '../SidebarSessionList.module.css';
import { AppIcon } from '../../ui/icons/index';
import { ProjectManageModal } from './ProjectManageModal';
import { useI18n } from '../../../i18n';

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

export function ProjectsSection({ data, actions }: ProjectsSectionProps) {
  const { t } = useI18n();
  const [expandedProjectFolders, setExpandedProjectFolders] = useState<
    Record<string, boolean>
  >({});
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [managingProjectId, setManagingProjectId] = useState<string | null>(
    null
  );

  const { projects, collapsedProjects, projectsSectionCollapsed, byProjectId } =
    data;
  const {
    onToggleProjectsSection,
    onToggleProjectCollapsed,
    onOpenProject,
    onSortBtnClick,
    sortTriggerRef,
    sortDropdownOpen = false,
    onMoveSessionRealtime: _onMoveSessionRealtime,
    renderSessionItem,
  } = actions;
  void _onMoveSessionRealtime;

  return (
    <section
      className={styles.section}
      aria-label={t('sidebar.projects', '项目')}
    >
      <div
        className={styles.sectionLabelRow}
        onClick={onToggleProjectsSection}
        style={{ cursor: 'pointer' }}
      >
        <div className={styles.sectionLabelLeft}>
          <Button
            variant="ghost"
            type="button"
            className={styles.sectionLabel}
            onClick={(e) => {
              e.stopPropagation();
              onToggleProjectsSection();
            }}
            aria-expanded={!projectsSectionCollapsed}
          >
            <span>{t('sidebar.projects', '项目')}</span>
            <AppIcon
              name="chevron-down"
              size={16}
              className={projectsSectionCollapsed ? styles.chevCollapsed : ''}
              aria-hidden
            />
          </Button>
        </div>
        <div
          className={styles.sectionLabelRight}
          onClick={(e) => e.stopPropagation()}
        >
          {onSortBtnClick ? (
            <Tooltip content={t('sidebar.sortAndFilter', '排序与过滤')}>
              <Button
                ref={sortTriggerRef}
                type="button"
                variant="ghost"
                size="sm"
                className={styles.sectionSortBtn}
                aria-label={t('sidebar.sortAndFilter', '排序与过滤')}
                aria-expanded={sortDropdownOpen}
                aria-haspopup="menu"
                onClick={(e) => {
                  e.stopPropagation();
                  onSortBtnClick(e);
                }}
                icon={<AppIcon name="chevrons-up-down" size={16} aria-hidden />}
              />
            </Tooltip>
          ) : null}
          <Tooltip content={t('sidebar.newProject', '新建项目')}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={styles.sectionNew}
              aria-label={t('sidebar.newProject', '新建项目')}
              aria-expanded={createProjectOpen}
              aria-haspopup="dialog"
              onClick={() => setCreateProjectOpen(true)}
              icon={<AppIcon name="folder-plus" size={16} aria-hidden />}
            />
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
            const isMoreOpen = managingProjectId === p.id;

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
                        <AppIcon name="folder-open" size={16} />
                      ) : (
                        <AppIcon name="folder" size={16} />
                      )}
                    </span>
                    <Tooltip content={p.path}>
                      <span className={styles.folderName}>{p.name}</span>
                    </Tooltip>
                  </div>
                  <div
                    className={styles.folderActions}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Tooltip
                      content={t(
                        'sidebar.projectSettingsAndMore',
                        '项目设置与更多操作'
                      )}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.folderMoreBtn}
                        aria-label={t(
                          'sidebar.projectMoreActions',
                          `项目 ${p.name} 更多操作`,
                          { name: p.name }
                        )}
                        aria-expanded={isMoreOpen}
                        aria-haspopup="dialog"
                        onClick={() => setManagingProjectId(p.id)}
                        icon={
                          <AppIcon
                            name="more-horizontal"
                            size={16}
                            aria-hidden
                          />
                        }
                      />
                    </Tooltip>
                    <Tooltip
                      content={t(
                        'sidebar.newSessionInProject',
                        '在本项目新建对话'
                      )}
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.folderNewBtn}
                        aria-label={t(
                          'sidebar.newSessionInProjectAria',
                          `在 ${p.name} 新建对话`,
                          { name: p.name }
                        )}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenProject(p.id);
                          navigateToNewDraft(p.id);
                        }}
                        icon={
                          <AppIcon name="file-plus" size={16} aria-hidden />
                        }
                      />
                    </Tooltip>
                  </div>
                </div>
                <div
                  className={styles.accordionWrapper}
                  data-expanded={open ? 'true' : 'false'}
                >
                  <div className={styles.accordionInner}>
                    {sess.length > 0 ? (
                      <>
                        <ul
                          className={`${styles.pinnedList} ${styles.folderSessions}`}
                          role="tree"
                          aria-label={t(
                            'sidebar.projectSessionsAria',
                            `${p.name} 会话`,
                            { name: p.name }
                          )}
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
                            <Button
                              variant="ghost"
                              type="button"
                              className={styles.foldToggleBtn}
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedProjectFolders((prev) => ({
                                  ...prev,
                                  [p.id]: !prev[p.id],
                                }));
                              }}
                              aria-expanded={Boolean(
                                expandedProjectFolders[p.id]
                              )}
                            >
                              {expandedProjectFolders[p.id]
                                ? t('sidebar.foldCollapse', '收起')
                                : t(
                                    'sidebar.viewAllWithCount',
                                    `查看全部 (${sess.length})`,
                                    { count: sess.length }
                                  )}
                            </Button>
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
              style={{ cursor: 'pointer' }}
              onClick={() => setCreateProjectOpen(true)}
            >
              {t('sidebar.clickPlusToNewProject', '点击分区旁 + 新建项目')}
            </div>
          )}
        </div>
      </div>
      <ProjectManageModal
        mode="create"
        open={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onOpenProject={onOpenProject}
      />
      <ProjectManageModal
        mode="manage"
        project={projects.find((p) => p.id === managingProjectId)}
        open={Boolean(managingProjectId)}
        onClose={() => setManagingProjectId(null)}
        onOpenProject={onOpenProject}
        onProjectRemoved={(id) => {
          if (managingProjectId === id) setManagingProjectId(null);
        }}
      />
    </section>
  );
}
