import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageToolCall } from '../../store/types';
import { buildTickerItems, type TickerItem } from './headerTickerUtils';

export interface UseHeaderTickerOptions {
  groupTitle?: string;
  tools: readonly MessageToolCall[];
  hasRunning: boolean;
  isSealed?: boolean;
  isExpanded: boolean;
  intervalMs?: number;
  /**
   * 运行时当前思考的最新行（用户裁决 2026-11-06 第 9 条）：思考与最新工具
   * 活动共用本 ticker 作为运行态唯一动态面。仅在未封口（live）时由宿主
   * 注入；封口后宿主传 null，且本钩子以 isLive 门禁兜底，思考项不入列。
   */
  thoughtLine?: string | null;
  /**
   * 宿主显式 live 判定（可选）：组级 isSealed 缺失（undefined）时，宿主以
   * 段级 live 信号回退判定后传入。未传时沿用 isSealed === false 派生。
   */
  isLive?: boolean;
}

export function useHeaderTicker({
  groupTitle = '',
  tools,
  hasRunning,
  isSealed,
  isExpanded,
  intervalMs = 3500,
  thoughtLine,
  isLive: isLiveOverride,
}: UseHeaderTickerOptions) {
  // 轮播只许发生在 AI 运行中（用户裁决 2026-11-05）：摘要行滚动仅在运行时
  // 按调用内容显示，运行结束后必须静止。
  const isLive =
    isLiveOverride !== undefined ? isLiveOverride : isSealed === false;

  const items = useMemo<TickerItem[]>(() => {
    const base = buildTickerItems(groupTitle, tools);
    const thought = (thoughtLine || '').trim();
    if (!isLive || !thought) return base;
    // 思考项恒居首位（索引 0）：思考阶段的当前活动即此行。封口瞬间
    // thought 随 isLive 转 false 出列，索引 0 自动回到组标题（收敛无涉）。
    return [
      {
        id: 'live-thought',
        text: thought,
        kind: 'thought' as const,
        status: 'running' as const,
      },
      ...base,
    ];
  }, [groupTitle, tools, thoughtLine, isLive]);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const isReducedMotion = useRef(
    typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ).current;

  // 1. 运行态：单向锁定最新正在执行工具意图，不轮播。
  //    必须以 isLive 为门禁：组项先封口、同块其余工具仍在跑时（isLive 已
  //    转假而 hasRunning 仍真），锁定不得再触发——否则索引会被 items
  //    变化反复锁回运行工具，封口收敛（2a）再无机会执行（实机实证）。
  useEffect(() => {
    if (!hasRunning || !isLive) return;
    let runIdx = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.status === 'running') {
        runIdx = i;
        break;
      }
    }
    setCurrentIndex(runIdx >= 0 ? runIdx : Math.max(0, items.length - 1));
  }, [hasRunning, items, isLive]);

  // 2a. 收敛：展开态或运行结束（封口）后，索引回到组标题（0）定格静止。
  //     hasRunning 纳入依赖：运行落定的一刻（true→false）即使 isLive
  //     早已转假，也要再收敛一次，兜住任何残留的运行索引。
  useEffect(() => {
    if (isExpanded || !isLive) setCurrentIndex(0);
  }, [isExpanded, isLive, hasRunning]);

  // 2c. 思考跟随（2026-11-06 第 9 条）：思考行更新且当前无工具在跑时，
  //     动态面切到思考项（索引 0）——思考阶段的「当前活动」即思考本身；
  //     工具开跑后由效应 1 锁定最新工具，思考间隙由轮播（2b）轮替呈现。
  const prevThoughtRef = useRef<string | null>(null);
  useEffect(() => {
    const current = (thoughtLine || '').trim() || null;
    const changed = current !== prevThoughtRef.current;
    prevThoughtRef.current = current;
    if (!changed || !current) return;
    if (!isLive || isExpanded || hasRunning) return;
    setCurrentIndex(0);
  }, [thoughtLine, isLive, isExpanded, hasRunning]);

  // 2b. 运行时轮播：仅未封口（本轮仍在进行）、当前无工具在跑的间隙、折叠态才启动；
  //     hover 暂停或 prefers-reduced-motion 时不轮播
  useEffect(() => {
    if (isExpanded || !isLive || hasRunning) return;
    if (items.length <= 1 || isPaused || isReducedMotion) return;
    const timer = setInterval(
      () => setCurrentIndex((p) => (p + 1) % items.length),
      intervalMs
    );
    return () => clearInterval(timer);
  }, [
    isExpanded,
    isLive,
    hasRunning,
    items.length,
    isPaused,
    isReducedMotion,
    intervalMs,
  ]);

  return {
    items,
    currentIndex,
    currentText: items[currentIndex]?.text || groupTitle,
    pause: () => setIsPaused(true),
    resume: () => setIsPaused(false),
    transformStyle: { transform: `translateY(-${currentIndex * 24}px)` },
  };
}
