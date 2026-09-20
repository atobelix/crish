/**
 * Chat 主列统一空态：无会话 / 过滤无命中 / 有会话无消息。
 * 视觉：透明底 + hairline chip，短文案；密钥引导由 soft-hint / FirstRun 负责。
 *
 * 三态扫视锚点（DOM）：
 * - class: chat-empty-state--{kind}
 * - data-empty-kind / data-primary-action / data-show-project-bar / data-show-prompts
 * - data-engine-ok / data-messages-loading / data-density
 *
 * 契约（与 api/chatEmptyState 纯函数对齐）：
 * - engineOk===false → 欢迎面草稿口径、隐藏快捷 prompt
 * - messagesLoading 不卸载欢迎面（轻量指示；快捷 prompt 可暂隐）
 * - CTA 文案只走 resolveChatEmptyActionLabel 中文标签
 */
import React, { useCallback, useEffect, useId, useRef } from 'react';
import styles from './ChatEmptyState.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { Button, Tooltip } from '../ui';
import {
  CHAT_EMPTY_QUICK_PROMPTS,
  chatEmptyKindAriaLabel,
  isChatEmptyKind,
  resolveChatEmptyActionLabel,
  resolveChatEmptyCopy,
  resolveChatEmptyPrimaryAction,
  shouldShowEmptyQuickPrompts,
  type ChatEmptyKind,
  type ChatEmptyPrimaryAction,
} from '../../api/chatEmptyState';
import {
  getActiveProject,
  getWorkspacePath,
  listProjects,
  resolveFolderToProjectId,
  projectFolderLabel,
  GENERAL_FOLDER,
  type ProjectEntry,
} from '../../api/projectStore';
import { ProjectPickerMenu } from './ProjectPickerMenu';
import { AppIcon } from '../ui/icons/index';


/** 项目菜单悬停关闭延迟（ms）：离开 trigger/菜单后启动，进入菜单取消 */
const PROJECT_PICKER_CLOSE_DELAY_MS = 400;

export type ChatEmptyStateProps = {
  kind: ChatEmptyKind;
  /** 窗格绑定的项目作用域 Key（支持 project.id / folder / GENERAL_FOLDER），隔离多分屏跨窗口文字乱跳 */
  workspaceKey?: string | null;
  filterQuery?: string;
  needsKeySetup?: boolean;
  needsModelSetup?: boolean;
  firstRunOpen?: boolean;
  /**
   * engineHint.ok；false = daemon/引擎离线。
   * 欢迎面改草稿口径并隐藏快捷 prompt；未传/null 按就绪处理。
   */
  engineOk?: boolean | null;
  /**
   * 会话消息仍在从磁盘/引擎水合。
   * 不卸载欢迎面；仅打 data-messages-loading + 轻量指示，快捷 prompt 可暂隐。
   */
  messagesLoading?: boolean;
  /** session-empty：项目选择器开关 */
  showProjectPicker?: boolean;
  onShowProjectPicker?: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged?: () => void;
  onSetChatInput?: (text: string) => void;
  /** no-session */
  onCreateSession?: () => void;
  /** filter-empty */
  onClearFilter?: () => void;
};

export interface ScopedProjectInfo {
  project: ProjectEntry | null;
  displayName: string;
  isGeneral: boolean;
}

/** 窗格作用域优先的项目解析器（纯函数、零全局副作用） */
export function resolveProjectForScope(
  workspaceKey?: string | null
): ScopedProjectInfo {
  if (workspaceKey !== undefined && workspaceKey !== null) {
    const k = workspaceKey.trim();
    if (
      !k ||
      k === GENERAL_FOLDER ||
      k === '对话' ||
      k === '会话' ||
      k === '常规会话' ||
      k === 'general'
    ) {
      return { project: null, displayName: '选择项目', isGeneral: true };
    }

    const projectId = resolveFolderToProjectId(k);
    if (projectId) {
      const p = listProjects().find((proj) => proj.id === projectId);
      if (p) {
        return { project: p, displayName: p.name, isGeneral: false };
      }
    }

    const label = projectFolderLabel(k);
    return { project: null, displayName: label, isGeneral: false };
  }

  const active = getActiveProject();
  if (active) {
    return { project: active, displayName: active.name, isGeneral: false };
  }
  return {
    project: null,
    displayName: getWorkspacePath() ? '当前目录' : '选择项目',
    isGeneral: true,
  };
}

function EmptyIcon({ kind }: { kind: ChatEmptyKind }) {
  const common = {
    size: 22 as const,
    strokeWidth: 1.5 as const,
    className: styles.chatEmptyIcon,
    'aria-hidden': true as const,
  };
  // 三态图标互不相同，辅助扫视（文案标题已区分）
  if (kind === 'no-session') return <AppIcon name="message-square-plus" {...common} />;
  if (kind === 'filter-empty') return <AppIcon name="search-x" {...common} />;
  return <AppIcon name="sparkles" {...common} />;
}

function primaryActionHandler(
  action: ChatEmptyPrimaryAction,
  handlers: {
    onCreateSession?: () => void;
    onClearFilter?: () => void;
  }
): (() => void) | undefined {
  if (action === 'create-session') return handlers.onCreateSession;
  if (action === 'clear-filter') return handlers.onClearFilter;
  return undefined;
}

/** 将快捷 prompt 填入后聚焦主列输入框（避免全局 query 误伤其它 textarea） */
function focusChatComposer(): void {
  const scope =
    document.querySelector<HTMLElement>('[data-main-surface="chat"]') ??
    document.body;
  const ta =
    scope.querySelector<HTMLTextAreaElement>(
      '.input-container textarea:not([disabled])'
    ) ??
    scope.querySelector<HTMLTextAreaElement>('textarea:not([disabled])') ??
    document.querySelector<HTMLTextAreaElement>(
      '.input-container textarea:not([disabled])'
    );
  ta?.focus();
}

export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
  kind,
  workspaceKey,
  filterQuery = '',
  needsKeySetup = false,
  needsModelSetup = false,
  firstRunOpen = false,
  engineOk = null,
  messagesLoading = false,
  showProjectPicker = false,
  onShowProjectPicker,
  onProjectChanged,
  onSetChatInput,
  onCreateSession,
  onClearFilter,
}) => {
  const reactId = useId();
  const projectPickerCloseTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const cancelProjectPickerClose = useCallback(() => {
    if (projectPickerCloseTimerRef.current) {
      clearTimeout(projectPickerCloseTimerRef.current);
      projectPickerCloseTimerRef.current = null;
    }
  }, []);

  const scheduleProjectPickerClose = useCallback(() => {
    cancelProjectPickerClose();
    projectPickerCloseTimerRef.current = setTimeout(() => {
      onShowProjectPicker?.(false);
      projectPickerCloseTimerRef.current = null;
    }, PROJECT_PICKER_CLOSE_DELAY_MS);
  }, [onShowProjectPicker, cancelProjectPickerClose]);

  const openProjectPicker = useCallback(() => {
    if (!onShowProjectPicker) return;
    cancelProjectPickerClose();
    onShowProjectPicker(true);
  }, [onShowProjectPicker, cancelProjectPickerClose]);

  const handleProjectPickerOpenChange = useCallback(
    (next: boolean) => {
      cancelProjectPickerClose();
      onShowProjectPicker?.(next);
    },
    [onShowProjectPicker, cancelProjectPickerClose]
  );

  useEffect(() => {
    return () => cancelProjectPickerClose();
  }, [cancelProjectPickerClose]);

  // 运行时守卫：非法 kind 不挂载，避免 class/data 污染
  if (!isChatEmptyKind(kind)) return null;

  const copy = resolveChatEmptyCopy({
    kind,
    filterQuery,
    needsKeySetup,
    needsModelSetup,
    firstRunOpen,
    engineOk,
  });

  // 主行动与中文 CTA：以纯函数为单一来源，避免 copy 分支漏接
  const primaryAction = resolveChatEmptyPrimaryAction(kind, { firstRunOpen });
  const actionLabel =
    resolveChatEmptyActionLabel(primaryAction) ?? copy.actionLabel;

  const projectInfo = resolveProjectForScope(workspaceKey);
  const projectName = projectInfo.displayName;
  const activeProject = projectInfo.project;

  const ariaLabel = chatEmptyKindAriaLabel(kind);
  const titleId = `chat-empty-title-${kind}-${reactId}`;
  const subId = `chat-empty-sub-${kind}-${reactId}`;

  const actionFn = primaryActionHandler(primaryAction, {
    ...(onCreateSession !== undefined && { onCreateSession }),
    ...(onClearFilter !== undefined && { onClearFilter }),
  });
  // 与 copy.primaryAction 交叉校验：任一为 null / 无 handler 则隐藏
  const showAction = Boolean(
    actionLabel &&
    primaryAction &&
    primaryAction === copy.primaryAction &&
    actionFn
  );

  // 项目条：有回调即可；onProjectChanged 可选（打开 picker 仍有意义）
  const showProjectBar = Boolean(copy.showProjectBar && onShowProjectPicker);

  // 快捷 prompt：copy + shouldShowEmptyQuickPrompts 双闸（含 loading/engine 矩阵）
  const showPrompts = Boolean(
    onSetChatInput &&
    copy.showQuickPrompts &&
    shouldShowEmptyQuickPrompts({
      kind,
      firstRunOpen,
      engineOk,
      messagesLoading,
    })
  );

  // 密度：向导盖层 / 引擎离线欢迎面收紧（去装饰图标，少一层扫视噪音）
  const density: 'compact' | 'default' =
    firstRunOpen || (kind === 'session-empty' && engineOk === false)
      ? 'compact'
      : 'default';
  const showIcon = density === 'default';

  // FirstRun 盖层打开时不抢读屏播报（向导独占）
  const ariaLive: 'polite' | 'off' = firstRunOpen ? 'off' : 'polite';

  const engineOkAttr =
    engineOk === false ? 'false' : engineOk === true ? 'true' : 'unknown';

  const kindClass =
    kind === 'no-session'
      ? styles.noSession
      : kind === 'filter-empty'
        ? styles.filterEmpty
        : styles.sessionEmpty;

  return (
    <AppErrorBoundary variant="minimal" title="快捷提示出错">
      <div
        className={`${styles.chatEmptyState} ${kindClass}`}
        data-empty-kind={kind}
        data-primary-action={primaryAction ?? 'none'}
        data-show-project-bar={showProjectBar ? 'true' : 'false'}
        data-show-prompts={showPrompts ? 'true' : 'false'}
        data-first-run={firstRunOpen ? 'true' : 'false'}
        data-engine-ok={engineOkAttr}
        data-messages-loading={messagesLoading ? 'true' : 'false'}
        data-density={density}
        role="status"
        aria-live={ariaLive}
        aria-label={ariaLabel}
        aria-labelledby={titleId}
        aria-describedby={subId}
      >
        {showIcon ? (
          <div className={styles.chatEmptyIconWrap} aria-hidden>
            <EmptyIcon kind={kind} />
          </div>
        ) : null}

        {kind === 'session-empty' ? (
          <div className={styles.chatEmptyHero}>
            <h3
              id={titleId}
              className={`${styles.chatEmptyTitle} ${styles.chatEmptyTitleHero}`}
            >
              我们该在
              {showProjectBar && onShowProjectPicker ? (
                <div
                  className={styles.chatEmptyProjectInline}
                  data-empty-region="project-bar"
                >
                  <ProjectPickerMenu
                    open={showProjectPicker}
                    onOpenChange={handleProjectPickerOpenChange}
                    onClose={() => onShowProjectPicker(false)}
                    onChanged={() => onProjectChanged?.()}
                    onContentMouseEnter={cancelProjectPickerClose}
                    onContentMouseLeave={scheduleProjectPickerClose}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      className={`${styles.chatEmptyProjectBtnInline}`}
                      aria-expanded={showProjectPicker}
                      aria-haspopup="menu"
                      aria-label={
                        activeProject
                          ? `当前项目：${projectName}，点击切换`
                          : getWorkspacePath()
                            ? '当前目录，点击选择项目'
                            : '选择项目'
                      }
                      onMouseEnter={openProjectPicker}
                      onMouseLeave={scheduleProjectPickerClose}
                    >
                      <span>{projectName}</span>
                    </Button>
                  </ProjectPickerMenu>
                </div>
              ) : (
                <span className={styles.chatEmptyProjectText}>
                  {' '}
                  {projectName}{' '}
                </span>
              )}
              中处理什么？
            </h3>
          </div>
        ) : (
          <h3 id={titleId} className={styles.chatEmptyTitle}>
            {copy.title}
          </h3>
        )}

        {messagesLoading && kind !== 'no-session' ? (
          <p
            className={styles.chatEmptyLoading}
            data-empty-region="loading"
          >
            正在加载消息
          </p>
        ) : null}

        {copy.sub ? (
          <p id={subId} className={styles.chatEmptySub}>
            {copy.sub}
          </p>
        ) : null}

        {showAction && actionLabel && actionFn ? (
          <Button
            type="button"
            variant="secondary"
            size="md"
            className={styles.chatEmptyAction}
            data-empty-action={primaryAction}
            aria-label={actionLabel}
            onClick={actionFn}
            icon={
              primaryAction === 'create-session' ? (
                <AppIcon name="plus" size={14} aria-hidden />
              ) : (
                <AppIcon name="eraser" size={14} aria-hidden />
              )
            }
          >
            {actionLabel}
          </Button>
        ) : null}

        {showPrompts && onSetChatInput ? (
          <div
            className={styles.chatEmptyPrompts}
            role="list"
            data-empty-region="quick-prompts"
            aria-label="快捷提示"
          >
            {CHAT_EMPTY_QUICK_PROMPTS.map((item) => (
              <Tooltip key={item.label} content={item.prompt}>
                <Button
                  type="button"
                  variant="ghost"
                  className={styles.quickPromptCard}
                  role="listitem"
                  data-quick-prompt={item.label}
                  aria-label={`填入提示：${item.label}`}
                  onClick={() => {
                    onSetChatInput(item.prompt);
                    focusChatComposer();
                  }}
                >
                  <span className={styles.quickPromptLabel}>{item.label}</span>
                  <span className={styles.quickPromptDesc}>{item.prompt}</span>
                  <AppIcon name="chevron-right" size={14}
                    className={styles.promptArrow}
                    aria-hidden="true" />
                </Button>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </div>
    </AppErrorBoundary>
  );
};
