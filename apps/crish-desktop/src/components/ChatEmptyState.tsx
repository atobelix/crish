/**
 * Chat 主列统一空态：无会话 / 过滤无命中 / 有会话无消息。
 * 视觉：透明底 + hairline chip，短文案；密钥引导由 soft-hint / FirstRun 负责。
 *
 * 三态扫视锚点（DOM）：
 * - class: chat-empty-state--{kind}
 * - data-empty-kind / data-primary-action / data-show-project-bar / data-show-prompts
 * - data-engine-ok / data-messages-loading / data-shell-cue / data-density
 *
 * 契约（与 api/chatEmptyState 纯函数对齐）：
 * - engineOk===false → 欢迎面草稿口径、隐藏快捷 prompt
 * - messagesLoading + 非 no-session → 不挂载（防幽灵「开始对话」）
 * - CTA 文案只走 resolveChatEmptyActionLabel 中文标签
 */
import React, { useId } from 'react';
import styles from './ChatEmptyState.module.css';
import * as Lucide from 'lucide-react';
import { AppErrorBoundary } from './AppErrorBoundary';
import {
  CHAT_EMPTY_QUICK_PROMPTS,
  chatEmptyKindAriaLabel,
  isChatEmptyKind,
  resolveChatEmptyActionLabel,
  resolveChatEmptyCopy,
  resolveChatEmptyPrimaryAction,
  resolveEmptyShellReuseCue,
  shouldShowEmptyQuickPrompts,
  type ChatEmptyKind,
  type ChatEmptyPrimaryAction,
} from '../api/chatEmptyState';
import {
  getActiveProject,
  getWorkspacePath,
} from '../api/projectStore';
import { ProjectPickerMenu } from './ProjectPickerMenu';

export type ChatEmptyStateProps = {
  kind: ChatEmptyKind;
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
   * 有活动会话时组件内二次抑制空壳，避免父级短暂漏判闪幽灵欢迎面。
   * no-session 仍展示「新建对话」CTA（与 resolveChatEmptyKind 一致）。
   */
  messagesLoading?: boolean;
  /** createSession 将复用空白会话时的旁注 */
  shellWillReuse?: boolean;
  /** 刚剪掉多余空白会话 */
  shellDidPrunePeers?: boolean;
  /** 当前活动即为默认可复用空壳 */
  shellActiveIsEmpty?: boolean;
  /** session-empty：项目选择器开关 */
  showProjectPicker?: boolean;
  onShowProjectPicker?: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged?: () => void;
  onSetChatInput?: (text: string) => void;
  /** no-session */
  onCreateSession?: () => void;
  /** filter-empty */
  onClearFilter?: () => void;
  /** Centered composer element for session-empty state */
  composer?: React.ReactNode;
};

function EmptyIcon({ kind }: { kind: ChatEmptyKind }) {
  const common = {
    size: 22 as const,
    strokeWidth: 1.5 as const,
    className: styles.chatEmptyIcon,
    'aria-hidden': true as const,
  };
  // 三态图标互不相同，辅助扫视（文案标题已区分）
  if (kind === 'no-session') return <Lucide.MessageSquarePlus {...common} />;
  if (kind === 'filter-empty') return <Lucide.SearchX {...common} />;
  return <Lucide.Sparkles {...common} />;
}

function primaryActionHandler(
  action: ChatEmptyPrimaryAction,
  handlers: {
    onCreateSession?: () => void;
    onClearFilter?: () => void;
  },
): (() => void) | undefined {
  if (action === 'create-session') return handlers.onCreateSession;
  if (action === 'clear-filter') return handlers.onClearFilter;
  return undefined;
}

/** 项目条按钮展示名（中文，与欢迎面口径一致） */
function projectDisplayName(
  active: ReturnType<typeof getActiveProject>,
): string {
  if (active?.name) return active.name;
  if (getWorkspacePath()) return '当前目录';
  return '选择项目';
}

/** 将快捷 prompt 填入后聚焦主列输入框（避免全局 query 误伤其它 textarea） */
function focusChatComposer(): void {
  const scope =
    document.querySelector<HTMLElement>('[data-main-surface="chat"]') ??
    document.body;
  const ta =
    scope.querySelector<HTMLTextAreaElement>(
      '.input-container textarea:not([disabled])',
    ) ??
    scope.querySelector<HTMLTextAreaElement>('textarea:not([disabled])') ??
    document.querySelector<HTMLTextAreaElement>(
      '.input-container textarea:not([disabled])',
    );
  ta?.focus();
}

export const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({
  kind,
  filterQuery = '',
  needsKeySetup = false,
  needsModelSetup = false,
  firstRunOpen = false,
  engineOk = null,
  messagesLoading = false,
  shellWillReuse = false,
  shellDidPrunePeers = false,
  shellActiveIsEmpty = false,
  showProjectPicker = false,
  onShowProjectPicker,
  onProjectChanged,
  onSetChatInput,
  onCreateSession,
  onClearFilter,
  composer,
}) => {
  const reactId = useId();

  // 运行时守卫：非法 kind 不挂载，避免 class/data 污染
  if (!isChatEmptyKind(kind)) return null;

  // 防幽灵空壳：水合中不渲染欢迎/过滤空态（no-session 仍需「新建对话」）
  if (messagesLoading && kind !== 'no-session') {
    return null;
  }

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

  const activeProject = getActiveProject();
  const projectName = projectDisplayName(activeProject);

  const ariaLabel = chatEmptyKindAriaLabel(kind);
  const titleId = `chat-empty-title-${kind}-${reactId}`;
  const subId = `chat-empty-sub-${kind}-${reactId}`;
  const cueId = `chat-empty-cue-${kind}-${reactId}`;

  const shellCue = resolveEmptyShellReuseCue({
    willReuse: shellWillReuse,
    didPrunePeers: shellDidPrunePeers,
    activeIsEmptyShell: shellActiveIsEmpty,
  });

  const actionFn = primaryActionHandler(primaryAction, {
    onCreateSession,
    onClearFilter,
  });
  // 与 copy.primaryAction 交叉校验：任一为 null / 无 handler 则隐藏
  const showAction = Boolean(
    actionLabel &&
      primaryAction &&
      primaryAction === copy.primaryAction &&
      actionFn,
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
      }),
  );

  // 密度：向导盖层 / 引擎离线欢迎面收紧（去装饰图标，少一层扫视噪音）
  const density: 'compact' | 'default' =
    firstRunOpen || (kind === 'session-empty' && engineOk === false)
      ? 'compact'
      : 'default';
  const showIcon = density === 'default';

  // FirstRun 盖层打开时不抢读屏播报（向导独占）
  const ariaLive: 'polite' | 'off' = firstRunOpen ? 'off' : 'polite';
  const describedBy = shellCue ? `${subId} ${cueId}` : subId;

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
        data-shell-cue={shellCue?.code ?? 'none'}
        role="status"
        aria-live={ariaLive}
        aria-label={ariaLabel}
        aria-labelledby={titleId}
        aria-describedby={describedBy}
      >
      {showIcon ? (
        <div className={styles.chatEmptyIconWrap} aria-hidden>
          <EmptyIcon kind={kind} />
        </div>
      ) : null}

      {kind === 'session-empty' ? (
        <div className={styles.chatEmptyHero}>
          <h3 id={titleId} className={`${styles.chatEmptyTitle} ${styles.chatEmptyTitleHero}`}>
            我们该在
            {showProjectBar && onShowProjectPicker ? (
              <div className={styles.chatEmptyProjectInline} data-empty-region="project-bar">
                <button
                  type="button"
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
                  onClick={() => onShowProjectPicker((v) => !v)}
                  onMouseEnter={() => onShowProjectPicker(true)}
                >
                  <span>{projectName}</span>
                </button>
                {showProjectPicker ? (
                  <ProjectPickerMenu
                    open
                    onClose={() => onShowProjectPicker(false)}
                    onChanged={() => onProjectChanged?.()}
                  />
                ) : null}
              </div>
            ) : (
              <span className={styles.chatEmptyProjectText}> {projectName} </span>
            )}
            中处理什么？
          </h3>
        </div>
      ) : (
        <h3 id={titleId} className={styles.chatEmptyTitle}>
          {copy.title}
        </h3>
      )}

      {copy.sub ? (
        <p id={subId} className={styles.chatEmptySub}>
          {copy.sub}
        </p>
      ) : null}

      {shellCue ? (
        <p
          id={cueId}
          className={styles.chatEmptySub}
          data-empty-region="shell-cue"
          data-shell-cue-code={shellCue.code}
          style={{ marginTop: -12, marginBottom: 12, fontSize: 'var(--font-size-sm)' }}
        >
          {shellCue.label}
        </p>
      ) : null}

      {showAction && actionLabel && actionFn ? (
        <button
          type="button"
          className={styles.chatEmptyAction}
          data-empty-action={primaryAction}
          aria-label={actionLabel}
          onClick={actionFn}
        >
          {primaryAction === 'create-session' ? (
            <Lucide.Plus size={14} strokeWidth={2} aria-hidden />
          ) : (
            <Lucide.Eraser size={14} strokeWidth={1.75} aria-hidden />
          )}
          {actionLabel}
        </button>
      ) : null}

      {composer && <div className={styles.chatEmptyComposerWrap}>{composer}</div>}

      {showPrompts && onSetChatInput ? (
        <div
          className={styles.chatEmptyPrompts}
          role="list"
          data-empty-region="quick-prompts"
          aria-label="快捷提示"
        >
          {CHAT_EMPTY_QUICK_PROMPTS.map((item) => (
            <button
              key={item.label}
              type="button"
              className={styles.quickPromptCard}
              role="listitem"
              data-quick-prompt={item.label}
              aria-label={`填入提示：${item.label}`}
              title={item.prompt}
              onClick={() => {
                onSetChatInput(item.prompt);
                focusChatComposer();
              }}
            >
              <span className={styles.quickPromptLabel}>{item.label}</span>
              <span className={styles.quickPromptDesc}>{item.prompt}</span>
              <Lucide.ChevronRight size={14} className={styles.promptArrow} style={{ opacity: 0.4, flexShrink: 0, marginLeft: 'auto' }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  </AppErrorBoundary>
);
};
