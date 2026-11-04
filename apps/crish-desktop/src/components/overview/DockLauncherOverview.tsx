/**
 * apps/crish-desktop/src/components/overview/DockLauncherOverview.tsx
 * 动态增量推荐/总览微型启动器（Dock Launcher Overview）
 *
 * 核心特性：
 * 1. 顶部 URL / 搜索引擎智能胶囊输入栏；
 * 2. 核心工具垂直入口（审阅、打开文件、终端、浏览器）；
 * 3. 增量动态信息（子智能体、后台与实时任务）按需自适应展开；
 * 4. 零动态信息时优雅垂直居中微型布局（.isMinimal）；
 * 5. 严守 AGENTS.md §12（自定义 Tooltip 规范）、§13（克制无重阴影/柔软对比度焦点态）与 §14（现代 CSS 语法与 Token）。
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { ToolViewId } from '../../store/layout-tree';
import { useI18n } from '../../i18n';
import { AppIcon } from '../ui/icons';
import { Tooltip, Button, Input } from '@/components/ui';
import {
  useSessionAgents,
  useSessionField,
  selectSessions,
} from '../../store/storeAccess';
import { useEngineState } from '../../hooks/useEngineState';
import { useOverviewState } from './useOverviewState';
import { mapSubagentRoleWireName } from '../../api/tool-presentation/agentRoleLabel';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import { formatElapsed, formatBgTaskMeta } from './helpers';
import { scheduleLabel } from '../../api/workflowApi';
import type { SessionAgent } from '../../store/types';
import styles from './DockLauncherOverview.module.css';

export interface DockLauncherOverviewProps {
  sessionId?: string | null;
  onOpenTool: (
    viewId: ToolViewId | string,
    params?: Record<string, unknown>
  ) => void;
  className?: string;
}

/**
 * 解析用户输入的检索词或 URL：
 * 1. 若已有协议头（http://, https://, file://, about: 等）直接返回
 * 2. 若为本地 localhost 或 IP 地址，补齐 http://
 * 3. 若为纯域名（无空格、含点号、有合法顶级域名或路径），补齐 https://
 * 4. 其余普通检索关键词，包装为搜索引擎查询 URL
 */
export function resolveSearchOrUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(trimmed) ||
    /^about:/i.test(trimmed)
  ) {
    return trimmed;
  }

  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(trimmed)) {
    return `http://${trimmed}`;
  }

  if (
    !/\s/.test(trimmed) &&
    /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/.*)?$/i.test(trimmed)
  ) {
    return `https://${trimmed}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

/** 获取子智能体呈现名称（角色 wire 名优先映射为多语言名称） */
function getAgentDisplayName(agent: SessionAgent): string {
  if (agent.displayLabel?.trim()) {
    return mapSubagentRoleWireName(agent.displayLabel);
  }
  if (agent.description?.trim()) {
    return agent.description.trim();
  }
  if (agent.mode?.trim()) {
    return agent.mode.trim();
  }
  return agent.id;
}

interface UnifiedTaskItem {
  id: string;
  icon: 'terminal' | 'clock' | 'play-circle';
  title: string;
  meta?: string;
  onClick: () => void;
}

export const DockLauncherOverview: React.FC<DockLauncherOverviewProps> =
  React.memo(function DockLauncherOverview({
    sessionId,
    onOpenTool,
    className,
  }) {
    const { t } = useI18n();
    const [searchQuery, setSearchQuery] = useState('');
    const [showAllAgents, setShowAllAgents] = useState(false);
    const [showAllTasks, setShowAllTasks] = useState(false);

    // 会话子智能体
    const agents = useSessionAgents(sessionId || '');

    // 引擎状态与总览状态
    const sessions = useSessionField(selectSessions);
    const ds = useEngineState();
    const { liveTasks, openBgTask, focusSession } = useOverviewState(
      sessions,
      ds.activeRuns,
      (id: string) => onOpenTool(id)
    );

    // 排序子智能体：运行中排首位，随后按启动时刻降序
    const sortedAgents = useMemo(() => {
      return [...agents].sort((a, b) => {
        const ar = a.status === 'running' ? 0 : 1;
        const br = b.status === 'running' ? 0 : 1;
        if (ar !== br) return ar - br;
        return (b.startedAt || 0) - (a.startedAt || 0);
      });
    }, [agents]);

    // 汇总后台与实时活动任务
    const allTaskItems = useMemo<UnifiedTaskItem[]>(() => {
      const items: UnifiedTaskItem[] = [];

      // 1. 实时活动任务 (liveTasks)
      for (const lt of liveTasks) {
        items.push({
          id: `live-${lt.id}`,
          icon: 'play-circle',
          title: lt.taskName,
          meta: formatElapsed(lt.elapsedSeconds),
          onClick: () => {
            if (lt.sessionId) {
              focusSession(lt.sessionId);
            }
          },
        });
      }

      // 2. 常驻后台任务 (bgTasks)
      for (const bt of ds.bgTasks) {
        items.push({
          id: `bg-${bt.id}`,
          icon: 'terminal',
          title:
            bt.label ||
            bt.command ||
            t('workspace.dock.backgroundTasks', '后台任务'),
          meta: bt.command
            ? `Run ${bt.command}`
            : formatBgTaskMeta({ state: bt.state, command: bt.command }),
          onClick: () => {
            openBgTask(bt);
          },
        });
      }

      // 3. 计划任务 (workflows)
      for (const wf of ds.workflows || []) {
        items.push({
          id: `wf-${wf.id}`,
          icon: 'clock',
          title: wf.name,
          meta: scheduleLabel(wf.schedule),
          onClick: () => {},
        });
      }

      return items;
    }, [liveTasks, ds.bgTasks, ds.workflows, focusSession, openBgTask, t]);

    // 零动态数据最小化展示态
    const isMinimal = agents.length === 0 && allTaskItems.length === 0;

    // 搜索或 URL 提交处理
    const handleSearchSubmit = useCallback(
      (e?: React.FormEvent) => {
        e?.preventDefault();
        const trimmed = searchQuery.trim();
        if (!trimmed) return;
        const url = resolveSearchOrUrl(trimmed);
        if (url) {
          onOpenTool('preview', { url });
        }
      },
      [searchQuery, onOpenTool]
    );

    // 终止子智能体
    const handleKillSubagent = useCallback(
      async (agentId: string, parentSession?: string) => {
        try {
          const sid = sessionId || parentSession || '';
          if (sid) {
            await killSubagent(sid, agentId, 'dock-launcher-kill');
          }
        } catch {
          /* swallow-ok */
        }
      },
      [sessionId]
    );

    // 核心工具列表定义
    const coreTools = useMemo(
      () => [
        {
          id: 'diff',
          icon: 'git-branch' as const,
          label: t('workspace.dock.toolReview', '审阅'),
        },
        {
          id: 'files',
          icon: 'folder-tree' as const,
          label: t('workspace.dock.toolOpenFile', '打开文件'),
        },
        {
          id: 'terminal',
          icon: 'terminal' as const,
          label: t('workspace.dock.toolTerminal', '终端'),
        },
        {
          id: 'preview',
          icon: 'globe' as const,
          label: t('workspace.dock.toolPreview', '浏览器'),
        },
      ],
      [t]
    );

    const displayedAgents = showAllAgents
      ? sortedAgents
      : sortedAgents.slice(0, 5);

    const displayedTasks = showAllTasks
      ? allTaskItems
      : allTaskItems.slice(0, 5);

    return (
      <div
        className={`${styles.container} ${isMinimal ? styles.isMinimal : ''} ${className || ''}`}
        role="region"
        aria-label="Dock Launcher Overview"
      >
        <div className={styles.contentWrapper}>
          {/* 顶部搜索 / URL 地址栏 */}
          <form className={styles.searchForm} onSubmit={handleSearchSubmit}>
            <div className={styles.searchBar}>
              <AppIcon
                name="search"
                size={14}
                className={styles.searchIcon}
                aria-hidden
              />
              <Input
                type="text"
                className={styles.searchInput}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t(
                  'workspace.dock.launcherSearchOrUrl',
                  '搜索或输入网址...'
                )}
                aria-label={t(
                  'workspace.dock.launcherSearchOrUrl',
                  '搜索或输入网址...'
                )}
              />
            </div>
          </form>

          {/* 核心工具列表 */}
          <div className={styles.coreToolsList}>
            {coreTools.map((tool) => (
              <Button
                key={tool.id}
                type="button"
                variant="unstyled"
                className={styles.toolItem}
                onClick={() => onOpenTool(tool.id)}
              >
                <AppIcon
                  name={tool.icon}
                  size={15}
                  className={styles.toolIcon}
                  aria-hidden
                />
                <span className={styles.toolLabel}>{tool.label}</span>
              </Button>
            ))}
          </div>

          {/* 增量动态信息：子智能体 */}
          {agents.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitleRow}>
                  <span className={styles.sectionTitle}>
                    {t('workspace.dock.subagents', '子智能体')}
                  </span>
                  <span className={styles.badgePill}>{agents.length}</span>
                </div>
                {agents.length > 5 && (
                  <Button
                    type="button"
                    variant="unstyled"
                    className={styles.seeAllBtn}
                    onClick={() => setShowAllAgents((v) => !v)}
                  >
                    {showAllAgents
                      ? t('workspace.dock.collapseList', '收起')
                      : t('workspace.dock.seeAll', '查看全部')}
                  </Button>
                )}
              </div>

              <div className={styles.itemList} role="list">
                {displayedAgents.map((agent) => {
                  const name = getAgentDisplayName(agent);
                  const isRunning = agent.status === 'running';

                  return (
                    <div
                      key={agent.id}
                      className={styles.rowItem}
                      role="listitem"
                      tabIndex={0}
                      onClick={() =>
                        openAgentInSidePanel(agent.id, {
                          sessionId: sessionId || undefined,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openAgentInSidePanel(agent.id, {
                            sessionId: sessionId || undefined,
                          });
                        }
                      }}
                    >
                      {/* 状态点或图标 */}
                      {isRunning && (
                        <span
                          className={`${styles.statusDot} ${styles.dotRunning}`}
                          aria-label="running"
                        />
                      )}
                      {agent.status === 'completed' && (
                        <span
                          className={`${styles.statusDot} ${styles.dotCompleted}`}
                          aria-label="completed"
                        >
                          <AppIcon name="check" size={12} stroke={2} />
                        </span>
                      )}
                      {agent.status === 'failed' && (
                        <span
                          className={`${styles.statusDot} ${styles.dotFailed}`}
                          aria-label="failed"
                        >
                          <AppIcon name="alert-triangle" size={12} stroke={2} />
                        </span>
                      )}
                      {agent.status === 'stopped' && (
                        <span
                          className={`${styles.statusDot} ${styles.dotStopped}`}
                          aria-label="stopped"
                        />
                      )}

                      <div className={styles.rowMain}>
                        <span className={styles.rowTitle}>{name}</span>
                        {isRunning && (
                          <span className={styles.rowMeta}>
                            {t(
                              'chat.agentCard.dispatch.statusWorking',
                              '运行中'
                            )}
                          </span>
                        )}
                      </div>

                      {/* 运行中悬浮终止图标 */}
                      {isRunning && (
                        <Tooltip
                          content={t(
                            'workspace.dock.stopSubagent',
                            '终止子智能体'
                          )}
                          side="left"
                        >
                          <Button
                            type="button"
                            variant="unstyled"
                            className={styles.killBtn}
                            aria-label={t(
                              'workspace.dock.stopSubagent',
                              '终止子智能体'
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleKillSubagent(
                                agent.id,
                                agent.parentSessionId
                              );
                            }}
                          >
                            <AppIcon name="x-octagon" size={13} aria-hidden />
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 增量动态信息：后台与实时任务 */}
          {allTaskItems.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitleRow}>
                  <span className={styles.sectionTitle}>
                    {t('workspace.dock.backgroundTasks', '后台任务')}
                  </span>
                  <span className={styles.badgePill}>
                    {allTaskItems.length}
                  </span>
                </div>
                {allTaskItems.length > 5 && (
                  <Button
                    type="button"
                    variant="unstyled"
                    className={styles.seeAllBtn}
                    onClick={() => setShowAllTasks((v) => !v)}
                  >
                    {showAllTasks
                      ? t('workspace.dock.collapseList', '收起')
                      : t('workspace.dock.seeAll', '查看全部')}
                  </Button>
                )}
              </div>

              <div className={styles.itemList} role="list">
                {displayedTasks.map((task) => (
                  <Button
                    key={task.id}
                    type="button"
                    variant="unstyled"
                    className={styles.rowItem}
                    onClick={task.onClick}
                  >
                    <AppIcon
                      name={task.icon}
                      size={14}
                      className={styles.taskIcon}
                      aria-hidden
                    />
                    <div className={styles.rowMain}>
                      <span className={styles.rowTitle}>{task.title}</span>
                      {task.meta && (
                        <span className={styles.rowMeta}>{task.meta}</span>
                      )}
                    </div>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  });

DockLauncherOverview.displayName = 'DockLauncherOverview';
export default DockLauncherOverview;
