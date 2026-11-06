/**
 * apps/crish-desktop/src/components/chat-message-list/SessionReadyCover.tsx
 *
 * 打开会话就绪遮罩（批 B ⑳）：数据已到、但布局/锚点尚未稳定时盖住消息流，
 * 就绪后以 --transition-popover-enter（180ms）淡出，避免首帧错位/跳动被看见。
 *
 * 与批 A ChatMessageList Loading 出口的分工：
 * - Loading 出口管「数据未到」（messages 为空且在途），渲染在虚拟列表之外；
 * - 本遮罩管「数据已到但布局未稳」，只存在于虚拟列表已挂载之后，
 *   两者渲染条件互斥（虚拟列表仅在 messages 非空时挂载），永不叠画。
 * - 不得用骨架屏（用户裁决）：遮罩是纯色面 + 一枚 ui/Spinner 原语
 *   （S8 收敛，与 ContentState 同源同规格，含防闪烁门：遮罩若在
 *   250ms 内就绪，spinner 永不显形）。
 *
 * 退出条件由宿主（MessageVirtualizer）裁决：测高遍数走完且锚点恢复落定后
 * 置 fading；减少动效时宿主直接卸载、不走淡出。
 */

import React from 'react';
import { Spinner } from '../ui/Spinner';
import styles from './SessionReadyCover.module.css';

/**
 * 遮罩退出条件（纯函数，宿主 rAF 探针据此裁决）：测高遍数走完（≤0）
 * 且锚点恢复已落定（无待恢复目标）才算就绪——两者任一未稳都继续盖住。
 */
export function isSessionCoverReady(input: {
  measurePassesRemaining: number;
  restorePending: boolean;
}): boolean {
  return input.measurePassesRemaining <= 0 && !input.restorePending;
}

export const SessionReadyCover: React.FC<{ fading: boolean }> = ({
  fading,
}) => (
  <div
    className={fading ? `${styles.cover} ${styles.coverFading}` : styles.cover}
    data-testid="session-ready-cover"
    data-fading={fading ? 'true' : 'false'}
    aria-hidden="true"
  >
    <Spinner delayed />
  </div>
);
