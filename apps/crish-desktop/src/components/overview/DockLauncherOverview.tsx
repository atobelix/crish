/**
 * apps/crish-desktop/src/components/overview/DockLauncherOverview.tsx
 * 动态增量推荐/总览微型启动器（Dock Launcher Overview）
 *
 * 核心特性：
 * 1. 顶部 URL / 搜索引擎智能胶囊输入栏（36px 高、18px 完美椭圆圆角，支持 URL 导航与工具/任务关键词即时过滤）；
 * 2. 软件全功能工具入口矩阵（审阅、打开文件、终端、浏览器、运行时、协作体、编排图、笔记及动态注册视图），带多语言 i18n；
 * 3. 严格会话绑定的动态增量信息（当前会话的子智能体、当前会话生成的后台任务与定时器，杜绝跨会话或全局工作流渗透）；
 * 4. 零动态信息时优雅垂直居中微型布局（.isMinimal），纯粹呈现输入框与功能选项；
 * 5. 严守 AGENTS.md §12（自定义 Tooltip 规范）、§13（克制无重阴影/柔软对比度焦点态）与 §14（现代 CSS 语法与 Token）。
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { ToolViewId } from '../../store/layout-tree';
import { useI18n } from '../../i18n';
import { AppIcon } from '../ui/icons';
import type { IconName } from '../ui/icons';
import { Tooltip, Button, Input } from '@/components/ui';
import { useSessionAgents } from '../../store/storeAccess';
import { useEngineState } from '../../hooks/useEngineState';
import { viewRegistry } from '../../services/view-registry';
import { mapSubagentRoleWireName } from '../../api/tool-presentation/agentRoleLabel';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { killSubagent } from '../../api/subagentRecoveryApi';
import {
  openBackgroundTaskInTerminal,
  getBackgroundTaskOutput,
  BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER,
  BACKGROUND_TASK_STATE_LABELS,
  type BackgroundTaskInfo,
} from '../../api/backgroundTasksApi';
import { formatElapsed } from './helpers';
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

/** 软件全量内置工具定义（规范排序与多语言回退） */
interface CanonicalToolConfig {
  id: string;
  defaultIcon: IconName;
  i18nKey: string;
  fallbackLabel: string;
}

const CANONICAL_TOOLS: CanonicalToolConfig[] = [
  {
    id: 'diff',
    defaultIcon: 'git-branch',
    i18nKey: 'workspace.dock.toolReview',
    fallbackLabel: 'Review',
  },
  {
    id: 'files',
    defaultIcon: 'folder-tree',
    i18nKey: 'workspace.dock.toolOpenFile',
    fallbackLabel: 'Open File',
  },
  {
    id: 'terminal',
    defaultIcon: 'terminal',
    i18nKey: 'workspace.dock.toolTerminal',
    fallbackLabel: 'Terminal',
  },
  {
    id: 'preview',
    defaultIcon: 'globe',
    i18nKey: 'workspace.dock.toolPreview',
    fallbackLabel: 'Browser',
  },
  {
    id: 'runtime',
    defaultIcon: 'play-circle',
    i18nKey: 'workspace.dock.toolRuntime',
    fallbackLabel: 'Runtime',
  },
  {
    id: 'agent',
    defaultIcon: 'bot',
    i18nKey: 'workspace.dock.toolAgent',
    fallbackLabel: 'Agents',
  },
  {
    id: 'flow-dag',
    defaultIcon: 'workflow',
    i18nKey: 'workspace.dock.toolFlowDag',
    fallbackLabel: 'Flow DAG',
  },
  {
    id: 'note',
    defaultIcon: 'notebook-pen',
    i18nKey: 'workspace.dock.toolNote',
    fallbackLabel: 'Notes',
  },
];

interface DisplayToolItem {
  id: string;
  icon: IconName;
  label: string;
}

interface SessionTaskItem {
  id: string;
  icon: IconName;
  title: string;
  meta?: string;
  rawTask: BackgroundTaskInfo;
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

    // 1. 会话专属子智能体（仅当前会话）
    const agents = useSessionAgents(sessionId || '');

    // 2. 引擎状态：严格限定为当前会话专属的后台任务
    const ds = useEngineState();

    // 3. 动态聚合软件工具列表（内置规范项 + viewRegistry 中注册的所有额外工具）
    const allTools = useMemo<DisplayToolItem[]>(() => {
      const registeredViews = viewRegistry.getToolViews();
      const items: DisplayToolItem[] = [];
      const handled = new Set<string>();

      // 优先按规范排序加入
      for (const def of CANONICAL_TOOLS) {
        handled.add(def.id);
        const iconName = viewRegistry.getIcon(def.id) || def.defaultIcon;
        const localizedLabel = t(def.i18nKey, def.fallbackLabel);
        items.push({
          id: def.id,
          icon: iconName,
          label: localizedLabel,
        });
      }

      // 追加 viewRegistry 中动态注册的其他工具视图
      for (const v of registeredViews) {
        if (!handled.has(v.id)) {
          handled.add(v.id);
          items.push({
            id: v.id,
            icon: viewRegistry.getIcon(v.id) || ('tool' as IconName),
            label: viewRegistry.getTitle(v.id),
          });
        }
      }

      return items;
    }, [t]);

    // 4. 严格将会话后台任务限定在当前对话内（排除全局工作流与非本会话的任务）
    const sessionTasks = useMemo<SessionTaskItem[]>(() => {
      if (!sessionId || sessionId.startsWith('__pending')) {
        return [];
      }

      const tasks = (ds.bgTasks || []).filter((bt) => {
        return Boolean(bt.sessionId && bt.sessionId === sessionId);
      });

      return tasks.map((bt) => {
        const isTimer =
          Boolean(bt.command?.includes('timer')) ||
          Boolean(bt.label?.includes('timer')) ||
          Boolean(bt.command?.includes('schedule'));

        const icon: IconName = isTimer ? 'clock' : 'terminal';

        let title =
          bt.label ||
          bt.command ||
          t('workspace.dock.backgroundTasks', '后台任务');
        if (bt.command && !isTimer) {
          title = bt.command.startsWith('Run ')
            ? bt.command
            : `Run ${bt.command}`;
        }

        let meta = '';
        if (bt.state === 'running') {
          if (bt.durationMs) {
            meta = formatElapsed(Math.round(bt.durationMs / 1000));
          } else if (bt.startedAt) {
            meta = formatElapsed(
              Math.max(0, Math.round((Date.now() - bt.startedAt) / 1000))
            );
          } else {
            meta = t('chat.agentCard.dispatch.statusWorking', '运行中');
          }
        } else {
          meta =
            BACKGROUND_TASK_STATE_LABELS[bt.state] || String(bt.state || '');
        }

        return {
          id: bt.id,
          icon,
          title,
          meta,
          rawTask: bt,
        };
      });
    }, [ds.bgTasks, sessionId, t]);

    // 5. 排序子智能体：运行中排首位，随后按启动时刻降序
    const sortedAgents = useMemo(() => {
      return [...agents].sort((a, b) => {
        const ar = a.status === 'running' ? 0 : 1;
        const br = b.status === 'running' ? 0 : 1;
        if (ar !== br) return ar - br;
        return (b.startedAt || 0) - (a.startedAt || 0);
      });
    }, [agents]);

    // 6. 搜索过滤（支持即时过滤工具列表、子智能体与后台任务）
    const trimmedQuery = searchQuery.trim().toLowerCase();

    const filteredTools = useMemo(() => {
      if (!trimmedQuery) return allTools;
      return allTools.filter(
        (tool) =>
          tool.label.toLowerCase().includes(trimmedQuery) ||
          tool.id.toLowerCase().includes(trimmedQuery)
      );
    }, [allTools, trimmedQuery]);

    const filteredAgents = useMemo(() => {
      if (!trimmedQuery) return sortedAgents;
      return sortedAgents.filter(
        (agent) =>
          getAgentDisplayName(agent).toLowerCase().includes(trimmedQuery) ||
          agent.id.toLowerCase().includes(trimmedQuery)
      );
    }, [sortedAgents, trimmedQuery]);

    const filteredTasks = useMemo(() => {
      if (!trimmedQuery) return sessionTasks;
      return sessionTasks.filter(
        (task) =>
          task.title.toLowerCase().includes(trimmedQuery) ||
          (task.meta && task.meta.toLowerCase().includes(trimmedQuery))
      );
    }, [sessionTasks, trimmedQuery]);

    // 7. 零动态信息时判定为微型居中模式（无会话子智能体且无会话后台任务）
    const isMinimal = agents.length === 0 && sessionTasks.length === 0;

    // 8. 搜索框回车提交：若精准匹配某工具则直接开启；若为 URL 或检索词则在浏览器内打开
    const handleSearchSubmit = useCallback(
      (e?: React.FormEvent) => {
        e?.preventDefault();
        const trimmed = searchQuery.trim();
        if (!trimmed) return;

        // 若用户输入精准匹配了某一工具名称，直接导航至该工具
        const matchedTool = allTools.find(
          (tool) =>
            tool.label.toLowerCase() === trimmed.toLowerCase() ||
            tool.id.toLowerCase() === trimmed.toLowerCase()
        );
        if (matchedTool) {
          onOpenTool(matchedTool.id);
          return;
        }

        const url = resolveSearchOrUrl(trimmed);
        if (url) {
          onOpenTool('preview', { url });
        }
      },
      [searchQuery, allTools, onOpenTool]
    );

    // 9. 打开后台任务在终端中回显
    const handleOpenTask = useCallback(
      async (task: BackgroundTaskInfo) => {
        try {
          const out = await getBackgroundTaskOutput(task.id);
          const text = out || BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER;
          openBackgroundTaskInTerminal(
            task.label || task.command || task.id,
            text
          );
          onOpenTool('terminal', { taskId: task.id });
        } catch {
          openBackgroundTaskInTerminal(
            task.label || task.command || task.id,
            BACKGROUND_TASK_EMPTY_OUTPUT_PLACEHOLDER
          );
          onOpenTool('terminal', { taskId: task.id });
        }
      },
      [onOpenTool]
    );

    // 10. 终止子智能体
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

    const displayedAgents = showAllAgents
      ? filteredAgents
      : filteredAgents.slice(0, 5);

    const displayedTasks = showAllTasks
      ? filteredTasks
      : filteredTasks.slice(0, 5);

    return (
      <div
        className={`${styles.container} ${isMinimal ? styles.isMinimal : ''} ${className || ''}`}
        role="region"
        aria-label={t('workspace.dock.launcherAriaLabel', '工作区微型启动器')}
      >
        <div className={styles.contentWrapper}>
          {/* 顶部搜索 / URL 胶囊地址栏 */}
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

          {/* 核心与扩展工具列表 */}
          <div className={styles.coreToolsList}>
            {filteredTools.map((tool) => (
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

          {/* 增量动态信息：当前会话子智能体（仅在有智能体时呈现） */}
          {filteredAgents.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitleRow}>
                  <span className={styles.sectionTitle}>
                    {t('workspace.dock.subagents', '子智能体')}
                  </span>
                  <span className={styles.badgePill}>{agents.length}</span>
                </div>
                {filteredAgents.length > 5 && (
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
                            <AppIcon
                              name="minus-circle"
                              size={13}
                              aria-hidden
                            />
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 增量动态信息：当前会话后台任务（仅在当前会话存在后台任务时呈现） */}
          {filteredTasks.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <div className={styles.sectionTitleRow}>
                  <span className={styles.sectionTitle}>
                    {t('workspace.dock.backgroundTasks', '后台任务')}
                  </span>
                  <span className={styles.badgePill}>
                    {sessionTasks.length}
                  </span>
                </div>
                {filteredTasks.length > 5 && (
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
                    onClick={() => handleOpenTask(task.rawTask)}
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
