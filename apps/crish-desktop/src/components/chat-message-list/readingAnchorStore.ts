/**
 * apps/crish-desktop/src/components/chat-message-list/readingAnchorStore.ts
 *
 * 阅读锚点持久化（批 B ⑱）：按会话保存阅读位置，重开会话 / 分栏宽度变化后恢复。
 *
 * 口径：
 * - 锚点模型复用既有 PagingAnchor（key = 消息 id，top = 锚点行相对容器内顶偏移），
 *   不另造一套；存取经 computePagingAnchor / restorePagingAnchor 双径引擎。
 * - 记录形态 { anchor, following, updatedAt }：following = 保存时是否处于跟随态。
 *   恢复只在「有保存记录且 following === false」时生效（resolveRestoreAnchor）；
 *   跟随态打开仍直达真底（R12 口径不回退）。
 * - 写入节流：滚动事件 trailing 200ms 捕获一次，且与上次落盘记录等值时跳过
 *   （key 相同、|Δtop| < 1px、following 相同）。scroll 提交本身保持同步，
 *   本模块只读位置、从不写 scrollTop（恢复写回由宿主在 layout 阶段同步完成）。
 * - 存储不可用（隐私模式 / 配额）时静默降级为不持久化，绝不抛错打断会话。
 */

import { useEffect, useRef } from 'react';
import type React from 'react';
import { safeGetItem, safeSetItem } from '../../api/localStorageApi';
import { READING_ANCHOR_PREFIX } from '../../utils/storageKeys';
import { computePagingAnchor, type PagingAnchor } from './PagingAnchor';
import type { VirtualScrollManager } from '../../api/VirtualScrollManager';

/** 按会话保存的阅读锚点记录 */
export interface SavedReadingAnchor {
  anchor: PagingAnchor;
  /** 保存时是否处于跟随（贴底）态；跟随态记录不参与恢复 */
  following: boolean;
  /** 落盘时刻（epoch ms，诊断用） */
  updatedAt: number;
}

/** 滚动捕获节流窗口（ms）：trailing 捕获，滚动停下后最多再等一个窗口落盘 */
export const READING_ANCHOR_CAPTURE_THROTTLE_MS = 200;

function storageKey(sessionId: string): string {
  return `${READING_ANCHOR_PREFIX}${sessionId}`;
}

function isValidSavedReadingAnchor(
  value: unknown
): value is SavedReadingAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const anchor = record.anchor as Record<string, unknown> | null;
  return (
    typeof anchor === 'object' &&
    anchor !== null &&
    typeof anchor.key === 'string' &&
    anchor.key.length > 0 &&
    typeof anchor.top === 'number' &&
    Number.isFinite(anchor.top) &&
    typeof record.following === 'boolean'
  );
}

/** 读取某会话的保存锚点；无记录 / 损坏 / 存储不可用一律返回 null */
export function readReadingAnchor(
  sessionId: string | null | undefined
): SavedReadingAnchor | null {
  if (!sessionId) return null;
  const raw = safeGetItem(storageKey(sessionId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidSavedReadingAnchor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 写入某会话的阅读锚点；存储不可用时静默跳过 */
export function writeReadingAnchor(
  sessionId: string,
  record: SavedReadingAnchor
): void {
  // 经 api/localStorageApi 统一通道落盘（其内部已吞存储异常：
  // 持久化是增强项，失败不打断会话，内存态仍可经捕获 hook 的账本去重）
  safeSetItem(storageKey(sessionId), JSON.stringify(record));
}

/**
 * 恢复裁决（纯函数）：仅当存在保存记录且保存时非跟随态才返回待恢复锚点。
 * 跟随态 / 无记录 → null，调用方按既有口径直达真底。
 */
export function resolveRestoreAnchor(
  saved: SavedReadingAnchor | null
): PagingAnchor | null {
  if (!saved || saved.following) return null;
  return saved.anchor;
}

/**
 * 锚点落点数学口径（与 restorePagingAnchor 路径 B 同式）：锚点 key 仍在
 * order 内时返回目标 scrollTop（前缀和 − 锚点相对偏移，下限 0）；
 * 无锚点 / key 已不在 order 内 → null（调用方回落吸底）。
 */
export function resolveAnchorTargetScrollTop(
  vsm: VirtualScrollManager,
  anchor: PagingAnchor | null
): number | null {
  if (!anchor) return null;
  const idx = vsm.getOrder().indexOf(anchor.key);
  if (idx === -1) return null;
  return Math.max(0, vsm.getOffset(idx) - anchor.top);
}

/** 两条记录是否等值（去重口径：key 同、following 同、top 亚像素级一致） */
export function isSameReadingAnchor(
  a: SavedReadingAnchor | null,
  b: SavedReadingAnchor | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.anchor.key === b.anchor.key &&
    a.following === b.following &&
    Math.abs(a.anchor.top - b.anchor.top) < 1
  );
}

export interface ReadingAnchorCaptureHandle {
  /**
   * 立即为指定会话捕获并落盘（宿主在渲染期检测到会话切换时调用：
   * 此刻 DOM 仍是旧会话几何，layout 阶段的切会话重置尚未改写滚动位置）。
   */
  flushForSession: (sessionId: string | null) => void;
}

export interface UseReadingAnchorCaptureParams {
  containerRef: React.RefObject<HTMLElement | null>;
  manager: VirtualScrollManager;
  activeSessionId: string | null;
  isAtBottomRef: React.RefObject<boolean>;
  /** 几何未稳窗口（切会话测高遍数未走完）为真时不捕获，避免把过渡位置落盘 */
  isGeometrySettled: () => boolean;
  /** 锚点恢复待决窗口为真时不捕获（当前所见即恢复目标本身，无需回写） */
  isRestorePending: () => boolean;
}

/**
 * 阅读锚点捕获：原生 scroll 监听 + trailing 节流 + 等值去重。
 * 捕获只读 computePagingAnchor（DOM 探针 / VSM 数学双径），不写任何滚动位置。
 */
export function useReadingAnchorCapture(
  params: UseReadingAnchorCaptureParams
): ReadingAnchorCaptureHandle {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const lastSavedRef = useRef<SavedReadingAnchor | null>(null);
  const baselineSessionRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRef = useRef<ReadingAnchorCaptureHandle | null>(null);

  if (!handleRef.current) {
    const handle: ReadingAnchorCaptureHandle = {
      flushForSession: (sessionId: string | null) => {
        if (!sessionId) return;
        const p = paramsRef.current;
        const container = p.containerRef.current;
        if (!container) return;
        if (!p.isGeometrySettled() || p.isRestorePending()) return;
        const anchor = computePagingAnchor(container, p.manager);
        if (!anchor) return;
        const record: SavedReadingAnchor = {
          anchor,
          following: p.isAtBottomRef.current === true,
          updatedAt: Date.now(),
        };
        if (isSameReadingAnchor(lastSavedRef.current, record)) return;
        lastSavedRef.current = record;
        writeReadingAnchor(sessionId, record);
      },
    };
    handleRef.current = handle;
  }

  // 会话基线：进入新会话时以其已存记录作去重基线，避免无位移也重写
  useEffect(() => {
    baselineSessionRef.current = params.activeSessionId;
    lastSavedRef.current = readReadingAnchor(params.activeSessionId);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [params.activeSessionId]);

  useEffect(() => {
    const container = params.containerRef.current;
    if (!container) return;

    const capture = () => {
      const p = paramsRef.current;
      const sessionId = p.activeSessionId;
      if (!sessionId || baselineSessionRef.current !== sessionId) return;
      handleRef.current?.flushForSession(sessionId);
    };

    const onScroll = () => {
      if (timerRef.current !== null) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        capture();
      }, READING_ANCHOR_CAPTURE_THROTTLE_MS);
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // 卸载收口：为当前会话补一次最终捕获（无新会话接管，几何仍属本会话）
      const sessionId = paramsRef.current.activeSessionId;
      if (sessionId && baselineSessionRef.current === sessionId) {
        handleRef.current?.flushForSession(sessionId);
      }
    };
    // containerRef 身份稳定（useVirtualScroll 单例），仅挂载期接线一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return handleRef.current as ReadingAnchorCaptureHandle;
}
