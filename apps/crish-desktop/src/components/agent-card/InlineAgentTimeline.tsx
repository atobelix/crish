/**
 * InlineAgentPanel 时间线（F1-β 拆分，纯展示）：
 * 正文工具栏（停止 + 待确认提示）+ live.messages 流（折叠行 / 思考折叠 /
 * AsyncMarkdownBlock / ChatToolStack 审批接线）+ 空态与失败恢复动作。
 * 零 hook / 零 store；壳组件把已派生 view model 经 props 传入。
 */
import React from 'react';
import styles from './InlineAgentPanel.module.css';
import { Tooltip } from '../ui';
import type { SessionAgent } from '../../store/types';
import { buildAssistantTimeline } from '../../api/toolPresentation';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { Priority } from '../../workers';
import { ChatToolStack } from '../chat-tool-call/ChatToolCallBlock';
import { StreamingMarkdownView } from '../chat-message-row/StreamingMarkdownView';
import { InlineAgentThinkingFold } from './InlineAgentThinkingFold';
import {
  InlineAgentApprovalHint,
  type InlineAgentApprovalProps,
} from './InlineAgentApproval';

/** 失败恢复动作视图（D8 §3.7.1：resume/kill/kill_all 按钮组） */
export interface InlineAgentRecoveryProps {
  isFailed: boolean;
  errorKindLabel: string;
  retries?: number;
  recoveryReady: boolean;
  resumeReady: boolean;
  killReady: boolean;
  killAllReady: boolean;
  recoveryBusy: boolean;
  recoveryError: string;
}

export interface InlineAgentTimelineProps {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  live: SessionAgent;
  running: boolean;
  stopping: boolean;
  /** 工具栏停止（L2，壳已绑定 summary） */
  onStop: () => void;
  parentSessionId: string;
  expandedTools: Record<string, boolean>;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
  /** 审批回调组（ChatToolStack 接线 + 工具栏待确认提示） */
  approval: InlineAgentApprovalProps;
  emptyStreamCopy: string;
  recovery: InlineAgentRecoveryProps;
  onRecoveryAction: (
    action: 'resume' | 'kill' | 'kill_all',
    errorMsg: string
  ) => void;
}

export const InlineAgentTimeline: React.FC<InlineAgentTimelineProps> = ({
  bodyRef,
  live,
  running,
  stopping,
  onStop,
  parentSessionId,
  expandedTools,
  onToggleTool,
  approval,
  emptyStreamCopy,
  recovery,
  onRecoveryAction,
}) => {
  const messages = live.messages || [];
  const msgCount = messages.length;
  const {
    isFailed,
    errorKindLabel,
    retries,
    recoveryReady,
    resumeReady,
    killReady,
    killAllReady,
    recoveryBusy,
    recoveryError,
  } = recovery;

  return (
    <>
      <div className={styles.inlineAgentToolbar}>
        {running ? (
          <Tooltip content="停止生成">
            <button
              type="button"
              className={`${styles.inlineAgentLink} ${styles.inlineAgentLinkStop}`}
              aria-label="停止生成"
              aria-busy={stopping || undefined}
              disabled={stopping}
              onClick={onStop}
            >
              {stopping ? '停止中…' : '停止'}
            </button>
          </Tooltip>
        ) : null}
        <InlineAgentApprovalHint pendingTools={approval.pendingTools} />
      </div>

      <div
        className={styles.inlineAgentStream}
        ref={bodyRef}
        role="log"
        aria-relevant="additions"
        aria-busy={running || undefined}
      >
        {msgCount === 0 ? (
          <div className={styles.inlineAgentEmpty} role="status">
            <p className={styles.inlineAgentEmptyP} style={{ margin: 0 }}>
              {emptyStreamCopy}
            </p>
            {/* D8 §3.7.1 失败摘要行：错误 kind + 重试次数（recovery-escalated
                投影；数据源缺位时回退「需人工介入」提示，不假装有数据） */}
            {isFailed &&
            (errorKindLabel || retries !== undefined || live.needsUser) ? (
              <div
                className={`${styles.inlineAgentFailSummary} is-failed-summary`}
                data-testid="inline-agent-fail-summary"
              >
                {errorKindLabel ? (
                  <span className={styles.inlineAgentFailKind}>
                    错误：{errorKindLabel}
                  </span>
                ) : null}
                {retries !== undefined && retries > 0 ? (
                  <span className={styles.inlineAgentFailRetries}>
                    已重试 {retries} 次
                  </span>
                ) : null}
                {live.needsUser ? (
                  <span className={styles.inlineAgentFailNeedsUser}>
                    需人工介入
                  </span>
                ) : null}
              </div>
            ) : null}
            {/* D8 §3.7.1 操作按钮组（failed 态专属；命令面未注册期隐藏） */}
            {isFailed && recoveryReady ? (
              <div
                className={`${styles.inlineAgentRecovery} is-recovery-actions`}
                data-testid="inline-agent-recovery-actions"
              >
                {resumeReady ? (
                  <Tooltip content="关闭并重新派发（fork 新 run）">
                    <button
                      type="button"
                      className={`${styles.inlineAgentLink} ${styles.inlineAgentLinkResume}`}
                      aria-label="恢复运行该子智能体"
                      disabled={recoveryBusy}
                      onClick={() =>
                        void onRecoveryAction('resume', 'resume 失败')
                      }
                    >
                      {recoveryBusy ? '处理中…' : '恢复运行'}
                    </button>
                  </Tooltip>
                ) : null}
                {killReady ? (
                  <Tooltip content="终止该子智能体">
                    <button
                      type="button"
                      className={`${styles.inlineAgentLink} ${styles.inlineAgentLinkKill}`}
                      aria-label="终止该子智能体"
                      disabled={recoveryBusy}
                      onClick={() => void onRecoveryAction('kill', 'kill 失败')}
                    >
                      关闭
                    </button>
                  </Tooltip>
                ) : null}
                {killAllReady ? (
                  <Tooltip content="批量终止全部运行中子智能体">
                    <button
                      type="button"
                      className={`${styles.inlineAgentLink} ${styles.inlineAgentLinkKillAll}`}
                      aria-label="批量终止全部运行中子智能体"
                      disabled={recoveryBusy}
                      onClick={() =>
                        void onRecoveryAction('kill_all', 'kill_all 失败')
                      }
                    >
                      全部关闭
                    </button>
                  </Tooltip>
                ) : null}
                {recoveryError ? (
                  <span
                    className={styles.inlineAgentRecoveryError}
                    role="alert"
                  >
                    {recoveryError}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`${styles.inlineAgentMsg} inline-agent-msg--${msg.sender}`}
            >
              {msg.sender === 'user' ? (
                <div className={styles.inlineAgentUserPrompt}>{msg.text}</div>
              ) : (
                <>
                  {msg.thinking &&
                  msg.thinking.trim() &&
                  msg.thinking !== '正在处理…' &&
                  !looksLikeShellDump(msg.thinking) ? (
                    <InlineAgentThinkingFold
                      thinkingText={msg.thinking}
                      isLive={running}
                    />
                  ) : null}
                  {(() => {
                    // Stream = plain text (no per-token HTML). Completed = Rust async.
                    const isStreamingMsg =
                      msg.status === 'processing' || msg.status === 'queued';
                    const mdPriority = isStreamingMsg
                      ? Priority.Normal
                      : Priority.High;
                    const timeline = buildAssistantTimeline(msg);
                    if (!timeline.length && (msg.text || '').trim()) {
                      const fallback = stripThoughtPlaceholders(msg.text || '');
                      if (!fallback.trim()) return null;
                      return (
                        <div className="msg-assistant-text">
                          <StreamingMarkdownView
                            text={fallback}
                            isStreaming={isStreamingMsg}
                            priority={mdPriority}
                          />
                        </div>
                      );
                    }
                    const textItems = timeline.filter((i) => i.kind === 'text');
                    const lastTextKey = textItems.length
                      ? textItems[textItems.length - 1]!.key
                      : null;
                    return timeline.map((item) => {
                      if (item.kind === 'thought') {
                        return (
                          <div key={item.key} className="msg-timeline-thought">
                            <StreamingMarkdownView
                              text={item.content}
                              isStreaming={false}
                              priority={mdPriority}
                            />
                          </div>
                        );
                      }
                      if (item.kind === 'text') {
                        const body = stripThoughtPlaceholders(
                          item.content || ''
                        );
                        if (!body.trim()) return null;
                        const streaming =
                          isStreamingMsg && item.key === lastTextKey;
                        return (
                          <div key={item.key} className="msg-timeline-text">
                            <StreamingMarkdownView
                              text={body}
                              isStreaming={streaming}
                              priority={mdPriority}
                            />
                          </div>
                        );
                      }
                      if (item.kind === 'tools') {
                        return (
                          <div
                            key={item.key}
                            className="msg-timeline-tools agent-tool-stack"
                          >
                            <ChatToolStack
                              items={item.items}
                              msgId={msg.id}
                              agents={[]}
                              activeSessionId={parentSessionId}
                              expandedTools={expandedTools}
                              onToggleTool={onToggleTool}
                              approvalBusy={approval.approvalBusy}
                              pendingApprovalMsgId={msg.id}
                              actions={{
                                onOpenDiff: () => {},
                                onOpenPath: () => {},
                                onOpenTerminal: () => {},
                                onApprovalAllow: approval.onApprovalAllow,
                                onApprovalDeny: approval.onApprovalDeny,
                              }}
                            />
                          </div>
                        );
                      }
                      return null;
                    });
                  })()}
                </>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
};

/** 避免把 shell 表格拉进「思考」折叠 */
function looksLikeShellDump(s: string): boolean {
  return (
    /FullName|LastWriteTime|Mode\s+Length|----/.test(s) ||
    (/^[A-Za-z]:\\/.test(s.trim()) &&
      s.includes('\n') &&
      s.split('\n').length > 4)
  );
}
