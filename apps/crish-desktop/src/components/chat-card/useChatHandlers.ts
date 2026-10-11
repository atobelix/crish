import { useCallback, useEffect, useRef } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { getCompositionRoot } from '../../app/compositionRoot';
import { formatBranchUndoToast } from '../../hooks/useToastQueue';
import { onUiEvent } from '../../api/uiEvents';
import { generateMessageId } from '../../utils/generateMessageId';
import { getTransport } from '../../api/transport';
import { backfillFromBoundaryText } from '../../hooks/chat-stream/slashSendDraftManager';
import { reportRuntimeStatus } from '../../store/sessionRuntimeStatusStore';
import { useSettingsField } from '../../store/storeAccess';
import type { ChatAttachment } from '../../hooks/useChatStream';
import type {
  ChatContentPart,
  StreamAttachmentMeta,
  StreamRequestOptions,
} from '../../api/chatApi';

export interface UseChatHandlersOptions {
  wsId: string;
  activeSessionId: string | null;
  activeSessionTitle: string | undefined;
  handleStopGeneration: () => void;
  setChatInput: (textOrFn: React.SetStateAction<string>) => void;
  runStreamingAssistant: (
    text: string,
    msgId: string,
    sessionIdOverride?: string,
    streamOptions?: StreamRequestOptions
  ) => void;
  handleSendChat?: (
    isInsert?: boolean,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => Promise<void>;
}

export function useChatHandlers({
  wsId,
  activeSessionId,
  activeSessionTitle,
  handleStopGeneration,
  setChatInput,
  runStreamingAssistant,
  handleSendChat,
}: UseChatHandlersOptions) {
  const lastRetryTimeRef = useRef<Record<string, number>>({});
  const retryCountRef = useRef<Record<string, number>>({});
  const configuredMaxRetries = useSettingsField(
    (s) => s.appSettings?.maxRetryAttempts ?? 10
  );

  const handleExportMarkdown = useCallback(() => {
    const byId = getCompositionRoot().session.getState().sessionsById;
    const session = byId[activeSessionId ?? ''];
    if (!session) return;
    void (async () => {
      try {
        const { tryDownloadSessionMarkdown } =
          await import('../../api/sessionExport');
        const result = tryDownloadSessionMarkdown(session, new Date(), {
          sessionsById: byId,
        });
        if (result.ok === false) {
          toast.show(result.error || '导出失败');
        }
      } catch {
        toast.show('导出失败');
      }
    })();
  }, [activeSessionId]);

  useEffect(() => {
    return onUiEvent('export-session-md', () => {
      handleExportMarkdown();
    });
  }, [handleExportMarkdown]);

  useEffect(() => {
    return onUiEvent('open-conversation-rewind', () => {
      void (async () => {
        const sid = activeSessionId;
        if (!sid || sid.startsWith('__pending')) {
          toast.show('当前无可用会话，无法回溯');
          return;
        }
        try {
          const { previewConversationRewind } =
            await import('../../api/conversationRewindApi');
          const preview = await previewConversationRewind({ sessionId: sid });
          if (!preview.ok) {
            toast.show(
              preview.error
                ? `回溯预览失败：${preview.error}`
                : '回溯预览失败：引擎未返回边界事实'
            );
            return;
          }
          const rawType =
            typeof preview.raw.type === 'string' ? preview.raw.type : 'preview';
          toast.show(
            `已收到回溯预览（${rawType}）。确认应用请使用引擎 apply-conversation-rewind；缺 leaf 事实时不会改写会话。`
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          toast.show(`回溯不可用：${msg}`);
        }
      })();
    });
  }, [activeSessionId]);

  // ── R1 撤回与就地编辑：引擎入口 + 回填消费 ──
  // 用户锁：入口在消息流（最后一条 user / 正在生成的助手行），不在 composer 页脚。
  // 流式中同样可撤。withdrawMessage action 本体保留（send-failure 乐观回滚 / regenerate）。
  const suppressRetractBackfillRef = useRef(false);

  // timeline-truncate 消费端派发的回填事件 → setChatInput + setComposerDraft
  //（数据源 = boundary user 节点 text，不依赖 draft 快照）
  useEffect(() => {
    return onUiEvent('retract-backfill', ({ sessionId, text }) => {
      if (!sessionId || !text) return;
      if (suppressRetractBackfillRef.current) return;
      backfillFromBoundaryText(sessionId, text, setChatInput);
    });
  }, [setChatInput]);

  // 撤回上一条 user 消息（消息行动作栏）：定位活跃会话最后一条
  // user 消息 → 引擎 core_session_retract（流式中不停用）
  const handleRetract = useCallback(async () => {
    const sid = activeSessionId;
    if (!sid || sid.startsWith('__pending')) {
      toast.show('当前无可用会话，无法撤回');
      return;
    }
    const session = getCompositionRoot().session.getState();
    const sess = session.sessionsById[sid];
    const lastUser = [...(sess?.messages || [])]
      .reverse()
      .find((m) => m.sender === 'user');
    if (!lastUser) {
      toast.show('没有可撤回的用户消息');
      return;
    }
    try {
      const transport = getTransport();
      await transport.send('core_session_retract', {
        sessionId: sid,
        targetMessageId: lastUser.id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.show(`撤回失败：${msg}`);
    }
  }, [activeSessionId]);

  // 消息就地编辑重发（替代粗暴撤回回退到底部输入框的交互）
  const handleEditMessageAndResend = useCallback(
    async (
      targetMessageId: string,
      newText: string,
      newAttachments: ChatAttachment[]
    ) => {
      const sid = activeSessionId;
      if (!sid || sid.startsWith('__pending')) {
        toast.show('当前无可用会话，无法编辑重发');
        return;
      }
      retryCountRef.current[sid] = 0;
      handleStopGeneration();
      suppressRetractBackfillRef.current = true;

      try {
        const transport = getTransport();
        await transport.send('core_session_retract', {
          sessionId: sid,
          targetMessageId,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[handleEditMessageAndResend] core_session_retract failed: ${msg}`
        );
      } finally {
        setTimeout(() => {
          suppressRetractBackfillRef.current = false;
        }, 800);
      }

      // 从 store 中安全移除该节点（若还残留在时间线）
      const session = getCompositionRoot().session.getState();
      session.withdrawMessage(wsId, sid, targetMessageId);

      // 以新文本和新附件重新启动流式会话发送
      if (handleSendChat) {
        await handleSendChat(false, newText, newAttachments);
      }
    },
    [activeSessionId, handleStopGeneration, wsId, handleSendChat]
  );

  /**
   * 原位重跑一轮（regenerate 核心，行动作栏与 ComposerErrorBar「重试」共用）：
   * - 撤回目标 assistant 节点（及其后续）；
   * - 复用 user 消息位：优先按显式 userMsgId 定位，否则取最后一条 user；
   * - 提问文本按 id 现查（用户编辑过消息也不会重发旧内容），仅当消息缺失时回落 fallbackText。
   */
  const regenerateTurn = useCallback(
    (opts: {
      sessionId: string;
      /** 缺省 = 该轮无助手节点可撤回（如串行守卫排队重试用尽），仅按 userMsgId 重发 */
      assistantMsgId?: string;
      userMsgId?: string;
      fallbackText?: string;
    }) => {
      const { sessionId, assistantMsgId } = opts;
      const now = Date.now();
      const lastTime = lastRetryTimeRef.current[sessionId] || 0;
      const prevAttempts = retryCountRef.current[sessionId] || 0;
      // 指数退避：重试间隔随尝试次数递增（初始 1.2s，按 1.4 倍递增，上限 10s）
      const backoffThrottleMs = Math.min(
        10000,
        Math.floor(1200 * Math.pow(1.4, prevAttempts))
      );
      if (now - lastTime < backoffThrottleMs) {
        console.warn(
          `[regenerateTurn] clicks too fast (backoff: ${backoffThrottleMs}ms), throttling duplicate submit`
        );
        return;
      }
      lastRetryTimeRef.current[sessionId] = now;

      const MAX_MANUAL_RETRIES = Math.max(1, configuredMaxRetries ?? 10);
      const currentAttempt = prevAttempts + 1;
      if (currentAttempt > MAX_MANUAL_RETRIES) {
        console.warn(
          `[regenerateTurn] retry limit exceeded (${MAX_MANUAL_RETRIES}) for session ${sessionId}`
        );
        reportRuntimeStatus({
          type: 'failed',
          sessionId,
          kind: 'generic',
          message: `已达到最大重试次数上限（${MAX_MANUAL_RETRIES}/${MAX_MANUAL_RETRIES} 次），请检查模型服务或网络连接`,
          technicalDetail: `单次手动重试上限已达 ${MAX_MANUAL_RETRIES} 次。为避免后台无限循环空转与资源耗尽，系统已停止自动拉起。可在「通用设置」中自由调整上限，或检查模型服务后重新发送消息。`,
          turn: {
            userMsgId: opts.userMsgId || '',
            assistantMsgId,
          },
        });
        return;
      }
      retryCountRef.current[sessionId] = currentAttempt;

      handleStopGeneration();
      const session = getCompositionRoot().session.getState();
      const msgs = session.sessionsById[sessionId]?.messages || [];
      const targetUser =
        (opts.userMsgId &&
          msgs.find((m) => m.id === opts.userMsgId && m.sender === 'user')) ||
        msgs.findLast((m) => m.sender === 'user');
      const userText = (targetUser?.text || opts.fallbackText || '').trim();
      const hasAttachments = Boolean(
        (targetUser?.images && targetUser.images.length > 0) ||
        (targetUser?.attachments && targetUser.attachments.length > 0)
      );
      if (!userText && !hasAttachments) return;

      if (assistantMsgId)
        session.withdrawMessage(wsId, sessionId, assistantMsgId);

      // 上报 retrying 状态驱动 InFlowStatusLine 展示重试进度（如「正在重试 1/3」）
      reportRuntimeStatus({
        type: 'retrying',
        sessionId,
        retry: {
          attempt: currentAttempt,
          maxAttempts: MAX_MANUAL_RETRIES,
        },
      });

      let userMsgId = targetUser?.id;
      if (!userMsgId) {
        // 发送前固定 clientMessageId
        userMsgId = generateMessageId('user');
        session.addMessage(wsId, sessionId, {
          id: userMsgId,
          sender: 'user',
          text: userText,
          timestamp: Date.now(),
          status: 'processing',
          ...(targetUser?.images?.length ? { images: targetUser.images } : {}),
          ...(targetUser?.attachments?.length
            ? { attachments: targetUser.attachments }
            : {}),
        });
      } else {
        session.setSessionMessageStatus(sessionId, userMsgId, 'processing');
      }

      const streamOptions: StreamRequestOptions = {
        clientMessageId: userMsgId,
      };

      const contentParts: ChatContentPart[] = [];
      if (userText) {
        contentParts.push({ type: 'text', text: userText });
      }
      if (targetUser?.images?.length) {
        for (const img of targetUser.images) {
          const url = img.resolvedUrl || img.source;
          if (url) {
            contentParts.push({
              type: 'image_url',
              image_url: { url, detail: 'auto' },
              name: img.alt || img.id,
              mime: img.mime || 'image/png',
            });
          }
        }
      }
      if (targetUser?.attachments?.length) {
        for (const att of targetUser.attachments) {
          if (att.dataUrl) {
            contentParts.push({
              type: 'image_url',
              image_url: { url: att.dataUrl, detail: 'auto' },
              name: att.name,
              mime: att.mime || 'image/png',
            });
          } else if (att.text) {
            contentParts.push({
              type: 'text',
              text: `--- ${att.name} ---\n${att.text}`,
            });
          }
        }
      }
      if (contentParts.length > 0) {
        streamOptions.content = contentParts;
      }

      const hasImages = Boolean(
        (targetUser?.images && targetUser.images.length > 0) ||
        (targetUser?.attachments &&
          targetUser.attachments.some((a) =>
            Boolean(a.dataUrl || a.mime?.startsWith('image/'))
          ))
      );
      if (hasImages) {
        streamOptions.hasImages = true;
      }

      const streamAttachmentMetas: StreamAttachmentMeta[] = [];
      if (targetUser?.attachments?.length) {
        for (const att of targetUser.attachments) {
          streamAttachmentMetas.push({
            name: att.name,
            mime: att.mime,
            kind:
              att.dataUrl || (att.mime && att.mime.startsWith('image/'))
                ? 'image'
                : att.text
                  ? 'text'
                  : 'file',
          });
        }
      }
      if (targetUser?.images?.length) {
        for (const img of targetUser.images) {
          streamAttachmentMetas.push({
            name: img.alt || img.id,
            mime: img.mime,
            kind: 'image',
          });
        }
      }
      if (streamAttachmentMetas.length > 0) {
        streamOptions.attachments = streamAttachmentMetas;
      }

      // 透传用户 clientMessageId 与多模态完整载荷；助手 id 在 runStreamingAssistant 内 mint 并经 run-task 下发
      runStreamingAssistant(userText, userMsgId, sessionId, streamOptions);
    },
    [handleStopGeneration, wsId, runStreamingAssistant, configuredMaxRetries]
  );

  const handleRegenerate = useCallback(
    (userText: string, assistantMsgId: string) => {
      if (!activeSessionId) return;
      regenerateTurn({
        sessionId: activeSessionId,
        assistantMsgId,
        fallbackText: userText,
      });
    },
    [activeSessionId, regenerateTurn]
  );

  // ComposerErrorBar「重试」（单轨收敛 §2.3）：复用原消息位重发当轮，严禁新建用户消息
  useEffect(() => {
    return onUiEvent(
      'retry-failed-turn',
      ({ sessionId, userMsgId, assistantMsgId }) => {
        if (!sessionId || (!assistantMsgId && !userMsgId)) return;
        regenerateTurn({ sessionId, assistantMsgId, userMsgId });
      }
    );
  }, [regenerateTurn]);

  const handleBranch = useCallback(() => {
    if (!activeSessionId) return;
    const oldId = activeSessionId;
    const base = activeSessionTitle || '会话';
    const newTitle = `${base} - 分支`;
    const session = getCompositionRoot().session;
    session.getState().branchSession(activeSessionId, newTitle);
    const newBranchId = session.getState().activeSessionId;
    toast.show(formatBranchUndoToast(base), () => {
      if (newBranchId && newBranchId !== oldId) {
        session.getState().archiveSession(newBranchId);
      }
      session.getState().setActiveSessionId(oldId);
    });
  }, [activeSessionId, activeSessionTitle]);

  return {
    handleExportMarkdown,
    handleRegenerate,
    handleBranch,
    handleRetract,
    handleEditMessageAndResend,
  };
}
