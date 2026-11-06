/**
 * useSessionListMotion.ts — 会话列表行级动效（S6，G 册 §1.3/1.4/1.5 + 审计 A 1-4/3-4）
 *
 * 覆盖：新行入场、删行退场、重排/置顶 FLIP、「查看全部」内层折叠（展开/收起即批量
 * 入场/退场，统一一次过渡）、置顶/取消置顶跨分区迁移（离开区退场 + 进入区入场）。
 *
 * 机制（与标签条标杆同构，G §2.1/2.2）：
 * - 入场：新行挂载即带 data-motion="enter"，CSS @starting-style 首帧 0 高 + 透明，
 *   过渡到自然态；高度过渡使下方行随布局平滑下移，无需 FLIP。
 * - 退场：行从源数组消失时，hook 以快照在原位多留一帧（S4 关闭快照同构），
 *   data-motion="leaving" 目标态 0 高 + 透明 + 负 margin 抵消 3px gap，
 *   200ms（退场主档 150ms + 50ms 余量，与 S4 useClosingFlag 同口径）后摘除。
 * - 重排/置顶：同组 id、顺序变化 → WAAPI FLIP（位移量 = 新旧 top 之差），
 *   120ms cubic-bezier(0.2, 0, 0, 1)——复用拖拽让位 sessionListDragShift 的同一手感常量。
 * - 抑制面（G §七反例 + 通道裁决）：搜索/过滤整表替换、拖拽期间、窗口化列表、
 *   混合大改（新增+删除同时大量发生，如切换工作区/整表重载）一律静默同步，不做逐行动效。
 * - 减动效：CSS 侧 token 归零（入场/退场直落）；WAAPI FLIP 经 isRevealDegraded 直落。
 *
 * 调用方：PinnedSection / GeneralSection（非窗口化路径）/ ProjectsSection（每项目一实例）。
 * 窗口化列表（general > 48 行）不启用——虚拟窗口与行级动效互斥（G §1.8 裁决沿用）。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionState } from '../../../store/types';
import { isRevealDegraded } from '../../chat-tool-call/toolRevealState';
import {
  DURATION_EXIT_MS,
  DURATION_NORMAL_MS,
  EXIT_SETTLE_BUFFER_MS,
} from '../../../utils/motionTokens';
import {
  SESSION_ROW_SHIFT_DURATION_MS,
  SESSION_ROW_SHIFT_EASING,
} from './sessionListDragShift';

export type SessionRowMotionKind = 'enter' | 'leaving' | 'steady';

export interface SessionRowMotion {
  kind: SessionRowMotionKind;
  /**
   * 该行下方是否还有同列表行：有则入场/退场以 margin-bottom: -3px 抵消
   * .folderSessions 的 3px gap，否则收尾时下方内容会多跳 3px。
   */
  gapAfter: boolean;
}

export interface SessionMotionRow {
  s: SessionState;
  motion: SessionRowMotion;
}

export interface UseSessionListMotionOptions {
  /** 列表 <ul>（GeneralSection 传入已有的 generalListRef；其余由 hook 自建并返回） */
  listRef?: React.RefObject<HTMLUListElement | null>;
  /** 搜索/过滤/拖拽期间禁用一切动效（静默同步，不留快照） */
  disabled?: boolean;
  /** 窗口化列表：虚拟窗口与行级动效互斥，直通 */
  windowed?: boolean;
}

/** steady 行共用同一对象：SessionRow 经 memo，motion 引用稳定才不无效化无关行 */
const STEADY_MOTION: SessionRowMotion = { kind: 'steady', gapAfter: false };
export const SESSION_ROW_LEAVE_MS =
  DURATION_EXIT_MS + EXIT_SETTLE_BUFFER_MS; // 200

/** 入场标记保留时长：入场主档 + 余量（@starting-style 只在挂载首帧生效，超时清标记） */
const SESSION_ROW_ENTER_MS = DURATION_NORMAL_MS + EXIT_SETTLE_BUFFER_MS; // 250

/**
 * 混合大改阈值：新增+删除同时发生且总数超过此值，视为整表替换（切换工作区/重载），
 * 静默同步。纯新增或纯删除（折叠展开/收起、单条增删、置顶迁移）任意数量均做动效——
 * 它们是单次用户手势的统一过渡。
 */
const MIXED_CHANGE_LIMIT = 12;

interface LeavingSnapshot {
  s: SessionState;
  /** 移除时紧随其后的行 id（快照按此锚点插回原位）；null 表示原末尾 */
  afterId: string | null;
  /** 移除时在旧 prev 顺序中的下标：同锚点桶内多快照按此排序 */
  prevIndex: number;
}

interface MotionState {
  prevIds: string[];
  prevById: Map<string, SessionState>;
  leaving: Map<string, LeavingSnapshot>;
  entering: Set<string>;
}

function idsOf(sessions: SessionState[]): string[] {
  return sessions.map((s) => s.id);
}

function diffIds(
  prev: string[],
  next: string[]
): { added: string[]; removed: string[] } {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((id) => !prevSet.has(id)),
    removed: prev.filter((id) => !nextSet.has(id)),
  };
}

/**
 * 读元素当前帧的 translateY（WAAPI/CSS 动画合成后的计算值）。
 * FLIP 在飞时 getBoundingClientRect 含动画位移，必须扣除才是布局真值——
 * 否则后续提交会把在飞位移误读成布局变化、反号重发动画（实机置顶轨迹实证）。
 */
function readTranslateY(el: HTMLElement): number {
  const t = window.getComputedStyle(el).transform;
  if (!t || t === 'none') return 0;
  const m = /^matrix(?:3d)?\(([^)]+)\)$/.exec(t.trim());
  if (!m) return 0;
  const nums = m[1]!.split(',').map((s) => parseFloat(s));
  const ty = t.startsWith('matrix3d') ? nums[13] : nums[5];
  return typeof ty === 'number' && Number.isFinite(ty) ? ty : 0;
}

function measureRowPositions(listEl: HTMLElement | null): {
  layoutTops: Map<string, number>;
  visualTops: Map<string, number>;
} {
  const layoutTops = new Map<string, number>();
  const visualTops = new Map<string, number>();
  if (!listEl) return { layoutTops, visualTops };
  const rows = listEl.querySelectorAll<HTMLElement>('li[data-session-id]');
  for (const row of rows) {
    const id = row.getAttribute('data-session-id');
    if (!id) continue;
    const top = row.getBoundingClientRect().top;
    visualTops.set(id, top);
    layoutTops.set(id, top - readTranslateY(row));
  }
  return { layoutTops, visualTops };
}

function escapeId(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id);
  }
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function useSessionListMotion(
  sessions: SessionState[],
  options?: UseSessionListMotionOptions
): {
  displaySessions: SessionMotionRow[];
  listRef: React.RefObject<HTMLUListElement | null>;
} {
  const { listRef: externalListRef, disabled = false, windowed = false } =
    options ?? {};
  const internalListRef = useRef<HTMLUListElement | null>(null);
  const listRef = externalListRef ?? internalListRef;

  const [motionState, setMotionState] = useState<MotionState>(() => ({
    prevIds: idsOf(sessions),
    prevById: new Map(sessions.map((s) => [s.id, s])),
    leaving: new Map(),
    entering: new Set(),
  }));

  /** 首挂载提交后为真；挂载当帧不同步做入场（与标签条 data-booted 门控同理） */
  const bootedRef = useRef(false);
  /** 上一提交是否处于非活跃态（搜索/拖拽/窗口化）：由非活跃切回时当次静默同步 */
  const prevInactiveRef = useRef(false);
  const prevTopsRef = useRef(new Map<string, number>());
  const flipAnimsRef = useRef(new WeakMap<Element, Animation>());

  useEffect(() => {
    bootedRef.current = true;
  }, []);

  useEffect(() => {
    prevInactiveRef.current = disabled || windowed;
  }, [disabled, windowed]);

  // 退场快照到期摘除（单一定时器覆盖整批；快照行高已为 0，超时滞留无视觉影响）
  useEffect(() => {
    if (motionState.leaving.size === 0) return;
    const timer = window.setTimeout(() => {
      setMotionState((prev) =>
        prev.leaving.size === 0 ? prev : { ...prev, leaving: new Map() }
      );
    }, SESSION_ROW_LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [motionState.leaving]);

  // 入场标记到期清除（@starting-style 只在挂载首帧生效，标记本身须及时回收）
  useEffect(() => {
    if (motionState.entering.size === 0) return;
    const timer = window.setTimeout(() => {
      setMotionState((prev) =>
        prev.entering.size === 0 ? prev : { ...prev, entering: new Set() }
      );
    }, SESSION_ROW_ENTER_MS);
    return () => window.clearTimeout(timer);
  }, [motionState.entering]);

  // 渲染期派生：源数组变化 → 同步 prev 并生成/清理退场快照与入场标记
  // （React 认可的渲染期 setState 模式：setState 后本轮渲染即被丢弃并以新 state 重渲染，
  // 故以下 display 计算在提交时恒以同步后的 state 为准；同步后 diff 为空，不会循环。）
  const currentIds = idsOf(sessions);
  const { added, removed } = diffIds(motionState.prevIds, currentIds);
  // 只在 id 集合变化时同步：会话对象引用变化（如新消息）不同步 prevById——
  // 快照只取用删除时刻的 prevById 对象，200ms 淡出里标题稍旧无视觉影响；
  // 若在此同步，每次消息更新都会多一次渲染期重渲染。
  if (!windowed && (added.length > 0 || removed.length > 0)) {
    const mixedWholesale =
      added.length > 0 &&
      removed.length > 0 &&
      added.length + removed.length > MIXED_CHANGE_LIMIT;
    const suppressMarks =
      disabled || prevInactiveRef.current || mixedWholesale;
    const nextById = new Map(sessions.map((s) => [s.id, s]));
    if (suppressMarks) {
      // 静默同步：更新 prev，丢弃一切快照与入场标记
      setMotionState({
        prevIds: currentIds,
        prevById: nextById,
        leaving: new Map(),
        entering: new Set(),
      });
    } else {
      const nextLeaving = new Map(motionState.leaving);
      for (const id of removed) {
        const s = motionState.prevById.get(id);
        if (!s || nextLeaving.has(id)) continue;
        const idx = motionState.prevIds.indexOf(id);
        nextLeaving.set(id, {
          s,
          afterId:
            idx >= 0 && idx + 1 < motionState.prevIds.length
              ? motionState.prevIds[idx + 1]!
              : null,
          prevIndex: idx,
        });
      }
      // 被重新加回的行：取消其快照（同一 id 又出现即视为存活）
      for (const id of added) nextLeaving.delete(id);
      const nextEntering = new Set<string>();
      // 入场只对已挂载过的非空列表生效：首挂载填充与空表首行不做入场（与标签条门控同理）
      if (bootedRef.current && motionState.prevIds.length > 0) {
        for (const id of added) nextEntering.add(id);
      }
      setMotionState({
        prevIds: currentIds,
        prevById: nextById,
        leaving: nextLeaving,
        entering: nextEntering,
      });
    }
  } else if (windowed && motionState.leaving.size > 0) {
    // 切入窗口化时丢弃残留快照（虚拟窗口内快照无处安放）
    setMotionState((prev) => ({ ...prev, leaving: new Map() }));
  }

  // 渲染输出：源行按序 + 退场快照按 afterId 锚点插回原位。
  // 锚点须沿快照链传递解析：连续删除时一行快照的 afterId 可能指向另一快照
  // （如折叠收起 24→10：被删 14 行互为锚点）；直用到存活行或 null 为止，
  // 否则链上除末尾外的快照永无插入点（实测收起后 li 计数 10+1=11 的回归）。
  const leavingById = new Map(motionState.leaving);
  const resolveAnchor = (snap: LeavingSnapshot): string | null => {
    let cur = snap.afterId;
    const seen = new Set<string>();
    while (cur !== null && leavingById.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = leavingById.get(cur)!.afterId;
    }
    return cur;
  };
  const leavingByAfter = new Map<string, LeavingSnapshot[]>();
  for (const snap of motionState.leaving.values()) {
    const key = resolveAnchor(snap) ?? '';
    const bucket = leavingByAfter.get(key);
    if (bucket) bucket.push(snap);
    else leavingByAfter.set(key, [snap]);
  }
  // 同锚点桶内按原位顺序排（跨批次快照的 prevIndex 分属不同 prev 数组，
  // 仅作桶内尽力排序；单批次折叠收起等主场景下精确）。
  for (const bucket of leavingByAfter.values()) {
    bucket.sort((a, b) => a.prevIndex - b.prevIndex);
  }
  const displaySessions: SessionMotionRow[] = [];
  const pushLeavingBefore = (afterId: string) => {
    for (const snap of leavingByAfter.get(afterId) ?? []) {
      displaySessions.push({
        s: snap.s,
        motion: { kind: 'leaving', gapAfter: true },
      });
    }
  };
  for (const s of sessions) {
    pushLeavingBefore(s.id);
    displaySessions.push({
      s,
      motion: motionState.entering.has(s.id)
        ? { kind: 'enter', gapAfter: false }
        : STEADY_MOTION,
    });
  }
  for (const snap of leavingByAfter.get('') ?? []) {
    displaySessions.push({
      s: snap.s,
      motion: { kind: 'leaving', gapAfter: false },
    });
  }
  // gapAfter：入场/退场行下方是否还有同列表行（决定是否以负 margin 抵消 3px gap）
  for (let i = 0; i < displaySessions.length; i++) {
    const row = displaySessions[i]!;
    if (row.motion.kind !== 'steady') {
      row.motion = { ...row.motion, gapAfter: i < displaySessions.length - 1 };
    }
  }

  // FLIP：同组 id 顺序变化时，位移行从当前视觉位置平滑滑到新布局位置。
  // 入场/退场行在场时跳过——其高度过渡已驱动下方行随布局移动，再叠 FLIP 会双重动画。
  // 搜索/拖拽/窗口化/减动效期间只清基线不量测（拖拽每帧重渲染，量测会制造滚动抖动）。
  // 量测一律用布局 top（已扣除在飞 FLIP 的 translateY）：后续提交（如流式刷新）
  // 不会把在飞位移误判为新的布局变化；重定向时起始帧取当前视觉 top，保证连续。
  useLayoutEffect(() => {
    const listEl = listRef.current;
    if (!listEl || windowed || disabled || isRevealDegraded()) {
      prevTopsRef.current = new Map();
      return;
    }
    const { layoutTops, visualTops } = measureRowPositions(listEl);
    const hasMotionRows = displaySessions.some(
      (d) => d.motion.kind !== 'steady'
    );
    if (!hasMotionRows && prevTopsRef.current.size > 0) {
      const moves: Array<{ el: HTMLElement; fromDelta: number }> = [];
      let firstDelta: number | null = null;
      let allSame = true;
      for (const [id, oldTop] of prevTopsRef.current) {
        const newTop = layoutTops.get(id);
        if (newTop === undefined) continue;
        const el = listEl.querySelector<HTMLElement>(
          `li[data-session-id="${escapeId(id)}"]`
        );
        if (!el) continue;
        // 拖拽残留内联 transform 的行让位给拖拽（拖拽收尾会自行复位）
        if (el.style.transform) continue;
        const delta = oldTop - newTop;
        if (Math.abs(delta) <= 1) continue;
        if (firstDelta === null) firstDelta = delta;
        else if (Math.abs(delta - firstDelta) > 1) allSame = false;
        // 起始帧位移：在飞动画的当前位移（rect − 布局 top）非零时取它——行此刻
        // 正显在 新布局+该位移 处，从此处起步才连续；无在飞位移时取布局位移量
        // （把行放回旧布局位置起步，即经典 FLIP 的 Invert 步）。
        const visualTop = visualTops.get(id);
        const tyNow = visualTop === undefined ? 0 : visualTop - newTop;
        moves.push({ el, fromDelta: tyNow !== 0 ? tyNow : delta });
      }
      // 全部行同量位移 = 容器整体移动（滚动/上方分区折叠），不是重排，不做 FLIP
      if (moves.length > 0 && !(moves.length > 1 && allSame)) {
        for (const { el, fromDelta } of moves) {
          flipAnimsRef.current.get(el)?.cancel();
          flipAnimsRef.current.delete(el);
          // 已视觉到位（重定向终点恰与当前视觉重合）：取消旧动画即定格，不必再发
          if (Math.abs(fromDelta) <= 1) continue;
          const anim = el.animate(
            [
              { transform: `translateY(${fromDelta}px)` },
              { transform: 'translateY(0px)' },
            ],
            {
              duration: SESSION_ROW_SHIFT_DURATION_MS,
              easing: SESSION_ROW_SHIFT_EASING,
            }
          );
          flipAnimsRef.current.set(el, anim);
        }
      }
    }
    prevTopsRef.current = layoutTops;
    // displaySessions 仅用于 hasMotionRows 判定；逐提交量测本身无 deps 依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  return { displaySessions, listRef };
}
