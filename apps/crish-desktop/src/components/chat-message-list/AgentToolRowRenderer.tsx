/**
 * 工具行关联子 agent 的渲染器（G13 断环：依赖倒置）。
 *
 * 原实现：CompactToolRow 直接懒加载 InlineAgentPanel —— 形成
 * InlineAgentPanel → ChatToolCallBlock → CompactToolRow → InlineAgentPanel 环。
 * 现改为：chat-tool-call 域只声明 `renderLinkedAgentRow` prop 接口，
 * 本组件（chat-message-list 域，agent-card 的上层）经 ChatMessageList 注入实现，
 * 懒加载保留拆包语义（InlineAgentPanel 不进主 bundle）。
 */
import React, { Suspense, lazy } from 'react';
import type { MessageToolCall, SessionAgent } from '../../store/layoutStore';
import { findAgentForTool } from '../chat-tool-call/chatToolCallUtils';

const InlineAgentPanel = lazy(() =>
  import('../agent-card/InlineAgentPanel').then((m) => ({ default: m.InlineAgentPanel }))
);

export interface AgentToolRowRendererProps {
  tc: MessageToolCall;
  agents: SessionAgent[];
  activeSessionId: string;
}

/** 关联 agent 行 fallback：与旧 CompactToolRow loading 占位等价（内联样式） */
const AgentRowFallback: React.FC = () => (
  <div
    className="tool-row is-running"
    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px' }}
  >
    <span
      className="loading-spinner"
      style={{ width: 8, height: 8, borderWidth: 1.5 }}
    />
    <span style={{ fontSize: 12, opacity: 0.8 }}>协作子任务…</span>
  </div>
);

export const AgentToolRowRenderer: React.FC<AgentToolRowRendererProps> = ({
  tc,
  agents,
  activeSessionId,
}) => {
  const linkedAgent = findAgentForTool(tc, agents);
  if (!linkedAgent || !activeSessionId) return null;
  return (
    <Suspense fallback={<AgentRowFallback />}>
      <InlineAgentPanel
        agent={linkedAgent}
        parentSessionId={activeSessionId}
        defaultOpen={tc.status === 'running' || linkedAgent.status === 'running'}
      />
    </Suspense>
  );
};
