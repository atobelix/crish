import React, { useMemo } from 'react';
import styles from './StreamingTableContainer.module.css';
import { usePinnedScroll, resolveMaxHeight } from '../../hooks/chat-stream/usePinnedScroll';

export interface StreamingTableContainerProps {
  /** 内部包裹的 table 或富文本 DOM */
  children: React.ReactNode;
  /** 局部视口最大高度限制 (如 480 或 "480px") */
  maxHeight?: number | string;
  /** 是否处于流式传输中 */
  isStreaming?: boolean;
  /** 自定义外层样式类 */
  className?: string;
}

/**
 * 流式表格局部滚动容器 (单一真相源)
 *
 * 核心设计：
 * 1. 物理锁定 fixed 布局：结合 @container 容器查询防抖；
 * 2. 严格渲染隔离：滚动视口启用 contain: layout paint 与 content-visibility: auto；
 * 3. 8px 容差局部双向吸底：无缝集成 usePinnedScroll 与 wheel/touch capture 物理输入拦截；
 * 4. 吸顶表头与平滑横向滚动：原生 table-layout 兼顾轻量与高性能；
 * 5. 挂载 data-table-streaming 契约属性驱动品牌翡翠绿呼吸脉冲。
 */
export const StreamingTableContainer: React.FC<StreamingTableContainerProps> = ({
  children,
  maxHeight = 480,
  isStreaming = false,
  className,
}) => {
  const resolvedMaxHeight = useMemo(() => resolveMaxHeight(maxHeight), [maxHeight]);
  const hasMaxHeight = Boolean(resolvedMaxHeight);

  // 挂载局部双向吸底 Hook
  const scrollViewportRef = usePinnedScroll({
    isActive: isStreaming,
    enabled: hasMaxHeight,
    contentKey: children,
  });

  return (
    <div
      className={`${styles.tableContainerRoot} ${className || ''}`.trim()}
      data-table-streaming={isStreaming ? 'true' : 'false'}
    >
      <div
        ref={scrollViewportRef}
        className={styles.tableScrollViewport}
        style={resolvedMaxHeight ? { maxHeight: resolvedMaxHeight } : undefined}
      >
        {children}
      </div>
    </div>
  );
};

StreamingTableContainer.displayName = 'StreamingTableContainer';
