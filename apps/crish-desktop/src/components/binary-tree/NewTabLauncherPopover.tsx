/**
 * NewTabLauncherPopover — 顶栏加号综合启动器浮层
 *
 * 核心契约：
 * 1. 336px Radix Popover 浮层，锚定于 PaneHeader 标签栏末尾 '+' 按钮；
 * 2. 遵循用户指令：简单清晰易懂，去除冗余次要标签与段落描述，让布局自己说话；
 * 3. 3 大核心操作：新建对话 (⌘N)、新建常规终端 (⌃`)、新建浏览器 (⌥B);
 * 4. 彻底清除虚假预制模板，若存在真实用户项目则动态展示，无则不展示；
 * 5. 全键盘漫游导航（ArrowDown/Up/Home/End/Enter/Esc），默认首项高亮（<100ms 即按即开）；
 * 6. 严格遵守 Conex §12（自定义 Tooltip，0 原生 title）、§13（克制软焦点、border: none）、§14（现代 CSS）；
 * 7. 严密防范双击 '+' 导致窗口最大化（事件隔离 + data-tauri-drag-region="false"）。
 */

import React, { useCallback, useMemo, useState, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Button, Tooltip, useLayerRegistration } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';
import { getCompositionRoot } from '../../app/compositionRoot';
import {
  collectLeaves,
  getSessionById,
  useLayoutTreeStore,
  useSessionExecutionTrackerStore,
  type SessionExecutionItem,
} from '../../store/storeAccess';
import { listProjects, type ProjectEntry } from '../../api/projectStore';
import {
  openAuthorizedProject,
  WorkspaceAccessError,
} from '../../api/workspaceAccessApi';
import { toast } from '../../services/toast';
import styles from './NewTabLauncherPopover.module.css';

export interface NewTabLauncherPopoverProps {
  leafId: string;
  onBeforeOpen?: () => void;
}

export const NewTabLauncherPopover: React.FC<NewTabLauncherPopoverProps> = ({
  leafId,
  onBeforeOpen,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useLayerRegistration(
    {
      id: `new-tab-launcher-${leafId}`,
      type: 'popover',
      elementRef: contentRef,
      dismissible: true,
      onDismiss: () => setIsOpen(false),
      onEscapeKeyDown: () => setIsOpen(false),
    },
    isOpen
  );

  // 1. 提取所有窗格当前处于激活展示态的 session 集合（前台排重，基于稳定字符串键防循环渲染）
  const visibleActiveSessionIdsKey = useLayoutTreeStore((s) => {
    const ids: string[] = [];
    const leaves = collectLeaves(s.tree.root);
    for (const leaf of leaves) {
      if (leaf.panelId === 'chat' && Array.isArray(leaf.tabs)) {
        const active = leaf.tabs.find((t) => t.tabId === leaf.activeTabId);
        if (active?.sessionId) {
          ids.push(active.sessionId);
        }
      }
    }
    return ids.sort().join('::');
  });

  const visibleActiveSessionIds = useMemo(() => {
    return new Set(
      visibleActiveSessionIdsKey ? visibleActiveSessionIdsKey.split('::') : []
    );
  }, [visibleActiveSessionIdsKey]);

  // 2. 提取并按紧迫度排序后台运行会话（经 getSessionById 静态读取标题，绝不订阅高频 sessionsById 避免渲染雪崩）
  const activeRuns = useSessionExecutionTrackerStore((s) => s.activeRuns);

  const runningSessions = useMemo(() => {
    const list: (SessionExecutionItem & { title: string })[] = [];
    for (const [sid, item] of Object.entries(activeRuns)) {
      if (visibleActiveSessionIds.has(sid)) continue;
      const title =
        getSessionById(sid)?.title || t('chat.untitledSession', '未命名会话');
      list.push({ ...item, title });
    }
    // 优先级排序：等待审批(100) > 工具执行(60) > 思考/生成(30) > 刚刚完成(0)
    return list.sort((a, b) => {
      const score = (stage: string) => {
        if (stage === 'waiting_approval') return 100;
        if (stage === 'executing_tool') return 60;
        if (stage === 'just_completed') return 0;
        return 30;
      };
      return score(b.stage) - score(a.stage) || b.startTime - a.startTime;
    });
  }, [activeRuns, visibleActiveSessionIds, t]);

  // 3. 动态加载真实用户项目（绝不硬编码假数据模板；无真实项目时不展示）
  const userProjects = useMemo<ProjectEntry[]>(() => {
    try {
      const list = listProjects();
      return Array.isArray(list) ? list.slice(0, 6) : [];
    } catch {
      return [];
    }
  }, [isOpen]);

  // 4. 键盘漫游总线（扁平索引映射）
  const totalItems = 3 + runningSessions.length + userProjects.length;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onBeforeOpen?.();
        setFocusedIndex(0); // 默认高亮首项【新建对话】
      }
      setIsOpen(open);
    },
    [onBeforeOpen]
  );

  const handleActionNewChat = useCallback(() => {
    setIsOpen(false);
    getCompositionRoot().shell.addTab(leafId);
  }, [leafId]);

  const handleActionNewTerminal = useCallback(() => {
    setIsOpen(false);
    const shell = getCompositionRoot().shell as unknown as {
      addTerminalTab?: (id: string) => void;
      addTab: (id: string) => void;
    };
    if (typeof shell.addTerminalTab === 'function') {
      shell.addTerminalTab(leafId);
    } else {
      shell.addTab(leafId);
    }
  }, [leafId]);

  const handleActionNewBrowser = useCallback(() => {
    setIsOpen(false);
    const shell = getCompositionRoot().shell as unknown as {
      addBrowserTab?: (id: string, opts?: { url?: string }) => void;
      addTab: (id: string) => void;
    };
    if (typeof shell.addBrowserTab === 'function') {
      shell.addBrowserTab(leafId, { url: 'about:blank' });
    } else {
      shell.addTab(leafId);
    }
  }, [leafId]);

  const handleFocusRunning = useCallback((sessionId: string) => {
    setIsOpen(false);
    getCompositionRoot().session.openOrFocusSession(sessionId);
  }, []);

  const handleLaunchProject = useCallback(
    async (project: ProjectEntry) => {
      setIsOpen(false);
      try {
        const opened = await openAuthorizedProject(project.id);
        if (!opened) return;
        getCompositionRoot().shell.addTab(leafId);
      } catch (error) {
        toast.error(
          error instanceof WorkspaceAccessError // i18n-allow: 授权错误文案为透传的用户提示
            ? error.message
            : '该项目目录未获授权，请重新选择项目文件夹。'
        );
      }
    },
    [leafId]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedIndex((prev) => (prev + 1) % totalItems);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedIndex((prev) => (prev - 1 + totalItems) % totalItems);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setFocusedIndex(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        setFocusedIndex(totalItems - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (focusedIndex === 0) {
          handleActionNewChat();
        } else if (focusedIndex === 1) {
          handleActionNewTerminal();
        } else if (focusedIndex === 2) {
          handleActionNewBrowser();
        } else if (focusedIndex < 3 + runningSessions.length) {
          const run = runningSessions[focusedIndex - 3];
          if (run) handleFocusRunning(run.sessionId);
        } else {
          const project =
            userProjects[focusedIndex - 3 - runningSessions.length];
          if (project) handleLaunchProject(project);
        }
      }
    },
    [
      totalItems,
      focusedIndex,
      handleActionNewChat,
      handleActionNewTerminal,
      handleActionNewBrowser,
      runningSessions,
      handleFocusRunning,
      userProjects,
      handleLaunchProject,
    ]
  );

  const hasBackgroundRuns = runningSessions.length > 0;
  const hasUrgentApproval = runningSessions.some(
    (r) => r.stage === 'waiting_approval'
  );

  return (
    <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip
        content={t('workspace.newTab', '新建标签页 (⌘N)')}
        side="bottom"
        disabled={isOpen}
      >
        <Popover.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            className={styles.newTabBtn}
            aria-label={t('sidebar.newChat', '新对话')}
            data-tauri-drag-region="false"
            data-active={isOpen ? 'true' : undefined}
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
          >
            <span
              className={styles.plusIconWrap}
              data-tauri-drag-region="false"
            >
              <AppIcon name="plus" size={14} />
            </span>
            {hasBackgroundRuns && (
              <span
                className={styles.plusLiveDot}
                data-urgent={hasUrgentApproval ? 'true' : undefined}
                data-tauri-drag-region="false"
              />
            )}
          </Button>
        </Popover.Trigger>
      </Tooltip>

      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          className={styles.popoverContent}
          side="bottom"
          align="start"
          sideOffset={6}
          avoidCollisions={true}
          collisionPadding={12}
          onKeyDown={handleKeyDown}
        >
          {/* Section 1: 核心操作区 */}
          <div
            className={styles.section}
            role="menu"
            aria-label={t('launcher.coreActions', '核心操作')}
          >
            <Button
              bare
              type="button"
              className={styles.actionItem}
              data-focused={focusedIndex === 0}
              onClick={handleActionNewChat}
              onMouseEnter={() => setFocusedIndex(0)}
            >
              <div className={styles.actionIconWrap}>
                <AppIcon name="new-chat" size={15} />
              </div>
              <span className={styles.actionLabel}>
                {t('chat.newConversation', '新建对话')}
              </span>
              <span className={styles.shortcutHint}>⌘N</span>
            </Button>

            <Button
              bare
              type="button"
              className={styles.actionItem}
              data-focused={focusedIndex === 1}
              onClick={handleActionNewTerminal}
              onMouseEnter={() => setFocusedIndex(1)}
            >
              <div className={styles.actionIconWrap}>
                <AppIcon name="terminal" size={15} />
              </div>
              <span className={styles.actionLabel}>
                {t('launcher.newTerminal', '新建常规终端')}
              </span>
              <span className={styles.shortcutHint}>⌃`</span>
            </Button>

            <Button
              bare
              type="button"
              className={styles.actionItem}
              data-focused={focusedIndex === 2}
              onClick={handleActionNewBrowser}
              onMouseEnter={() => setFocusedIndex(2)}
            >
              <div className={styles.actionIconWrap}>
                <AppIcon name="globe" size={15} />
              </div>
              <span className={styles.actionLabel}>
                {t('launcher.newBrowser', '新建浏览器')}
              </span>
              <span className={styles.shortcutHint}>⌥B</span>
            </Button>
          </div>

          {/* Section 2: 运行中会话 (CSS Grid 0fr -> 1fr 平滑抗抖过渡) */}
          <div
            className={styles.runningSection}
            data-visible={runningSessions.length > 0}
          >
            <div className={styles.runningSectionInner}>
              <div className={styles.divider} />
              <div className={styles.sectionHeader}>
                <span>
                  {t('launcher.running', '运行中')} ({runningSessions.length})
                </span>
              </div>
              <div className={styles.runningList}>
                {runningSessions.map((session, idx) => {
                  const navIdx = 3 + idx;
                  const isUrgent = session.stage === 'waiting_approval';
                  const isDone = session.stage === 'just_completed';
                  const stageText = isUrgent
                    ? t('launcher.waitingApproval', '等待审批: {tool}', {
                        tool:
                          session.approvalMeta?.toolName ||
                          t('common.tool', '工具'),
                      })
                    : session.stageDetail || t('launcher.running', '运行中');

                  return (
                    <Button
                      key={session.sessionId}
                      bare
                      type="button"
                      className={styles.runningItem}
                      data-focused={focusedIndex === navIdx}
                      onClick={() => handleFocusRunning(session.sessionId)}
                      onMouseEnter={() => setFocusedIndex(navIdx)}
                    >
                      <div className={styles.pulseContainer}>
                        {isDone ? (
                          <span className={styles.doneCheck}>
                            <AppIcon name="check" size={14} />
                          </span>
                        ) : (
                          <>
                            <span
                              className={styles.pulseDot}
                              data-urgent={isUrgent ? 'true' : undefined}
                            />
                            <span
                              className={styles.pulseHalo}
                              data-urgent={isUrgent ? 'true' : undefined}
                            />
                          </>
                        )}
                      </div>
                      <Tooltip content={session.title} side="right">
                        <span className={styles.runningTitle}>
                          {session.title}
                        </span>
                      </Tooltip>
                      <span
                        className={styles.runningStage}
                        data-urgent={isUrgent ? 'true' : undefined}
                      >
                        {stageText}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Section 3: 真实用户项目（仅在存在真实项目时呈现，绝无虚假假数据） */}
          {userProjects.length > 0 && (
            <>
              <div className={styles.divider} />
              <div className={styles.sectionHeader}>
                <span>
                  {t('launcher.projects', '项目')} ({userProjects.length})
                </span>
              </div>
              <div className={styles.projectList}>
                {userProjects.map((project, idx) => {
                  const navIdx = 3 + runningSessions.length + idx;
                  return (
                    <Button
                      key={project.id}
                      bare
                      type="button"
                      className={styles.projectItem}
                      data-focused={focusedIndex === navIdx}
                      onClick={() => handleLaunchProject(project)}
                      onMouseEnter={() => setFocusedIndex(navIdx)}
                    >
                      <div className={styles.actionIconWrap}>
                        <AppIcon name="folder" size={14} />
                      </div>
                      <Tooltip
                        content={project.path || project.name}
                        side="right"
                      >
                        <span className={styles.projectTitle}>
                          {project.name}
                        </span>
                      </Tooltip>
                    </Button>
                  );
                })}
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
