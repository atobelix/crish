/**
 * 消息列表渲染：空状态 + user/assistant bubbles + 工具时间线。
 * 从 ChatCard 剪切粘贴，保持 className；状态机/stream 仍在 ChatCard。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import type { FileDiff, SessionAgent, SessionMessage } from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import {
  getActiveProject,
  getWorkspacePath,
  listProjects,
  openProject,
} from '../api/projectStore';
import { ProjectPickerMenu } from './ProjectPickerMenu';
import { ChatToolStack } from './ChatToolCallBlock';
import {
  assistantCopyText,
  buildAssistantTimeline,
  extractImageRefs,
} from '../api/toolPresentation';
import { parseMarkdownToHtml, stripThoughtPlaceholders } from '../api/markdownRender';
import { ChangeOverviewCard } from './ChangeOverviewCard';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  nextExpandedOlder,
  windowMessages,
} from '../api/messageWindow';
import {
  messageMatchesSearch,
  readSessionSearchQuery,
} from '../api/sessionSearch';

const EMPTY_PIN_IDS: string[] = [];
const EMPTY_MSGS: SessionMessage[] = [];

/** 固定条摘要：去空白后截断 */
function pinSnippet(text?: string, max = 72): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（无文本）';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function scrollToMessage(messageId: string) {
  const el = document.querySelector(
    `[data-msg-id="${CSS.escape(messageId)}"]`,
  ) as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-row-pin-flash');
  window.setTimeout(() => el.classList.remove('msg-row-pin-flash'), 1200);
}

/** 助手回复是否像「计划」：含步骤/计划/编号列表/标题 */
function looksLikePlan(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (/步骤|计划/.test(t)) return true;
  if (/^#{1,3}\s/m.test(t)) return true;
  // 1. / 1、 / 2. 等有序列表
  if (/(?:^|\n)\s*\d+[\.、]\s+\S/.test(t)) return true;
  return false;
}

export interface ChatMessageListProps {
  messages: SessionMessage[];
  agents: SessionAgent[];
  activeSessionId: string;
  thinkingSeconds: number;
  showProjectPicker: boolean;
  onShowProjectPicker: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged: () => void;
  onSetChatInput: (text: string) => void;
  onWithdraw: (msgId: string, text: string) => void;
  onRegenerate: (userText: string, assistantMsgId: string) => void;
  onBranch: () => void;
  onShowToast: (message: string) => void;
  approvalBusy: boolean;
  pendingApprovalMsgId: string;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
  /** 打开右侧变更面板（可选） */
  onOpenDiffPanel?: () => void;
  onApprovalAllow: (toolId: string, msgId: string, remember?: boolean) => void;
  onApprovalDeny: (toolId: string, msgId: string) => void;
}

function formatTime(ts?: number) {
  if (!ts) return '';
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

const ChatMessageListInner: React.FC<ChatMessageListProps> = ({
  messages,
  agents,
  activeSessionId,
  thinkingSeconds,
  showProjectPicker,
  onShowProjectPicker,
  onProjectChanged,
  onSetChatInput,
  onWithdraw,
  onRegenerate,
  onBranch,
  onShowToast,
  approvalBusy,
  pendingApprovalMsgId,
  onOpenDiff,
  onOpenPath,
  onOpenTerminal,
  onOpenDiffPanel,
  onApprovalAllow,
  onApprovalDeny,
}) => {
  /** 按会话保留工具展开态，切换 session 不互相冲掉 */
  const [expandedToolsBySession, setExpandedToolsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  /** 本轮工具组展开态（key=`${msgId}:${timelineKey}`）；N>=4 默认折叠 */
  const [expandedRoundsBySession, setExpandedRoundsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [expandedUserMsgs, setExpandedUserMsgs] = useState<Record<string, boolean>>({});
  const [pinsOpen, setPinsOpen] = useState(true);
  /** 长列表窗口：从尾部展开的额外更早条数；切换会话重置 */
  const [expandedOlder, setExpandedOlder] = useState(0);
  const activeProject = getActiveProject();
  const sessionKey = activeSessionId || '_';
  const expandedTools = expandedToolsBySession[sessionKey] || {};
  const expandedRounds = expandedRoundsBySession[sessionKey] || {};

  useEffect(() => {
    setExpandedOlder(0);
  }, [activeSessionId]);

  const messageWindow = useMemo(
    () =>
      windowMessages(messages, {
        recentCount: DEFAULT_RECENT_MESSAGE_COUNT,
        expandedOlder,
      }),
    [messages, expandedOlder],
  );
  const visibleMessages = messageWindow.visible;
  /** 侧栏搜索选中后写入 sessionStorage，用于命中消息高亮 */
  const searchHighlightQuery = useMemo(
    () => readSessionSearchQuery(),
    // 随会话切换 / 消息数变化重读（选中会话后进入列表）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeSessionId 触发重读
    [activeSessionId, messages.length],
  );

  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const pinMessage = useLayoutStore((s) => s.pinMessage);
  const unpinMessage = useLayoutStore((s) => s.unpinMessage);
  const pinnedMessageIds = useLayoutStore(
    (s) =>
      s.sessions.find((x) => x.id === activeSessionId)?.pinnedMessageIds || EMPTY_PIN_IDS,
  );
  const sessionAllMessages = useLayoutStore(
    (s) => s.sessions.find((x) => x.id === activeSessionId)?.messages || EMPTY_MSGS,
  );
  const pinnedIdSet = useMemo(() => new Set(pinnedMessageIds), [pinnedMessageIds]);

  const pinnedItems = useMemo(() => {
    if (!pinnedMessageIds.length) return [];
    const byId = new Map(sessionAllMessages.map((m) => [m.id, m]));
    return pinnedMessageIds
      .map((id) => {
        const m = byId.get(id);
        if (!m) return null;
        const text =
          m.sender === 'assistant' ? assistantCopyText(m) || m.text || '' : m.text || '';
        return {
          id,
          sender: m.sender as 'user' | 'assistant',
          snippet: pinSnippet(text),
        };
      })
      .filter(Boolean) as { id: string; sender: 'user' | 'assistant'; snippet: string }[];
  }, [pinnedMessageIds, sessionAllMessages]);

  const togglePin = useCallback(
    (messageId: string) => {
      if (!activeSessionId) return;
      if (pinnedIdSet.has(messageId)) {
        unpinMessage(activeSessionId, messageId);
        onShowToast('已取消固定');
      } else {
        pinMessage(activeSessionId, messageId);
        onShowToast('已固定消息');
      }
    },
    [activeSessionId, pinnedIdSet, pinMessage, unpinMessage, onShowToast],
  );

  const lastAssistantId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.sender === 'assistant') return messages[i]!.id;
    }
    return null;
  })();

  /** 切换展开；须传入当前展示态，避免 defaultOpen=true 时首次点击仍为 true */
  const toggleTool = useCallback(
    (toolId: string, currentlyOpen: boolean) => {
      setExpandedToolsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] || {}),
          [toolId]: !currentlyOpen,
        },
      }));
    },
    [sessionKey],
  );

  const toggleRound = useCallback(
    (roundKey: string, currentlyOpen: boolean) => {
      setExpandedRoundsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] || {}),
          [roundKey]: !currentlyOpen,
        },
      }));
    },
    [sessionKey],
  );

  /** 代码块「复制」按钮（markdown 注入的 .md-code-copy） */
  const handleMarkdownClick = useCallback(
    (e: React.MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const btn = t?.closest?.('.md-code-copy') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const fromAttr = btn.getAttribute('data-copy');
      const fromPre =
        btn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
      const text = fromAttr != null && fromAttr !== '' ? fromAttr : fromPre;
      if (!text) return;
      void navigator.clipboard.writeText(text).then(
        () => onShowToast('已复制'),
        () => onShowToast('复制失败'),
      );
    },
    [onShowToast],
  );

  const toolStackProps = {
    agents,
    activeSessionId,
    expandedTools,
    onToggleTool: toggleTool,
    expandedRounds,
    onToggleRound: toggleRound,
    approvalBusy,
    pendingApprovalMsgId,
    onOpenDiff,
    onOpenPath,
    onOpenTerminal,
    onApprovalAllow,
    onApprovalDeny,
    onShowToast,
  };

  if (messages.length === 0) {
    return (
      <div className="chat-empty-state">
        <h3 className="chat-empty-title">有什么可以帮你？</h3>
        <p className="chat-empty-sub">先选择项目，或在无项目模式下直接开始对话。</p>

        <div className="chat-empty-project-bar">
          <div className="chat-empty-project-anchor">
            <button
              type="button"
              className="chat-empty-project-btn"
              onClick={() => onShowProjectPicker((v) => !v)}
            >
              <Lucide.Folder size={16} />
              <span>
                {activeProject
                  ? activeProject.name
                  : getWorkspacePath()
                    ? '当前目录'
                    : '选择项目'}
              </span>
              <Lucide.ChevronDown size={16} style={{ opacity: 0.5 }} />
            </button>
            {showProjectPicker && (
              <ProjectPickerMenu
                open
                onClose={() => onShowProjectPicker(false)}
                onChanged={onProjectChanged}
              />
            )}
          </div>
          {listProjects().length > 0 && !activeProject && (
            <button
              type="button"
              className="chat-empty-last-btn"
              onClick={() => {
                const last = listProjects()[0];
                if (last) {
                  openProject(last.id);
                  onProjectChanged();
                }
              }}
            >
              打开最近：{listProjects()[0]?.name}
            </button>
          )}
        </div>

        <div className="chat-empty-prompts">
          {[
            { label: '分析项目结构', prompt: '分析当前工作区项目结构，梳理核心模块与依赖关系' },
            { label: '查看代码改动', prompt: '运行 git status 与 git diff，总结当前工作区修改' },
            { label: '检查开发服务', prompt: '检查本地开发服务器与相关工具是否正常运行' },
          ].map((item, idx) => (
            <button
              key={idx}
              type="button"
              className="quick-prompt-card"
              onClick={() => {
                onSetChatInput(item.prompt);
                document.querySelector<HTMLTextAreaElement>('.input-container textarea')?.focus();
              }}
            >
              <span>{item.label}</span>
              <Lucide.ArrowRight size={16} style={{ opacity: 0.4 }} />
            </button>
          ))}
        </div>
      </div>
    );
  }

  const thinkingMsgId = messages.find(
    (m) => m.sender === 'assistant' && m.status === 'processing',
  )?.id;

  return (
    <div className="chat-message-list" onClick={handleMarkdownClick}>
      {messageWindow.hasOlder ? (
        <div className="chat-msg-window-older">
          <button
            type="button"
            className="chat-msg-window-older-btn"
            onClick={() =>
              setExpandedOlder((n) =>
                nextExpandedOlder(n, messageWindow.hiddenCount),
              )
            }
          >
            显示更早的 {Math.min(40, messageWindow.hiddenCount)} 条消息
            <span className="chat-msg-window-older-meta">
              （已隐藏 {messageWindow.hiddenCount}）
            </span>
          </button>
        </div>
      ) : null}
      {pinnedItems.length > 0 ? (
        <div className="chat-pinned-bar" role="region" aria-label="已固定消息">
          <button
            type="button"
            className="chat-pinned-bar-toggle"
            onClick={() => setPinsOpen((v) => !v)}
            title={pinsOpen ? '收起固定列表' : '展开固定列表'}
            aria-expanded={pinsOpen}
          >
            <Lucide.Pin size={13} strokeWidth={2} />
            <span>已固定 · {pinnedItems.length}</span>
            <Lucide.ChevronDown
              size={14}
              className={`chat-pinned-chevron${pinsOpen ? ' is-open' : ''}`}
            />
          </button>
          {pinsOpen ? (
            <ul className="chat-pinned-list">
              {pinnedItems.map((item) => (
                <li key={item.id} className="chat-pinned-item">
                  <button
                    type="button"
                    className="chat-pinned-jump"
                    title="跳转到消息"
                    onClick={() => scrollToMessage(item.id)}
                  >
                    <span
                      className={`chat-pinned-role ${
                        item.sender === 'user' ? 'is-user' : 'is-assistant'
                      }`}
                    >
                      {item.sender === 'user' ? '你' : '助手'}
                    </span>
                    <span className="chat-pinned-snippet">{item.snippet}</span>
                  </button>
                  <button
                    type="button"
                    className="chat-pinned-unpin msg-icon-btn"
                    title="取消固定"
                    aria-label="取消固定"
                    onClick={() => togglePin(item.id)}
                  >
                    <Lucide.PinOff size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {visibleMessages.map((msg, index) => {
        const prevMsg = index > 0 ? visibleMessages[index - 1] : null;
        const isFollowUp = msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
        const isPinnedMsg = pinnedIdSet.has(msg.id);
        if (msg.sender === 'user') {
          const isLong = (msg.text || '').length > 260;
          const isExpanded = !!expandedUserMsgs[msg.id];
          const displayText =
            isLong && !isExpanded ? (msg.text || '').slice(0, 240) + '…' : msg.text;
          const isSearchHit =
            !!searchHighlightQuery && messageMatchesSearch(msg, searchHighlightQuery);
          return (
            <div
              className={`msg-row msg-row-user${isSearchHit ? ' msg-search-hit' : ''}${isPinnedMsg ? ' is-pinned' : ''}`}
              key={msg.id}
              data-msg-id={msg.id}
            >
              <div className="msg-user-stack">
                {isPinnedMsg ? (
                  <span className="msg-pin-badge" title="已固定">
                    <Lucide.Pin size={11} strokeWidth={2.25} />
                    已固定
                  </span>
                ) : null}
                <div
                  className={`msg-user-bubble ${isExpanded ? 'expanded' : ''}`}
                  onClick={() => {
                    if (isLong) {
                      setExpandedUserMsgs((prev) => ({ ...prev, [msg.id]: !prev[msg.id] }));
                    }
                  }}
                  style={{ cursor: isLong ? 'pointer' : 'default' }}
                >
                  <span className="msg-user-text">{displayText}</span>
                  {msg.status === 'queued' && (
                    <span className="msg-status-badge queued">排队中</span>
                  )}
                </div>
                <div className="msg-user-meta">
                  <span className="msg-time">{formatTime(msg.timestamp)}</span>
                  <button
                    type="button"
                    className={`msg-icon-btn${isPinnedMsg ? ' is-pinned-active' : ''}`}
                    title={isPinnedMsg ? '取消固定' : '固定'}
                    onClick={() => togglePin(msg.id)}
                  >
                    {isPinnedMsg ? <Lucide.PinOff size={16} /> : <Lucide.Pin size={16} />}
                  </button>
                  <button
                    type="button"
                    className="msg-icon-btn"
                    title="复制"
                    onClick={() => {
                      navigator.clipboard.writeText(msg.text || '');
                    }}
                  >
                    <Lucide.Copy size={16} />
                  </button>
                  <button
                    type="button"
                    className="msg-icon-btn"
                    title="撤回"
                    onClick={() => {
                      onWithdraw(msg.id, msg.text || '');
                    }}
                  >
                    <Lucide.Undo2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          );
        }

        const isThinkingMsg = msg.id === thinkingMsgId;
        const thinkingRaw =
          msg.thinking &&
          msg.thinking.trim() &&
          msg.thinking !== '正在处理…' &&
          msg.thinking !== '正在思考中...'
            ? msg.thinking.trim()
            : '';
        const thinkingText = thinkingRaw || (isThinkingMsg ? '…' : '');
        const thinkingLineCount = thinkingText
          ? thinkingText.split(/\r?\n/).length
          : 0;
        /** 五行以内（且非流式中）直接展示，不折叠 */
        const thinkingShort =
          !isThinkingMsg && thinkingLineCount > 0 && thinkingLineCount <= 5;
        const showThinking = isThinkingMsg || thinkingLineCount > 0;
        const isSearchHit =
          !!searchHighlightQuery && messageMatchesSearch(msg, searchHighlightQuery);

        return (
          <div
            className={`msg-row msg-row-assistant ${isFollowUp ? 'is-followup' : ''}${isSearchHit ? ' msg-search-hit' : ''}${isPinnedMsg ? ' is-pinned' : ''}`}
            key={msg.id}
            data-msg-id={msg.id}
          >
            {isPinnedMsg ? (
              <span className="msg-pin-badge" title="已固定">
                <Lucide.Pin size={11} strokeWidth={2.25} />
                已固定
              </span>
            ) : null}
            {/* 思考：短内容平铺；长内容 / 进行中用折叠 */}
            {showThinking && thinkingShort ? (
              <div className="msg-thinking-plain" key={`think-plain-${msg.id}`}>
                <div className="msg-thinking-plain-label">思考</div>
                <div className="msg-thinking-plain-body">{thinkingText.slice(0, 4000)}</div>
              </div>
            ) : showThinking ? (
              <details
                className={`msg-thinking-fold ${isThinkingMsg ? 'is-live' : ''}`}
                key={`think-${msg.id}-${isThinkingMsg ? 'live' : 'done'}`}
                open={Boolean(isThinkingMsg) ? true : undefined}
              >
                <summary className="msg-thinking-fold-sum">
                  {isThinkingMsg ? (
                    <span
                      className="loading-spinner"
                      style={{ width: 8, height: 8, borderWidth: 1.5 }}
                    />
                  ) : null}
                  <span className="msg-thinking-fold-label">
                    {isThinkingMsg ? '思考中' : '思考'}
                    {isThinkingMsg ? (
                      <span className="msg-thinking-sec"> · {thinkingSeconds}s</span>
                    ) : null}
                  </span>
                </summary>
                <div className="msg-thinking-fold-body">
                  {thinkingText.slice(0, 4000)}
                </div>
              </details>
            ) : null}

            <div className="msg-assistant-body">
              {(() => {
                try {
                  const timeline = buildAssistantTimeline(msg);
                  if (!timeline.length) {
                    const fallback = stripThoughtPlaceholders(msg.text || '');
                    if (!fallback.trim()) return null;
                    return (
                      <div className="msg-timeline-text">
                        <div
                          className={`msg-assistant-text md-rendered ${isThinkingMsg ? 'is-streaming' : ''}`}
                          dangerouslySetInnerHTML={{
                            __html: parseMarkdownToHtml(fallback),
                          }}
                        />
                      </div>
                    );
                  }
                  const textItems = timeline.filter((i) => i.kind === 'text');
                  const lastTextKey = textItems.length
                    ? textItems[textItems.length - 1]!.key
                    : null;
                  return timeline.map((item) => {
                    if (item.kind === 'text') {
                      const bodyText = stripThoughtPlaceholders(item.content || '');
                      if (!bodyText.trim()) return null;
                      const imgs = extractImageRefs(bodyText);
                      const streaming = isThinkingMsg && item.key === lastTextKey;
                      return (
                        <div key={item.key} className="msg-timeline-text">
                          <div
                            className={`msg-assistant-text md-rendered ${streaming ? 'is-streaming' : ''}`}
                            dangerouslySetInnerHTML={{
                              __html: parseMarkdownToHtml(bodyText),
                            }}
                          />
                          {imgs.length > 0 && (
                            <div className="msg-inline-images">
                              {imgs.map((src) => (
                                <img
                                  key={src}
                                  src={src}
                                  alt=""
                                  className="md-img"
                                  loading="lazy"
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }
                    if (!item.items?.length) return null;
                    return (
                      <div key={item.key} className="msg-timeline-tools">
                        <ChatToolStack
                          items={item.items}
                          msgId={msg.id}
                          roundKey={`${msg.id}:${item.key}`}
                          {...toolStackProps}
                        />
                      </div>
                    );
                  });
                } catch (err) {
                  console.error('[ChatMessageList] timeline render', err);
                  const fallback = stripThoughtPlaceholders(msg.text || '');
                  return fallback ? (
                    <div className="msg-assistant-text md-rendered">{fallback}</div>
                  ) : null;
                }
              })()}
            </div>

            {/* 完成态：改动总览（有文件 diff 时）+ 操作栏 */}
            {!isThinkingMsg && msg.status !== 'processing' && (
              <>
                <ChangeOverviewCard
                  message={msg}
                  onOpenDiff={onOpenDiff}
                  onOpenDiffPanel={onOpenDiffPanel}
                  onShowToast={onShowToast}
                />
                {inPlanMode &&
                !planApproved &&
                msg.id === lastAssistantId &&
                looksLikePlan(assistantCopyText(msg) || msg.text || '') ? (
                  <div className="msg-plan-approve-row">
                    <button
                      type="button"
                      className="msg-plan-approve-chip"
                      onClick={() => {
                        setPermissionMode('ask');
                        setPlanApproved(true);
                        onShowToast('已批准此计划，已切回需确认模式');
                      }}
                    >
                      批准此计划
                    </button>
                  </div>
                ) : null}
                <div className="msg-assistant-meta">
                  <button
                    type="button"
                    className={`msg-icon-btn${isPinnedMsg ? ' is-pinned-active' : ''}`}
                    title={isPinnedMsg ? '取消固定' : '固定'}
                    onClick={() => togglePin(msg.id)}
                  >
                    {isPinnedMsg ? <Lucide.PinOff size={16} /> : <Lucide.Pin size={16} />}
                  </button>
                  <button
                    type="button"
                    className="msg-icon-btn"
                    title="复制正文"
                    onClick={() => {
                      const text = assistantCopyText(msg);
                      if (!text.trim()) {
                        onShowToast('没有可复制的正文');
                        return;
                      }
                      navigator.clipboard.writeText(text);
                      onShowToast('已复制');
                    }}
                  >
                    <Lucide.Copy size={16} />
                  </button>
                  <button
                    type="button"
                    className="msg-icon-btn"
                    title="重新生成"
                    onClick={() => {
                      const idx = messages.findIndex((m) => m.id === msg.id);
                      let userText = '';
                      for (let i = idx - 1; i >= 0; i--) {
                        if (messages[i].sender === 'user') {
                          userText = messages[i].text || '';
                          break;
                        }
                      }
                      if (!userText.trim()) {
                        onShowToast('没有可重新生成的内容');
                        return;
                      }
                      if (messages.some((m) => m.status === 'processing')) {
                        onShowToast('请等待当前回复完成');
                        return;
                      }
                      onRegenerate(userText, msg.id);
                    }}
                  >
                    <Lucide.RefreshCw size={16} />
                  </button>
                  <button
                    type="button"
                    className="msg-icon-btn"
                    title="分支继续"
                    onClick={onBranch}
                  >
                    <Lucide.GitFork size={16} />
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const ChatMessageList = React.memo(ChatMessageListInner);
