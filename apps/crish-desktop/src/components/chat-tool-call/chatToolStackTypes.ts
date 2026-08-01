/**
 * ChatToolStack 共享类型与依赖反转上下文。
 *
 * CompactToolRow → InlineAgentPanel → ChatToolCallBlock → CompactToolRow
 * 原环：InlineAgentPanel 静态 import ChatToolStack，而 ChatToolStack 渲染 CompactToolRow，
 * CompactToolRow 又 lazy import InlineAgentPanel，形成值依赖环。
 *
 * 解法：ChatToolStack 将自身注入 ChatToolStackContext，InlineAgentPanel 通过
 * useContext 取用，不再静态 import ChatToolCallBlock，从根上断开环。
 */
import { createContext, type FC } from 'react';
import type { ToolRenderItem } from '../../api/toolPresentation';
import type { FileDiff, SessionAgent } from '../../store/layoutStore';

export interface ChatToolStackProps {
  items: ToolRenderItem[];
  msgId?: string;
  agents: SessionAgent[];
  activeSessionId: string;
  expandedTools: Record<string, boolean>;
  onToggleTool: (toolId: string, currentlyOpen: boolean) => void;
  approvalBusy: boolean;
  pendingApprovalMsgId?: string | undefined;
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
  onOpenPath?: ((filePath: string) => void) | undefined;
  onOpenTerminal?: (() => void) | undefined;
  onApprovalAllow?: ((toolId: string, msgId: string, remember?: boolean) => void) | undefined;
  onApprovalDeny?: ((toolId: string, msgId: string) => void) | undefined;
  onRetryTool?: ((toolId: string) => void) | undefined;
  /** 批量批准：msgIds 与 toolIds 等长，按 bar 内相邻 pending 组 */
  onBatchApprove?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
  onBatchDeny?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
}

/**
 * 行级共享 props（不含 items/msgId）：由 ChatMessageList 一次组装，
 * 经 ChatAssistantMessageRow 展开进 ChatToolStack，避免双份类型定义漂移。
 */
export type ChatToolStackSharedProps = Omit<
  ChatToolStackProps,
  'items' | 'msgId'
>;

/** ChatToolStack 组件类型（用于上下文注入，打破递归 import 环） */
export type ChatToolStackComponent = FC<ChatToolStackProps>;

/**
 * 依赖反转上下文：ChatToolStack 渲染时将自身注入，
 * InlineAgentPanel 通过 useContext 取用，无需静态 import ChatToolCallBlock。
 */
export const ChatToolStackContext = createContext<ChatToolStackComponent | null>(
  null,
);
