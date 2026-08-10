import React, { useLayoutEffect, useRef } from 'react';
import styles from './ChatMessageRow.module.css';

export interface StreamingTextBlockProps {
  /** 本帧新增文本（可为 ''）；append 语义必须单调累积 */
  delta: string;
}

/**
 * 流式文本块（T1.3，08-detail 2.4）：ref 桥接 appendText 增量写 DOM。
 *
 * 为什么存在：
 * - React 对 `{text}` 单文本子节点的更新是整节点 `textContent` 替换（O(全文)）；
 * - 本组件 children 恒为空 → React 从不协调文本子节点；DOM 文本由
 *   `useLayoutEffect` 在提交后、paint 前直写（O(增量) appendChild）；
 * - 桌面 SPA 无 SSR/hydration，ref 直写无一致性风险。
 *
 * 契约红线：
 * - **任何路径不得向本组件传 children / text prop**（fallback 渲染走
 *   AsyncMarkdownBlock 全量路径，见 MessageContent 重构）；
 * - append 单调性由调用方保证（IncrementalThoughtStripper 完成行窗口）；
 *   流重启/文本收缩 → 调用方必须变更 key 重挂载本组件（新节点天然空）；
 * - 挂载守卫 lastDeltaRef：React 19 StrictMode effect 双执行防重复 append。
 *
 * caret/滚动跟随：沿用现有 `.isStreaming` CSS（含 caret 样式）。
 */
export const StreamingTextBlock: React.FC<StreamingTextBlockProps> = React.memo(
  ({ delta }) => {
    const ref = useRef<HTMLDivElement>(null);
    /** 最近一次已 append 的 delta 值：StrictMode 双执行防重（幂等守卫） */
    const lastDeltaRef = useRef<string | null>(null);

    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      // StrictMode 双执行 / 同值帧：本 delta 已写入 → 跳过，避免重复 append
      if (lastDeltaRef.current === delta) return;
      lastDeltaRef.current = delta;
      if (delta) el.appendChild(document.createTextNode(delta));
    }, [delta]);

    return (
      <div
        ref={ref}
        className={`${styles.assistantText} md-rendered ${styles.isStreaming}`}
        data-streaming="true"
      />
    );
  }
);

StreamingTextBlock.displayName = 'StreamingTextBlock';
