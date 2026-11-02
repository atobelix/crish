/**
 * 子 agent 外壳（conversation-flow 路径）：渲染与经典路径同一张流内分派卡
 * （SubagentDispatchCard，R4b 双路收敛）——同一卡面、同一点击进侧栏行为，
 * 不再有第二套徽章/展开体。外壳只负责流内定位与数据锚点。
 */
import { lazy, Suspense, type ReactElement } from 'react';
import type { ActionNode } from '@crish/conversation-flow';
import type { SessionAgent } from '../../store/types';
import styles from './narrative.module.css';

const SubagentDispatchCard = lazy(async () => {
  const m = await import('../../components/agent-card/SubagentDispatchCard');
  return { default: m.SubagentDispatchCard };
});

export interface SubagentBlockProps {
  agent: SessionAgent;
  parentSessionId: string;
  action?: ActionNode;
}

export function SubagentBlock({
  agent,
  parentSessionId,
  action,
}: SubagentBlockProps): ReactElement {
  return (
    <div
      className={styles.subagent}
      data-flow-subagent={agent.id}
      data-flow-action={action?.id}
    >
      <div className={styles.subagentShell}>
        <Suspense fallback={<div className={styles.meta}>协作子任务…</div>}>
          <SubagentDispatchCard
            agent={agent}
            parentSessionId={parentSessionId}
            parentToolCallId={agent.parentToolCallId}
          />
        </Suspense>
      </div>
    </div>
  );
}
