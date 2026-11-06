/**
 * InFlowStatusLine — 对话流内瞬态状态行（单轨收敛 docs/chat-notice-convergence §2.2）
 *
 * 会话运行时「重试进行中」的**唯一**可见承载体：
 * - 数据源唯一：SessionRuntimeStatusStore retrying 相位（reportRuntimeStatus 唯一写入）；
 * - 形态极简：左侧小图标 + 一行闪光流动文字（与「正在思考」同一视觉语言）；
 * - 生命周期：新 Token 到达 / run complete / 新一轮发送 / 切换会话 → 物理消失，对话流不留痕；
 * - 无按钮、无可展开详情、无倒计时（引擎不下发下次重试时刻，前端不臆造）。
 */
import React from 'react';
import styles from './InFlowStatusLine.module.css';
import { AppIcon } from '@/components/ui/icons';
import type { RuntimeRetryInfo } from '../../store';
import { formatRetryStatusText } from './inFlowStatusLineLib';
import { useEntranceReveal } from '../motion/useEntranceReveal';
import { useExitReveal } from '../motion/useExitReveal';

export interface InFlowStatusLineProps {
  retry: RuntimeRetryInfo;
  /**
   * S4 退场：宿主（MessageContent）在 retrying 相位结束时保持挂载播
   * 退场。closing=true 时行高收敛 + 淡出，退场期间下方内容不上跳
   * （与入场 grow 同为高度动画，虚拟滚动测高已同理处理）。
   */
  closing?: boolean | undefined;
}

export const InFlowStatusLine: React.FC<InFlowStatusLineProps> = React.memo(
  function InFlowStatusLine({ retry, closing = false }) {
    // 统一入场通道：retrying 相位是纯实况瞬态（存在本身即事件、无可用
    // 事件戳下发到本组件），以 liveOnMount 判定 + grow 变体让 24px 行
    // 高度同步生长，不再瞬时弹入顶开下方内容。
    const entrance = useEntranceReveal({
      key: `retry:${retry.attempt}:${retry.errorKind ?? ''}`,
      liveOnMount: true,
      variant: 'grow',
    });
    // S4 退场：closing 翻 true 时收敛行高并淡出（见 useExitReveal 契约）；
    // 退场期间入场生长让位（data-exiting 标志），由 useEntranceReveal 认领。
    const exit = useExitReveal({ closing });
    return (
      <div
        ref={(el) => {
          entrance.rootRef(el);
          exit.rootRef(el);
        }}
        className={`${styles.statusLine}${entrance.entering ? ' crish-entrance-fade' : ''}${closing ? ' crish-exit-fade' : ''}`}
        style={
          entrance.entering || closing
            ? ({
                ...(entrance.entering
                  ? { '--reveal-delay': `${entrance.delayMs}ms` }
                  : null),
                ...(closing ? { pointerEvents: 'none' } : null),
              } as React.CSSProperties)
            : undefined
        }
        role="status"
        aria-live="polite"
        aria-hidden={closing ? true : undefined}
        data-testid="in-flow-status-line"
        data-entering={entrance.entering ? 'true' : undefined}
        data-exiting={closing ? 'true' : undefined}
        onAnimationEnd={entrance.handleAnimationEnd}
      >
        <AppIcon
          name="wifi"
          size={14}
          aria-hidden
          className={styles.statusIcon}
        />
        <span className={styles.statusText}>
          {formatRetryStatusText(retry)}
        </span>
      </div>
    );
  }
);

InFlowStatusLine.displayName = 'InFlowStatusLine';
