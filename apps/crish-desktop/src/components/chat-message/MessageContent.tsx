import React, {
  useState,
  useMemo,
  useRef,
  useCallback,
  useEffect,
} from 'react';
import { useNarrativeRenderSlots } from './narrativeRenderSlots';
import styles from './MessageContent.module.css';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import {
  buildAssistantTimelineCached,
  partitionTimelineSegments,
  type AssistantTimelineItem,
  type ProcessTimelineSegment,
  type TimelineSegment,
  type ToolRenderItem,
} from '../../api/toolPresentation';
import {
  reconcileTimelineItems,
  reconcileTimelineSegments,
} from '../../api/tool-presentation/timelineCache';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { Priority } from '../../workers';
import { StreamingMarkdownView } from '../chat-message-row/StreamingMarkdownView';
import {
  collapseContextState,
  isContextStateInjection,
  formatContextStateDisplayText,
} from './contextStateUtils';
import { WorkingStatusIndicator } from '../chat-message-row/WorkingStatusIndicator';
import { InFlowStatusLine } from '../chat-message-row/InFlowStatusLine';
import { FoldableProcessSection } from './FoldableProcessSection';
import {
  subscribeMessageProcessExpansion,
  setMessageProcessExpanded,
} from './searchExpandBridge';
import {
  useSessionRuntimeStatus,
  useSessionStore,
} from '../../store/storeAccess';

import { ProcessItemRenderer } from './ProcessItemRenderer';
import { logInternalError } from '../../api/userFacingErrors';

export interface MessageContentProps {
  /**
   * 已合并的流式渲染 view model（T4 A1：由页面壳层 useStreamMessageViewModel
   * 装配后传入；本组件不再直读 streamingStore）。
   */
  msg: SessionMessage;
  /**
   * 流式累积正文（undefined = 热缓冲无条目）。驱动流式增量区 / 图片扫描 /
   * streaming 判定；正文合并已由壳层完成（msg.text 即当前有效正文）。
   */
  streamText?: string;
  isThinkingMsg?: boolean;
  /** true = 新渲染的思考段默认折叠；false = 默认展开 */
  hideThinkingBlock?: boolean;
  toolStackProps?: ChatToolStackSharedProps;
  className?: string;
  /**
   * 测高作废回调（由虚拟滚动宿主注入）。
   * 折叠段展开/收起的物理高度变更必须经此单轨通知宿主动态测高。
   */
  onInvalidateActual?: (msgId: string) => void;
}

/**
 * 过程组折叠展开态字典：`sectionId → boolean`。
 *
 * 收敛说明：历史实现使用「整条消息一个布尔」的 `searchExpandBridge`，
 * 无法表达「同一消息内多过程段各自独立展开」。此处以 section 粒度收敛，
 * 并保留 bridge 作为外部（检索命中）命令入口。R9 单组化后一轮通常只有
 * 一个过程组键（仅状态通知切分时多组），字典机制不变。
 */
type SectionExpandedMap = Record<string, boolean>;

/* ═══════════════════════════════════════════════════════════════════════
 * 行内尾部窗口化（R3 落地段级形态，R9 起单位改判为组）
 *
 * 背景（性能审计 P0-1）：巨型回合的单行可达约 5,000 DOM 节点，历史过程
 * 内容全部真实挂载既拖慢流式帧，也让行测高/重排成本随回合长度线性增长。
 * 口径（R9）：占位单位为**过程组**——整组已封口、非末位、未被用户交互过，
 * 且组内条目数与估算节点数双双越过阈值时才启用；占位采用二段式：
 * **组头（控制栏）常驻 + 组体等高占位**，组体占位进入视口预热区
 * （rootMargin 1200px）时由 IntersectionObserver 真实挂载（单向闩：
 * 挂载后不再回退占位）。活跃组永不占位。
 * 边界：本机制只改「组体何时挂载」，不改 FoldableProcessSection 的
 * DOM 常驻语义（折叠组 hidden=until-found 的页内查找取舍归 D1 改判口径）。
 * 已知代价（诚实标注）：组体占位期间其内容不进入浏览器原生 Ctrl+F 查找
 * （组头常驻，摘要始终可见）；检索展开命令（searchExpandBridge）会先
 * 全量挂载再展开，不受影响。
 * IntersectionObserver 不可用（如 jsdom）时整体禁用，渲染与旧行为一致。
 * ═══════════════════════════════════════════════════════════════════════ */

/** 启用组级窗口化的最小组内条目数（R3 段数条件的组粒度等价物） */
const GROUP_WINDOW_MIN_ITEMS = 16;
/** 启用组级窗口化的最小估算节点数（审计实测问题行约 5,005 节点，取约半数） */
const GROUP_WINDOW_MIN_NODES = 2400;
/** 占位组体进入视口外扩预热距离（px），保证滚动到达前完成真实挂载 */
const SEGMENT_WINDOW_ROOT_MARGIN_PX = 1200;

const EMPTY_SECTION_HEIGHTS: ReadonlyMap<string, number> = new Map();

function estimateToolRenderNodes(item: ToolRenderItem): number {
  if (item.kind === 'single') {
    return 30 + Math.ceil((item.tc.output?.length ?? 0) / 700);
  }
  let nodes = 16;
  for (const tc of item.tools) {
    nodes += 30 + Math.ceil((tc.output?.length ?? 0) / 700);
  }
  return nodes;
}

/** 段/组估算节点数（启发式，仅用于窗口化阈值判定，不参与测高） */
function estimateSegmentNodes(seg: TimelineSegment): number {
  if (seg.kind === 'text_narrative') {
    return 20 + Math.ceil(seg.item.content.length / 100);
  }
  if (seg.kind === 'state_notice') {
    return 10;
  }
  let nodes = 24;
  for (const item of seg.items) {
    if (item.kind === 'thought') {
      nodes += 14 + Math.ceil(item.content.length / 140);
    } else if (item.kind === 'tools') {
      for (const ri of item.items) {
        nodes += estimateToolRenderNodes(ri);
      }
    } else if (item.kind === 'text') {
      // 组内叙述行：全文 Markdown 渲染，节点密度与正文段同口径
      nodes += 20 + Math.ceil(item.content.length / 100);
    } else if (item.kind === 'injection') {
      nodes += 10;
    } else {
      nodes += 12;
    }
  }
  return nodes;
}

/** 组体占位估算高度（px）：仅需量级接近，真实挂载后由 VSM 重测纠正 */
function estimateProcessSectionHeightPx(seg: ProcessTimelineSegment): number {
  let px = 36;
  for (const item of seg.items) {
    if (item.kind === 'thought' || item.kind === 'text') {
      px += 22 + Math.ceil(item.content.length / 55) * 17;
    } else if (item.kind === 'tools') {
      for (const ri of item.items) {
        px += ri.kind === 'single' ? 30 : 26 + ri.tools.length * 30;
      }
    } else {
      px += 20;
    }
  }
  return Math.max(40, px);
}

export const MessageContent: React.FC<MessageContentProps> = React.memo(
  ({
    msg,
    streamText,
    isThinkingMsg = false,
    hideThinkingBlock = false,
    toolStackProps,
    className,
    onInvalidateActual,
  }) => {
    /* ═══════════════════════════════════════════════════════════════════════
     * Hooks 无条件区（Hooks 顺序铁律）
     *
     * 历史缺陷（P0-1）：原实现在 `linearItems.length === 0` 分支提前 `return`，
     * 导致其后的 `useState` 在「时间线非空」与「时间线为空」两种渲染间
     * 产生 Hooks 数量差异，违反 React Hooks 规则。
     * 现统一：所有 Hooks 在组件顶部无条件执行，分支仅决定「渲染什么」，
     * 绝不影响「Hook 调用序列」。
     * ═══════════════════════════════════════════════════════════════════════ */

    const displayMsg = msg;
    const { renderTools, renderThought } = useNarrativeRenderSlots();
    // 纸墨极简流：思考段折叠受 hideThinkingBlock 契约管控（默认受控收起/展开）
    const thoughtDefaultOpen = !hideThinkingBlock;

    const sessionId = useSessionStore((s) => s.activeSessionId) || '';
    // 单轨收敛 §2.2：运行时状态机 retrying 相位（唯一数据源）
    const runtimeStatus = useSessionRuntimeStatus(sessionId);

    const isLiveTurn = Boolean(msg.status === 'processing' || isThinkingMsg);

    const hasThoughtContent = Boolean(
      (displayMsg.thinking && displayMsg.thinking.trim()) ||
      (displayMsg.thinkingTurns &&
        displayMsg.thinkingTurns.some(
          (tt) => tt.content?.trim() || tt.isStreaming
        ))
    );

    const hasTextContent = Boolean(
      displayMsg.text?.trim() || streamText?.trim()
    );

    const hasToolContent = Boolean(
      displayMsg.toolCalls && displayMsg.toolCalls.length > 0
    );

    const isInitialWaiting = Boolean(
      isLiveTurn && !hasThoughtContent && !hasTextContent && !hasToolContent
    );

    // 单轨收敛 §2.2：瞬态状态行仅在「本轮活跃 + retrying 相位」出现
    const inFlowRetry =
      (isThinkingMsg || msg.status === 'processing') &&
      runtimeStatus?.phase === 'retrying'
        ? runtimeStatus.retry
        : undefined;
    // 单轨收敛 §2.3：有正文的失败轮次状态为 error——流内只留一行事实标记
    //（无按钮、无详情；行动入口唯一在 ComposerErrorBar）。零正文失败已被 withdraw，不会到这里。
    const interruptedMark =
      msg.status === 'error' ? (
        <div
          className={styles.interruptedMark}
          data-testid="turn-interrupted-mark"
        >
          回复中断
        </div>
      ) : null;

    // timeline 签名缓存
    const timelineCacheRef = useRef<{
      msgId: string;
      sig: string | null;
      timeline: AssistantTimelineItem[] | null;
    }>({ msgId: '', sig: null, timeline: null });

    if (timelineCacheRef.current.msgId !== msg.id) {
      timelineCacheRef.current = { msgId: msg.id, sig: null, timeline: null };
    }

    let timeline: AssistantTimelineItem[];
    try {
      const cached = timelineCacheRef.current;
      const r = buildAssistantTimelineCached(
        displayMsg,
        cached.sig,
        cached.timeline
      );
      // R3 身份协调：签名未命中重建时，把语义未变的已封口条目换回上一帧
      // 对象引用——linearItems / segments 的输入引用稳定，历史段整链零重算，
      // 只有真正变化的尾段/变更段产生新对象（详见 timelineCache 协调器）。
      timeline = reconcileTimelineItems(cached.timeline, r.timeline);
      timelineCacheRef.current = {
        msgId: msg.id,
        sig: r.sig,
        timeline,
      };
    } catch (err) {
      // 静默清空 timeline = 整条助手消息内容消失（最忌讳级）。必须可观测。
      logInternalError('message-content-timeline-build', err, {
        severity: 'warning',
      });
      timeline = [];
    }

    // 流式区判定：助手思考中且累积流式正文有效
    const streaming = Boolean(
      isThinkingMsg && streamText != null && streamText.length > 0
    );

    // 跟踪流式相位变更（首帧流式正文接入时微重排单次通知）
    const prevStreamingRef = useRef(false);
    const streamPhaseRef = useRef(0);
    if (prevStreamingRef.current !== streaming) {
      streamPhaseRef.current += 1;
      prevStreamingRef.current = streaming;
    }

    // 单轨交错线性时间线：相邻同文案的上下文状态提示只留一条（S-5 唯一折叠实现）
    const linearItems = useMemo(
      () =>
        collapseContextState(
          timeline,
          (item) =>
            item.kind === 'injection' &&
            isContextStateInjection(item.injection),
          {
            keep: 'first-same-key',
            stateKey: (item) =>
              item.kind === 'injection'
                ? formatContextStateDisplayText(item.injection)
                : '',
          }
        ),
      [timeline]
    );

    // ── 分段唯一权威：`partitionTimelineSegments`（R9 过程组口径） ──
    const hasStreamText = Boolean(streamText != null && streamText.length > 0);
    const rawSegments: TimelineSegment[] = useMemo(
      () =>
        partitionTimelineSegments(
          msg.id,
          linearItems,
          isLiveTurn,
          hasStreamText,
          {
            msgTimestamp: msg.timestamp,
            totalTurnDurationSec: msg.thinkingTime,
          }
        ),
      [
        msg.id,
        linearItems,
        isLiveTurn,
        hasStreamText,
        msg.timestamp,
        msg.thinkingTime,
      ]
    );

    // R3 段级身份协调：重分段后语义未变的段保持上一帧对象引用，
    // FoldableProcessSection 的 React.memo 在流式帧期间只对尾段/变更段失效。
    const segmentsCacheRef = useRef<{
      msgId: string;
      segments: TimelineSegment[] | null;
    }>({ msgId: '', segments: null });
    if (segmentsCacheRef.current.msgId !== msg.id) {
      segmentsCacheRef.current = { msgId: msg.id, segments: null };
    }
    const segments: TimelineSegment[] = useMemo(() => {
      const next = reconcileTimelineSegments(
        segmentsCacheRef.current.segments,
        rawSegments
      );
      segmentsCacheRef.current = { msgId: msg.id, segments: next };
      return next;
    }, [rawSegments, msg.id]);

    // R9 组级窗口化计划：逐组以「组内条目数 + 估算节点数」双阈值判定，
    // 命中的组登记其组体占位高度（口径见文件头常量区）
    const windowPlan = useMemo(() => {
      if (typeof IntersectionObserver === 'undefined') {
        return { engaged: false, heights: EMPTY_SECTION_HEIGHTS };
      }
      const heights = new Map<string, number>();
      for (const seg of segments) {
        if (seg.kind !== 'process_section') continue;
        if (seg.items.length < GROUP_WINDOW_MIN_ITEMS) continue;
        if (estimateSegmentNodes(seg) < GROUP_WINDOW_MIN_NODES) continue;
        heights.set(seg.id, estimateProcessSectionHeightPx(seg));
      }
      return {
        engaged: heights.size > 0,
        heights: heights as ReadonlyMap<string, number>,
      };
    }, [segments]);

    // ── 分段展开态字典（受控，首帧直接对齐权威态以避免挂载后二次作废 VSM 实测高度） ──
    const [expandedMap, setExpandedMap] = useState<SectionExpandedMap>(() => {
      const initial: SectionExpandedMap = {};
      for (const seg of segments) {
        if (seg.kind === 'process_section') {
          initial[seg.id] = seg.defaultExpanded ?? true;
        }
      }
      return initial;
    });

    const userInteractedKeysRef = useRef<Set<string>>(new Set());

    useEffect(() => {
      const patch: SectionExpandedMap = {};
      let mutated = false;
      let effectiveChanged = false;

      for (const seg of segments) {
        if (seg.kind !== 'process_section') continue;
        if (userInteractedKeysRef.current.has(seg.id)) continue;
        const target = seg.defaultExpanded ?? true;
        const currentEffective = expandedMap[seg.id] ?? seg.defaultExpanded;
        if (
          Object.prototype.hasOwnProperty.call(expandedMap, seg.id) &&
          expandedMap[seg.id] === target
        ) {
          continue;
        }
        patch[seg.id] = target;
        mutated = true;
        if (currentEffective !== target) {
          effectiveChanged = true;
        }
      }

      if (!mutated) return;
      setExpandedMap((prev) => ({ ...prev, ...patch }));
      if (effectiveChanged) {
        onInvalidateActual?.(msg.id);
      }
    }, [segments, expandedMap, onInvalidateActual, msg.id]);

    const handleToggleSection = useCallback(
      (sectionId: string, nextExpanded: boolean) => {
        userInteractedKeysRef.current.add(sectionId);
        setExpandedMap((prev) => ({ ...prev, [sectionId]: nextExpanded }));
        setMessageProcessExpanded(sectionId, nextExpanded, sessionId);
        onInvalidateActual?.(msg.id);
      },
      [sessionId, msg.id, onInvalidateActual]
    );

    const handleExpandSection = useCallback(
      (sectionId: string) => {
        // 检索穿透（beforematch）属显式用户意图：钉住，避免被终态收敛再次收起
        userInteractedKeysRef.current.add(sectionId);
        setExpandedMap((prev) => ({ ...prev, [sectionId]: true }));
        setMessageProcessExpanded(sectionId, true, sessionId);
        onInvalidateActual?.(msg.id);
      },
      [sessionId, msg.id, onInvalidateActual]
    );

    // ── R9 组级窗口化挂载登记（单向闩：进入集合后永不回退占位） ──
    const mountedSectionsRef = useRef<{ msgId: string; ids: Set<string> }>({
      msgId: '',
      ids: new Set(),
    });
    if (mountedSectionsRef.current.msgId !== msg.id) {
      mountedSectionsRef.current = { msgId: msg.id, ids: new Set() };
    }
    const [, setMountVersion] = useState(0);
    const msgIdRef = useRef(msg.id);
    msgIdRef.current = msg.id;
    const onInvalidateActualRef = useRef(onInvalidateActual);
    onInvalidateActualRef.current = onInvalidateActual;
    const placeholderObserverRef = useRef<IntersectionObserver | null>(null);
    const placeholderElsRef = useRef(new Map<string, HTMLElement>());

    const ensurePlaceholderObserver =
      useCallback((): IntersectionObserver | null => {
        if (placeholderObserverRef.current)
          return placeholderObserverRef.current;
        if (typeof IntersectionObserver === 'undefined') return null;
        const obs = new IntersectionObserver(
          (entries) => {
            let mountedAny = false;
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const el = entry.target as HTMLElement;
              const sectionId = el.dataset.sectionId;
              obs.unobserve(el);
              if (sectionId && !mountedSectionsRef.current.ids.has(sectionId)) {
                mountedSectionsRef.current.ids.add(sectionId);
                mountedAny = true;
              }
            }
            if (mountedAny) {
              setMountVersion((v) => v + 1);
              // 真实挂载将改变行高，单轨通知宿主重测
              onInvalidateActualRef.current?.(msgIdRef.current);
            }
          },
          { rootMargin: `${SEGMENT_WINDOW_ROOT_MARGIN_PX}px 0px` }
        );
        placeholderObserverRef.current = obs;
        return obs;
      }, []);

    const registerPlaceholder = useCallback(
      (sectionId: string) => (el: HTMLElement | null) => {
        const prev = placeholderElsRef.current.get(sectionId);
        if (prev && prev !== el) {
          placeholderObserverRef.current?.unobserve(prev);
          placeholderElsRef.current.delete(sectionId);
        }
        if (el) {
          placeholderElsRef.current.set(sectionId, el);
          ensurePlaceholderObserver()?.observe(el);
        }
      },
      [ensurePlaceholderObserver]
    );

    useEffect(() => {
      return () => {
        placeholderObserverRef.current?.disconnect();
        placeholderObserverRef.current = null;
        placeholderElsRef.current.clear();
      };
    }, []);

    /**
     * 外部检索命中命令入口：bridge 侧要求展开时，同步至本消息全部过程段。
     *
     * 【关键修正】遍历权威分段（`segments`）而非既有字典键：
     * 若只遍历既有键，则用户从未交互过的分段无处落键，消息级展开形同虚设。
     * 同时必须「钉住」——检索穿透属显式用户意图，
     * 否则终态收敛会在下一帧把刚展开的段重新收起（幽灵展开）。
     */
    useEffect(() => {
      const unsub = subscribeMessageProcessExpansion(msg.id, (exp) => {
        if (!exp) return;
        let mountedAny = false;
        for (const seg of segments) {
          if (seg.kind !== 'process_section') continue;
          userInteractedKeysRef.current.add(seg.id);
          // R9：检索展开必须先全量真实挂载占位组体，否则展开无 DOM 可作用
          if (!mountedSectionsRef.current.ids.has(seg.id)) {
            mountedSectionsRef.current.ids.add(seg.id);
            mountedAny = true;
          }
        }
        if (mountedAny) {
          setMountVersion((v) => v + 1);
        }
        setExpandedMap((prev) => {
          let mutated = false;
          const next = { ...prev };
          for (const seg of segments) {
            if (seg.kind !== 'process_section') continue;
            if (next[seg.id] === true) continue;
            next[seg.id] = true;
            mutated = true;
          }
          return mutated ? next : prev;
        });
        onInvalidateActual?.(msg.id);
      });
      return unsub;
    }, [msg.id, segments, onInvalidateActual]);

    // 定位可承接流式打字的正文项（必须位于最后工具块之后）
    const streamingTextItem = useMemo(() => {
      let lastToolIdx = -1;
      for (let i = linearItems.length - 1; i >= 0; i--) {
        if (linearItems[i]!.kind === 'tools') {
          lastToolIdx = i;
          break;
        }
      }
      for (let i = linearItems.length - 1; i >= 0; i--) {
        if (linearItems[i]!.kind === 'text') {
          if (lastToolIdx === -1 || i > lastToolIdx) return linearItems[i]!;
          break;
        }
      }
      return null;
    }, [linearItems]);

    /**
     * 顶层常驻指示器的去重闸门（单一真理源 SSOT）。
     *
     * 当时间线内已有实体分段处于活跃执行态（如单思考行、工具控制栏、或正文流式中）时，
     * 运行态已由时间线原生节点权威呈现，顶层指示器必须绝对让位静默，杜绝双状态栏与双计时器噪音。
     */
    const hasLiveProcessIndicator =
      segments.some(
        (seg) =>
          (seg.kind === 'process_section' && seg.isLive) ||
          (seg.kind === 'text_narrative' && seg.isStreaming)
      ) ||
      streaming ||
      Boolean(displayMsg.thinkingTurns?.some((tt) => tt.isStreaming));

    /**
     * 过程组渲染项：由 `ProcessItemRenderer` 承载（唯一渲染路径）。
     *
     * R3 回调稳定化（渲染整改波 1）：流式正文项只出现在 text_narrative
     * 段并走下方内联路径（该路径自带 D7.2/FE-INV-6 的流式注入面收窄：
     * 仅活跃尾项注入 streamingTextContent，历史项恒 undefined）。
     * R9 后本回调会收到组内 text 条目（叙述行）：叙述行恒为已封口的
     * 静态文本（其后必有过程项），永不注入流式正文，故本回调对
     * streamText / streamingTextItem 仍无依赖——旧实现把它们列入依赖
     * 时对这些调用点恒为死值，却让回调每帧重建、击穿每个
     * FoldableProcessSection 的 React.memo。现只依赖回合级稳定量：
     * 流式期间引用恒定；hasFinalAnswer 取派生布尔（整个回合至多翻转
     * 一次），不再依赖每帧变化的正文串。
     */
    const hasFinalAnswerNow = Boolean(
      displayMsg.text?.trim() || streamText?.trim()
    );
    const renderProcessItem = useCallback(
      (item: AssistantTimelineItem, _index: number) => (
        <ProcessItemRenderer
          item={item}
          msgId={msg.id}
          status={msg.status}
          isThinkingMsg={isThinkingMsg}
          thoughtDefaultOpen={thoughtDefaultOpen}
          renderThought={renderThought}
          renderTools={renderTools}
          toolStackProps={toolStackProps}
          streamPhase={streamPhaseRef.current}
          hasFinalAnswer={hasFinalAnswerNow}
          isStreamingText={false}
          streamingTextContent={undefined}
          isNarration={item.kind === 'text'}
        />
      ),
      [
        msg.id,
        msg.status,
        isThinkingMsg,
        thoughtDefaultOpen,
        renderThought,
        renderTools,
        toolStackProps,
        hasFinalAnswerNow,
      ]
    );

    // ── 渲染分支（全部位于 Hooks 之后，绝不影响 Hook 序列） ──

    const fallbackText = stripThoughtPlaceholders(
      displayMsg.text || streamText || ''
    );
    const hasSegments = segments.length > 0;

    // 分支 α：无任何可渲染内容
    if (!hasSegments && !fallbackText.trim() && !streaming) {
      if (isInitialWaiting || isLiveTurn) {
        return (
          <div className={`${styles.contentText} ${className || ''}`}>
            <div
              className={styles.topProcessHeader}
              data-testid="top-live-header"
            >
              <WorkingStatusIndicator
                startTime={msg.timestamp}
                mode="initial"
              />
            </div>
            {inFlowRetry && <InFlowStatusLine retry={inFlowRetry} />}
          </div>
        );
      }
      return null;
    }

    // 分支 β：时间线为空但有降级正文（首 Token 到达前 / 纯错误态）
    if (!hasSegments) {
      return (
        <div className={`${styles.contentText} ${className || ''}`}>
          <StreamingMarkdownView
            text={fallbackText}
            isStreaming={streaming}
            priority={
              msg.status === 'processing' ? Priority.Normal : Priority.High
            }
            messageId={msg.id}
          />
          {inFlowRetry && <InFlowStatusLine retry={inFlowRetry} />}
          {interruptedMark}
        </div>
      );
    }

    // 分支 γ：正常交错分段渲染
    let textCursor = 0;
    return (
      <div className={`${styles.assistantTimelineStream} ${className || ''}`}>
        {/* 顶层常驻态（生成中）：时间线内已有任何活跃过程节点时让位，杜绝双状态栏 */}
        {isLiveTurn && !hasLiveProcessIndicator && (
          <div
            className={styles.topProcessHeader}
            data-testid="top-live-header"
          >
            <WorkingStatusIndicator startTime={msg.timestamp} mode="initial" />
          </div>
        )}

        {segments.map((seg, segIndex) => {
          // 系统状态通知段（上下文压缩 / 模型切换 / 思考强度切换 / 权限切换）：
          // 走居中发丝通知通道，常驻平铺，绝不参与过程折叠。
          // 渲染路径与过程子项同构，统一由 ProcessItemRenderer 承载（单一出口）。
          if (seg.kind === 'state_notice') {
            return (
              <React.Fragment key={seg.id}>
                {renderProcessItem(seg.item, 0)}
              </React.Fragment>
            );
          }

          if (seg.kind === 'text_narrative') {
            const item = seg.item;
            const isThisStreaming = Boolean(
              streaming && item === streamingTextItem
            );
            textCursor += 1;
            // 仅活跃流式项注入；历史项 undefined（引用稳定，FE-INV-6）。
            // offset 语义与原版一致：textCursor>1 时才应用 streamTextOffset 切片。
            let narrativeContent: string | undefined;
            if (isThisStreaming) {
              if (
                textCursor > 1 &&
                msg.streamTextOffset &&
                msg.streamTextOffset > 0 &&
                streamText &&
                streamText.length >= msg.streamTextOffset
              ) {
                narrativeContent = streamText.slice(msg.streamTextOffset);
              } else {
                narrativeContent = streamText;
              }
            }
            return (
              <ProcessItemRenderer
                key={seg.id}
                item={item}
                msgId={msg.id}
                status={msg.status}
                isThinkingMsg={isThinkingMsg}
                thoughtDefaultOpen={thoughtDefaultOpen}
                renderThought={renderThought}
                renderTools={renderTools}
                toolStackProps={toolStackProps}
                streamPhase={streamPhaseRef.current}
                hasFinalAnswer={seg.isFinalAnswer}
                isStreamingText={isThisStreaming}
                streamingTextContent={narrativeContent}
              />
            );
          }

          // 过程组
          const isExpanded = expandedMap[seg.id] ?? seg.defaultExpanded;
          // R9 组级窗口化（二段式）：符合条件的历史封口组组头常驻、
          // 组体先以等高占位替代挂载，IntersectionObserver 在占位进入
          // 预热区时真实挂载组体（口径见文件头常量区）。
          const deferBody =
            windowPlan.heights.has(seg.id) &&
            !seg.isLive &&
            segIndex < segments.length - 1 &&
            !userInteractedKeysRef.current.has(seg.id) &&
            !mountedSectionsRef.current.ids.has(seg.id);
          return (
            <FoldableProcessSection
              key={seg.id}
              msgId={msg.id}
              sectionId={seg.id}
              items={seg.items}
              metrics={seg.metrics}
              startTime={seg.startTime}
              endTime={seg.endTime}
              showWorkTime={seg.showWorkTime}
              isLive={seg.isLive}
              isExpanded={isExpanded}
              isFoldable={seg.foldable}
              deferredBodyHeight={
                deferBody ? (windowPlan.heights.get(seg.id) ?? 48) : undefined
              }
              bodyPlaceholderRef={
                deferBody ? registerPlaceholder(seg.id) : undefined
              }
              onToggle={handleToggleSection}
              onExpand={handleExpandSection}
              renderItem={renderProcessItem}
              onInvalidateActual={onInvalidateActual}
            />
          );
        })}

        {streaming && !streamingTextItem && streamText && (
          <div className={styles.contentText}>
            <StreamingMarkdownView
              text={stripThoughtPlaceholders(
                msg.streamTextOffset &&
                  msg.streamTextOffset > 0 &&
                  streamText.length >= msg.streamTextOffset
                  ? streamText.slice(msg.streamTextOffset)
                  : streamText
              )}
              isStreaming={true}
              priority={Priority.Normal}
              messageId={msg.id}
            />
          </div>
        )}

        {inFlowRetry && <InFlowStatusLine retry={inFlowRetry} />}
        {interruptedMark}
      </div>
    );
  }
);

MessageContent.displayName = 'MessageContent';
