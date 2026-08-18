import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatAttachment,
  QueuedMessage,
} from '../../hooks/useChatStream';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import { useSettingsField, selectAppSettings } from '../../store/storeAccess';
import { clientApi } from '../../api/clientApi';

export interface UseChatQueueOptions {
  activeSessionId: string | null;
  setChatInput: (value: string) => void;
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  handleSendChat: (
    isInsert?: boolean,
    textOverride?: string,
    attachmentsOverride?: ChatAttachment[]
  ) => Promise<void>;
  isProcessing: boolean;
}

export interface UseChatQueueResult {
  queueMode: boolean;
  queuedMessages: QueuedMessage[];
  enqueueMessage: (text: string, items: ChatAttachment[]) => void;
  deleteQueuedMessage: (id: string) => void;
  editQueuedMessage: (id: string) => void;
  sendQueuedMessageNow: (id: string) => Promise<void>;
}

export function useChatQueue({
  activeSessionId,
  setChatInput,
  setAttachments,
  handleSendChat,
  isProcessing,
}: UseChatQueueOptions): UseChatQueueResult {
  const appSettings = useSettingsField(selectAppSettings);
  const [queueMode, setQueueMode] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>(() => {
    if (activeSessionId) {
      return sessionRuntimeRegistry.get(activeSessionId).queuedMessages ?? [];
    }
    return [];
  });

  const prevSessionIdRef = useRef(activeSessionId);
  /** 被移回输入框编辑的队内 id（drain 遇队首命中即跳过，不抢发） */
  const editedBackMsgIdRef = useRef<string | null>(null);
  const prevIsProcessingRef = useRef(isProcessing);
  const drainLockRef = useRef(false);

  useEffect(() => {
    setQueueMode(Boolean(appSettings?.queueMode));
  }, [appSettings]);

  // 原单体 skills effect 内的 clientApi.getSettings() 双源同步 queueMode
  useEffect(() => {
    let cancelled = false;
    void clientApi.getSettings().then((s) => {
      if (!cancelled) setQueueMode(Boolean(s?.queueMode));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    if (prevId && prevId !== activeSessionId) {
      sessionRuntimeRegistry.save(prevId, { queuedMessages });
    }
    prevSessionIdRef.current = activeSessionId || '';
    if (activeSessionId) {
      const restored = sessionRuntimeRegistry.get(activeSessionId);
      setQueuedMessages(restored.queuedMessages ?? []);
    } else {
      setQueuedMessages([]);
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeSessionId) {
      sessionRuntimeRegistry.save(activeSessionId, { queuedMessages });
    }
  }, [activeSessionId, queuedMessages]);

  const generateQueueId = useCallback(
    () => `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, []
  );

  const enqueueMessage = useCallback((text: string, items: ChatAttachment[]) => {
    const trimmed = text.trim();
    if (!trimmed && items.length === 0) return;
    setQueuedMessages((prev) => [...prev, {
      id: generateQueueId(), text: trimmed, attachments: items, createdAt: Date.now(),
    }]);
    setChatInput('');
    setAttachments([]);
  }, [generateQueueId, setChatInput, setAttachments]);

  const deleteQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const editQueuedMessage = useCallback((id: string) => {
    const msg = queuedMessages.find((m) => m.id === id);
    if (!msg) return;
    editedBackMsgIdRef.current = id;
    setChatInput(msg.text);
    setAttachments(msg.attachments);
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, [queuedMessages, setChatInput, setAttachments]);

  const sendQueuedMessageNow = useCallback(async (id: string) => {
    const msg = queuedMessages.find((m) => m.id === id);
    if (!msg) return;
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
    await handleSendChat(false, msg.text, msg.attachments);
  }, [queuedMessages, handleSendChat]);

  useEffect(() => {
    const wasProcessing = prevIsProcessingRef.current;
    prevIsProcessingRef.current = isProcessing;
    if (
      !queueMode ||
      !wasProcessing ||
      isProcessing ||
      queuedMessages.length === 0
    ) {
      return;
    }
    if (drainLockRef.current) return;
    const first = queuedMessages[0];
    if (!first) return;
    if (editedBackMsgIdRef.current === first.id) return;
    drainLockRef.current = true;
    void (async () => {
      await sendQueuedMessageNow(first.id);
      drainLockRef.current = false;
    })();
  }, [isProcessing, queueMode, queuedMessages, sendQueuedMessageNow]);

  return {
    queueMode,
    queuedMessages,
    enqueueMessage,
    deleteQueuedMessage,
    editQueuedMessage,
    sendQueuedMessageNow,
  };
}
