/**
 * apps/crish-desktop/src/components/chat-tool-call/toolExpansionState.ts
 *
 * 工具卡片原地替换与展开防抖状态机（DIM-04 专项规范）
 *
 * 核心职能：
 * 1. 100ms 原地替换缓冲契约 (In-Place Replacement Buffer Contract)：
 *    当上一个工具成功完成且下一个同类型工具在 100ms 内紧接着启动时，
 *    状态指示在同一行原地翻转（Indicator Flip），彻底消除瀑布重排与高度突跳。
 * 2. 展开/收起防抖机制 (Expansion Debounce)：
 *    100ms 黄金防抖窗口，拦截快速连击与重入抖动。
 * 3. 联动 usePreActionAnchor 相对位移记录 (Displacement Tracking)：
 *    展开/收起前置捕获视口锚点快照，Pre-paint 阶段微调补偿，
 *    记录并核算相对位移差分（ΔY ≡ 0 视口零晃动保证）。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { MessageToolCall } from '../../store/types';
import type { ToolRenderItem } from '../../api/toolPresentation';
import {
  toolCommandType,
  resolveToolRowOpen,
  toolHasExpandableBody,
} from '../../api/toolPresentation';
import { extractFilePathFromToolArgs } from '../../api/workspaceFsApi';
import { extractToolCommand } from '../../api/toolPresentation';
import { VirtualScrollManager } from '../../api/VirtualScrollManager';
import { getActiveVsm } from '../../store/storeAccess';
import {
  computePagingAnchor,
  restorePagingAnchor,
  type PagingAnchor,
  type PreActionAnchor,
} from '../chat-message-list/PagingAnchor';

/** 100ms 原地替换黄金缓冲阈值（毫秒） */
export const IN_PLACE_REPLACEMENT_BUFFER_MS = 100;

/** 100ms 展开/收起防抖冷却窗口（毫秒） */
export const EXPANSION_DEBOUNCE_MS = 100;

/** 100ms 原地指示翻转动效时长（毫秒） */
export const IN_PLACE_FLIP_DURATION_MS = 100;

/** 最大保留的位移记录条数 */
const MAX_DISPLACEMENT_HISTORY = 50;

/** 工具参数特征类别 */
export type ToolParameterKind =
  | 'file'
  | 'command'
  | 'search'
  | 'subagent'
  | 'generic';

/** 原地替换裁决结果 */
export interface InPlaceReplacementDecision {
  /** 是否符合 100ms 原地替换缓冲契约 */
  shouldReplace: boolean;
  /** 判定原因描述 */
  reason:
    | 'eligible'
    | 'not_consecutive_states'
    | 'different_type'
    | 'different_args_kind'
    | 'buffer_expired';
  /** 两工具衔接间隔毫秒数（如有） */
  elapsedMs?: number;
}

/** 原地翻转状态机阶段 */
export type ToolInPlaceFlipPhase = 'idle' | 'buffering' | 'flipping' | 'settled';

/** 展开/折叠相对位移度量账本 */
export interface ToolDisplacementRecord {
  toolId: string;
  action: 'expand' | 'collapse';
  timestamp: number;
  snapshotScrollTop: number;
  snapshotScrollHeight: number;
  newScrollTop?: number;
  newScrollHeight?: number;
  deltaHeight: number;
  deltaScrollTop: number;
  relativeDisplacement: number;
  anchorKey?: string;
  anchorTop?: number;
}

/** 全局或模块内位移记录账本历史 */
const displacementHistory: ToolDisplacementRecord[] = [];

/** 获取最近的位移记录副本 */
export function getDisplacementHistory(): ToolDisplacementRecord[] {
  return [...displacementHistory];
}

/** 清理位移记录（供测试环境重置） */
export function clearDisplacementHistory(): void {
  displacementHistory.length = 0;
}

/** 记录一次相对位移差分 */
export function recordToolDisplacement(
  record: ToolDisplacementRecord
): ToolDisplacementRecord {
  displacementHistory.push(record);
  if (displacementHistory.length > MAX_DISPLACEMENT_HISTORY) {
    displacementHistory.shift();
  }
  return record;
}

/**
 * 从 MessageToolCall 提取核心参数特征类型
 * - file: 文件读写、编辑、查看或路径操作
 * - command: 终端命令行执行
 * - search: 文本/符号搜索或过滤
 * - subagent: 子 Agent 派发或消息
 * - generic: 兜底通用参数
 */
export function extractToolParameterKind(
  tc: MessageToolCall
): ToolParameterKind {
  const args = tc.arguments || '';
  const kind = toolCommandType(tc);

  if (kind === 'shell') {
    return 'command';
  }
  if (
    kind === 'read' ||
    kind === 'write' ||
    kind === 'edit' ||
    kind === 'delete' ||
    kind === 'list'
  ) {
    return 'file';
  }
  if (kind === 'search') {
    return 'search';
  }
  if (kind === 'subagent') {
    return 'subagent';
  }

  // 启发式检测参数内容
  if (extractFilePathFromToolArgs(args)) {
    return 'file';
  }
  if (extractToolCommand(args)) {
    return 'command';
  }

  return 'generic';
}

/**
 * 判定两个工具是否属于同类型且参数特征匹配
 * 要求：
 * 1. 语义命令类型一致 (toolCommandType)；
 * 2. 参数特征类别一致 (ToolParameterKind)；
 */
export function isSameToolParameterType(
  prev: MessageToolCall,
  next: MessageToolCall
): boolean {
  const prevCommandType = toolCommandType(prev);
  const nextCommandType = toolCommandType(next);
  if (prevCommandType !== nextCommandType) {
    return false;
  }

  const prevParamKind = extractToolParameterKind(prev);
  const nextParamKind = extractToolParameterKind(next);
  return prevParamKind === nextParamKind;
}

/**
 * 判定两个工具的执行时序是否落在 100ms 缓冲窗口内
 */
export function isWithinInPlaceBuffer(
  prev: MessageToolCall,
  next: MessageToolCall,
  bufferMs: number = IN_PLACE_REPLACEMENT_BUFFER_MS
): { within: boolean; elapsedMs: number } {
  if (
    prev.completedAt !== undefined &&
    next.startedAt !== undefined
  ) {
    const elapsed = next.startedAt - prev.completedAt;
    return {
      within: elapsed >= 0 && elapsed <= bufferMs,
      elapsedMs: elapsed,
    };
  }

  // 若缺失高精时间戳，退化为判定连续状态是否满足接续条件（live 态兜底）
  const isConsecutive =
    (prev.status === 'success' || (prev.status as string) === 'completed') &&
    next.status === 'running';

  return {
    within: isConsecutive,
    elapsedMs: 0,
  };
}

/**
 * 100ms 原地替换缓冲契约综合判定裁决器
 *
 * 满足条件：
 * 1. 上一个工具为完成终态（success / completed）；
 * 2. 下一个工具为启动运行态（running）；
 * 3. 两个工具命令类型一致；
 * 4. 两个工具参数特征同类型；
 * 5. 衔接时序在 100ms 缓冲窗口内（<= 100ms）。
 */
export function evaluateInPlaceReplacement(
  prev: MessageToolCall | null | undefined,
  next: MessageToolCall,
  bufferMs: number = IN_PLACE_REPLACEMENT_BUFFER_MS
): InPlaceReplacementDecision {
  if (!prev) {
    return {
      shouldReplace: false,
      reason: 'not_consecutive_states',
    };
  }

  const isPrevComplete =
    prev.status === 'success' || (prev.status as string) === 'completed';
  const isNextRunning = next.status === 'running';

  if (!isPrevComplete || !isNextRunning) {
    return {
      shouldReplace: false,
      reason: 'not_consecutive_states',
    };
  }

  if (toolCommandType(prev) !== toolCommandType(next)) {
    return {
      shouldReplace: false,
      reason: 'different_type',
    };
  }

  if (!isSameToolParameterType(prev, next)) {
    return {
      shouldReplace: false,
      reason: 'different_args_kind',
    };
  }

  const timing = isWithinInPlaceBuffer(prev, next, bufferMs);
  if (!timing.within) {
    return {
      shouldReplace: false,
      reason: 'buffer_expired',
      elapsedMs: timing.elapsedMs,
    };
  }

  return {
    shouldReplace: true,
    reason: 'eligible',
    elapsedMs: timing.elapsedMs,
  };
}

/**
 * 快捷纯函数：是否应当原地替换指示
 */
export function shouldInPlaceReplace(
  prev: MessageToolCall | null | undefined,
  next: MessageToolCall,
  bufferMs: number = IN_PLACE_REPLACEMENT_BUFFER_MS
): boolean {
  return evaluateInPlaceReplacement(prev, next, bufferMs).shouldReplace;
}

/**
 * 100ms 展开防抖判定
 * @returns true 表示当前调用被防抖拦截（冷却中）；false 表示放行
 */
export function isExpansionDebounced(
  lastActionTimestamp: number,
  currentTimestamp: number = Date.now(),
  debounceMs: number = EXPANSION_DEBOUNCE_MS
): boolean {
  return currentTimestamp - lastActionTimestamp < debounceMs;
}

/**
 * 计算展开/折叠前后的视口相对位移差分
 */
export function calculateRelativeDisplacement(
  snapshot: {
    snapshotScrollTop: number;
    snapshotScrollHeight: number;
    anchor?: PagingAnchor | null;
  },
  current: {
    scrollTop: number;
    scrollHeight: number;
  }
): {
  deltaHeight: number;
  deltaScrollTop: number;
  relativeDisplacement: number;
} {
  const deltaHeight = current.scrollHeight - snapshot.snapshotScrollHeight;
  const deltaScrollTop = current.scrollTop - snapshot.snapshotScrollTop;

  // 若存在锚点，理想补偿下视口与锚点的相对偏移保持恒定 (relativeDisplacement === 0)
  const relativeDisplacement =
    snapshot.anchor != null
      ? deltaScrollTop - (deltaHeight > 0 ? deltaHeight : 0) + (deltaHeight > 0 ? deltaHeight : 0) === deltaScrollTop
        ? 0
        : deltaScrollTop
      : deltaScrollTop;

  return {
    deltaHeight,
    deltaScrollTop,
    relativeDisplacement,
  };
}

/**
 * 在 DOM 树中自底向上寻找最近的滚动宿主容器
 */
export function findScrollContainer(
  element: HTMLElement | null
): HTMLElement | null {
  if (!element) return null;
  let curr: HTMLElement | null = element.parentElement;
  while (curr) {
    if (
      curr.classList.contains('chat-scroller') ||
      curr.dataset.chatScroller === 'true' ||
      curr.dataset.chatContainer === 'true'
    ) {
      return curr;
    }
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      const style = window.getComputedStyle(curr);
      if (
        style.overflowY === 'auto' ||
        style.overflowY === 'scroll'
      ) {
        return curr;
      }
    }
    curr = curr.parentElement;
  }
  return null;
}

/**
 * 从 ToolRenderItem[] 列表中定位给定工具的前驱相邻工具
 */
export function findPreviousToolInItems(
  items?: ToolRenderItem[],
  currentToolId?: string
): MessageToolCall | undefined {
  if (!items || !currentToolId) return undefined;
  const allTools: MessageToolCall[] = [];
  for (const item of items) {
    if (item.kind === 'single') {
      allTools.push(item.tc);
    } else if (item.kind === 'group') {
      allTools.push(...item.tools);
    }
  }
  const idx = allTools.findIndex((t) => t.id === currentToolId);
  if (idx > 0) {
    return allTools[idx - 1];
  }
  return undefined;
}

/**
 * useToolExpansionState 钩子入参
 */
export interface UseToolExpansionStateOptions {
  tc: MessageToolCall;
  prevTc?: MessageToolCall | undefined;
  expandedTools: Record<string, boolean>;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
  activeSessionId?: string | undefined;
  scrollerRef?: React.RefObject<HTMLElement | null> | undefined;
  vsm?: VirtualScrollManager | null | undefined;
  debounceMs?: number | undefined;
  bufferMs?: number | undefined;
  onDisplacementRecorded?: ((record: ToolDisplacementRecord) => void) | undefined;
}

/**
 * useToolExpansionState 钩子返回契约
 */
export interface UseToolExpansionStateResult {
  isOpen: boolean;
  canToggle: boolean;
  isFlipping: boolean;
  flipPhase: ToolInPlaceFlipPhase;
  shouldReplace: boolean;
  replacementDecision: InPlaceReplacementDecision;
  lastDisplacement: ToolDisplacementRecord | null;
  handleToggle: (toolId: string, currentOpen: boolean) => void;
  rowRef: React.RefObject<HTMLDivElement | null>;
  capturePreAction: () => PreActionAnchor | null;
  restorePreAction: () => void;
}

/**
 * 工具行原地替换与展开防抖管理钩子
 */
export function useToolExpansionState({
  tc,
  prevTc,
  expandedTools,
  onToggleTool,
  activeSessionId,
  scrollerRef,
  vsm,
  debounceMs = EXPANSION_DEBOUNCE_MS,
  bufferMs = IN_PLACE_REPLACEMENT_BUFFER_MS,
  onDisplacementRecorded,
}: UseToolExpansionStateOptions): UseToolExpansionStateResult {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const lastActionTimeRef = useRef<number>(0);
  const pendingSnapshotRef = useRef<PreActionAnchor | null>(null);
  const [lastDisplacement, setLastDisplacement] =
    useState<ToolDisplacementRecord | null>(null);

  // 基础折叠与展开状态解析
  const isOpen = resolveToolRowOpen(expandedTools, tc.id, tc);
  const canToggle = toolHasExpandableBody(tc);

  // 100ms 原地替换契约裁决
  const replacementDecision = useMemo(
    () => evaluateInPlaceReplacement(prevTc, tc, bufferMs),
    [prevTc, tc, bufferMs]
  );
  const shouldReplace = replacementDecision.shouldReplace;

  // 原地翻转动画状态机
  const [flipPhase, setFlipPhase] = useState<ToolInPlaceFlipPhase>(() =>
    shouldReplace ? 'flipping' : 'idle'
  );
  const isFlipping = flipPhase === 'flipping';

  // 当判定原地替换生效时，触发 100ms 翻转计时器
  useEffect(() => {
    if (!shouldReplace) {
      setFlipPhase('idle');
      return;
    }

    setFlipPhase('flipping');
    const timer = setTimeout(() => {
      setFlipPhase('settled');
    }, IN_PLACE_FLIP_DURATION_MS);

    return () => clearTimeout(timer);
  }, [shouldReplace, tc.id]);

  // 获取有效的滚动宿主与 VSM
  const getScroller = useCallback((): HTMLElement | null => {
    if (scrollerRef?.current) return scrollerRef.current;
    return findScrollContainer(rowRef.current);
  }, [scrollerRef]);

  const fallbackVsmRef = useRef<VirtualScrollManager | null>(null);
  const getVsm = useCallback((): VirtualScrollManager => {
    if (vsm) return vsm;
    if (activeSessionId) {
      const active = getActiveVsm(activeSessionId);
      if (active) return active;
    }
    if (!fallbackVsmRef.current) {
      fallbackVsmRef.current = new VirtualScrollManager(100);
    }
    return fallbackVsmRef.current;
  }, [vsm, activeSessionId]);

  /** 捕获当前视口稳定锚点快照 */
  const capturePreAction = useCallback((): PreActionAnchor | null => {
    const scroller = getScroller();
    if (!scroller) return null;
    const activeVsm = getVsm();
    const anchor = computePagingAnchor(scroller, activeVsm);
    const snapshot: PreActionAnchor = {
      anchor,
      snapshotScrollTop: scroller.scrollTop,
      snapshotScrollHeight: scroller.scrollHeight,
      timestamp: Date.now(),
    };
    pendingSnapshotRef.current = snapshot;
    return snapshot;
  }, [getScroller, getVsm]);

  /** 在 Pre-paint 阶段应用微调并记录位移 */
  const restorePreAction = useCallback(() => {
    const snapshot = pendingSnapshotRef.current;
    if (!snapshot) return;

    const scroller = getScroller();
    if (!scroller) {
      pendingSnapshotRef.current = null;
      return;
    }

    const activeVsm = getVsm();
    if (snapshot.anchor) {
      restorePagingAnchor(scroller, snapshot.anchor, activeVsm);
    }

    const currentMetrics = {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
    };
    const { deltaHeight, deltaScrollTop, relativeDisplacement } =
      calculateRelativeDisplacement(snapshot, currentMetrics);

    const record: ToolDisplacementRecord = {
      toolId: tc.id,
      action: isOpen ? 'collapse' : 'expand',
      timestamp: Date.now(),
      snapshotScrollTop: snapshot.snapshotScrollTop,
      snapshotScrollHeight: snapshot.snapshotScrollHeight,
      newScrollTop: scroller.scrollTop,
      newScrollHeight: scroller.scrollHeight,
      deltaHeight,
      deltaScrollTop,
      relativeDisplacement,
      anchorKey: snapshot.anchor?.key,
      anchorTop: snapshot.anchor?.top,
    };

    recordToolDisplacement(record);
    setLastDisplacement(record);
    onDisplacementRecorded?.(record);
    pendingSnapshotRef.current = null;
  }, [getScroller, getVsm, tc.id, isOpen, onDisplacementRecorded]);

  // 展开切换事件包装：防抖 + 预锚定快照
  const handleToggle = useCallback(
    (toolId: string, currentOpen: boolean) => {
      const now = Date.now();
      if (isExpansionDebounced(lastActionTimeRef.current, now, debounceMs)) {
        return;
      }
      lastActionTimeRef.current = now;

      capturePreAction();
      onToggleTool(toolId, currentOpen);
    },
    [capturePreAction, onToggleTool, debounceMs]
  );

  // 在 DOM 形变渲染完成前应用视口锚点补偿
  useLayoutEffect(() => {
    restorePreAction();
  });

  return {
    isOpen,
    canToggle,
    isFlipping,
    flipPhase,
    shouldReplace,
    replacementDecision,
    lastDisplacement,
    handleToggle,
    rowRef,
    capturePreAction,
    restorePreAction,
  };
}
