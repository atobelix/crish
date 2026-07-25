import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ShowToastFn } from '../../hooks/useToastQueue';
import { useLayoutStore } from '../../store/layoutStore';
import { sessionRuntimeRegistry } from '../../api/SessionRuntimeRegistry';
import type { Attachment } from '../../api/SessionRuntimeRegistry';
import { useChatStream, type ChatAttachment } from '../../hooks/useChatStream';
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
  onShowToast,
  handleGlobalTabClick,
  setShowModelDropdown,
  setPickerInlineError,
}: UseChatComposerPropsOptions) {
  const setComposerDraft = useLayoutStore((s) => s.setComposerDraft);
  const composerDrafts = useLayoutStore((s) => s.composerDrafts);

  // Keyboard and Input states
  const [chatInput, setChatInputState] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [showPlusMenu, setShowPlusMenu] = useState(false);

  const prevSessionIdRef = useRef(activeSessionId);
  const activeSessionIdRef = useRef(activeSessionId);

  const [attachments, setAttachments] = useState<ChatAttachment[]>(() => {
    if (activeSessionId) {
      return (sessionRuntimeRegistry.get(activeSessionId).attachments ??
        []) as ChatAttachment[];
    }
    return [];
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    const restored = activeSessionId
      ? composerDrafts[activeSessionId] || ''
      : '';
    setChatInputState(restored);
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setChatInput = useCallback(
    (textOrFn: React.SetStateAction<string>) => {
      setChatInputState((prev) => {
        const next =
          typeof textOrFn === 'function' ? textOrFn(prev) : textOrFn;
        const sid = activeSessionIdRef.current;
        if (sid) {
          setComposerDraft(sid, next);
        }
        return next;
      });
    },
    [setComposerDraft]
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
      });
    }
    prevSessionIdRef.current = activeSessionId || '';
    if (activeSessionId) {
      const restored =
        sessionRuntimeRegistry.get(activeSessionId).attachments ?? [];
      setAttachments(restored as ChatAttachment[]);
    } else {
      setAttachments([]);
    }
  }, [activeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const settings = await clientApi.getSettings();
        if (cancelled) return;
        const on = settings?.enableSkillCommands !== false;
        setSkillCommandsEnabled(on);
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
  };
}
