/**
 * 工具行渲染：每工具独立一行；默认折叠；点击展开仅该工具结果。
 * 关联子 agent 行（CompactToolRow 内嵌 InlineAgentPanel）由组合根经
 * renderLinkedAgentPanel 注入，避免 chat-tool-call → agent-card 反向依赖
 * （InlineAgentPanel 渲染 ChatToolStack 形成的环形依赖）。
 */
import React from 'react';
import { Check, X } from 'lucide-react';
import styles from './ChatToolCallBlock.module.css';
import type {
  FileDiff,
  MessageToolCall,
  SessionAgent,
} from '../../store/types';
import type { ToolRenderItem } from '../../api/toolPresentation';
import { Button } from '../ui';
import { CompactToolRow } from './CompactToolRow';

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
  onApprovalAllow?:
    ((toolId: string, msgId: string, remember?: boolean) => void) | undefined;
  onApprovalDeny?: ((toolId: string, msgId: string) => void) | undefined;
  onRetryTool?: ((toolId: string) => void) | undefined;
  /** 批量批准：msgIds 与 toolIds 等长，按 bar 内相邻 pending 组 */
  onBatchApprove?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
  onBatchDeny?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
  /** 关联子 agent 面板渲染器（组合根注入；切断 chat-tool-call → agent-card 依赖） */
  renderLinkedAgentPanel?:
    | ((
        agent: SessionAgent,
        parentSessionId: string,
        tc: MessageToolCall
      ) => React.ReactNode)
    | undefined;
}

/**
 * 行级共享 props（不含 items/msgId）：由 ChatMessageList 一次组装，
 * 经 ChatAssistantMessageRow 展开进 ChatToolStack，避免双份类型定义漂移。
 */
export type ChatToolStackSharedProps = Omit<
  ChatToolStackProps,
  'items' | 'msgId'
>;

/** 组也展平为独立行，避免「N 步」汇总头 */
function flattenRenderTools(items: ToolRenderItem[]): MessageToolCall[] {
  const out: MessageToolCall[] = [];
  for (const item of items) {
    if (item.kind === 'single') out.push(item.tc);
    else out.push(...item.tools);
  }
  return out;
}

/** 批量审批栏：2+ 相邻待确认工具时渲染 */
function BatchApprovalBar({
  toolIds,
  msgIds,
  onApprove,
  onDeny,
}: {
  toolIds: string[];
  msgIds: string[];
  onApprove?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
  onDeny?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
}) {
  return (
    <div
      className={styles.batchBar}
      role="group"
      aria-label={`批量审批 ${toolIds.length} 个工具`}
    >
      <span className={styles.batchBarLabel}>
        待确认工具（{toolIds.length}）
      </span>
      {onApprove ? (
        <Button
          type="button"
          variant="primary"
          size="sm"
          className={`${styles.batchBarBtn} ${styles.batchBarApprove}`}
          onClick={() => onApprove(msgIds, toolIds)}
          icon={<Check size={12} />}
        >
          全部批准
        </Button>
      ) : null}
      {onDeny ? (
        <Button
          type="button"
          variant="danger"
          size="sm"
          className={`${styles.batchBarBtn} ${styles.batchBarDeny}`}
          onClick={() => onDeny(msgIds, toolIds)}
          icon={<X size={12} />}
        >
          全部拒绝
        </Button>
      ) : null}
    </div>
  );
}

/** 对一组工具渲染行，在相邻 pending_approval 间插入批量审批栏 */
function renderToolsWithBatchBars(
  tools: MessageToolCall[],
  msgId: string | undefined,
  props: ChatToolStackProps
): React.ReactElement[] {
  const elements: React.ReactElement[] = [];
  let i = 0;
  while (i < tools.length) {
    const ti = tools[i]!;
    if (ti.status === 'pending_approval' && msgId) {
      const pendingGroup: MessageToolCall[] = [ti];
      let j = i + 1;
      while (j < tools.length) {
        const tj = tools[j]!;
        if (tj.status !== 'pending_approval') break;
        pendingGroup.push(tj);
        j++;
      }
      if (pendingGroup.length >= 2) {
        const ids = pendingGroup.map((t) => t.id);
        const mIds = pendingGroup.map(() => msgId);
        elements.push(
          <BatchApprovalBar
            key={`batch-${ids[0]}`}
            toolIds={ids}
            msgIds={mIds}
            onApprove={props.onBatchApprove}
            onDeny={props.onBatchDeny}
          />
        );
      }
      for (const tc of pendingGroup) {
        elements.push(
          <CompactToolRow
            key={tc.id}
            tc={tc}
            rowKey={tc.id}
            {...(msgId !== undefined ? { msgId } : {})}
            props={props}
          />
        );
      }
      i = j;
    } else {
      const ti = tools[i]!;
      elements.push(
        <CompactToolRow
          key={ti.id}
          tc={ti}
          rowKey={ti.id}
          {...(msgId !== undefined ? { msgId } : {})}
          props={props}
        />
      );
      i++;
    }
  }
  return elements;
}

function renderToolStackItems(
  items: ToolRenderItem[],
  msgId: string | undefined,
  props: ChatToolStackProps
) {
  const tools = flattenRenderTools(items);
  const segments: React.ReactElement[] = [];
  let i = 0;
  while (i < tools.length) {
    const cur = tools[i]!;
    if (cur.turnId && cur.startedAt) {
      const group: MessageToolCall[] = [cur];
      let j = i + 1;
      while (j < tools.length) {
        const tj = tools[j]!;
        if (
          tj.turnId !== cur.turnId ||
          tj.startedAt == null ||
          Math.abs(tj.startedAt - cur.startedAt) > 200
        )
          break;
        group.push(tj);
        j++;
      }
      if (group.length >= 2) {
        segments.push(
          <div key={`pg-${cur.id}`} className={styles.parallelGroup}>
            <div className={styles.parallelHeader}>
              Parallel（{group.length}）
            </div>
            {renderToolsWithBatchBars(group, msgId, props)}
          </div>
        );
        i = j;
        continue;
      }
    }
    segments.push(...renderToolsWithBatchBars([cur], msgId, props));
    i++;
  }
  return segments;
}

export const ChatToolStack: React.FC<ChatToolStackProps> = (props) => {
  const { items, msgId } = props;
  return (
    <div className={`${styles.toolStack} tool-stack`}>
      {renderToolStackItems(items, msgId, props)}
    </div>
  );
};
