import React, { useLayoutEffect, useRef } from 'react';
import styles from './ChatMessageRow.module.css';

export interface StreamingTextBlockProps {
  /** 本帧新增文本（可为 ''）；append 语义必须单调累积 */
  delta: string;
  /** 单调帧序号（R2-4 N1 修复）：区分「同值新帧」与「StrictMode 双执行」——
   * 连续两帧 delta 字符串相同（如逐字输出「哈」「哈」）时，仅靠 delta 相等
   * 判定幂等会吞掉第二帧（丢字）；以 seq 记录「已写帧」，同 seq 拦截
   * （StrictMode 双执行），seq+1 同值帧照常 append。 */
  seq: number;
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
  ({ delta, seq }) => {
    const ref = useRef<HTMLDivElement>(null);
    /** 最近一次已 append 的帧序号：StrictMode 双执行（同 seq）防重 */
    const lastSeqRef = useRef<number | null>(null);

    useLayoutEffect(() => {
      const el = ref.current;
      if (!el) return;
      // 同 seq（StrictMode 双执行）→ 已写，跳过；seq+1（含同值新帧）→ 照常 append
      if (lastSeqRef.current === seq) return;
      lastSeqRef.current = seq;
      if (delta) el.appendChild(document.createTextNode(delta));
    }, [delta, seq]);

    return (
      <div
        ref={ref}
        className={`${styles.assistantText} md-rendered ${styles.isStreaming}`}
        data-streaming="true"
      />
    );
  },
  (prev, next) => prev.delta === next.delta && prev.seq === next.seq
);

StreamingTextBlock.displayName = 'StreamingTextBlock';
