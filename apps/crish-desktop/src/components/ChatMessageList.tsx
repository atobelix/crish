/**
 * 消息列表渲染：空状态 + user/assistant bubbles + 工具时间线。
 * 从 ChatCard 剪切粘贴，保持 className；状态机/stream 仍在 ChatCard。
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import type { FileDiff, SessionAgent, SessionMessage } from '../store/layoutStore';
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
  onRegenerate: (userText: string) => void;
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

export const ChatMessageList: React.FC<ChatMessageListProps> = ({
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
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [expandedUserMsgs, setExpandedUserMsgs] = useState<Record<string, boolean>>({});
  const activeProject = getActiveProject();

  /** 切换展开；须传入当前展示态，避免 defaultOpen=true 时首次点击仍为 true */
  const toggleTool = (toolId: string, currentlyOpen: boolean) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !currentlyOpen }));
  };

  const toolStackProps = {
    agents,
    activeSessionId,
    expandedTools,
    onToggleTool: toggleTool,
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
    <>
      {messages.map((msg, index) => {
        const prevMsg = index > 0 ? messages[index - 1] : null;
        const isFollowUp = msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
        if (msg.sender === 'user') {
          const isLong = (msg.text || '').length > 260;
          const isExpanded = !!expandedUserMsgs[msg.id];
          const displayText =
            isLong && !isExpanded ? (msg.text || '').slice(0, 240) + '…' : msg.text;
          return (
            <div className="msg-row msg-row-user" key={msg.id}>
              <div className="msg-user-stack">
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

        return (
          <div
            className={`msg-row msg-row-assistant ${isFollowUp ? 'is-followup' : ''}`}
            key={msg.id}
          >
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
                        <ChatToolStack items={item.items} msgId={msg.id} {...toolStackProps} />
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
                />
                <div className="msg-assistant-meta">
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
                      onRegenerate(userText);
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
    </>
  );
};
