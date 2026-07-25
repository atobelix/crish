/**
 * 消息列表渲染：窗口化 user/assistant bubbles + 工具时间线。
 * 空态由 ChatCard → ChatEmptyState 负责；本组件不渲染欢迎壳，避免幽灵闪屏。
 * 状态机/stream 仍在 ChatCard；className 与历史路径保持一致。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import styles from './ChatMessageList.module.css';
import { AppErrorBoundary } from './AppErrorBoundary';
import { Tooltip } from './settings/SettingsUI';
import type {
  FileDiff,
  SessionAgent,
  SessionMessage,
} from '../store/layoutStore';
import { useLayoutStore } from '../store/layoutStore';
import { assistantCopyText } from '../api/toolPresentation';
import {
  DEFAULT_RECENT_MESSAGE_COUNT,
  collectMustIncludeIndices,
  expandOlderStepCount,
  expandedOlderForPinJump,
  expandedOlderToShowAll,
  messageWindowContainsId,
  nextExpandedOlder,
  resolveExpandedForKeepAlive,
  shouldOfferShowAllOlder,
  windowMessages,
} from '../api/messageWindow';
import {
  messageMatchesSearch,
  subscribeSearchQuery,
  getSearchQuerySnapshot,
} from '../api/sessionSearch';
import { ChatAssistantMessageRow, ChatUserMessageRow } from './ChatMessageRow';
import { prepare, layout } from '@chenglou/pretext';
import { useVirtualScroll } from '../hooks/useVirtualScroll';
import { MESSAGE_ESTIMATED_ROW_HEIGHT } from '../api/messageWindow';
import { buildPretextFontForUiSize } from '../utils/pretextFontBridge';
import { ChevronDown, Pin, PinOff } from 'lucide-react';
import type { ChatToolStackSharedProps } from './ChatToolCallBlock';

const EMPTY_PIN_IDS: string[] = [];
const EMPTY_MSGS: SessionMessage[] = [];
const EMPTY_MUST_INDICES: number[] = [];

/**
 * 统一的 idle 句柄类型：浏览器 `requestIdleCallback` 返回 number；
 * 不支持时降级为 `setTimeout`，其句柄在浏览器环境下也是 number。
 * 用 discriminated union 收口，取代过去 `as unknown as number` 类型逃逸。
 */
type IdleHandle = number;

/** 是否原生支持 requestIdleCallback / cancelIdleCallback（浏览器 + 现代运行时） */
const HAS_NATIVE_REQUEST_IDLE =
  typeof requestIdleCallback === 'function' &&
  typeof cancelIdleCallback === 'function';

/**
 * 跨环境调度 idle 任务：
 * - 优先 `requestIdleCallback`（可向回调提供 deadline）
 * - 回退 `setTimeout`，回调不接收 deadline（调用方需处理 undefined 情况）
 *
 * 返回幂等 cancel 函数：重复调用安全；与 `cancelIdleCallback` / `clearTimeout` 内部自适配。
 */
function scheduleIdle(
  task: (deadline?: IdleDeadline) => void,
  options?: { timeout?: number },
): { handle: IdleHandle; cancel: () => void } {
  if (HAS_NATIVE_REQUEST_IDLE) {
    const handle = requestIdleCallback(task, options) as IdleHandle;
    return {
      handle,
      cancel: () => {
        if (typeof cancelIdleCallback === 'function') {
          cancelIdleCallback(handle);
        }
      },
    };
  }
  const timeout = options?.timeout ?? 16;
  const handle = window.setTimeout(() => task(undefined), timeout) as unknown as IdleHandle;
  return {
    handle,
    cancel: () => window.clearTimeout(handle),
  };
}

/** 固定条摘要：去空白后截断 */
function pinSnippet(text?: string, max = 72): string {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（无文本）';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 按 data-msg-id 选择消息行元素。querySelector 返回 Element | null；
 * 用 instanceof HTMLElement 守卫避免 `as HTMLElement | null` 类型逃逸
 * （Element 上没有 scrollIntoView / classList.add 的具体子类型签名）。
 */
function findMessageElement(messageId: string): HTMLElement | null {
  const el = document.querySelector(
    `[data-msg-id="${CSS.escape(messageId)}"]`,
  );
  return el instanceof HTMLElement ? el : null;
}

/**
 * 滚动到指定消息并短暂高亮。
 * - 命中：scrollIntoView + 添加 flash 类 1.2s 后移除
 * - 未命中：返回 false 由调用方决定重试或提示
 *
 * flash 类名取自 CSS module；CSS module 在编译期类型不全，运行时可能为 undefined，
 * 必须真值检查后再 add/remove，避免 `classList.add('')` 抛错或无操作。
 */
function scrollToMessage(messageId: string): boolean {
  const el = findMessageElement(messageId);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const flashClass = styles.rowPinFlash;
  if (flashClass) {
    el.classList.add(flashClass);
    window.setTimeout(() => {
      el.classList.remove(flashClass);
    }, 1200);
  }
  return true;
}

/** 双 rAF 后再试 scroll（等 expandedOlder 提交后 DOM 挂载） */
function scrollToMessageAfterPaint(
  messageId: string,
  onMiss?: () => void,
): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (!scrollToMessage(messageId)) onMiss?.();
    });
  });
}

export interface ChatMessageListProps {
  messages: SessionMessage[];
  agents: SessionAgent[];
  activeSessionId: string;
  thinkingSeconds: number;
  /**
   * true = 不窗口化（本会话搜索过滤中展示全部命中）。
   * 默认 false：长列表仅挂载最近 N 条。
   */
  showAllMessages?: boolean;
  /** 兼容 ChatCard 传参；空态已上收，列表内不再使用 */
  showProjectPicker: boolean;
  onShowProjectPicker: (open: boolean | ((v: boolean) => boolean)) => void;
  onProjectChanged: () => void;
  onSetChatInput: (text: string) => void;
  /** 后续引导直发（可选；与 onSetChatInput 配套） */
  onSendFollowUp?: (prompt: string) => void;
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
  /** 批量批准/拒绝（BatchApprovalBar；未传则 bar 按钮不显示） */
  onBatchApprove?: (msgIds: string[], toolIds: string[]) => void;
  onBatchDeny?: (msgIds: string[], toolIds: string[]) => void;
}

const ChatMessageListInner: React.FC<ChatMessageListProps> = ({
  messages,
  agents,
  activeSessionId,
  thinkingSeconds,
  showAllMessages = false,
  // showProjectPicker / onShowProjectPicker / onProjectChanged：空态已由 ChatEmptyState 承接，不解构
  onSetChatInput,
  onSendFollowUp,
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
  onBatchApprove,
  onBatchDeny,
}) => {
  /** 按会话保留工具展开态，切换 session 不互相冲掉 */
  const [expandedToolsBySession, setExpandedToolsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  /** 用户消息展开态按会话隔离，避免跨会话幽灵展开 */
  const [expandedUserMsgsBySession, setExpandedUserMsgsBySession] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [pinsOpen, setPinsOpen] = useState(true);
  /** 长列表窗口：从尾部展开的额外更早条数；切换会话重置 */
  const [expandedOlder, setExpandedOlder] = useState(0);
  /**
   * 用户关闭过的引导芯片（按消息 id）。
   * 不入消息持久化，避免污染 blocks / stream 时间线。
   */
  const [dismissedFollowUps, setDismissedFollowUps] = useState<
    Record<string, true>
  >({});
  const sessionKey = activeSessionId || '_';
  const expandedTools = useMemo(
    () => expandedToolsBySession[sessionKey] ?? {},
    [expandedToolsBySession, sessionKey]
  );
  const expandedUserMsgs = useMemo(
    () => expandedUserMsgsBySession[sessionKey] ?? {},
    [expandedUserMsgsBySession, sessionKey]
  );

  // ref 层：依赖频繁变化的值，使回调 identity 稳定
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const onShowToastRef = useRef(onShowToast);
  onShowToastRef.current = onShowToast;
  const onRegenerateRef = useRef(onRegenerate);
  onRegenerateRef.current = onRegenerate;
  const onSendFollowUpRef = useRef(onSendFollowUp);
  onSendFollowUpRef.current = onSendFollowUp;

  /** 侧栏搜索选中后写入 sessionStorage，用于命中消息高亮 */
  const searchHighlightQuery = useSyncExternalStore(
    subscribeSearchQuery,
    getSearchQuerySnapshot,
    getSearchQuerySnapshot
  );

  const pinMessage = useLayoutStore((s) => s.pinMessage);
  const unpinMessage = useLayoutStore((s) => s.unpinMessage);
  // 收紧订阅：按 sessionsById 取当前会话字段，避免 sessions 整表 find
  const pinnedMessageIds = useLayoutStore(
    (s) => s.sessionsById[activeSessionId]?.pinnedMessageIds || EMPTY_PIN_IDS
  );
  const sessionAllMessages = useLayoutStore(
    (s) => s.sessionsById[activeSessionId]?.messages || EMPTY_MSGS
  );
  const pinnedIdSet = useMemo(
    () => new Set(pinnedMessageIds),
    [pinnedMessageIds]
  );

  /**
   * 待审批 / 搜索最早命中 keep-alive：同帧 mustInclude + 抬升 expandedOlder。
   * 固定消息仅在 jumpToPinned 时 include（避免早期 pin 一次挂满历史）。
   */
  const searchMatch = useMemo(() => {
    if (!searchHighlightQuery) return undefined;
    const q = searchHighlightQuery;
    return (m: SessionMessage) => messageMatchesSearch(m, q);
  }, [searchHighlightQuery]);

  const mustIncludeIndices = useMemo(() => {
    if (showAllMessages || messages.length === 0) return EMPTY_MUST_INDICES;
    return collectMustIncludeIndices(messages, {
      includePendingApprovals: true,
      ...(searchMatch !== undefined ? { match: searchMatch } : {}),
      matchOnlyFirst: true,
    });
  }, [messages, showAllMessages, searchMatch]);

  /**
   * 列表变短时钳制；审批/搜索 keep-alive 抬升写回 state，保证「更早」步进连续。
   * 与 windowMessages.mustIncludeIndices 双路径一致（resolveExpandedForKeepAlive）。
   */
  useEffect(() => {
    if (showAllMessages) return;
    setExpandedOlder((prev) => {
      // 审批 ∪ 搜索 keep-alive 抬升；无命中时 resolve 内仍 clamp（截断/重生成）
      const { expandedOlder: next } = resolveExpandedForKeepAlive(messages, {
        includePendingApprovals: true,
        ...(searchMatch !== undefined ? { match: searchMatch } : {}),
        matchOnlyFirst: true,
        currentExpanded: prev,
        recentCount: DEFAULT_RECENT_MESSAGE_COUNT,
      });
      return next === prev ? prev : next;
    });
  }, [messages, mustIncludeIndices, showAllMessages, searchMatch]);

  const messageWindow = useMemo(
    () =>
      windowMessages(messages, {
        recentCount: DEFAULT_RECENT_MESSAGE_COUNT,
        expandedOlder,
        showAll: showAllMessages,
        ...(!showAllMessages ? { mustIncludeIndices } : {}),
      }),
    [messages, expandedOlder, showAllMessages, mustIncludeIndices]
  );
  const visibleMessages = messageWindow.visible;
  const olderStep = expandOlderStepCount(messageWindow.hiddenCount);
  const offerShowAllOlder = shouldOfferShowAllOlder(messageWindow.hiddenCount);

  /** 侧栏全局搜索高亮：窗口已由 keep-alive 展开；确认在窗内再滚入视口 */
  useEffect(() => {
    if (!searchHighlightQuery) return;
    const idx = messages.findIndex((m) =>
      messageMatchesSearch(m, searchHighlightQuery)
    );
    if (idx < 0) return;
    const id = messages[idx]?.id;
    if (!id) return;
    const t = window.setTimeout(() => {
      // showAll 或已进窗才滚；否则再等一帧（mustInclude 抬升后）
      if (
        showAllMessages ||
        messageWindowContainsId(messages, messageWindow, id)
      ) {
        scrollToMessage(id);
        return;
      }
      window.requestAnimationFrame(() => {
        scrollToMessage(id);
      });
    }, 40);
    return () => window.clearTimeout(t);
    // messageWindow 随 keep-alive 更新；查询/会话变化时重跳
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅会话/查询/窗起点变化时跳转
  }, [
    searchHighlightQuery,
    activeSessionId,
    showAllMessages,
    messageWindow.startIndex,
  ]);

  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const hideThinkingBlock = useLayoutStore((s) =>
    Boolean(s.appSettings?.hideThinkingBlock)
  );
  const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
  const planApproved = useLayoutStore((s) => s.planApproved);
  const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const inPlanMode = permissionMode === 'plan' || planModeEnabled;

  const pinnedItems = useMemo(() => {
    if (!pinnedMessageIds.length) return [];
    const byId = new Map(sessionAllMessages.map((m) => [m.id, m]));
    type PinnedItem = {
      id: string;
      sender: 'user' | 'assistant';
      snippet: string;
    };
    const items: PinnedItem[] = [];
    for (const id of pinnedMessageIds) {
      const m = byId.get(id);
      if (!m) continue;
      const text =
        m.sender === 'assistant'
          ? assistantCopyText(m) || m.text || ''
          : m.text || '';
      // m.sender 在 SessionMessage 上是更宽的联合（可能含 'system' 等）；
      // 仅接受 'user' / 'assistant'，避免在 PinnedItem 上做强类型断言
      if (m.sender !== 'user' && m.sender !== 'assistant') continue;
      items.push({
        id,
        sender: m.sender,
        snippet: pinSnippet(text),
      });
    }
    return items;
  }, [pinnedMessageIds, sessionAllMessages]);

  const togglePin = useCallback(
    (messageId: string) => {
      if (!activeSessionId) return;
      if (pinnedIdSet.has(messageId)) {
        unpinMessage(activeSessionId, messageId);
      } else {
        pinMessage(activeSessionId, messageId);
      }
      // 钉栏图标 / is-pinned 态即反馈，不 toast 成功
    },
    [activeSessionId, pinnedIdSet, pinMessage, unpinMessage]
  );

  /** 固定条跳转：pin include 抬升窗口（带 overscan）再 scroll；用 containsId 校验 */
  const jumpToPinned = useCallback(
    (messageId: string) => {
      const idx = messages.findIndex((m) => m.id === messageId);
      // 过滤视图：钉住的消息可能不在 displayMessages 中
      if (idx < 0 && showAllMessages) {
        const exists = sessionAllMessages.some((m) => m.id === messageId);
        onShowToast(exists ? '该消息不在当前过滤结果中' : '未找到该固定消息');
        return;
      }
      // 优先当前展示列表；过滤视图回落到完整会话
      const listForPin = idx >= 0 ? messages : sessionAllMessages;
      const inList = listForPin.some((m) => m.id === messageId);
      if (!inList) {
        onShowToast('未找到该固定消息');
        return;
      }

      const raisePinWindow = (prev: number) =>
        expandedOlderForPinJump(
          listForPin,
          messageId,
          prev,
          DEFAULT_RECENT_MESSAGE_COUNT
        );

      if (!showAllMessages) {
        setExpandedOlder(raisePinWindow);
      }

      scrollToMessageAfterPaint(messageId, () => {
        // 仍不在 DOM：再拉一次 pin 窗口后重试
        if (!showAllMessages) {
          setExpandedOlder(raisePinWindow);
        }
        window.setTimeout(() => {
          if (!scrollToMessage(messageId)) {
            onShowToast('未找到该固定消息');
          }
        }, 50);
      });
    },
    [messages, sessionAllMessages, showAllMessages, onShowToast]
  );

  /** 步进以 effectiveExpanded 为基，避免 mustInclude 抬升后 state 滞后导致少扩 */
  const expandOlderStep = useCallback(() => {
    setExpandedOlder((n) =>
      nextExpandedOlder(
        Math.max(n, messageWindow.effectiveExpanded),
        messageWindow.hiddenCount
      )
    );
  }, [messageWindow.hiddenCount, messageWindow.effectiveExpanded]);

  const expandOlderAll = useCallback(() => {
    setExpandedOlder(
      expandedOlderToShowAll(messages.length, DEFAULT_RECENT_MESSAGE_COUNT)
    );
  }, [messages.length]);

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      // 治理防线 #3（noUncheckedIndexedAccess）：下标访问返回 T | undefined，
      // 用循环变量复用避免 `messages[i]!.id` 非空断言
      const msg = messages[i];
      if (msg && msg.sender === 'assistant') return msg.id;
    }
    return null;
  }, [messages]);

  const thinkingMsgId = useMemo(
    () =>
      messages.find(
        (m) => m.sender === 'assistant' && m.status === 'processing'
      )?.id,
    [messages]
  );

  /**
   * 切换展开；须传入当前展示态。
   * 默认折叠（完成态不自动撑开），流式过程中也不会默认打开，避免高度抖动。
   */
  const toggleTool = useCallback(
    (toolId: string, currentlyOpen: boolean) => {
      setExpandedToolsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] ?? {}),
          [toolId]: !currentlyOpen,
        },
      }));
    },
    [sessionKey]
  );

  /** 代码块「复制」：只从相邻 pre 取文本，不依赖 data-copy 属性 */
  const handleMarkdownClick = useCallback(
    (e: React.MouseEvent) => {
      // e.target 是 EventTarget；只有 HTMLElement 才有 closest 方法
      // 用 instanceof 守卫替代 `as HTMLElement | null`，避免在文本节点等非元素目标上误调
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const btn = target.closest('.md-code-copy');
      if (!(btn instanceof HTMLElement)) return;
      e.preventDefault();
      e.stopPropagation();
      const text =
        btn.closest('.md-code-block')?.querySelector('pre')?.textContent ?? '';
      if (!text) return;
      void navigator.clipboard.writeText(text).then(
        () => {
          /* 成功静默 */
        },
        () => onShowToast('复制失败'),
      );
    },
    [onShowToast],
  );

  const onToggleExpandUser = useCallback(
    (msgId: string) => {
      setExpandedUserMsgsBySession((prev) => ({
        ...prev,
        [sessionKey]: {
          ...(prev[sessionKey] ?? {}),
          [msgId]: !(prev[sessionKey] ?? {})[msgId],
        },
      }));
    },
    [sessionKey]
  );

  /** 行组件内只收 assistantMsgId；在此解析对应用户原文，避免把整表 messages 传入行 props */
  const handleRegenerateRow = useCallback((assistantMsgId: string) => {
    const msgs = messagesRef.current;
    const toast = onShowToastRef.current;
    const idx = msgs.findIndex((m) => m.id === assistantMsgId);
    let userText = '';
    for (let i = idx - 1; i >= 0; i--) {
      const targetMsg = msgs[i];
      if (targetMsg && targetMsg.sender === 'user') {
        userText = targetMsg.text || '';
        break;
      }
    }
    if (!userText.trim()) {
      toast('没有可重新生成的内容');
      return;
    }
    if (msgs.some((m) => m.status === 'processing')) {
      toast('请等待当前回复完成');
      return;
    }
    onRegenerateRef.current?.(userText, assistantMsgId);
  }, []);

  const handleDismissFollowUp = useCallback((msgId: string) => {
    setDismissedFollowUps((prev) =>
      prev[msgId] ? prev : { ...prev, [msgId]: true }
    );
  }, []);

  const handleFillFollowUp = useCallback(
    (prompt: string) => {
      onSetChatInput(prompt);
    },
    [onSetChatInput]
  );

  const handleSendFollowUp = useCallback((prompt: string) => {
    const send = onSendFollowUpRef.current;
    if (!send) return;
    const msgs = messagesRef.current;
    if (msgs.some((m) => m.status === 'processing')) {
      onShowToastRef.current?.('请等待当前回复完成');
      return;
    }
    send(prompt);
  }, []);

  const toolStackProps = useMemo(
    (): ChatToolStackSharedProps => ({
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
      ...(onBatchApprove !== undefined ? { onBatchApprove } : {}),
      ...(onBatchDeny !== undefined ? { onBatchDeny } : {}),
    }),
    [
      agents,
      activeSessionId,
      expandedTools,
      toggleTool,
      approvalBusy,
      pendingApprovalMsgId,
      onOpenDiff,
      onOpenPath,
      onOpenTerminal,
      onApprovalAllow,
      onApprovalDeny,
      onBatchApprove,
      onBatchDeny,
    ]
  );

  // ───── 虚拟滚动（window pan / expand relies on syncOrder internally） ─────
  const visibleMsgIds = useMemo(() => visibleMessages.map((m) => m.id), [visibleMessages]);
  const vs = useVirtualScroll({
    ids: visibleMsgIds,
    itemCount: visibleMessages.length,
    overscan: 6,
    fallbackHeight: MESSAGE_ESTIMATED_ROW_HEIGHT,
  });
  const { containerRef, setActual, clearHeights, manager } = vs;

  useEffect(() => {
    // activeSessionId switch clears heights cache
    setExpandedOlder(0);
    setDismissedFollowUps({});
    clearHeights();
  }, [activeSessionId, clearHeights]);

  const pretextFont = useMemo(() => {
    try {
      return buildPretextFontForUiSize('medium', 'sans', 'normal');
    } catch {
      return null;
    }
  }, []);

  const [containerWidth, setContainerWidth] = useState(680);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  /**
   * 未渲染过的消息用 Pretext 估算纯文本部分高度（喂给 VirtualScrollManager）。
   * 改为 idle 分批执行，避免阻塞会话切换的首帧渲染。
   *
   * 句柄与卸载逻辑通过 `scheduleIdle` 统一收口，取代过去 `as unknown as number` + 双分支 cancel。
   */
  const pretextIdleRef = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => {
    if (!pretextFont || containerWidth <= 0) return;
    // 取消上一次未完成的 idle 任务（幂等）
    if (pretextIdleRef.current) {
      pretextIdleRef.current.cancel();
      pretextIdleRef.current = null;
    }
    const TEXT_LINE_HEIGHT = 22;
    const TEXT_PADDING = 40;
    const TOOL_CALL_OVERHEAD_PER_CALL = 80;
    const availWidth = Math.max(1, containerWidth - 32);
    // 只处理还未被 Pretext/RO 测量过的 index
    const pending = visibleMessages
      .map((msg, i) => ({ msg, i }))
      .filter(
        ({ msg, i }) =>
          msg != null &&
          manager.getHeight(String(i)) === MESSAGE_ESTIMATED_ROW_HEIGHT,
      );

    if (pending.length === 0) return;

    let cursor = 0;
    const processChunk = (deadline?: IdleDeadline) => {
      const timeRemaining = deadline ? () => deadline.timeRemaining() : () => 1;
      while (cursor < pending.length && timeRemaining() > 0) {
        // 治理防线 #3（noUncheckedIndexedAccess）：pending[cursor] 已过滤掉 null msg，
        // 但下标访问仍为 T | undefined，需显式守卫
        const item = pending[cursor++];
        if (!item) continue;
        const { msg, i } = item;
        if (manager.getHeight(String(i)) !== MESSAGE_ESTIMATED_ROW_HEIGHT) continue; // RO 已测量，跳过
        let h = MESSAGE_ESTIMATED_ROW_HEIGHT;
        const text = msg.text || '';
        if (text && availWidth > 0) {
          try {
            const prepared = prepare(text, pretextFont);
            const result = layout(prepared, availWidth, TEXT_LINE_HEIGHT);
            h = result.height + TEXT_PADDING;
          } catch {
            h = MESSAGE_ESTIMATED_ROW_HEIGHT;
          }
        }
        if (msg.toolCalls?.length) {
          h += TOOL_CALL_OVERHEAD_PER_CALL * msg.toolCalls.length;
        }
        manager.setEstimated(String(i), h);
      }
      if (cursor < pending.length) {
        // 还有剩余，继续安排下一个 idle 帧
        const next = scheduleIdle(processChunk, { timeout: 500 });
        if (pretextIdleRef.current) {
          // 把上一次的 cancel 替换为下一次的 cancel；旧 handle 已执行完，cancel 幂等
          pretextIdleRef.current = next;
        } else {
          pretextIdleRef.current = next;
        }
      } else {
        pretextIdleRef.current = null;
      }
    };

    pretextIdleRef.current = scheduleIdle(processChunk, { timeout: 300 });

    return () => {
      if (pretextIdleRef.current) {
        pretextIdleRef.current.cancel();
        pretextIdleRef.current = null;
      }
    };
  }, [visibleMessages, pretextFont, containerWidth, manager]);

  /** 渲染后通过 ResizeObserver 获取实际行高，覆盖 estimate */
  const roRef = useRef<ResizeObserver | null>(null);
  const observedRowsRef = useRef<Set<Element>>(new Set());
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 创建一次 RO，生命周期与组件一致
    if (!roRef.current) {
      roRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          // entry.target 是 Element；只有 HTMLElement 才有 dataset 属性
          // 用 instanceof 守卫避免 `as HTMLElement` 类型逃逸
          const el = entry.target;
          if (!(el instanceof HTMLElement)) continue;
          const vindex = el.dataset.vindex;
          if (vindex != null && entry.contentRect.height > 0) {
            setActual(vindex, entry.contentRect.height);
          }
        }
      });
    }
    const ro = roRef.current;
    const observed = observedRowsRef.current;
    const current = new Set<Element>(
      Array.from(container.querySelectorAll('[data-vindex]'))
    );
    // 新增观测
    for (const row of current) {
      if (!observed.has(row)) {
        ro.observe(row);
        observed.add(row);
      }
    }
    // 移除不再可见的行
    for (const row of observed) {
      if (!current.has(row)) {
        ro.unobserve(row);
        observed.delete(row);
      }
    }
    // 无需 cleanup disconnect：保持 RO 活跃直到组件 unmount
  }, [visibleMessages, containerRef, setActual]);

  // 组件卸载时彻底清理
  useEffect(() => {
    return () => {
      roRef.current?.disconnect();
      roRef.current = null;
      observedRowsRef.current.clear();
    };
  }, []);

  // ChatCard 在 emptyKind 时改挂 ChatEmptyState；此处防御性短路，杜绝欢迎壳幽灵闪屏
  if (messages.length === 0) {
    return null;
  }

  const olderAria = `显示更早的 ${olderStep} 条消息，当前仍有 ${messageWindow.hiddenCount} 条未显示`;
  const showAllAria = `一次展开全部 ${messageWindow.hiddenCount} 条更早消息`;

  const { startIndex, endIndex, startOffset, estimatedTotalHeight } =
    vs.visibleRange;
  const endOffset = vs.manager.getOffset(endIndex);

  return (
    <AppErrorBoundary variant="compact" title="消息列表出错">
      <div
        ref={vs.containerRef}
        className={styles.list}
        role="region"
        aria-label="会话消息"
        data-window-start={messageWindow.startIndex}
        data-hidden-count={messageWindow.hiddenCount}
        data-visible-count={messageWindow.visibleCount}
        data-total-count={messageWindow.totalCount}
        data-show-all={showAllMessages ? 'true' : 'false'}
        data-has-older={messageWindow.hasOlder ? 'true' : 'false'}
        data-virtual-scroll="true"
        onClick={handleMarkdownClick}
        onScroll={vs.onScroll}
      >
        {messageWindow.hasOlder && olderStep > 0 ? (
          <div
            className="chat-msg-window-older"
            role="region"
            aria-label="更早消息"
          >
            <div className="chat-msg-window-older-actions">
              <Tooltip content={olderAria}>
                <button
                  type="button"
                  className="chat-msg-window-older-btn"
                  onClick={expandOlderStep}
                  aria-label={olderAria}
                >
                  显示更早的 {olderStep} 条
                  <span
                    className="chat-msg-window-older-meta"
                    aria-hidden="true"
                  >
                    （另有 {messageWindow.hiddenCount} 条未显示）
                  </span>
                </button>
              </Tooltip>
              {offerShowAllOlder ? (
                <Tooltip content={showAllAria}>
                  <button
                    type="button"
                    className="chat-msg-window-older-btn chat-msg-window-older-btn--all"
                    onClick={expandOlderAll}
                    aria-label={showAllAria}
                  >
                    全部展开
                    <span
                      className="chat-msg-window-older-meta"
                      aria-hidden="true"
                    >
                      （{messageWindow.hiddenCount} 条）
                    </span>
                  </button>
                </Tooltip>
              ) : null}
            </div>
          </div>
        ) : null}
        {pinnedItems.length > 0 ? (
          <div
            className={styles.pinnedBar}
            role="region"
            aria-label="已固定消息"
          >
            <Tooltip content={pinsOpen ? '收起固定列表' : '展开固定列表'}>
              <button
                type="button"
                className={styles.pinnedBarToggle}
                onClick={() => setPinsOpen((v) => !v)}
                aria-expanded={pinsOpen}
                aria-controls="chat-pinned-list"
                aria-label={
                  pinsOpen
                    ? `收起已固定消息列表，共 ${pinnedItems.length} 条`
                    : `展开已固定消息列表，共 ${pinnedItems.length} 条`
                }
              >
                <Pin size={13} strokeWidth={2} aria-hidden />
                <span>已固定 · {pinnedItems.length}</span>
                <ChevronDown
                  size={14}
                  className={`${styles.pinnedChevron}${pinsOpen ? ` ${styles.isOpen}` : ''}`}
                  aria-hidden
                />
              </button>
            </Tooltip>
            {pinsOpen ? (
              <ul id="chat-pinned-list" className={styles.pinnedList}>
                {pinnedItems.map((item) => (
                  <li key={item.id} className={styles.pinnedItem}>
                    <Tooltip content="跳转到消息">
                      <button
                        type="button"
                        className={styles.pinnedJump}
                        aria-label={`跳转到${item.sender === 'user' ? '你' : '助手'}的固定消息：${item.snippet}`}
                        onClick={() => jumpToPinned(item.id)}
                      >
                        <span className={styles.pinnedSnippet}>
                          {item.snippet}
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip content="取消固定">
                      <button
                        type="button"
                        className={styles.pinnedUnpin}
                        aria-label={`取消固定：${item.snippet}`}
                        onClick={() => togglePin(item.id)}
                      >
                        <PinOff size={14} aria-hidden />
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {/* 顶部 spacer：已被滚出视口的消息占位 */}
        <div style={{ height: startOffset, flexShrink: 0 }} aria-hidden />

        {/* 可视范围内的消息 */}
        {visibleMessages.slice(startIndex, endIndex).map((msg, i) => {
          const virtualIndex = startIndex + i;
          const prevMsg =
            virtualIndex > 0 ? visibleMessages[virtualIndex - 1] : null;
          const isFollowUp =
            msg.sender === 'assistant' && prevMsg?.sender === 'assistant';
          const isPinnedMsg = pinnedIdSet.has(msg.id);
          const isSearchHit =
            !!searchHighlightQuery &&
            messageMatchesSearch(msg, searchHighlightQuery);

          if (msg.sender === 'user') {
            return (
              <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
                <div data-vindex={virtualIndex}>
                  <ChatUserMessageRow
                    msg={msg}
                    isPinned={isPinnedMsg}
                    isSearchHit={isSearchHit}
                    isExpanded={!!expandedUserMsgs[msg.id]}
                    onToggleExpand={onToggleExpandUser}
                    onTogglePin={togglePin}
                    onWithdraw={onWithdraw}
                    onShowToast={onShowToast}
                    messageIndex={virtualIndex}
                    virtualScrollManager={manager}
                  />
                </div>
              </AppErrorBoundary>
            );
          }

          return (
            <AppErrorBoundary key={msg.id} variant="minimal" title="消息出错">
              <div data-vindex={virtualIndex}>
                <ChatAssistantMessageRow
                  msg={msg}
                  isFollowUp={isFollowUp}
                  isPinned={isPinnedMsg}
                  isSearchHit={isSearchHit}
                  isThinkingMsg={msg.id === thinkingMsgId}
                  thinkingSeconds={thinkingSeconds}
                  hideThinkingBlock={hideThinkingBlock}
                  inPlanMode={inPlanMode}
                  planApproved={planApproved}
                  isLastAssistant={msg.id === lastAssistantId}
                  toolStackProps={toolStackProps}
                  onTogglePin={togglePin}
                  onShowToast={onShowToast}
                  onRegenerate={handleRegenerateRow}
                  onBranch={onBranch}
                  onOpenDiff={onOpenDiff}
                  onOpenDiffPanel={onOpenDiffPanel}
                  setPermissionMode={setPermissionMode}
                  setPlanApproved={setPlanApproved}
                  onFillFollowUp={handleFillFollowUp}
                  onSendFollowUp={
                    onSendFollowUp ? handleSendFollowUp : undefined
                  }
                  followUpDismissed={!!dismissedFollowUps[msg.id]}
                  onDismissFollowUp={handleDismissFollowUp}
                  messageIndex={virtualIndex}
                  virtualScrollManager={manager}
                />
              </div>
            </AppErrorBoundary>
          );
        })}

        {/* 底部 spacer：可视范围之后的剩余消息占位 */}
        <div
          style={{
            height: Math.max(0, estimatedTotalHeight - endOffset),
            flexShrink: 0,
          }}
          aria-hidden
        />
      </div>
    </AppErrorBoundary>
  );
};

export const ChatMessageList = React.memo(ChatMessageListInner);
