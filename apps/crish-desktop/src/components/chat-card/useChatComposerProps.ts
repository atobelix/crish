import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { useLayoutStore } from '../../store/storeAccess';
import { useSettingsField, selectAppSettings } from '../../store/storeAccess';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import type { Attachment } from '../../api/SessionRuntimeRegistry';
import {
  useChatStream,
  type ChatAttachment,
  type QueuedMessage,
} from '../../hooks/useChatStream';
import { isDemoMode } from '../../api/appMode';
import type { SkillSlashCommand } from '../../api/skillsApi';
import { clientApi } from '../../api/clientApi';
import { COMPOSER_SEED_EVENT, takeComposerSeed } from '../../api/composerSeed';

function isImageFile(f: File): boolean {
  return (
    f.type.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name)
  );
}

export interface UseChatComposerPropsOptions {
  wsId: string;
  activeSessionId: string | null;
  needsKeySetup: boolean;
  needsModelSetup: boolean;
  isProcessing: boolean;
  onShowToast: ShowToastFn;
  handleGlobalTabClick: (cardId: string) => void;
  setShowModelDropdown: React.Dispatch<React.SetStateAction<boolean>>;
  setPickerInlineError: React.Dispatch<React.SetStateAction<string>>;
}

export function useChatComposerProps({
  wsId,
  activeSessionId,
  needsKeySetup,
  needsModelSetup,
  isProcessing,
  onShowToast,
  handleGlobalTabClick,
  setShowModelDropdown,
  setPickerInlineError,
}: UseChatComposerPropsOptions) {
  const setComposerDraft = useLayoutStore((s) => s.setComposerDraft);
  // Do not subscribe to the full composerDrafts map — it re-renders on every keystroke persist.
  // Session restore reads drafts via getState() only.
  const appSettings = useSettingsField(selectAppSettings);

  // Keyboard and Input states
  const [chatInput, setChatInputState] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [showPlusMenu, setShowPlusMenu] = useState(false);

  const prevSessionIdRef = useRef(activeSessionId);
  const activeSessionIdRef = useRef(activeSessionId);
  const draftPersistTimerRef = useRef<number | null>(null);
  /** R2-a ③：被移回输入框编辑的队内 id（drain 遇队首命中即跳过，不抢发） */
  const editedBackMsgIdRef = useRef<string | null>(null);
  /** Latest draft text pending debounce flush (so session switch / unmount can flush). */
  const pendingDraftRef = useRef<{ sid: string; text: string } | null>(null);

  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => {
    if (activeSessionId) {
      return (sessionRuntimeRegistry.get(activeSessionId).attachments ??
        []) as ChatAttachment[];
    }
    return [];
  });
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>(() => {
    if (activeSessionId) {
      return sessionRuntimeRegistry.get(activeSessionId).queuedMessages ?? [];
    }
    return [];
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const flushComposerDraft = useCallback(() => {
    if (draftPersistTimerRef.current != null) {
      window.clearTimeout(draftPersistTimerRef.current);
      draftPersistTimerRef.current = null;
    }
    const pending = pendingDraftRef.current;
    pendingDraftRef.current = null;
    if (pending) {
      setComposerDraft(pending.sid, pending.text);
    }
  }, [setComposerDraft]);

  const scheduleComposerDraft = useCallback(
    (sid: string, text: string) => {
      pendingDraftRef.current = { sid, text };
      if (draftPersistTimerRef.current != null) {
        window.clearTimeout(draftPersistTimerRef.current);
      }
      // Debounce store writes so typing does not churn layout/persist subscribers every key.
      draftPersistTimerRef.current = window.setTimeout(() => {
        draftPersistTimerRef.current = null;
        const pending = pendingDraftRef.current;
        pendingDraftRef.current = null;
        if (pending) setComposerDraft(pending.sid, pending.text);
      }, 350);
    },
    [setComposerDraft]
  );

  useEffect(() => {
    // Flush any in-flight draft for the previous session before switching.
    flushComposerDraft();
    activeSessionIdRef.current = activeSessionId;
    const restored = activeSessionId
      ? useLayoutStore.getState().composerDrafts[activeSessionId] || ''
      : '';
    setChatInputState(restored);
  }, [activeSessionId, flushComposerDraft]);

  useEffect(() => {
    const onLeave = () => flushComposerDraft();
    window.addEventListener('beforeunload', onLeave);
    const onVis = () => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      flushComposerDraft();
    };
  }, [flushComposerDraft]);

  const setChatInput = useCallback(
    (textOrFn: React.SetStateAction<string>) => {
      const sid = activeSessionIdRef.current;
      setChatInputState((prev) => {
        const next = typeof textOrFn === 'function' ? textOrFn(prev) : textOrFn;
        if (sid) {
          // Local state updates immediately; store draft is debounced.
          // schedule via microtask so functional updater never calls setState mid-render.
          queueMicrotask(() => scheduleComposerDraft(sid, next));
        }
        return next;
      });
    },
    [scheduleComposerDraft]
  );

  useEffect(() => {
    const apply = (text: string) => {
      const t = text.trim();
      if (!t) return;
      setChatInput(t);
    };
    const seed = takeComposerSeed();
    if (seed) apply(seed);
    const onSeed = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      if (detail?.text) apply(detail.text);
    };
    window.addEventListener(COMPOSER_SEED_EVENT, onSeed);
    return () => window.removeEventListener(COMPOSER_SEED_EVENT, onSeed);
  }, [setChatInput]);

  useEffect(() => {
    const prevId = prevSessionIdRef.current;
    if (prevId && prevId !== activeSessionId) {
      sessionRuntimeRegistry.save(prevId, {
        attachments: attachments as Attachment[],
        queuedMessages,
      });
    }
    prevSessionIdRef.current = activeSessionId || '';
    if (activeSessionId) {
      const restored = sessionRuntimeRegistry.get(activeSessionId);
      setAttachments((restored.attachments ?? []) as ChatAttachment[]);
      setQueuedMessages(restored.queuedMessages ?? []);
    } else {
      setAttachments([]);
      setQueuedMessages([]);
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeSessionId) {
      sessionRuntimeRegistry.save(activeSessionId, { queuedMessages });
    }
  }, [activeSessionId, queuedMessages]);

  const addAttachments = useCallback((items: ChatAttachment[]) => {
    if (!items.length) return;
    setAttachments((prev) => {
      const names = new Set(prev.map((p) => p.name));
      const next = items.filter((n) => !names.has(n.name));
      const uniqued = items
        .filter((n) => names.has(n.name))
        .map((n, i) => {
          if (!n.dataUrl) return null;
          const base = n.name.replace(/(\.[^.]+)?$/, '');
          const ext = (n.name.match(/(\.[^.]+)$/) || [])[1] || '';
          return { ...n, name: `${base}-${Date.now()}-${i}${ext}` };
        })
        .filter(Boolean) as ChatAttachment[];
      return [...prev, ...next, ...uniqued];
    });
  }, []);

  const handlePasteImage = useCallback(
    async (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(items)) {
        if (!item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
      if (!imageFiles.length) return;
      e.preventDefault();
      try {
        const { blobToImageAttachment } =
          await import('../../api/imageProcessing');
        const next: ChatAttachment[] = [];
        for (const f of imageFiles) {
          next.push(await blobToImageAttachment(f, f.name || undefined));
        }
        addAttachments(next);
      } catch {
        onShowToast('图片粘贴失败');
      }
    },
    [addAttachments, onShowToast]
  );

  const handleFilesSelected = useCallback(
    async (files: File[]) => {
      const next: ChatAttachment[] = [];
      let blobToImageAttachment:
        | ((blob: Blob, preferredName?: string) => Promise<ChatAttachment>)
        | null = null;
      for (const f of files) {
        if (isImageFile(f)) {
          try {
            if (!blobToImageAttachment) {
              ({ blobToImageAttachment } =
                await import('../../api/imageProcessing'));
            }
            next.push(await blobToImageAttachment(f, f.name));
          } catch {
            next.push({ name: f.name, ...(f.type ? { mime: f.type } : {}) });
          }
          continue;
        }
        const isText =
          f.type.startsWith('text/') ||
          /\.(txt|md|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|yml|yaml|toml|xml|csv|log|sh|ps1)$/i.test(
            f.name
          );
        if (isText && f.size < 512_000) {
          try {
            const text = await f.text();
            next.push({ name: f.name, text });
          } catch {
            next.push({ name: f.name });
          }
        } else {
          next.push({ name: f.name });
        }
      }
      addAttachments(next);
    },
    [addAttachments]
  );

  const BASE_SLASH = useMemo(
    () => [
      { cmd: '/goal', desc: '多轮推进直至完成' },
      { cmd: '/learn', desc: '记住一条规则' },
      { cmd: '/grill-me', desc: '对齐提问，暂不实施' },
      { cmd: '/schedule', desc: '定时任务' },
      { cmd: '/teamwork', desc: '协作看板' },
      { cmd: '/browser', desc: '预览浏览器' },
      ...(isDemoMode() ? [{ cmd: '/simulate', desc: '演示流水线' }] : []),
    ],
    []
  );
  const [skillSlash, setSkillSlash] = useState<SkillSlashCommand[]>([]);
  const [skillCommandsEnabled, setSkillCommandsEnabled] = useState(true);
  const [queueMode, setQueueMode] = useState(false);

  useEffect(() => {
    setQueueMode(Boolean(appSettings?.queueMode));
  }, [appSettings]);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const settings = await clientApi.getSettings();
        if (cancelled) return;
        const on = settings?.enableSkillCommands !== false;
        setSkillCommandsEnabled(on);
        setQueueMode(Boolean(settings?.queueMode));
        if (!on) setSkillSlash([]);
      } catch {
        /* ignore */
      }
    };
    void loadSettings();
    const onSkillsChanged = () => {
      void (async () => {
        try {
          const settings = await clientApi.getSettings();
          if (cancelled) return;
          const on = settings?.enableSkillCommands !== false;
          setSkillCommandsEnabled(on);
          if (!on) {
            setSkillSlash([]);
            return;
          }
          const { getSkillSlashCommandsCached } =
            await import('../../api/skillsApi');
          const { commands } = await getSkillSlashCommandsCached(true);
          if (!cancelled) setSkillSlash(commands);
        } catch {
          /* ignore */
        }
      })();
    };
    window.addEventListener('crish-skills-changed', onSkillsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('crish-skills-changed', onSkillsChanged);
    };
  }, []);

  const loadSkillSlash = useCallback(async () => {
    if (!skillCommandsEnabled) return;
    try {
      const { getSkillSlashCommandsCached } =
        await import('../../api/skillsApi');
      const { commands } = await getSkillSlashCommandsCached();
      setSkillSlash(commands);
    } catch {
      /* ignore */
    }
  }, [skillCommandsEnabled]);

  const allSlashCommands = useMemo(() => {
    const skillPart = skillCommandsEnabled
      ? skillSlash.map((s) => ({ cmd: s.cmd, desc: s.desc }))
      : [];
    return [...BASE_SLASH, ...skillPart];
  }, [BASE_SLASH, skillSlash, skillCommandsEnabled]);

  const filteredCommands = allSlashCommands.filter((c) =>
    c.cmd.toLowerCase().startsWith(chatInput.toLowerCase())
  );

  const {
    runNotice,
    setRunNotice,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
    handleForceCancelGeneration,
  } = useChatStream({
    wsId,
    onShowToast,
    handleGlobalTabClick,
    chatInput,
    setChatInput,
    setSlashMenuOpen,
    attachments,
    setAttachments,
    skillCommandsEnabled,
    needsKeySetup,
    needsModelSetup,
    setPickerInlineError,
    onOpenModelPicker: () => setShowModelDropdown(true),
  });

  const canSend = Boolean(chatInput.trim() || attachments.length > 0);

  const generateQueueId = useCallback(
    () => `queued-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    []
  );

  const enqueueMessage = useCallback(
    (text: string, items: ChatAttachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && items.length === 0) return;
      setQueuedMessages((prev) => [
        ...prev,
        {
          id: generateQueueId(),
          text: trimmed,
          attachments: items,
          createdAt: Date.now(),
        },
      ]);
      setChatInput('');
      setAttachments([]);
    },
    [generateQueueId, setChatInput, setAttachments]
  );

  const deleteQueuedMessage = useCallback((id: string) => {
    setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const editQueuedMessage = useCallback(
    (id: string) => {
      const msg = queuedMessages.find((m) => m.id === id);
      if (!msg) return;
      // R2-a ③：移回输入框编辑 → 关闭「可 drain」标记（ref 同步生效防抢发）
      editedBackMsgIdRef.current = id;
      setChatInput(msg.text);
      setAttachments(msg.attachments);
      setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
    },
    [queuedMessages, setChatInput, setAttachments]
  );

  const sendQueuedMessageNow = useCallback(
    async (id: string) => {
      const msg = queuedMessages.find((m) => m.id === id);
      if (!msg) return;
      setQueuedMessages((prev) => prev.filter((m) => m.id !== id));
      await handleSendChat(false, msg.text, msg.attachments);
    },
    [queuedMessages, handleSendChat]
  );

  // 运行中发送：queueMode 走 composer 队列（L1 follow_up 语义，不 abort 当前 stream）
  const onSend = useCallback(() => {
    if (queueMode && isProcessing) {
      const text = chatInput;
      enqueueMessage(text, attachments);
      // 与 useSlashSend 同源：compositionRoot.runControl.followUp（不 cancel）
      void import('../../app/compositionRoot').then(
        ({ getCompositionRoot }) => {
          void getCompositionRoot().runControl.followUp({
            sessionId: activeSessionId || null,
            text: text.trim(),
            reason: 'ui-composer-queue-mode',
          });
        }
      );
    } else {
      // handleSendChat 内部 isAiBusy 时也会 follow_up + status=queued
      void handleSendChat(false);
    }
  }, [
    queueMode,
    isProcessing,
    chatInput,
    attachments,
    enqueueMessage,
    handleSendChat,
    activeSessionId,
  ]);

  const prevIsProcessingRef = useRef(isProcessing);
  const drainLockRef = useRef(false);
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
    // R2-a ③ 竞态关闭：队首被编辑中 → 跳过本次 drain 不抢发
    if (editedBackMsgIdRef.current === first.id) return;
    drainLockRef.current = true;
    void (async () => {
      await sendQueuedMessageNow(first.id);
      drainLockRef.current = false;
    })();
  }, [isProcessing, queueMode, queuedMessages, sendQueuedMessageNow]);

  return {
    chatInput,
    setChatInput,
    isComposing,
    setIsComposing,
    slashMenuOpen,
    setSlashMenuOpen,
    slashSelectedIndex,
    setSlashSelectedIndex,
    filteredCommands,
    loadSkillSlash,
    attachments,
    setAttachments,
    fileInputRef,
    handleFilesSelected,
    handlePasteImage,
    canSend,
    showPlusMenu,
    setShowPlusMenu,
    runNotice,
    setRunNotice,
    runStreamingAssistant,
    handleSendChat,
    handleStopGeneration,
    handleForceCancelGeneration,
    onSend,
    queueMode,
    queuedMessages,
    enqueueMessage,
    deleteQueuedMessage,
    editQueuedMessage,
    sendQueuedMessageNow,
  };
}
