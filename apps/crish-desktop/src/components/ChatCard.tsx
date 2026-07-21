import React, {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  lazy,
  Suspense,
} from 'react';
import styles from './ChatCard.module.css';
import { useLayoutStore } from '../store/layoutStore';
import type { FileDiff } from '../store/layoutStore';
import {
  getSessionById,
  selectActiveSessionId,
  useSessionField,
} from '../store/sessionStore';
import type { Attachment } from '../api/SessionRuntimeRegistry';
import {
  addCommandPermission,
  addMessage,
  archiveSession,
  branchSession,
  createSession,
  getSessionStoreState,
  openSettings,
  patchSession,
  setActiveDiffSource as setActiveDiffSourceAccess,
  setActiveSessionId,
  setSessionMessageStatus,
  updateMessageToolCall,
} from '../api/storeAccess';
import type { ShowToastFn } from '../hooks/useToastQueue';
import { isDemoMode } from '../api/appMode';
import { fetchEngineStatus, type EngineStatus } from '../api/engineConfig';
import {
  anyProfileHasKey,
  getActiveModelId,
  getActiveProfile,
  getActiveProfileId,
  getProviderSetupStatus,
  resolveDisplayModelId,
  resolvePreferredModelSelection,
} from '../api/providerProfiles';
import { ChevronDown } from 'lucide-react';
import { ChatMessageList } from './ChatMessageList';
import { ChatEmptyState } from './ChatEmptyState';
import { Tooltip } from './settings/SettingsUI';
import { toolHumanLabel } from '../api/toolPresentation';
import type { SkillSlashCommand } from '../api/skillsApi';
import { clientApi } from '../api/clientApi';
import { openFileInPanel } from '../api/workspaceFsApi';
import { useChatStream, type ChatAttachment } from '../hooks/useChatStream';
import { useChatAutoScroll } from '../hooks/useChatAutoScroll';
import { useThinkingTimer } from '../hooks/useThinkingTimer';
import { onUiEvent } from '../api/uiEvents';
import { ChatComposer } from './ChatComposer';
import { ChatStatusRibbons } from './ChatStatusRibbons';
import { ChatMsgFilterBar } from './ChatMsgFilterBar';
import { COMPOSER_SEED_EVENT, takeComposerSeed } from '../api/composerSeed';
import {
  approvalDockLabel,
  collectPendingApprovals,
  planApprovalUi,
} from '../api/chatApprovalUi';
import {
  chatEmptyKindAriaLabel,
  resolveChatEmptyKind,
} from '../api/chatEmptyState';
import { rememberPrefixFromToolArgs } from '../api/approvalMeta';
import { extractCommandForMatch } from '../api/commandPermissions';
import { messageMatchesSearch } from '../api/sessionSearch';
import {
  EMPTY_SESSION_TITLE,
  findReusableEmptyShell,
  isEmptyShellSession,
} from '../api/sessionTitle';
import { isFirstRunOverlayOpen } from './FirstRunWizard';
import { sessionRuntimeRegistry } from '../api/SessionRuntimeRegistry';

/** 冷路径：仅 demo / 定时主面 / 模型菜单打开时再拉 chunk */
const ChatDemoChrome = lazy(() =>
  import('./ChatDemoChrome').then((m) => ({ default: m.ChatDemoChrome }))
);
const ScheduledTasksPanel = lazy(() =>
  import('./ScheduledTasksPanel').then((m) => ({
    default: m.ScheduledTasksPanel,
  }))
);
const ModelBadgePickerMenu = lazy(() =>
  import('./ModelBadgePickerMenu').then((m) => ({
    default: m.ModelBadgePickerMenu,
  }))
);

/** 轻量类型判断内联，避免顶层拉 imageProcessing 整模 */
function isImageFile(f: File): boolean {
  return (
    f.type.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name)
  );
}

interface ChatCardProps {
  wsId: string;
  colIdx: number;
  groupIdx: number;
  onShowToast: ShowToastFn;
  handleGlobalTabClick: (cardId: string) => void;
}

const EMPTY_ARRAY: never[] = [];

export const ChatCard: React.FC<ChatCardProps> = React.memo(
  ({ wsId, onShowToast, handleGlobalTabClick }) => {
    // 收紧订阅：只跟当前会话，避免 sessions 整表变更触发重渲染
    const activeSessionId = useSessionField(selectActiveSessionId);
    const messages = useSessionField((s) => {
      return s.sessionsById[s.activeSessionId]?.messages || EMPTY_ARRAY;
    });
    const agents = useSessionField((s) => {
      return s.sessionsById[s.activeSessionId]?.agents || EMPTY_ARRAY;
    });
    const goalMode = useSessionField((s) => {
      return s.sessionsById[s.activeSessionId]?.goalMode;
    });
    const hydratedFromEngine = useSessionField((s) => {
      return s.sessionsById[s.activeSessionId]?.hydratedFromEngine;
    });
    const engineCursor = useSessionField((s) => {
      return s.sessionsById[s.activeSessionId]?.engineCursor;
    });
    const engineLastRunId = useSessionField((s) => {
      return s.sessionsById[s.activeSessionId]?.engineLastRunId;
    });
    const activeSessionTitle = useSessionField((s) => {
      return s.sessionsById[s.activeSessionId]?.title;
    });

    const withdrawMessage = useLayoutStore((s) => s.withdrawMessage);
    const appSettings = useLayoutStore((s) => s.appSettings);
    const diffFiles = useLayoutStore((s) => s.diffFiles);

    const [engineModel, setEngineModel] = useState('');
    const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const [pickerInlineError, setPickerInlineError] = useState('');
    const [showProjectPicker, setShowProjectPicker] = useState(false);
    /** chat = 对话流；scheduled = 主区定时任务（与 layoutStore 同步，供 CardPanel 藏面包屑） */
    const mainSurface = useLayoutStore((s) => s.chatMainSurface || 'chat');
    const setMainSurface = useLayoutStore((s) => s.setChatMainSurface);
    const [projectTick, setProjectTick] = useState(0);
    const [engineHint, setEngineHint] = useState<EngineStatus | null>(null);
    const modelSelectorRef = useRef<HTMLDivElement>(null);
    const [approvalBusy, setApprovalBusy] = useState(false);
    const [showPlusMenu, setShowPlusMenu] = useState(false);
    /** 本会话消息客户端过滤（搜索本会话；由 card-header ChatHeaderMore 触发） */
    const [localMsgFilter, setLocalMsgFilter] = useState('');
    const [showMsgFilter, setShowMsgFilter] = useState(false);
    const msgFilterInputRef = useRef<HTMLInputElement>(null);
    /** 远程水合超时后放行空态，避免失败路径永久空白 */
    const [hydrateTimedOut, setHydrateTimedOut] = useState(false);
    /** createSession 刚剪掉多余空壳时的短暂旁注 */
    const [shellDidPrunePeers, setShellDidPrunePeers] = useState(false);
    const shellPruneCueTimerRef = useRef<number | null>(null);

    useEffect(() => {
      const offs = [
        onUiEvent('project-changed', () => setProjectTick((n) => n + 1)),
        onUiEvent('open-project-picker', () => setShowProjectPicker(true)),
        onUiEvent('open-scheduled', () => setMainSurface('scheduled')),
        onUiEvent('open-chat', () => setMainSurface('chat')),
        onUiEvent('toggle-msg-filter', () => {
          setShowMsgFilter((v) => {
            const next = !v;
            if (!next) setLocalMsgFilter('');
            return next;
          });
        }),
        onUiEvent('focus-composer', () => {
          setMainSurface('chat');
          window.requestAnimationFrame(() => {
            const el =
              document.querySelector<HTMLTextAreaElement>(
                'textarea[data-chat-composer], .chat-composer textarea, .composer-textarea'
              ) ||
              document.querySelector<HTMLTextAreaElement>(
                '.chat-footer textarea'
              );
            el?.focus();
          });
        }),
      ];
      return () => offs.forEach((off) => off());
    }, [setMainSurface]);

    // 仅当活动会话 id 变化时回到对话面（打开定时任务不会清 activeSessionId）
    const prevActiveSessionRef = useRef(activeSessionId);
    useEffect(() => {
      if (prevActiveSessionRef.current !== activeSessionId) {
        prevActiveSessionRef.current = activeSessionId;
        setMainSurface('chat');
      }
    }, [activeSessionId, setMainSurface]);

    const applyResolvedModelLabel = (engineHintModel?: string | null) => {
      const resolved = resolvePreferredModelSelection({
        engineModel: engineHintModel,
      });
      if (resolved) {
        setEngineModel(resolved.model);
        setActiveProfileId(resolved.profileId);
        return;
      }
      // 无本机列表时：仅展示本机 active / settings 默认；不采用未知引擎演示 id（如 mimo）
      const settingsDefault = (appSettings?.defaultModel || '').trim();
      const localActive = (getActiveModelId() || '').trim();
      const display =
        resolveDisplayModelId(engineHintModel) ||
        localActive ||
        settingsDefault ||
        '';
      setEngineModel(display);
      setActiveProfileId(getActiveProfileId());
    };

    useEffect(() => {
      void fetchEngineStatus().then((s) => {
        setEngineHint(s);
        applyResolvedModelLabel(s.model);
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projectTick, appSettings?.defaultModel]);

    // 设置页/其它入口切换模型后，底栏与会话立即用新 model
    useEffect(() => {
      const off = onUiEvent('model-changed', (detail) => {
        if (detail?.model) setEngineModel(detail.model);
        if (detail?.profileId) setActiveProfileId(detail.profileId);
        void fetchEngineStatus().then(setEngineHint);
      });
      return off;
    }, []);

    const getModelDisplayName = (modelId: string) => {
      if (!modelId) return '选择模型';
      const profile = getActiveProfile();
      if (profile && activeProfileId === profile.id) {
        // Compact: model only when space is tight; profile name in title attribute
        return modelId;
      }
      return modelId;
    };

    /** 本地优先就绪态：与 FirstRunWizard / providerProfiles 共用 */
    const setupStatus = getProviderSetupStatus({
      engineOk: engineHint?.ok,
      engineHasApiKey: engineHint?.hasApiKey,
      engineModel: engineHint?.model ?? engineModel,
    });
    const needsKeySetup = setupStatus.needsKeySetup;
    const needsModelSetup = setupStatus.needsModelSetup;
    /** 有密钥即展示选择器（空 models 可手填）；无密钥时隐藏，改走 soft-hint */
    const showModelPicker = setupStatus.showModelPicker;

    /** /goal 目标模式进行中时展示停止 */
    const goalModeActive = Boolean(goalMode?.active);

    // 切换会话时保存当前附件到 registry，恢复目标会话附件，并收起过滤 / 审批忙 / 水合超时 / 剪枝旁注，避免串会话
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
      setLocalMsgFilter('');
      setShowMsgFilter(false);
      setApprovalBusy(false);
      setHydrateTimedOut(false);
      setShellDidPrunePeers(false);
      if (shellPruneCueTimerRef.current != null) {
        window.clearTimeout(shellPruneCueTimerRef.current);
        shellPruneCueTimerRef.current = null;
      }
    }, [activeSessionId]);

    useEffect(() => {
      if (showMsgFilter) {
        // 打开后聚焦输入
        window.requestAnimationFrame(() => msgFilterInputRef.current?.focus());
      }
    }, [showMsgFilter]);

    /** 导出 Markdown：sessionExport 冷路径动态 import（ChatHeaderMore / 与侧栏一致） */
    const handleExportMarkdown = useCallback(() => {
      const byId = getSessionStoreState().sessionsById;
      const session =
        getSessionStoreState().sessionsById[activeSessionId ?? ''];
      if (!session) return;
      void (async () => {
        try {
          const { tryDownloadSessionMarkdown } =
            await import('../api/sessionExport');
          const result = tryDownloadSessionMarkdown(session, new Date(), {
            sessionsById: byId,
          });
          if (result.ok === false) {
            onShowToast(result.error || '导出失败');
          }
          // 成功：浏览器下载即反馈，不 toast
        } catch {
          onShowToast('导出失败');
        }
      })();
    }, [activeSessionId, onShowToast]);

    /** card-header ChatHeaderMore → export-session-md */
    useEffect(() => {
      return onUiEvent('export-session-md', () => {
        handleExportMarkdown();
      });
    }, [handleExportMarkdown]);

    /** 本会话文本过滤（与侧栏/高亮共用 messageMatchesSearch；含 blocks） */
    const displayMessages = useMemo(() => {
      const q = localMsgFilter.trim();
      if (!q) return messages;
      return messages.filter((m) => messageMatchesSearch(m, q));
    }, [messages, localMsgFilter]);

    // 当前会话待审批：按 toolId 去重（防双写双算）；dock 策略见 planApprovalUi
    const pendingApprovalScan = useMemo(() => {
      const agentLists = (agents || []).map((ag) => ag.messages || []);
      return collectPendingApprovals(messages, agentLists);
    }, [messages, agents]);
    const pendingApprovalMsgId = pendingApprovalScan.first?.msgId || '';
    const pendingApprovalToolId = pendingApprovalScan.first?.toolId || '';
    // 一次算出 mode/showDock/total，避免 dock 与内联各算各的漂移
    const approvalUiPlan = useMemo(
      () => planApprovalUi(pendingApprovalScan.counts),
      [pendingApprovalScan.counts]
    );
    const pendingApprovalCount = approvalUiPlan.total;
    // 摘要：优先 first.summary；否则从首条 toolCall 做人读标签
    const pendingApprovalSummary = useMemo(() => {
      const first = pendingApprovalScan.first;
      if (!first) return '';
      if (first.summary) {
        // collect 存的是 name/explanation；有完整 toolCall 时再用人读标签覆盖
        const fromMsg =
          messages
            .flatMap((m) => m.toolCalls || [])
            .find((tc) => tc.id === first.toolId) ||
          (agents || [])
            .flatMap((ag) => ag.messages || [])
            .flatMap((m) => m.toolCalls || [])
            .find((tc) => tc.id === first.toolId);
        if (fromMsg) return toolHumanLabel(fromMsg);
        return first.summary;
      }
      return '';
    }, [pendingApprovalScan.first, messages, agents]);
    // 单条主时间线 → 仅内联；多条/协作 → dock（plan 内再钳一次，禁止单条双 dock）
    const approvalDockVisible = approvalUiPlan.showDock;
    const pendingApprovalDockLabel = approvalDockLabel(
      pendingApprovalScan.counts,
      pendingApprovalSummary
    );

    // Composer extras — permission mode is global so chatApi can read it
    // 状态须在依赖它的 useEffect 之前声明，避免 TDZ 白屏
    const permissionMode = useLayoutStore((s) => s.permissionMode);
    const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
    const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
    const planApproved = useLayoutStore((s) => s.planApproved);
    const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
    const inPlanMode = permissionMode === 'plan' || planModeEnabled;
    const prevSessionIdRef = useRef(activeSessionId);
    const [attachments, setAttachments] = useState<ChatAttachment[]>(() => {
      if (activeSessionId) {
        return (sessionRuntimeRegistry.get(activeSessionId).attachments ??
          []) as ChatAttachment[];
      }
      return [];
    });
    const fileInputRef = useRef<HTMLInputElement>(null);

    const addAttachments = useCallback((items: ChatAttachment[]) => {
      if (!items.length) return;
      setAttachments((prev) => {
        const names = new Set(prev.map((p) => p.name));
        const next = items.filter((n) => !names.has(n.name));
        // 同名时给图片补唯一后缀，避免粘贴多张被吞
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
      async (e: React.ClipboardEvent<HTMLElement>) => {
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
            await import('../api/imageProcessing');
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

    useEffect(() => {
      const handleOutsideClick = (e: MouseEvent) => {
        if (
          modelSelectorRef.current &&
          !modelSelectorRef.current.contains(e.target as Node)
        ) {
          setShowModelDropdown(false);
        }
      };
      if (showModelDropdown) {
        document.addEventListener('mousedown', handleOutsideClick);
      }
      return () => {
        document.removeEventListener('mousedown', handleOutsideClick);
      };
    }, [showModelDropdown]);

    // Keyboard and Input states
    const [chatInput, setChatInputState] = useState('');
    const setComposerDraft = useLayoutStore((s) => s.setComposerDraft);
    const composerDrafts = useLayoutStore((s) => s.composerDrafts);

    const activeSessionIdRef = useRef(activeSessionId);
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

    // 设置页「AI 创建技能/定时」写入的输入种子
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
    const [isComposing, setIsComposing] = useState(false); // IME Composition State
    const [slashMenuOpen, setSlashMenuOpen] = useState(false);
    const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
    /** 有文字或附件（含截图）即可发送 */
    const canSend = Boolean(chatInput.trim() || attachments.length > 0);

    const openSidePanel = (
      panelId: 'terminal' | 'diff' | 'preview' | 'tasks' | 'files'
    ) => {
      handleGlobalTabClick(panelId);
    };

    const isProcessing = messages.some((m) => m.status === 'processing');
    const { chatFlowRef, showScrollToBottom, scrollToBottom } =
      useChatAutoScroll(messages, isProcessing);
    const thinkingSeconds = useThinkingTimer(isProcessing);

    // Slash commands：固定 + 技能（enableSkillCommands）
    // 正式模式含已实现命令；纯演示命令仅 demo
    // 描述宜短：斜杠菜单紧凑单行
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

    // 技能开关：挂载只读设置；skillsApi 延到首次打开 slash / 技能变更后再 import
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
            // 已开 slash 时热更新：动态 import + force 刷新缓存语义
            const { getSkillSlashCommandsCached } =
              await import('../api/skillsApi');
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

    // AI 正文里的路径按钮 → 侧栏文件
    useEffect(() => {
      const root = chatFlowRef.current;
      if (!root) return;
      const onClick = (e: MouseEvent) => {
        const t = e.target as HTMLElement | null;
        const btn = t?.closest?.('.md-path-link') as HTMLElement | null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const path = btn.getAttribute('data-path') || btn.textContent || '';
        if (!path.trim()) return;
        openPathInFilesPanel(path.trim());
      };
      root.addEventListener('click', onClick);
      return () => root.removeEventListener('click', onClick);
    }, [messages.length, activeSessionId]);

    /** 首次打开 slash 菜单时再拉 skillsApi（缓存语义由 getSkillSlashCommandsCached 自身保证） */
    const loadSkillSlash = useCallback(async () => {
      if (!skillCommandsEnabled) return;
      try {
        const { getSkillSlashCommandsCached } =
          await import('../api/skillsApi');
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

    useEffect(() => {
      if (pickerInlineError) {
        onShowToast(pickerInlineError);
        setPickerInlineError('');
      }
    }, [pickerInlineError, onShowToast]);

    useEffect(() => {
      return onUiEvent('stop-generation', () => {
        handleStopGeneration();
      });
    }, [handleStopGeneration]);

    const openDiffInRightPanel = useCallback(
      (diff: FileDiff) => {
        setActiveDiffSourceAccess(diff);
        handleGlobalTabClick('diff');
      },
      [handleGlobalTabClick]
    );

    /** 在右侧文件管理器中打开路径（按需预览；不 toast 刷屏） */
    const openPathInFilesPanel = useCallback((filePath: string) => {
      openSidePanel('files');
      openFileInPanel(filePath);
    }, []);

    const handleApprovalAllow = useCallback(
      (toolId: string, msgId: string, remember = false) => {
        // 无活动会话 / 忙时不写，避免幽灵审批落盘到空 id
        if (!activeSessionId || approvalBusy) return;
        const tid = String(toolId || '').trim();
        const mid = String(msgId || '').trim();
        if (!tid || !mid) return;
        // 乐观：立刻从 pending 摘掉，避免幽灵条卡住后续审批
        setApprovalBusy(true);
        if (remember) {
          const tc = getSessionById(activeSessionId)
            ?.messages.find((m) => m.id === mid)
            ?.toolCalls?.find((t) => t.id === tid);
          // JSON args 需 dig command，不能把整段 {…} 写进白名单
          const prefix = rememberPrefixFromToolArgs(
            tc?.name || '',
            tc?.arguments || '',
            extractCommandForMatch
          );
          if (prefix) {
            addCommandPermission(prefix);
          }
        }
        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'running',
          output: '执行中…',
        });
        // 同步清掉同 id 的其它消息里残留 pending（防御）
        for (const m of getSessionById(activeSessionId)?.messages || []) {
          const tc = m.toolCalls?.find(
            (t) => t.id === tid && t.status === 'pending_approval'
          );
          if (tc && m.id !== mid) {
            updateMessageToolCall(activeSessionId, m.id, tid, {
              status: 'running',
              output: '执行中…',
            });
          }
        }
        // daemonChatBridge 冷路径：审批点击时再 import（不改审批业务语义）
        void import('../api/daemonChatBridge')
          .then(({ daemonApproveTool }) => daemonApproveTool(tid))
          .catch(() => {
            updateMessageToolCall(activeSessionId, mid, tid, {
              status: 'error',
              output: '批准失败',
            });
            onShowToast?.('批准失败，请重试');
          })
          .finally(() => {
            window.setTimeout(() => setApprovalBusy(false), 200);
          });
      },
      [activeSessionId, approvalBusy]
    );

    const handleApprovalDeny = useCallback(
      (toolId: string, msgId: string) => {
        if (!activeSessionId || approvalBusy) return;
        const tid = String(toolId || '').trim();
        const mid = String(msgId || '').trim();
        if (!tid || !mid) return;
        setApprovalBusy(true);
        updateMessageToolCall(activeSessionId, mid, tid, {
          status: 'error',
          output: '已拒绝',
        });
        void import('../api/daemonChatBridge')
          .then(({ daemonDenyTool }) => daemonDenyTool(tid))
          .finally(() => {
            window.setTimeout(() => setApprovalBusy(false), 200);
          });
      },
      [activeSessionId, approvalBusy]
    );

    // 子 agent 只在侧栏打开，主对话列永不被 AgentCard 覆盖；主列始终渲染 chat-body（永不 blank）
    const isFiltering = Boolean(localMsgFilter.trim());
    /**
     * FirstRun 盖层挂载时不与空态/ soft-hint 抢密钥引导。
     * 用 overlay 生命周期而非 shouldShow gate（密钥步落盘后 gate 会 false，盖层仍可能打开）。
     */
    const firstRunOpen = !isDemoMode() && isFirstRunOverlayOpen();
    /** engineHint 未回 = null；已回用 ok，驱动空态草稿口径 / data-engine-ok */
    const engineOk: boolean | null = engineHint == null ? null : engineHint.ok;

    /**
     * 远程/引擎会话消息水合中：抑制幽灵「开始对话」欢迎面。
     * 本地 mint（sess- / sess-branch-）空壳立即展示；超时后放行，防 hydrate 失败永久空白。
     */
    const messagesLoadingCandidate = useMemo(() => {
      if (isDemoMode()) return false;
      if (!activeSessionId) return false;
      if (messages.length > 0) return false;
      if (hydratedFromEngine === true) return false;
      const isLocalMintId = /^sess-(branch-)?\d+$/i.test(activeSessionId);
      if (
        isLocalMintId &&
        typeof engineCursor !== 'number' &&
        !engineLastRunId
      ) {
        return false;
      }
      return true;
    }, [
      activeSessionId,
      messages.length,
      hydratedFromEngine,
      engineCursor,
      engineLastRunId,
    ]);

    useEffect(() => {
      if (!messagesLoadingCandidate) {
        setHydrateTimedOut(false);
        return;
      }
      setHydrateTimedOut(false);
      const t = window.setTimeout(() => setHydrateTimedOut(true), 3000);
      return () => window.clearTimeout(t);
    }, [activeSessionId, messagesLoadingCandidate]);

    const messagesLoading = messagesLoadingCandidate && !hydrateTimedOut;

    /** 当前活动即为默认可复用空壳（旁注「当前为空白会话」） */
    const shellActiveIsEmpty = useSessionField((s) => {
      const active = s.sessionsById[s.activeSessionId];
      return active ? isEmptyShellSession(active) : false;
    });
    /**
     * 无活动会话时：若已有可复用空壳，新建将复用而非再堆幽灵。
     * 有活动会话时由 shellActiveIsEmpty 表达，不叠 willReuse。
     */
    const shellWillReuse = useSessionField((s) => {
      const active = s.sessionsById[s.activeSessionId];
      if (s.activeSessionId && active) return false;
      const sessions = s.sessions;
      return Boolean(findReusableEmptyShell(sessions));
    });

    const emptyKind = resolveChatEmptyKind({
      hasActiveSession: Boolean(activeSessionId),
      messageCount: messages.length,
      displayCount: displayMessages.length,
      filterQuery: localMsgFilter,
      mainSurface,
      messagesLoading,
    });
    const onEmptySurface = emptyKind != null;

    /** 主列 region 中文 aria：空态三态 / 定时 / 对话流 */
    const chatRegionAria =
      mainSurface === 'scheduled'
        ? '定时任务'
        : emptyKind
          ? chatEmptyKindAriaLabel(emptyKind)
          : messagesLoading
            ? '正在加载会话消息'
            : '对话主区';

    const handleCreateSessionFromEmpty = useCallback(() => {
      const before = getSessionStoreState().sessions;
      const ghostBefore = before.filter((s) => isEmptyShellSession(s)).length;
      createSession({ title: EMPTY_SESSION_TITLE });
      const after = getSessionStoreState().sessions;
      const ghostAfter = after.filter((s) => isEmptyShellSession(s)).length;
      // 剪掉了多余空白壳：短暂展示「已清理多余空白会话」旁注（中文 cue）
      if (ghostBefore > 1 && ghostAfter < ghostBefore) {
        setShellDidPrunePeers(true);
        if (shellPruneCueTimerRef.current != null) {
          window.clearTimeout(shellPruneCueTimerRef.current);
        }
        shellPruneCueTimerRef.current = window.setTimeout(() => {
          setShellDidPrunePeers(false);
          shellPruneCueTimerRef.current = null;
        }, 4000);
      }
    }, []);

    const composerElement = (
      <ChatComposer
        chatInput={chatInput}
        setChatInput={setChatInput}
        isComposing={isComposing}
        setIsComposing={setIsComposing}
        slashMenuOpen={slashMenuOpen}
        setSlashMenuOpen={setSlashMenuOpen}
        slashSelectedIndex={slashSelectedIndex}
        setSlashSelectedIndex={setSlashSelectedIndex}
        filteredCommands={filteredCommands}
        loadSkillSlash={loadSkillSlash}
        onPasteImage={handlePasteImage}
        onSend={() => {
          void handleSendChat(false);
        }}
        onStop={handleStopGeneration}
        canSend={canSend}
        isProcessing={messages.some((m) => m.status === 'processing')}
        attachments={attachments}
        setAttachments={setAttachments}
        fileInputRef={fileInputRef}
        onFilesSelected={async (files) => {
          const next: ChatAttachment[] = [];
          let blobToImageAttachment:
            | ((blob: Blob, preferredName?: string) => Promise<ChatAttachment>)
            | null = null;
          for (const f of files) {
            if (isImageFile(f)) {
              try {
                if (!blobToImageAttachment) {
                  ({ blobToImageAttachment } =
                    await import('../api/imageProcessing'));
                }
                next.push(await blobToImageAttachment(f, f.name));
              } catch {
                next.push({ name: f.name, mime: f.type || undefined });
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
        }}
        showPlusMenu={showPlusMenu}
        setShowPlusMenu={setShowPlusMenu}
        permissionMode={permissionMode}
        onPermissionChange={(m) => {
          setPermissionMode(m);
        }}
        onOpenSchedule={() => {
          setMainSurface('scheduled');
        }}
        onCloseSiblingMenus={() => setShowPlusMenu(false)}
        rightActions={
          showModelPicker ? (
            <Tooltip
              content={
                getActiveProfile()
                  ? `${getActiveProfile()!.name} · ${resolveDisplayModelId(engineModel) || engineModel || '未选模型'}`
                  : '服务商与模型（可在设置中更改）'
              }
            >
              <div
                ref={modelSelectorRef}
                className={`${styles.modelBadge} ${showModelDropdown ? styles.active : ''}`}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  setShowModelDropdown((v) => !v);
                }}
                style={{ cursor: 'pointer', position: 'relative' }}
              >
                <span
                  className={styles.modelText}
                  style={{
                    textOverflow: 'ellipsis',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    flex: 1,
                    textAlign: 'left',
                  }}
                >
                  {getModelDisplayName(
                    resolveDisplayModelId(engineModel) ||
                      engineModel ||
                      (needsModelSetup ? '填写模型' : '无可用模型')
                  )}
                </span>
                <ChevronDown
                  size={14}
                  style={{ opacity: 0.6, marginLeft: 6, flexShrink: 0 }}
                />
                {showModelDropdown && (
                  <Suspense fallback={null}>
                    <ModelBadgePickerMenu
                      activeModel={engineModel}
                      onClose={() => setShowModelDropdown(false)}
                    />
                  </Suspense>
                )}
              </div>
            </Tooltip>
          ) : null
        }
      />
    );

    return (
      <div
        className={styles.chatBody}
        role="region"
        aria-label={chatRegionAria}
        aria-busy={messagesLoading || undefined}
        data-main-surface={mainSurface}
        data-empty-kind={emptyKind ?? undefined}
        data-messages-loading={messagesLoading ? 'true' : undefined}
        data-engine-ok={
          engineOk === false ? 'false' : engineOk === true ? 'true' : 'unknown'
        }
        data-approval-mode={approvalUiPlan.mode}
      >
        {/* 本会话消息过滤条：chat 主面；定时主面不展示 */}
        {mainSurface === 'chat' && showMsgFilter ? (
          <ChatMsgFilterBar
            localMsgFilter={localMsgFilter}
            setLocalMsgFilter={setLocalMsgFilter}
            setShowMsgFilter={setShowMsgFilter}
            displayCount={displayMessages.length}
            totalCount={messages.length}
            inputRef={msgFilterInputRef}
          />
        ) : null}

        <div
          className={styles.chatDocFlow}
          ref={chatFlowRef}
          aria-busy={messagesLoading || undefined}
        >
          {mainSurface === 'scheduled' ? (
            <Suspense fallback={null}>
              <ScheduledTasksPanel
                onShowToast={onShowToast}
                onBackToChat={() => setMainSurface('chat')}
              />
            </Suspense>
          ) : emptyKind != null ? (
            <ChatEmptyState
              kind={emptyKind}
              filterQuery={localMsgFilter}
              needsKeySetup={needsKeySetup}
              needsModelSetup={needsModelSetup}
              firstRunOpen={firstRunOpen}
              engineOk={engineOk}
              messagesLoading={messagesLoading}
              shellWillReuse={shellWillReuse}
              shellDidPrunePeers={shellDidPrunePeers}
              shellActiveIsEmpty={shellActiveIsEmpty}
              showProjectPicker={showProjectPicker}
              onShowProjectPicker={setShowProjectPicker}
              onProjectChanged={() => setProjectTick((n) => n + 1)}
              onSetChatInput={setChatInput}
              onCreateSession={handleCreateSessionFromEmpty}
              onClearFilter={() => setLocalMsgFilter('')}
              composer={
                emptyKind === 'session-empty'
                  ? React.cloneElement(composerElement, {
                      className: styles.emptyComposer,
                    })
                  : undefined
              }
            />
          ) : (
            <ChatMessageList
              messages={displayMessages}
              agents={agents}
              activeSessionId={activeSessionId || ''}
              thinkingSeconds={thinkingSeconds}
              /* 过滤中展示全部命中，避免窗口裁掉早期匹配 */
              showAllMessages={isFiltering}
              showProjectPicker={showProjectPicker}
              onShowProjectPicker={setShowProjectPicker}
              onProjectChanged={() => setProjectTick((n) => n + 1)}
              onSetChatInput={setChatInput}
              onSendFollowUp={(prompt) => {
                // 直发：走 textOverride，不依赖 composer 异步 setState
                void handleSendChat(false, prompt);
              }}
              onWithdraw={(msgId, text) => {
                // 撤回前停掉进行中的流，避免幽灵 run / 审批挂起
                handleStopGeneration();
                setChatInput(text);
                withdrawMessage(wsId, activeSessionId, msgId);
              }}
              onRegenerate={(userText, assistantMsgId) => {
                // 重生成前先停旧流，再从助手消息截断
                handleStopGeneration();
                withdrawMessage(wsId, activeSessionId, assistantMsgId);
                const msgs = getSessionById(activeSessionId)?.messages || [];
                let userMsgId = msgs.findLast((m) => m.sender === 'user')?.id;
                if (!userMsgId) {
                  userMsgId = `user-msg-${Date.now()}`;
                  addMessage(wsId, activeSessionId, {
                    id: userMsgId,
                    sender: 'user',
                    text: userText,
                    timestamp: Date.now(),
                    status: 'processing',
                  });
                } else {
                  setSessionMessageStatus(
                    activeSessionId,
                    userMsgId,
                    'processing'
                  );
                }
                runStreamingAssistant(userText, userMsgId);
              }}
              onBranch={() => {
                // 分叉可撤销：toast + Undo；列表聚焦新会话
                if (!activeSessionId) return;
                const oldId = activeSessionId;
                const base = activeSessionTitle || '会话';
                const newTitle = `${base} - 分支`;
                branchSession(activeSessionId, newTitle);
                const newBranchId = getSessionStoreState().activeSessionId;
                onShowToast(`已分叉: ${base}`, () => {
                  if (newBranchId && newBranchId !== oldId) {
                    archiveSession(newBranchId);
                  }
                  setActiveSessionId(oldId);
                });
              }}
              onShowToast={onShowToast}
              approvalBusy={approvalBusy}
              pendingApprovalMsgId={pendingApprovalMsgId}
              onOpenDiff={openDiffInRightPanel}
              onOpenPath={openPathInFilesPanel}
              onOpenTerminal={() => openSidePanel('terminal')}
              onOpenDiffPanel={() => openSidePanel('diff')}
              onApprovalAllow={handleApprovalAllow}
              onApprovalDeny={handleApprovalDeny}
            />
          )}
        </div>

        {/* scheduled 主面隐藏 footer；子 agent 只在侧栏，主列 composer 始终存在 */}
        <div
          className={styles.chatFooter}
          style={{
            display: mainSurface === 'scheduled' ? 'none' : undefined,
          }}
        >
          <ChatStatusRibbons
            onOpenTerminal={() => openSidePanel('terminal')}
            onOpenDiff={() => openSidePanel('diff')}
            diffCount={diffFiles.length}
            engineHint={engineHint}
            needsKeySetup={needsKeySetup}
            needsModelSetup={needsModelSetup}
            onEmptySurface={onEmptySurface}
            localHasKey={anyProfileHasKey()}
            onOpenModelSettings={() => openSettings('models')}
            onOpenModelDropdown={() => setShowModelDropdown(true)}
            inPlanMode={inPlanMode}
            planApproved={planApproved}
            onApprovePlan={() => {
              setPermissionMode('ask');
              setPlanApproved(true);
            }}
            goalModeActive={goalModeActive && Boolean(goalMode)}
            goalText={goalMode?.goal || ''}
            goalIteration={goalMode?.iteration ?? 0}
            goalTasksDone={(goalMode?.tasks || []).filter((t) => t.done).length}
            goalTasksTotal={(goalMode?.tasks || []).length}
            onStopGoal={() => {
              handleStopGeneration();
              if (activeSessionId) {
                patchSession(activeSessionId, { goalMode: null });
              }
            }}
            showScrollToBottom={showScrollToBottom}
            onScrollToBottom={scrollToBottom}
            runNotice={runNotice}
            onDismissRunNotice={() => setRunNotice(null)}
            pendingApprovalCount={pendingApprovalCount}
            showApprovalDock={approvalDockVisible}
            pendingApprovalSummary={pendingApprovalDockLabel}
            pendingApprovalToolId={pendingApprovalToolId}
            pendingApprovalMsgId={pendingApprovalMsgId}
            activeSessionId={activeSessionId}
            onShowToast={onShowToast}
            between={
              isDemoMode() ? (
                <Suspense fallback={null}>
                  <ChatDemoChrome handleGlobalTabClick={handleGlobalTabClick} />
                </Suspense>
              ) : null
            }
          />

          {emptyKind !== 'session-empty' && composerElement}
        </div>
      </div>
    );
  }
);

ChatCard.displayName = 'ChatCard';
