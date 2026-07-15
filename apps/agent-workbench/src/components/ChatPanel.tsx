/**
 * ChatPanel - 代码智能体工作台的主聊天面板组件
 * 包含消息列表、输入区域、工具审批、子智能体栏及事件处理
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { appState, type ChatMessage, type ToolCall, type SubAgent, type ChangedFile, type PendingAskQuestion, type PendingInputIntent } from '../core/app-state';
import { tauriBridge, type WorkbenchEvent } from '../core/tauri-bridge';
import { eventBus, Events } from '../core/event-bus';
import {
  createRuntimeEventProjectionState,
  projectDaemonOrchestratorEvent,
  projectRuntimeEvent,
  timelineItemsFromRuntimeProjectionMessages,
  type RuntimeEventProjectionState,
  type RuntimeProjectionDelta,
  type RuntimeProjectionMessage,
  type RuntimeProjectionToolCall,
} from '../core/runtime-event-projector';
import { MarkdownRenderer, CodeBlockCopyButton, ActionLinkHandler } from './MarkdownRenderer';
import { showToast } from './ToastContainer';
import AskCard from './AskCard';
import { ToolApprovalDeck } from './chat/ApprovalDeck';
import { ThinkingBlock } from './chat/ThinkingBlock';
import { FileEditSummary } from './chat/FileEditSummary';
import { DiagnosticBlock as DaemonErrorBlock } from './chat/DiagnosticBlock';
import { UserMessageEditor } from './chat/UserMessageEditor';
import { SubagentBar } from './chat/SubAgentBar';
import { CompactionSummaryCard, type CompactionSummaryData } from './chat/CompactionSummaryCard';
import {
  chatMessageFromRuntimeProjection,
  toolCallFromRuntimeProjection,
  changedFileEntriesFromToolResult,
  isFileEditTool,
  isFileModifyingTool,
} from './chat/utils';
import { formatTime, truncatePath } from './utils';
import {
  reduceChatMessages,
  removeChatMessages,
  truncateChatMessages,
  updateChatMessage,
} from '../core/message-pipeline';
import { loadInputDraft, saveInputDraft } from './chat/draft-store';
import { AskDeck, PendingInputDeck } from './chat/AskDeck';
import { ChatInput } from './chat/ChatInput';
import { MessageList, formatTokenCount } from './chat/MessageList';
import { createDefaultWorkbenchSettings } from '../shared/workbench-config';
import {
  workbenchRunLifecycleStatusFromDaemon,
  type DaemonOrchestratorEvent,
  type WorkbenchRunLifecycleStatus,
} from '../shared/workbench-contract';
import {
  IconTerminal,
  IconFolder,
  IconFolderOpen,
  IconShield,
  IconSend,
  IconKill,
  IconChevronRight,
  IconChevronDown,
  IconCheck,
  IconSpinner,
  IconBot,
  IconMaximize,
  IconX,
  IconPlus,
  IconSettings,
  IconChat,
  IconFileCode,
  IconFilePlus,
  IconFileMinus,
  IconCopy,
  IconRevert,
  IconInfo,
  IconMoreHorizontal,
  IconMoreVertical,
  IconArrowLeft,
  IconArrowRight,
  IconPanelLeft,
  IconPanelRight,
  IconMinus,
  IconEdit,
  IconAlertTriangle,
  IconRefresh,
  IconClock,
} from './icons';

const TERMINAL_SNAPSHOT_REFRESH_DELAYS_MS = [0, 120, 350, 750];
const TERMINAL_DAEMON_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const INPUT_MODEL_OPTIONS = createDefaultWorkbenchSettings().provider.models;
const PRODUCT_FILE_EDIT_TOOLS = new Set(['edit', 'apply_workspace_edits']);
const LEGACY_FILE_EDIT_TOOLS = new Set(['write_file']);
const FILE_MODIFYING_TOOLS = new Set([
  ...PRODUCT_FILE_EDIT_TOOLS,
  ...LEGACY_FILE_EDIT_TOOLS,
  'restore_file_snapshot',
  'create_workspace_checkpoint',
  'restore_workspace_checkpoint',
]);

function waitForSnapshotRefresh(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fallbackStatusForRuntimeEvent(eventType: string, event: Record<string, unknown>, payload: Record<string, unknown>): WorkbenchRunLifecycleStatus | null {
  const daemonStatus = workbenchRunLifecycleStatusFromDaemon(event) ?? workbenchRunLifecycleStatusFromDaemon(payload);
  if (daemonStatus) return daemonStatus;
  if (payload?.type === 'error' || eventType === 'runtime-error') return 'failed';
  if (eventType !== 'agent-end') return null;
  if (event.reason === 'aborted') return 'cancelled';
  if (event.reason === 'error' || event.reason === 'max-turns') return 'failed';
  if (event.reason === 'stop') return 'completed';
  return null;
}

function isDaemonOrchestratorEvent(value: unknown): value is DaemonOrchestratorEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.payload === 'object' &&
    v.payload !== null &&
    (
      v.type === 'runtime-event' ||
      v.type === 'run-queued' ||
      v.type === 'run-completed' ||
      v.type === 'run-failed' ||
      v.type === 'run-cancelled'
    )
  );
}

async function refreshDaemonSnapshotAfterTerminalEvent(
  runId: string | null | undefined,
  fallbackStatus: WorkbenchRunLifecycleStatus | null
): Promise<void> {
  if (!runId) return;

  let lastSnapshotStatus: string | undefined;
  for (const delayMs of TERMINAL_SNAPSHOT_REFRESH_DELAYS_MS) {
    if (delayMs > 0) await waitForSnapshotRefresh(delayMs);
    try {
      const response = await tauriBridge.getRunSnapshot({ runId });
      if (!response?.snapshot) continue;
      appState.applyDaemonTaskSnapshot(response.snapshot);
      lastSnapshotStatus = response.snapshot.status;
      if (TERMINAL_DAEMON_STATUSES.has(response.snapshot.status)) return;
    } catch (error) {
      showToast('Refresh daemon run snapshot failed', 'error', 4500);
      break;
    }
  }

  if (lastSnapshotStatus && !TERMINAL_DAEMON_STATUSES.has(lastSnapshotStatus)) {
    return;
  }

  if (fallbackStatus) appState.finishRun(runId, fallbackStatus);
}

// ==================== 工具调用分组逻辑 ====================

interface ToolCallGroup {
  key: string;
  label: string;
  icon: 'file-edit' | 'search' | 'terminal' | 'network' | 'other';
  toolCalls: ToolCall[];
  summary: string;
}

interface InterventionMessage extends ChatMessage {
  _interventionActions?: {
    rollback: () => void;
    pause: () => void;
    userInstruction: () => void;
  };
}

function ChatPanel({ onToggleRightSidebar, sessionId }: { onToggleRightSidebar?: () => void; sessionId?: string } = {}) {
  const boundSessionId = sessionId; // 绑定窗口的会话（分屏副窗口用），不受下方局部变量遮蔽
  const [session, setSession] = useState(sessionId ? appState.getSession(sessionId) : appState.getState().currentSession);
  const [isStreaming, setIsStreaming] = useState(false);
  const [workMode, setWorkMode] = useState(appState.workMode);
  const [workingDirectory, setWorkingDirectory] = useState(appState.getState().workingDirectory);
  const [permissionMode, setPermissionMode] = useState(appState.getState().permissionMode);
  const [activeRunId, setActiveRunId] = useState(appState.getState().activeRunId);
  const [activeRunSessionId, setActiveRunSessionId] = useState(appState.getState().activeRunSessionId);

  const handleSendMessageRef = useRef<(text: string, options?: { pendingInputId?: string }) => void>(() => {});
  const startupMessageIdsRef = useRef<Map<string, string>>(new Map());
  const startupTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const runtimeProjectionStatesRef = useRef<Map<string, RuntimeEventProjectionState>>(new Map());
  const pendingInputDrainRef = useRef(false);

  useEffect(() => {
    const unsubStreaming = appState.subscribe('isStreaming', setIsStreaming);
    const unsubWorkMode = appState.subscribe('workMode', setWorkMode);
    const unsubWorkingDir = appState.subscribe('workingDirectory', setWorkingDirectory);
    const unsubPermission = appState.subscribe('permissionMode', setPermissionMode);
    const unsubActiveRun = appState.subscribe('activeRunId', setActiveRunId);
    const unsubActiveRunSession = appState.subscribe('activeRunSessionId', setActiveRunSessionId);
    // 绑定了 sessionId 的窗口跟随该会话；否则跟随当前会话
    let unsubSession: () => void;
    if (sessionId) {
      const refresh = () => setSession(appState.getSession(sessionId));
      refresh();
      unsubSession = appState.subscribe('sessions', refresh);
    } else {
      unsubSession = appState.subscribe('currentSession', setSession);
    }
    return () => {
      unsubSession();
      unsubStreaming();
      unsubWorkMode();
      unsubWorkingDir();
      unsubPermission();
      unsubActiveRun();
      unsubActiveRunSession();
    };
  }, [sessionId]);

  // 监听 eventBus MESSAGE_SENT 事件（来自技能面板等）。仅主对话窗口处理，避免分屏副窗口重复发送
  useEffect(() => {
    if (sessionId) return;
    const unsub = eventBus.on(Events.MESSAGE_SENT, (text: string) => {
      handleSendMessageRef.current(text);
    });
    return unsub;
  }, [sessionId]);

  useEffect(() => {
    if (sessionId) return;
    const flushPendingInput = () => {
      if (pendingInputDrainRef.current) return;
      const state = appState.getState();
      const currentSessionId = state.currentSessionId;
      if (state.isStreaming && state.activeRunSessionId === currentSessionId) return;
      const next = appState.getPendingInputs(currentSessionId)[0];
      if (!next) return;

      pendingInputDrainRef.current = true;
      window.setTimeout(() => {
        pendingInputDrainRef.current = false;
        handleSendMessageRef.current(next.text, { pendingInputId: next.id });
      }, 0);
    };

    const unsubInputs = appState.subscribe('pendingInputs', flushPendingInput);
    const unsubStreaming = appState.subscribe('isStreaming', flushPendingInput);
    const unsubSession = appState.subscribe('currentSession', flushPendingInput);
    flushPendingInput();
    return () => {
      unsubInputs();
      unsubStreaming();
      unsubSession();
    };
  }, []);

  // 监听后端事件。仅主对话窗口处理后端 run 事件，避免分屏副窗口重复处理同一事件
  useEffect(() => {
    if (sessionId) return;
    const unlisten = tauriBridge.onRunEvent((payload: WorkbenchEvent) => {
      const event = payload.event || payload;
      const eventType = event.type;

      if (!eventType) return;

      const runId = payload.runId || event.runId || appState.getState().activeRunId || undefined;
      const sessionId = appState.resolveRunSessionId(runId, payload.sessionId || event.frontendSessionId);
      const streamKey = runId || sessionId || 'current';
      const getProjectionState = () => {
        let projectionState = runtimeProjectionStatesRef.current.get(streamKey);
        if (!projectionState) {
          projectionState = createRuntimeEventProjectionState();
          runtimeProjectionStatesRef.current.set(streamKey, projectionState);
        }
        return projectionState;
      };
      const getScopedSession = () => appState.getSession(sessionId);
      const addScopedMessage = (message: Omit<ChatMessage, 'id' | 'timestamp'>) =>
        appState.addMessage({
          ...message,
          runId: message.runId ?? runId,
          sessionId: message.sessionId ?? sessionId ?? undefined,
        }, sessionId);
      const updateScopedMessage = (messageId: string, updates: Partial<ChatMessage>) =>
        appState.updateMessage(messageId, updates, sessionId);
      const clearStartupMessage = (updates: Partial<ChatMessage>) => {
        if (!runId) return;
        const startupId = startupMessageIdsRef.current.get(runId);
        if (!startupId) return;
        // 收到首个事件时清除超时定时器
        const timeout = startupTimeoutRef.current.get(runId);
        if (timeout) {
          clearTimeout(timeout);
          startupTimeoutRef.current.delete(runId);
        }
        updateScopedMessage(startupId, updates);
        startupMessageIdsRef.current.delete(runId);
      };
      const upsertProjectedMessage = (message: RuntimeProjectionMessage) => {
        const currentSession = getScopedSession();
        if (!currentSession) return;
        const chatMessage = chatMessageFromRuntimeProjection(message);

        let messages = currentSession.messages;

        // 当用户消息的本地 ID 需要替换为 daemon 端 ID 时，先更新 id
        if (chatMessage.role === 'user') {
          const localUserMsgIndex = messages.findIndex(
            m => m.role === 'user' && (m.id.startsWith('msg-') || m.runId === chatMessage.runId)
          );
          if (localUserMsgIndex >= 0) {
            messages = updateChatMessage(messages, messages[localUserMsgIndex].id, { id: chatMessage.id });
          }
        }

        // 使用 reduceChatMessages 归并消息（去重 + 合并 + 排序）
        const merged = reduceChatMessages(messages, [chatMessage]);
        appState.updateSession({ ...currentSession, messages: merged });
      };
      const applyProjectedMessages = (messages: RuntimeProjectionMessage[]) => {
        const byId = new Map<string, RuntimeProjectionMessage>();
        messages.forEach(message => byId.set(message.id, message));
        byId.forEach(upsertProjectedMessage);
      };
      const applyProjectionDelta = (delta: RuntimeProjectionDelta) => {
        applyProjectedMessages([...delta.updatedMessages, ...delta.messages]);
        delta.approvals.forEach(approval => {
          if (approval.status === 'requested' && approval.toolCall) {
            appState.enqueueApproval(toolCallFromRuntimeProjection(approval.toolCall));
          }
          if (approval.status === 'resolved') {
            const decision = approval.decision === 'denied' || approval.decision === 'deny' ? 'denied' : 'approved';
            appState.resolveApproval(approval.id, decision, 'once');
          }
        });
        return delta;
      };
      const applyRuntimeProjection = (runtimeEvent: Record<string, unknown>) => {
        return applyProjectionDelta(projectRuntimeEvent(getProjectionState(), runtimeEvent, {
          eventId: payload.id || payload.eventId || event.id,
          runId,
          sessionId: sessionId ?? undefined,
          timestamp: payload.timestamp || event.timestamp,
          sourceEvent: payload,
        }));
      };
      const projectionEvent = isDaemonOrchestratorEvent(payload)
        ? payload
        : isDaemonOrchestratorEvent(event)
          ? event
          : null;
      const runtimeEvent = projectionEvent?.type === 'runtime-event' && projectionEvent.payload
        ? projectionEvent.payload.event
        : event;
      const runtimeEventType = typeof runtimeEvent?.type === 'string' ? runtimeEvent.type : eventType;

      // ---- 文本流式增量 ----
      const reducerEventTypes = new Set([
        'message-start',
        'message-delta',
        'message-end',
        'tool-start',
        'tool-update',
        'tool-end',
        'approval-requested',
        'approval-resolved',
        'agent-end',
        'runtime-error',
        'run-queued',
        'runtime-event',
        'run-completed',
        'run-failed',
        'run-cancelled',
      ]);

      if (reducerEventTypes.has(eventType) || reducerEventTypes.has(runtimeEventType)) {
        if (runtimeEventType === 'message-delta' && runtimeEvent?.block?.type === 'text') {
          clearStartupMessage({ content: '', streaming: false });
        }
        if (runtimeEventType === 'agent-end' || runtimeEventType === 'runtime-error') {
          clearStartupMessage({ content: '', streaming: false });
        }
        if (projectionEvent) {
          applyProjectionDelta(projectDaemonOrchestratorEvent(getProjectionState(), projectionEvent));
        } else {
          applyRuntimeProjection(event);
        }

        if (runtimeEventType === 'tool-end') {
          const result = runtimeEvent.result;
          if (result && isFileModifyingTool(result.toolName)) {
            const entries = changedFileEntriesFromToolResult(result);
            if (entries.length > 0) {
              const changedFiles = [...appState.getState().changedFiles];
              entries.forEach(entry => {
                const existing = changedFiles.findIndex(f => f.path === entry.path);
                if (existing >= 0) {
                  changedFiles[existing] = entry;
                } else {
                  changedFiles.push(entry);
                }
              });
              appState.setState('changedFiles', changedFiles);
            }
          }
        }

        if (
          runtimeEventType === 'agent-end' ||
          runtimeEventType === 'runtime-error' ||
          eventType === 'run-completed' ||
          eventType === 'run-failed' ||
          eventType === 'run-cancelled'
        ) {
          void refreshDaemonSnapshotAfterTerminalEvent(runId, fallbackStatusForRuntimeEvent(runtimeEventType, runtimeEvent, payload));
        }
        return;
      }

      if (eventType === 'run-completed' || eventType === 'run-failed' || eventType === 'run-cancelled') {
        clearStartupMessage({ content: '', streaming: false });
        void refreshDaemonSnapshotAfterTerminalEvent(runId, fallbackStatusForRuntimeEvent(eventType, event, payload));
      }

      // ---- 子智能体启动 ----
      if (eventType === 'subagent-started') {
        const subAgentData = event.subagent || event;
        const subAgent: SubAgent = {
          id: subAgentData.id || `subagent-${Date.now()}`,
          name: subAgentData.name || subAgentData.toolName || 'Sub-agent',
          status: 'active',
          messages: [],
          parentRunId: subAgentData.parentRunId || payload.runId,
        };
        const subAgents = [...appState.getState().subAgents, subAgent];
        appState.setState('subAgents', subAgents);
      }

      // ---- 子智能体结束 ----
      if (eventType === 'subagent-ended') {
        const subAgentId = event.subagentId || event.id;
        if (subAgentId) {
          const subAgents = appState.getState().subAgents.map(sa =>
            sa.id === subAgentId ? { ...sa, status: 'done' as const } : sa
          );
          appState.setState('subAgents', subAgents);
        }
      }

      // ---- 子智能体事件转发 ----
      if (eventType === 'subagent-event') {
        const innerEvent = event.event || event;
        const targetSubAgentId = event.subagentId || event.agentId;
        if (targetSubAgentId && innerEvent) {
          const subAgents = [...appState.getState().subAgents];
          const targetAgent = subAgents.find(sa => sa.id === targetSubAgentId);
          if (targetAgent) {
            if (innerEvent.type === 'message-delta' && innerEvent.block?.type === 'text') {
              const existingMsg = targetAgent.messages.find(m => m.streaming);
              if (existingMsg) {
                targetAgent.messages = updateChatMessage(
                  targetAgent.messages,
                  existingMsg.id,
                  { content: existingMsg.content + (innerEvent.block.text || '') }
                );
              } else {
                targetAgent.messages = reduceChatMessages(targetAgent.messages, [{
                  id: `submsg-${Date.now()}-${Math.random()}`,
                  role: 'assistant',
                  content: innerEvent.block.text || '',
                  timestamp: Date.now(),
                  streaming: true,
                }]);
              }
            } else if (innerEvent.type === 'message-end') {
              const streamingMsg = targetAgent.messages.find(m => m.streaming);
              if (streamingMsg) {
                targetAgent.messages = updateChatMessage(
                  targetAgent.messages,
                  streamingMsg.id,
                  { streaming: false }
                );
              }
            }
            appState.setState('subAgents', subAgents);
          }
        }
      }

      // ---- 运行时干预请求 ----
      if (eventType === 'runtime-intervention-required') {
        const interventionMsg = addScopedMessage({
          role: 'system',
          content: 'Agent 似乎陷入了循环，请选择操作：',
        });
        // Store intervention message id so we can reference it later
        const interventionId = interventionMsg.id;
        const sendInterventionAction = (action: string) => {
          updateScopedMessage(interventionId, {
            content: `干预: 已选择 ${action}`,
          });
          handleSendMessageRef.current(action);
        };
        // Attach action handlers via a custom property on the message
        const currentSession = getScopedSession();
        if (currentSession) {
          const msg = currentSession.messages.find(m => m.id === interventionId);
          if (msg) {
            (msg as InterventionMessage)._interventionActions = {
              rollback: () => sendInterventionAction('回滚'),
              pause: () => sendInterventionAction('暂停'),
              userInstruction: () => sendInterventionAction('用户指令'),
            };
            appState.updateSession({ ...currentSession });
          }
        }
      }

      // ---- 上下文压缩开始 ----
      if (eventType === 'context-compression-start') {
        const tokensBefore = event.tokensBefore ?? 0;
        addScopedMessage({
          role: 'system',
          content: '正在压缩上下文...',
          systemType: 'compression',
          streaming: true,
          compactionData: { phase: 'start', tokensBefore },
        });
      }

      // ---- 上下文压缩结束 ----
      if (eventType === 'context-compression-end') {
        const record = event.result;
        const structuredSummary = record?.details?.structuredSummary as Record<string, unknown> | undefined;
        const handoff = record?.handoff as Record<string, unknown> | undefined;

        // Build CompactionSummaryData
        const compactionData: CompactionSummaryData = {
          compactionId: record?.id ?? '',
          trigger: record?.trigger ?? 'unknown',
          reason: record?.reason ?? 'unknown',
          summary: record?.summary ?? '',
          tokensBefore: record?.tokensBefore ?? 0,
          tokensAfter: record?.tokensAfter ?? 0,
          compressedMessageCount: record?.compressedMessageIds?.length ?? 0,
          keptMessageCount: record?.keptMessageIds?.length ?? 0,
          createdAt: record?.createdAt ?? new Date().toISOString(),
          goal: typeof structuredSummary?.goal === 'string' ? structuredSummary.goal : undefined,
          progress: Array.isArray(structuredSummary?.progress) ? structuredSummary.progress as string[] : undefined,
          nextSteps: Array.isArray(structuredSummary?.nextSteps) ? structuredSummary.nextSteps as string[] : undefined,
          readFiles: Array.isArray(structuredSummary?.readFiles) ? structuredSummary.readFiles as string[] : undefined,
          modifiedFiles: Array.isArray(structuredSummary?.modifiedFiles) ? structuredSummary.modifiedFiles as string[] : undefined,
          risks: Array.isArray(structuredSummary?.risks) ? structuredSummary.risks as string[] : undefined,
          policy: record?.policy ? {
            tier: typeof record.policy.tier === 'string' ? record.policy.tier : undefined,
            action: typeof record.policy.action === 'string' ? record.policy.action : undefined,
            forced: typeof record.policy.forced === 'boolean' ? record.policy.forced : undefined,
            thresholdExceeded: typeof record.policy.thresholdExceeded === 'boolean' ? record.policy.thresholdExceeded : undefined,
            providerRetry: typeof record.policy.providerRetry === 'boolean' ? record.policy.providerRetry : undefined,
          } : undefined,
          handoff: handoff ? {
            trigger: typeof handoff.trigger === 'string' ? handoff.trigger : undefined,
            reason: typeof handoff.reason === 'string' ? handoff.reason : undefined,
            action: typeof handoff.action === 'string' ? handoff.action : undefined,
            summary: typeof handoff.summary === 'string' ? handoff.summary : undefined,
            pendingTasks: Array.isArray(handoff.pendingTasks) ? handoff.pendingTasks as string[] : undefined,
            completedTaskSummaries: Array.isArray(handoff.completedTaskSummaries) ? handoff.completedTaskSummaries as string[] : undefined,
            sessionEvents: Array.isArray(handoff.sessionEvents) ? handoff.sessionEvents as string[] : undefined,
            fileSnapshotHints: Array.isArray(handoff.fileSnapshotHints) ? handoff.fileSnapshotHints as string[] : undefined,
            providerRetry: typeof handoff.providerRetry === 'boolean' ? handoff.providerRetry : undefined,
          } : undefined,
        };

        const savedTokens = (record?.tokensBefore ?? 0) - (record?.tokensAfter ?? 0);
        const currentSession = getScopedSession();
        if (currentSession) {
          const compressionMsg = [...currentSession.messages].reverse().find(
            m => m.role === 'system' && m.systemType === 'compression' && m.streaming
          );
          if (compressionMsg) {
            updateScopedMessage(compressionMsg.id, {
              content: `上下文已压缩 (节省 ${formatTokenCount(savedTokens)} tokens)`,
              streaming: false,
              compactionData: compactionData as unknown as Record<string, unknown>,
            });
          } else {
            addScopedMessage({
              role: 'system',
              content: `上下文已压缩 (节省 ${formatTokenCount(savedTokens)} tokens)`,
              systemType: 'compression',
              compactionData: compactionData as unknown as Record<string, unknown>,
            });
          }
        }
      }

      // ---- 检查点创建 ----
      if (eventType === 'checkpoint-created') {
        const label = event.label || event.checkpoint?.label || 'unnamed';
        const checkpointId = event.checkpoint?.id || `cp-${Date.now()}`;
        const filePaths: string[] = Array.isArray(event.checkpoint?.filePaths)
          ? event.checkpoint.filePaths
          : Array.isArray(event.checkpoint?.files)
            ? event.checkpoint.files
            : [];
        appState.addCheckpoint({
          id: checkpointId,
          label,
          runId: event.runId,
          sessionId: event.sessionId,
          filePaths,
          createdAt: Date.now(),
        });
        addScopedMessage({
          role: 'system',
          content: `Checkpoint created: ${label}`,
          systemType: 'checkpoint',
        });
      }

      // ---- 检查点恢复 ----
      if (eventType === 'checkpoint-restored') {
        const checkpointId = event.checkpointId || event.checkpoint?.id;
        if (checkpointId) {
          appState.markCheckpointRestored(checkpointId);
        }
        addScopedMessage({
          role: 'system',
          content: '检查点已恢复',
          systemType: 'checkpoint',
        });
      }

      // ---- 计划更新 ----
      if (eventType === 'plan-update') {
        const snapshot = appState.getState().taskSnapshot;
        if (snapshot && event.plan) {
          appState.setState('taskSnapshot', { ...snapshot, plan: event.plan });
        }
        // 自动打开任务标签
        appState.openRightTab('diagnostics');
      }

      // ---- 进度更新 ----
      if (eventType === 'progress-update') {
        const snapshot = appState.getState().taskSnapshot;
        if (snapshot) {
          appState.setState('taskSnapshot', {
            ...snapshot,
            completionPercent: event.completionPercent ?? snapshot.completionPercent,
            progressLabel: event.progressLabel ?? snapshot.progressLabel,
            state: event.state ?? snapshot.state,
          });
        }
      }

      // ---- 变更更新 ----
      if (eventType === 'change-update') {
        const snapshot = appState.getState().taskSnapshot;
        if (snapshot && event.changes) {
          appState.setState('taskSnapshot', { ...snapshot, changes: event.changes });
        }
      }

      // ---- 健康状态更新 ----
      if (eventType === 'health-update') {
        const snapshot = appState.getState().taskSnapshot;
        if (snapshot && event.health) {
          appState.setState('taskSnapshot', { ...snapshot, health: event.health });
        }
      }

      // ---- 续跑请求 ----
      if (eventType === 'resume-requested') {
        const reason = event.reason || event.message || '任务需要续跑';
        addScopedMessage({
          role: 'system',
          content: `[续跑请求] ${reason}`,
        });
      }

      // ---- 后台任务事件 ----
      if (eventType === 'background-task-start' || eventType === 'background-task-end' || eventType === 'background-task-heartbeat') {
        const snapshot = appState.getState().taskSnapshot;
        if (snapshot && event.backgroundTasks) {
          appState.setState('taskSnapshot', { ...snapshot, backgroundTasks: event.backgroundTasks });
        }
      }

      // ---- Provider 诊断 ----
      if (eventType === 'provider-diagnostic') {
        /* diagnostic handled silently */
      }

      // ---- 工具批次开始 ----
      if (eventType === 'tool-batch-start') {
        /* batch start handled silently */
      }

      // ---- 工具批次结束 ----
      if (eventType === 'tool-batch-end') {
        /* batch end handled silently */
      }

      // ---- Agent 启动 ----
      if (eventType === 'agent-start') {
        appState.setState('isStreaming', true);
        // 更新启动反馈消息
        clearStartupMessage({ content: '', streaming: false });
      }

      // ---- 回合开始 ----
      if (eventType === 'turn-start') {
        /* turn start handled silently */
      }

      // ---- 工具输入修复 ----
      if (eventType === 'tool-input-repaired') {
        /* input repair handled silently */
      }

      // ---- 交互式提问（消费 BE-16 ask-requested / ask-resolved） ----
      if (eventType === 'ask-requested') {
        const ask = event as { questionId?: unknown; prompt?: unknown; kind?: unknown; options?: unknown; required?: unknown; sessionId?: unknown };
        if (typeof ask.questionId === 'string') {
          appState.addPendingQuestion({
            questionId: ask.questionId,
            prompt: typeof ask.prompt === 'string' ? ask.prompt : '',
            kind: ask.kind === 'single' || ask.kind === 'multi' ? ask.kind : 'text',
            options: Array.isArray(ask.options) ? (ask.options as Array<{ value: string; label: string }>) : undefined,
            required: ask.required === true,
            runId,
            sessionId: typeof ask.sessionId === 'string' ? ask.sessionId : undefined,
          });
        }
      }
      if (eventType === 'ask-resolved') {
        const ask = event as { questionId?: unknown };
        if (typeof ask.questionId === 'string') appState.resolvePendingQuestion(ask.questionId);
      }

      // ---- 运行时错误 ----
      if (payload.type === 'error') {
        // 清除启动消息
        clearStartupMessage({ content: '', streaming: false });
        const errorMsg = payload.message || payload.code || '未知错误';
        addScopedMessage({
          role: 'assistant',
          content: `[系统错误] ${errorMsg}`,
          streaming: false,
        });
        void refreshDaemonSnapshotAfterTerminalEvent(runId, fallbackStatusForRuntimeEvent(eventType, event, payload));
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  const handleSendMessage = async (text: string, options?: { pendingInputId?: string }) => {
    // 分屏副窗口：发送前先切到其绑定会话，使消息进入该会话
    if (boundSessionId && appState.getCurrentSessionId() !== boundSessionId) {
      appState.switchSession(boundSessionId);
    }
    const userMsg = appState.addMessage({ role: 'user', content: text });
    const sessionId = userMsg.sessionId || appState.getCurrentSessionId();
    let runId: string | null = null;
    let runSessionId: string | null = sessionId;

    const sess = appState.getSession(sessionId);
    if (sess && sess.title === '新对话') {
      const newTitle = text.slice(0, 20) + (text.length > 20 ? '...' : '');
      sess.title = newTitle;
      appState.updateSession({ ...sess });
    }

    try {
      const state = appState.getState();
      const workspace = appState.getRunWorkspace(sessionId);
      const request = tauriBridge.createRunTaskRequest({
        prompt: text,
        sessionId: sessionId ?? undefined,
        mode: workspace.workspaceMode === 'none' ? 'chat' : 'agent',
        workspaceMode: workspace.workspaceMode,
        cwd: workspace.cwd,
        permissionMode: state.permissionMode,
      });
      runId = request.runId;
      runSessionId = request.sessionId;
      if (options?.pendingInputId) {
        appState.dispatchPendingInput(options.pendingInputId, request.runId);
      }
      appState.updateMessage(userMsg.id, { runId: request.runId }, sessionId);
      appState.registerRun({
        runId: request.runId,
        sessionId: request.sessionId,
        prompt: text,
        mode: request.mode,
        cwd: request.cwd,
        permissionMode: request.permissionMode,
      });

      // 添加启动反馈消息
      const startupMsg = appState.addMessage({
        role: 'system',
        content: '正在启动 Agent...',
        streaming: true,
        systemType: 'startup',
        runId: request.runId,
      }, request.sessionId);
      startupMessageIdsRef.current.set(request.runId, startupMsg.id);

      // 超时保护：如果后端 30s 内未返回任何事件，自动清除 startup 消息并复位状态
      const startupTimeout = setTimeout(() => {
        const startupId = startupMessageIdsRef.current.get(request.runId);
        if (startupId) {
          appState.updateMessage(startupId, {
            content: 'Agent 后端未响应（超时 30s），请检查后台服务是否正常运行。',
            streaming: false,
            systemType: undefined,
          }, request.sessionId);
          startupMessageIdsRef.current.delete(request.runId);
          appState.finishRun(request.runId, 'failed');
        }
      }, 30_000);
      startupTimeoutRef.current.set(request.runId, startupTimeout);

      await tauriBridge.runTask(request);
    } catch (error) {
      showToast('发送消息失败', 'error', 4500);
      // 清除超时定时器
      if (runId) {
        const timeout = startupTimeoutRef.current.get(runId);
        if (timeout) {
          clearTimeout(timeout);
          startupTimeoutRef.current.delete(runId);
        }
        const startupId = startupMessageIdsRef.current.get(runId);
        if (startupId) {
          appState.updateMessage(startupId, { content: '', streaming: false }, runSessionId);
          startupMessageIdsRef.current.delete(runId);
        }
      }
      appState.addMessage({
        role: 'assistant',
        content: `发送失败: ${error}`,
        streaming: false,
        runId: runId ?? undefined,
      }, runSessionId);
      if (runId) {
        appState.finishRun(runId, 'failed');
      } else {
        appState.setState('isStreaming', false);
      }
    }
  };

  handleSendMessageRef.current = handleSendMessage;

  const currentSessionRunId = session?.activeRunId ?? (activeRunSessionId === session?.id ? activeRunId : null);
  const currentSessionIsStreaming = Boolean(
    session?.id && isStreaming && activeRunSessionId === session.id && currentSessionRunId
  );

  return (
    <section class="repl-main-panel-container" id="chat-panel">
      <CodeBlockCopyButton />
      <ActionLinkHandler />
      <div class="repl-main-card repl-chat-full-height">
        <MessageList sessionId={session?.id ?? null} messages={session?.messages || []} onSendFromSuggestion={handleSendMessage} />
        <SubagentBar />
        <ChatInput
          onSend={handleSendMessage}
          disabled={currentSessionIsStreaming}
          sessionId={session?.id ?? null}
          runId={currentSessionRunId}
          onCancel={() => {
          const runId = currentSessionRunId;
          if (runId) {
            void tauriBridge.cancelRun(runId)
              .catch(error => { showToast('取消运行失败: ' + (error instanceof Error ? error.message : String(error)), 'error'); })
              .finally(() => {
                void refreshDaemonSnapshotAfterTerminalEvent(runId, 'cancelled');
              });
          }
        }} />
      </div>
    </section>
  );
}

export default ChatPanel;
