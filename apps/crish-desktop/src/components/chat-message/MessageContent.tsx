import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useNarrativeRenderSlots } from './narrativeRenderSlots';
import styles from './MessageContent.module.css';
import type { SessionMessage } from '../../store/types';
import type { ChatToolStackSharedProps } from '../chat-tool-call/ChatToolCallBlock';
import {
  buildAssistantTimelineCached,
  partitionTimelineSegments,
  type AssistantTimelineItem,
  type TimelineSegment,
} from '../../api/toolPresentation';
import { stripThoughtPlaceholders } from '../../api/markdownRenderLite';
import { Priority } from '../../workers';
import { StreamingMarkdownView } from '../chat-message-row/StreamingMarkdownView';
import {
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
import { useSessionRuntimeStatusStore } from '../../store/sessionRuntimeStatusStore';
import { useSessionStore } from '../../store/sessionStore';

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
 * 单段折叠展开态字典：`sectionId → boolean`。
 *
 * 收敛说明：历史实现使用「整条消息一个布尔」的 `searchExpandBridge`，
 * 无法表达「同一消息内多过程段各自独立展开」。此处以 section 粒度收敛，
 * 并保留 bridge 作为外部（检索命中）命令入口。
 */
type SectionExpandedMap = Record<string, boolean>;

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
    const runtimeStatus = useSessionRuntimeStatusStore(
      useCallback((s) => s.statusBySession[sessionId], [sessionId])
    );

    const isLiveTurn = Boolean(msg.status === 'processing' || isThinkingMsg);

    const hasThoughtContent = Boolean(
      (displayMsg.thinking && displayMsg.thinking.trim()) ||
      (displayMsg.thinkingTurns && displayMsg.thinkingTurns.some((tt) => tt.content?.trim() || tt.isStreaming))
    );

    const hasTextContent = Boolean(
      displayMsg.text?.trim() ||
      streamText?.trim()
    );

    const hasToolContent = Boolean(
      displayMsg.toolCalls && displayMsg.toolCalls.length > 0
    );

    const isInitialWaiting = Boolean(
      isLiveTurn &&
      !hasThoughtContent &&
      !hasTextContent &&
      !hasToolContent
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
        <div className={styles.interruptedMark} data-testid="turn-interrupted-mark">
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
      timelineCacheRef.current = {
        msgId: msg.id,
        sig: r.sig,
        timeline: r.timeline,
      };
      timeline = r.timeline;
    } catch (err) {
      // 静默清空 timeline = 整条助手消息内容消失（最忌讳级）。必须可观测。
      logInternalError('message-content-timeline-build', err, { severity: 'warning' });
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

    // 单轨交错线性时间线：去重连续的上下文状态提示，严格保持原生时序
    const linearItems = useMemo(() => {
      const deduped: AssistantTimelineItem[] = [];
      let lastStateText = '';
      for (const item of timeline) {
        if (
          item.kind === 'injection' &&
          isContextStateInjection(item.injection)
        ) {
          const currentText = formatContextStateDisplayText(item.injection);
          if (currentText === lastStateText) {
            continue;
          }
          lastStateText = currentText;
        } else {
          lastStateText = '';
        }
        deduped.push(item);
      }
      return deduped;
    }, [timeline]);

    // ── 分段唯一权威：`partitionTimelineSegments`（四铁律裁决） ──
    const hasStreamText = Boolean(streamText != null && streamText.length > 0);
    const segments: TimelineSegment[] = useMemo(
      () =>
        partitionTimelineSegments(msg.id, linearItems, isLiveTurn, hasStreamText, {
          msgTimestamp: msg.timestamp,
          totalTurnDurationSec: msg.thinkingTime,
        }),
      [msg.id, linearItems, isLiveTurn, hasStreamText, msg.timestamp, msg.thinkingTime]
    );

    // ── 分段展开态字典（受控） ──
    const [expandedMap, setExpandedMap] = useState<SectionExpandedMap>({});

    /**
     * 用户手动裁决过的分段 ID 集合。
     *
     * 【存在意义】分段权威态（`defaultExpanded`）随流式推进而演化：
     *   铁律二（尾部活跃）→ true；正文总结抵达后 → 铁律一（hasNextText）→ false。
     * 若宿主无条件跟随权威态，用户手动展开的操作会在下一次权威态变化时
     * 被无声冲掉。故显式用户交互即「钉住」该段，权威态收敛对其让位。
     * 【铁律四】forceExpanded 段不受钉住影响——子代理可见性特权恒最高。
     */
    const userInteractedKeysRef = useRef<Set<string>>(new Set());

    /**
     * 分段展开态对齐：
     * 2026-09-19 用户裁决：「不要弄这个折叠了，就去掉这个工作完成后的整体内容折叠了。顺序做不对，弄这种折叠没有意义。」
     * 过程段默认全部展开平铺直出，绝不在生成结束后强制折叠为单行遮掩真实过程。
     */
    useEffect(() => {
      const patch: SectionExpandedMap = {};
      let mutated = false;

      for (const seg of segments) {
        if (seg.kind !== 'process_section') continue;
        // ① 用户手动裁决优先：钉住的段不参与自动收敛
        if (userInteractedKeysRef.current.has(seg.id)) continue;
        // ② 默认全展开平铺（2026-09-19 用户裁决）
        const target = seg.forceExpanded ? true : (seg.defaultExpanded ?? true);
        // ③ 首次出现（无键）或有键但与权威态不符 → 对齐
        if (
          Object.prototype.hasOwnProperty.call(expandedMap, seg.id) &&
          expandedMap[seg.id] === target
        ) {
          continue;
        }
        patch[seg.id] = target;
        mutated = true;
      }

      if (!mutated) return;
      setExpandedMap((prev) => ({ ...prev, ...patch }));
      // 高度变更必须经单轨通知宿主动态测高（VSM）
      onInvalidateActual?.(msg.id);
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
        for (const seg of segments) {
          if (seg.kind !== 'process_section') continue;
          userInteractedKeysRef.current.add(seg.id);
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
     * 流式注入面收窄（D7.2 / FE-INV-6）：
     * 仅当本项是活跃流式尾块且确实处于流式时才注入 streamingTextContent；
     * 历史卡 / 非活跃项恒为 undefined——保证引用稳定，不被 streamText 每帧新建字符串击穿 memo。
     */
    const activeStreamSlice = useMemo(() => {
      if (!streaming || !streamText) return undefined;
      if (
        msg.streamTextOffset &&
        msg.streamTextOffset > 0 &&
        streamText.length >= msg.streamTextOffset
      ) {
        return streamText.slice(msg.streamTextOffset);
      }
      return streamText;
    }, [streaming, streamText, msg.streamTextOffset]);

    // 分段渲染项：由 `ProcessItemRenderer` 承载（唯一渲染路径）
    const renderSegmentItem = useCallback(
      (item: AssistantTimelineItem, _index: number) => {
        const isThisStreaming = Boolean(streaming && item === streamingTextItem);
        return (
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
            hasFinalAnswer={Boolean(displayMsg.text?.trim() || streamText?.trim())}
            isStreamingText={isThisStreaming}
            streamingTextContent={isThisStreaming ? activeStreamSlice : undefined}
          />
        );
      },
      [
        msg.id,
        msg.status,
        isThinkingMsg,
        thoughtDefaultOpen,
        renderThought,
        renderTools,
        toolStackProps,
        displayMsg.text,
        streamText,
        streaming,
        streamingTextItem,
        activeStreamSlice,
      ]
    );

    // ── 渲染分支（全部位于 Hooks 之后，绝不影响 Hook 序列） ──

    const fallbackText = stripThoughtPlaceholders(displayMsg.text || streamText || '');
    const hasSegments = segments.length > 0;

    // 分支 α：无任何可渲染内容
    if (!hasSegments && !fallbackText.trim() && !streaming) {
      if (isInitialWaiting || isLiveTurn) {
        return (
          <div className={`${styles.contentText} ${className || ''}`}>
            <div className={styles.topProcessHeader} data-testid="top-live-header">
              <WorkingStatusIndicator startTime={msg.timestamp} mode="initial" />
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
            priority={msg.status === 'processing' ? Priority.Normal : Priority.High}
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
          <div className={styles.topProcessHeader} data-testid="top-live-header">
            <WorkingStatusIndicator startTime={msg.timestamp} mode="initial" />
          </div>
        )}

        {segments.map((seg) => {
          // 系统状态通知段（上下文压缩 / 模型切换 / 思考强度切换 / 权限切换）：
          // 走居中发丝通知通道，常驻平铺，绝不参与过程折叠。
          // 渲染路径与过程子项同构，统一由 ProcessItemRenderer 承载（单一出口）。
          if (seg.kind === 'state_notice') {
            return (
              <React.Fragment key={seg.id}>
                {renderSegmentItem(seg.item, 0)}
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

          // 过程段
          const isExpanded = expandedMap[seg.id] ?? seg.defaultExpanded;
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
              forceExpanded={seg.forceExpanded}
              onToggle={handleToggleSection}
              onExpand={handleExpandSection}
              renderItem={renderSegmentItem}
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
