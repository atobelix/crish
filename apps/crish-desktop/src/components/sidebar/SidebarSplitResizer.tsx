/**
 * apps/crish-desktop/src/components/sidebar/SidebarSplitResizer.tsx
 *
 * 侧栏分界线拖拽组件（挂载于 .sidebar-wrapper 与 .workspaces-column 之间）。
 *
 * 架构优势：
 * 1. 独立于侧栏内部 DOM 与 overflow:hidden 容器，SVG 胶囊手柄（120px）完整居中展示，
 *    彻底消除单侧被裁切只有一半的问题；
 * 2. live 变量 --sidebar-width 直接写在 .sidebar-wrapper 容器上（或根目标），
 *    拖拽期使侧栏与右侧工作区每帧无缝物理联动，彻底消除左右脱节空白；
 * 3. 宽度尺寸去阻尼即刻跟手（1:1 响应），手柄弯曲/粗细/呼吸渐变动效平滑保留。
 */

import React, { type CSSProperties, type MutableRefObject } from 'react';
import { useI18n } from '../../i18n';
import { SplitResizer } from '../ui/SplitResizer';
import {
  SIDEBAR_COLLAPSE_PX,
  SIDEBAR_RESIZER_HIT_PX,
  SIDEBAR_RESIZE_STEP,
  SIDEBAR_RESIZE_STEP_LARGE,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from './sidebarHelpers';
import { useSidebarResize } from './useSidebarResize';

export interface SidebarSplitResizerProps {
  /** 写入 live 变量的目标（通常为 .sidebar-wrapper 容器） */
  targetRef?: MutableRefObject<HTMLElement | null>;
  style?: CSSProperties;
}

export const SidebarSplitResizer: React.FC<SidebarSplitResizerProps> =
  React.memo(function SidebarSplitResizer({ targetRef, style }) {
    const { t } = useI18n();
    const {
      sidebarWidthPx,
      applySidebarWidth,
      handleResizerDragStateChange,
      handleResizerRest,
      handleResizerLiveChange,
    } = useSidebarResize();

    return (
      <SplitResizer
        id="sidebar-resizer"
        value={sidebarWidthPx}
        min={SIDEBAR_WIDTH_MIN}
        max={SIDEBAR_WIDTH_MAX}
        step={SIDEBAR_RESIZE_STEP}
        largeStep={SIDEBAR_RESIZE_STEP_LARGE}
        hitArea={SIDEBAR_RESIZER_HIT_PX}
        collapseBelow={SIDEBAR_COLLAPSE_PX}
        liveCollapse
        onCollapse={() =>
          applySidebarWidth(0, { collapse: true, persist: false })
        }
        defaultValue={SIDEBAR_WIDTH_DEFAULT}
        onCommit={applySidebarWidth}
        onLiveChange={handleResizerLiveChange}
        onDragStateChange={handleResizerDragStateChange}
        onRest={handleResizerRest}
        liveVarName="--sidebar-width"
        liveVarTargetRef={targetRef}
        aria-label={t('sidebar.resizeAriaLabel')}
        style={{
          marginLeft: -(SIDEBAR_RESIZER_HIT_PX / 2),
          marginRight: -(SIDEBAR_RESIZER_HIT_PX / 2),
          zIndex: 'var(--z-resizer, 110)',
          ...style,
        }}
      />
    );
  });

SidebarSplitResizer.displayName = 'SidebarSplitResizer';
