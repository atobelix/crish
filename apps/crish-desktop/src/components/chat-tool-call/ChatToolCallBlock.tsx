/**
 * 工具行渲染：每工具独立一行；默认折叠；点击展开仅该工具结果。
 * V1-γ（统一输入流收敛战役 · 折叠单源）：本组件直接消费投影层已裁决的
 * `ToolRenderItem[]`——`single` → 单行；`group` → 折叠标题行（复活
 * `label`：`${toolHumanLabel(last)} · ${n} 步`）+ 组内子行展开列表。
 * 不再展平（flattenRenderTools 已删）也不再按 turnId/startedAt 重分组
 * （parallelGroup 已删，语义下沉 timelineNormalizer.buildToolRenderItems）。
 * 关联子 agent 分派行不在本栈渲染：R4b 起分派由组合根
 * （MessageToolCallsSection）从渲染项序列中提取为独立消息卡
 * （SubagentDispatchCard），本栈只承载普通工具行。
 */
import React from 'react';

import styles from './ChatToolCallBlock.module.css';
import type {
  FileDiff,
  MessageToolCall,
  SessionAgent,
} from '../../store/types';
import type { ToolRenderItem } from '../../api/toolPresentation';
import { Button } from '@/components/ui';
import { CompactToolRow } from './CompactToolRow';
import { AppIcon } from '@/components/ui/icons';

export interface ChatToolStackActions {
  onOpenDiff?: ((diff: FileDiff) => void) | undefined;
  onOpenPath?: ((filePath: string) => void) | undefined;
  onOpenTerminal?: (() => void) | undefined;
  onRetryInjection?: ((injectionId: string) => void) | undefined;
  onRetryTool?: ((toolId: string) => void) | undefined;
  onApprovalAllow?:
    ((toolId: string, msgId: string, remember?: boolean) => void) | undefined;
  onApprovalDeny?: ((toolId: string, msgId: string) => void) | undefined;
  /** 批量批准：msgIds 与 toolIds 等长，按 bar 内相邻 pending 组 */
  onBatchApprove?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
  onBatchDeny?: ((msgIds: string[], toolIds: string[]) => void) | undefined;
}

export interface ChatToolStackProps {
  items: ToolRenderItem[];
  msgId?: string;
  agents: SessionAgent[];
  activeSessionId: string;
  /**
   * 本消息的工具展开 map（toolId → open）。
   * D7.3（FE-INV-5）：由行装配层按 messageId 从 expandedToolsByMessage 切片注入；
   * 其它消息 toggle 时本 map 引用保持稳定。
   */
  expandedTools: Record<string, boolean>;
  /**
   * 会话级嵌套展开 store（sessionId 已切片为当前会话）：
   * messageId → toolId → open。供行装配层按 msgId 切片；不直接下传 CompactToolRow。
   */
  expandedToolsByMessage?: Record<string, Record<string, boolean>>;
  /**
   * 工具展开 toggle。第三参 msgId 由行装配层绑定（FE-INV-5 per-message）。
   */
  onToggleTool: (
    toolId: string,
    currentlyOpen: boolean,
    msgId?: string
  ) => void;
  onToggleInjection?:
    ((injectionId: string, currentlyOpen: boolean) => void) | undefined;
  approvalBusy: boolean;
  pendingApprovalMsgId?: string | undefined;
  /** 操作回调与关联渲染器组（打开/审批/重试/批量/子 agent） */
  actions?: ChatToolStackActions;
}

/**
 * 行级共享 props（不含 items/msgId）：由 ChatMessageList 一次组装，
 * 经 ChatAssistantMessageRow 展开进 ChatToolStack，避免双份类型定义漂移。
 */
export type ChatToolStackSharedProps = Omit<
  ChatToolStackProps,
  'items' | 'msgId'
>;

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
          onClick={() => onApprove(msgIds, toolIds)}
          icon={<AppIcon name="check" size={12} />}
        >
          全部批准
        </Button>
      ) : null}
      {onDeny ? (
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => onDeny(msgIds, toolIds)}
          icon={<AppIcon name="x" size={12} />}
        >
          全部拒绝
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 对一组工具渲染行，在相邻 pending_approval 间插入批量审批栏。
 * 【B-STRUCT-04 · 逐行包装展平】每行包一层 .toolGroup div，该 div 本身就
 * 是 .toolStack 的直接子级（key 只取行 id，两形态同源）；组容器 div 不再
 * 渲染。kind 翻转只改变包装的 props（data-group-id 由无到有），不改变行
 * 在树中的父级与 key——行实例（含 S4 退场宿主 useClosingFlag）不重挂。
 * 组头不在此渲染（UX-03：组头由外层 FoldableToolGroup 统一渲染）。
 * BatchApprovalBar 保持为返回数组中的裸兄弟元素，不包包装。
 */
function renderToolsWithBatchBars(
  tools: MessageToolCall[],
  msgId: string | undefined,
  props: ChatToolStackProps,
  groupId?: string
): React.ReactElement[] {
  const elements: React.ReactElement[] = [];
  const pushRow = (tc: MessageToolCall) => {
    elements.push(
      <div
        key={`grp-${tc.id}`}
        className={styles.toolGroup}
        data-expanded="true"
        {...(groupId !== undefined ? { 'data-group-id': groupId } : {})}
      >
        <CompactToolRow
          key={tc.id}
          tc={tc}
          rowKey={tc.id}
          {...(msgId !== undefined ? { msgId } : {})}
          props={props}
        />
      </div>
    );
  };
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
            onApprove={props.actions?.onBatchApprove}
            onDeny={props.actions?.onBatchDeny}
          />
        );
      }
      for (const tc of pendingGroup) {
        pushRow(tc);
      }
      i = j;
    } else {
      pushRow(tools[i]!);
      i++;
    }
  }
  return elements;
}

/**
 * 直接消费投影层已裁决的 ToolRenderItem[]（V1-γ 折叠单源），展平渲染：
 * - single → 该行的逐行包装（即 B 的 single 段包装 div 本身，同 key、同
 *   class、同属性、同子级，字节一致）；
 * - group → 每行一个逐行包装（带 data-group-id），直接作为 .toolStack
 *   的子级；组容器 div 不再渲染，组头由外层 FoldableToolGroup 统一渲染。
 * 翻转前后 .toolStack 的子级列表逐 key 同一：单工具组首翻转（C2）零子级
 * 变化；非首工具并入既有组（B-STRUCT-04）仅包装的 data-group-id 由无
 * 到有，行与包装均为同一节点，退场宿主不重挂。`.toolGroup` 视觉中性
 * （与 .toolStack 同 gap、零边框零内边距），单子级时 gap 无作用。
 * （B 的段包装 key 机制 toolStackSegmentKey 已随展平删除：行包装 key
 * 只取行 id，不再派生自组首工具。）
 */
function renderToolStackItems(
  items: ToolRenderItem[],
  msgId: string | undefined,
  props: ChatToolStackProps
) {
  const segments: React.ReactElement[] = [];
  for (const item of items) {
    if (item.kind === 'single') {
      segments.push(...renderToolsWithBatchBars([item.tc], msgId, props));
      continue;
    }
    segments.push(
      ...renderToolsWithBatchBars(item.tools, msgId, props, item.id)
    );
  }
  return segments;
}

/**
 * D7.4：React.memo + 显式比较器——items/msgId 引用稳定时跳过整栈重渲染。
 * expandedTools / onToggleTool / actions 引用由上游装配层保证稳定（D7.3 + useMemo）。
 */
export function chatToolStackPropsEqual(
  a: ChatToolStackProps,
  b: ChatToolStackProps
): boolean {
  return (
    a.items === b.items &&
    a.msgId === b.msgId &&
    a.agents === b.agents &&
    a.activeSessionId === b.activeSessionId &&
    a.expandedTools === b.expandedTools &&
    a.onToggleTool === b.onToggleTool &&
    a.onToggleInjection === b.onToggleInjection &&
    a.approvalBusy === b.approvalBusy &&
    a.pendingApprovalMsgId === b.pendingApprovalMsgId &&
    a.actions === b.actions
  );
}

export const ChatToolStack: React.FC<ChatToolStackProps> = React.memo(
  function ChatToolStack(props) {
    const { items, msgId } = props;
    return (
      <div className={`${styles.toolStack} tool-stack`}>
        {renderToolStackItems(items, msgId, props)}
      </div>
    );
  },
  chatToolStackPropsEqual
);
ChatToolStack.displayName = 'ChatToolStack';
