/**
 * PaneTabItem — 窗格会话标签项（纯展示 + 事件转发）。
 *
 * 几何/关闭等 orchestration 全部留在 PaneHeader，本组件只负责：
 * 形态 class、离场标记、无障碍属性、四类交互事件（点选 / 中键关闭 / 拖拽 / transitionend）。
 */

import React from 'react';
import { X } from 'lucide-react';
import type { LeafSessionTab } from './paneHeaderGeometry';
import styles from './PaneHeader.module.css';

export interface PaneTabItemProps {
  tab: LeafSessionTab;
  title: string;
  isSelected: boolean;
  isLeaving: boolean;
  onSelect: (tab: LeafSessionTab) => void;
  /** 左键点叉关闭（含中键语义路由） */
  onClose: (e: React.MouseEvent, tab: LeafSessionTab) => void;
  onDragStart: (e: React.PointerEvent, tab: LeafSessionTab) => void;
  /** 离场 transition 到位（flex-basis）后转发，由父级驱动摘除 */
  onLeaveTransitionEnd: (
    e: React.TransitionEvent<HTMLDivElement>,
    tab: LeafSessionTab
  ) => void;
}

export const PaneTabItem: React.FC<PaneTabItemProps> = React.memo(
  ({
    tab,
    title,
    isSelected,
    isLeaving,
    onSelect,
    onClose,
    onDragStart,
    onLeaveTransitionEnd,
  }) => {
    const wasActiveRef = React.useRef(isSelected);
    if (!isLeaving) {
      wasActiveRef.current = isSelected;
    }
    const wasActive = isLeaving && wasActiveRef.current;
    const showActiveStyle = isSelected || wasActive;

    return (
      <div
        className={`${styles.tabItem} ${showActiveStyle ? styles.tabItemActive : ''}`}
        data-leaving={isLeaving || undefined}
        data-was-active={wasActive || undefined}
        tabIndex={isSelected ? 0 : -1}
        onClick={() => onSelect(tab)}
        onMouseDown={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            onClose(e, tab);
          }
        }}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            onClose(e, tab);
          }
        }}
        onPointerDown={(e) => {
          if (e.button === 0) {
            e.stopPropagation();
            onDragStart(e, tab);
          }
        }}
          onTransitionEnd={(e) => {
          if (isLeaving) {
            onLeaveTransitionEnd(e, tab);
          }
        }}
          role="tab"
          aria-selected={isSelected}
          aria-label={title}
          data-tauri-drag-region="false"
          data-tab-id={tab.tabId}
        data-session-id={tab.sessionId || undefined}
      >
        <div className={styles.tabItemInner}>
          <span className={styles.tabTitle}>{title}</span>
          <button
            type="button"
            className={styles.tabCloseBtn}
            onClick={(e) => onClose(e, tab)}
            aria-label={`关闭 ${title}`}
          >
            <X size={10} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    );
  }
);

PaneTabItem.displayName = 'PaneTabItem';
