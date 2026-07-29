import React, { useCallback, useState } from 'react';
import type { FileDiff, SessionMessage } from '../../store/layoutStore';
import { ChatAssistantMessageRow, ChatUserMessageRow } from '../ChatMessageRow';
import { useAgentToolApproval } from '../../hooks/useAgentToolApproval';

export function AgentMessageRow({
  msg,
  parentSessionId,
  agentId,
  idx,
  totalMsgs,
  onOpenDiff,
  onOpenPath,
  onOpenTerminal,
}: {
  msg: SessionMessage;
  parentSessionId: string;
  agentId: string;
  idx: number;
  totalMsgs: number;
  onOpenDiff: (diff: FileDiff) => void;
  onOpenPath: (filePath: string) => void;
  onOpenTerminal: () => void;
}) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const onToggleTool = useCallback((toolId: string, currentlyOpen: boolean) => {
    setExpandedTools((prev) => ({ ...prev, [toolId]: !currentlyOpen }));
  }, []);
  // ApprovalAskCard 二次确认后落地：busy + remember 白名单
  const { approvalBusy, onApprovalAllow, onApprovalDeny } = useAgentToolApproval(
    parentSessionId,
    agentId,
  );

  if (msg.sender === 'user') {
    return (
      <ChatUserMessageRow
        msg={msg}
        isPinned={false}
        isSearchHit={false}
        isExpanded={true}
        onToggleExpand={() => {}}
        onTogglePin={() => {}}
        onWithdraw={() => {}}
        messageIndex={idx}
        virtualScrollManager={null}
      />
    );
  }

  const isLastAssistant = idx === totalMsgs - 1;
  const isThinkingMsg = msg.status === 'processing' || msg.status === 'queued';

  return (
    <ChatAssistantMessageRow
      msg={msg}
      isFollowUp={false}
      isPinned={false}
      isSearchHit={false}
      isThinkingMsg={isThinkingMsg}
      hideThinkingBlock={false}
      inPlanMode={false}
      planApproved={false}
      isLastAssistant={isLastAssistant}
      messageIndex={idx}
      virtualScrollManager={null}
      toolStackProps={{
        agents: [],
        activeSessionId: parentSessionId,
        expandedTools: expandedTools,
        onToggleTool: onToggleTool,
        approvalBusy: approvalBusy,
        pendingApprovalMsgId: msg.id,
        onOpenDiff: onOpenDiff,
        onOpenPath: onOpenPath,
        onOpenTerminal: onOpenTerminal,
        onApprovalAllow: onApprovalAllow,
        onApprovalDeny: onApprovalDeny,
      }}
      onTogglePin={() => {}}
      onShowToast={() => {}}
      onRegenerate={() => {}}
      onBranch={() => {}}
      onOpenDiff={onOpenDiff}
      onOpenDiffPanel={() => {}}
      setPermissionMode={() => {}}
      setPlanApproved={() => {}}
    />
  );
}
