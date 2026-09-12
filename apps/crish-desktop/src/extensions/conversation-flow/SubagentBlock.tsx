/**
 * 子 agent 外壳：装饰 InlineAgentPanel，不重写 useAgentPanel。
 * 默认两行根（面板自身折叠头）；展开体限高对齐 TOOL_OUTPUT_PIXEL_CAP。
 */
import { lazy, Suspense, type ReactElement } from 'react';
import type { ActionNode } from '@crish/conversation-flow';
import type { SessionAgent } from '../../store/types';
import { FLOW_OUTPUT_STYLE } from './flowOutputStyle';
import styles from './narrative.module.css';

const InlineAgentPanel = lazy(async () => {
  const m = await import('../../components/agent-card/InlineAgentPanel');
  return { default: m.InlineAgentPanel };
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
  const outputMax = FLOW_OUTPUT_STYLE;

  return (
    <div
      className={styles.subagent}
      data-flow-subagent={agent.id}
      data-flow-action={action?.id}
      style={outputMax}
    >
      <div className={styles.subagentShell}>
        <Suspense fallback={<div className={styles.meta}>协作子任务…</div>}>
          <InlineAgentPanel
            agent={agent}
            parentSessionId={parentSessionId}
            defaultOpen={false}
          />
        </Suspense>
      </div>
    </div>
  );
}
