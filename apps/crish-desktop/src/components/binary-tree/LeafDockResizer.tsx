/**
 * 叶内坞 resizer（LeafDockResizer.tsx）— 分割线统一波次 R4 迁移后形态
 *
 * 不是 TreeResizeSash，不改会话树拓扑：拖中写 CSS 变量，松手才提交比例。
 *
 * 架构分工（统一 hook 与叶坞域能力的边界，与 R3 DockResizeSash 同构）：
 * 1. 手势协议由统一 hook `useSplitResize` 托管：指针捕获、window 级 move/up、
 *    rAF 节流、Esc 取消、blur / pointercancel 按提交当前值兜底、单一 body
 *    协议（data-split-resizing + 光标锁）。本组件不再自滚手势监听；hook 以
 *    axisSign=-1 作指针增量信道（指针左移 = 坞变宽），增量与坐标原点无关，
 *    域钳制全部在本组件换算。
 * 2. 叶坞域能力全部保留为调用方专有层，不进统一 hook：
 *    - px 域钳制 [200, 叶体宽 × 0.7] 与提交比例钳制 [0.2, 0.75]（与
 *      TreeLeafPanel 写 --leaf-dock-width 的口径同源）；
 *    - 拖拽期 --leaf-dock-width 直写叶体元素（零 React 状态、零 store 写入）；
 *    - 全局副作用三件：叶体 `is-dragging` 类、body 的 `is-resizing` +
 *      `leaf-dock-resizing` 类（shell-reset.css 的 iframe 封锁与全局光标契约）、
 *      iframe 指针屏蔽（disableIframePointerEvents）。
 * 3. 结束提交契约：原实现在 pointerup / pointercancel 时恒提交一次当前比例
 *    （含松手未移动）；统一 hook 在「钳制值未变化」时不触发 onCommit，故由
 *    onDragStateChange 兜底补提交（Esc 取消除外——Esc 经捕获期监听标记，
 *    取消不提交、几何由 hook 的恢复回调还原起始宽）。
 * 4. 键盘走 hook 基线（方向键 10px / Shift 50px / Home / End 立即提交），
 *    提交在无拖拽会话时按 px 标尺换算比例；aria 百分比域（20 / 75 / 当前
 *    比例）在 separatorProps 之上覆写。aria-label 沿用原文案：其 i18n 化需
 *    同步修订 check:i18n 硬编码基线，登记为后续项，本批不动基线文件。
 * 5. 呈现全部在 BinaryTreeWorkspace.module.css：静止线归抽屉 border-left
 *    （--border-subtle），hover / 拖拽高亮线与之重合走 --border-color
 *    中性灰，无辉光（用户 2026-11-02 裁决：全站中性灰）；本批不改 CSS。
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import styles from './BinaryTreeWorkspace.module.css';
import { disableIframePointerEvents } from '../../utils/dragOverlay';
import { useSplitResize } from '../ui/SplitResizer';
import { ElasticSplitHandle } from '../ui/SplitResizer';

/** 坞宽下限（px），与 TreeLeafPanel 的 --leaf-dock-width 钳制同源 */
export const MIN_LEAF_DOCK_WIDTH_PX = 200;
/** 坞宽上限（占叶体宽比例），与 TreeLeafPanel 同源 */
export const MAX_LEAF_DOCK_WIDTH_RATIO = 0.7;
export const MIN_LEAF_DOCK_RATIO = 0.2;
export const MAX_LEAF_DOCK_RATIO = 0.75;

/**
 * 统一 hook 的 px 域宽界：叶坞域全部钳制由本组件承担，hook 侧 min/max
 * 仅需不截断任何真实指针行程（取远超屏幕行程的宽界），其 aria / Home /
 * End 语义均由本组件覆写或在提交换算时钳制，不受宽界影响。
 */
const HOOK_WIDE_BOUND = 100_000;

function clampDockRatio(ratio: number): number {
  return Math.min(MAX_LEAF_DOCK_RATIO, Math.max(MIN_LEAF_DOCK_RATIO, ratio));
}

function clampDockWidthPx(px: number, bodyWidth: number): number {
  return Math.max(
    MIN_LEAF_DOCK_WIDTH_PX,
    Math.min(bodyWidth * MAX_LEAF_DOCK_WIDTH_RATIO, px)
  );
}

/** 一次拖拽会话的叶坞域状态（手势本体在统一 hook 内，这里只存域侧账本） */
interface LeafDockDragSession {
  /** 手势开始时实测的叶体宽度（钳制与比例换算的基准） */
  bodyWidth: number;
  /** 手势开始时的坞宽 px（钳制后，增量叠加的原点） */
  startWidthPx: number;
  /** 最近一次实时换算出的比例（兜底提交用） */
  liveRatio: number;
  /** 本次手势是否已由 hook 的 onCommit 提交过 */
  commitSeen: boolean;
  /** 本次手势是否被 Esc 取消（捕获期监听标记，先于 hook 的结束回调） */
  escCancel: boolean;
}

/** hook 指针增量 → 钳制后坞宽 px：会话起始宽叠加增量后按域钳制 */
function dragWidthPx(
  px: number,
  dragStartPx: number,
  session: LeafDockDragSession
): number {
  return clampDockWidthPx(
    session.startWidthPx + (px - dragStartPx),
    session.bodyWidth
  );
}

export function LeafDockResizer({
  leafBodyRef,
  widthRatio,
  onCommitRatio,
}: {
  leafBodyRef: React.RefObject<HTMLDivElement | null>;
  widthRatio: number;
  onCommitRatio: (ratio: number) => void;
}) {
  const restoreIframesRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<LeafDockDragSession | null>(null);

  /**
   * hook 的 px 标尺：value = widthRatio × 实测叶体宽。增量信道与原点无关，
   * 标尺只需渲染期新鲜（布局后实测校正，与 R3 的 axisPx 同法）；jsdom 等
   * 零宽环境下保持回退标尺，会话建立时以同一标尺兜底实测值。
   */
  const [bodyPx, setBodyPx] = useState(1000);
  useLayoutEffect(() => {
    const w = leafBodyRef.current?.clientWidth ?? 0;
    if (w > 0) {
      setBodyPx((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    }
  });

  // 统一手势 hook（px 域仅作增量信道，域语义全部在本组件换算）
  const resize = useSplitResize({
    value: widthRatio * bodyPx,
    min: -HOOK_WIDE_BOUND,
    max: HOOK_WIDE_BOUND,
    orientation: 'vertical',
    axisSign: -1,
    commitMode: 'release',
    onLiveChange: (px) => {
      const session = sessionRef.current;
      const body = leafBodyRef.current;
      if (!session || !body) return;
      const widthPx = dragWidthPx(
        px,
        resizeRef.current.dragStartValueRef.current,
        session
      );
      session.liveRatio = clampDockRatio(widthPx / session.bodyWidth);
      body.style.setProperty('--leaf-dock-width', `${widthPx}px`);
    },
    onCommit: (px) => {
      const session = sessionRef.current;
      if (session) {
        // 拖拽提交：增量换算（与 onLiveChange 同源）
        session.commitSeen = true;
        const widthPx = dragWidthPx(
          px,
          resizeRef.current.dragStartValueRef.current,
          session
        );
        session.liveRatio = clampDockRatio(widthPx / session.bodyWidth);
        onCommitRatio(session.liveRatio);
        return;
      }
      // 键盘提交（无拖拽会话）：px 即标尺上的绝对坞宽，按域钳制换算
      const widthPx = clampDockWidthPx(px, bodyPx);
      onCommitRatio(clampDockRatio(widthPx / bodyPx));
    },
    onDragStateChange: (nowDragging) => {
      if (nowDragging) {
        // 手势开始：建立域会话（实测叶体、挂全局副作用）
        const body = leafBodyRef.current;
        if (!body) return;
        const bodyWidth = body.clientWidth > 0 ? body.clientWidth : bodyPx;
        const startWidthPx = clampDockWidthPx(
          widthRatio * bodyWidth,
          bodyWidth
        );
        sessionRef.current = {
          bodyWidth,
          startWidthPx,
          liveRatio: clampDockRatio(startWidthPx / bodyWidth),
          commitSeen: false,
          escCancel: false,
        };
        body.classList.add('is-dragging');
        document.body.classList.add('is-resizing', 'leaf-dock-resizing');
        restoreIframesRef.current = disableIframePointerEvents();
      } else {
        // 手势结束：回收全局副作用，随后按域契约兜底提交
        const session = sessionRef.current;
        sessionRef.current = null;
        leafBodyRef.current?.classList.remove('is-dragging');
        document.body.classList.remove('is-resizing', 'leaf-dock-resizing');
        if (restoreIframesRef.current) {
          restoreIframesRef.current();
          restoreIframesRef.current = null;
        }
        if (session && !session.commitSeen && !session.escCancel) {
          onCommitRatio(session.liveRatio);
        }
      }
    },
  });
  const resizeRef = useRef(resize);
  resizeRef.current = resize;
  const { dragging, separatorProps } = resize;

  // Esc 取消标记：捕获期监听先于 hook 的结束回调置位，供兜底提交判别
  useEffect(() => {
    if (!dragging) return;
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sessionRef.current) {
        sessionRef.current.escCancel = true;
      }
    };
    window.addEventListener('keydown', onKeyDownCapture, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, {
        capture: true,
      });
    };
  }, [dragging]);

  // 组件卸载时确保无残留全局状态（与迁移前口径一致）
  useEffect(() => {
    return () => {
      if (restoreIframesRef.current) {
        restoreIframesRef.current();
        restoreIframesRef.current = null;
      }
      document.body.classList.remove('is-resizing', 'leaf-dock-resizing');
    };
  }, []);

  return (
    <div
      {...separatorProps}
      className={styles.leafDockResizer}
      data-leaf-dock-resizer="true"
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={(e) => {
        // 沿用迁移前的传播契约：叶面激活走捕获期路径，冒泡不二次触发
        e.stopPropagation();
        separatorProps.onPointerDown(e);
      }}
      aria-label="拖拽调整右侧工具栏宽度"
      aria-valuemin={20}
      aria-valuemax={75}
      aria-valuenow={Math.round(widthRatio * 100)}
    >
      <ElasticSplitHandle orientation="vertical" isDragging={dragging} />
    </div>
  );
}
