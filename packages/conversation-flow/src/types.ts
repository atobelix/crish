/**
 * 叙事投影类型。输入对齐 desktop `SessionMessage` / `MessageToolCall` 的结构，
 * 本包自建最小接口，不反向依赖 desktop / block-paper / reference。
 *
 * 凡标「前端派生」的字段均非引擎协议（Phase A 无 purpose_id）。
 */

/** 与 desktop `MessageToolCall.status` 同形 */
export type ToolCallStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'pending_approval';

/** 与 desktop `MessageSender` 同形 */
export type MessageSender = 'user' | 'assistant';

/** 单次工具调用的最小输入（结构兼容 `MessageToolCall`） */
export interface ProjectToolCallInput {
  id: string;
  name: string;
  arguments?: string;
  status: ToolCallStatus;
  output?: string;
  explanation?: string;
  startedAt?: number;
  completedAt?: number;
  finishedAt?: number;
  turnId?: string;
  approvalMeta?: {
    risk?: string;
  };
}

/**
 * `projectMessage` 最小输入。
 * 结构兼容 desktop `SessionMessage` 的投影所需字段；多出来的字段被忽略。
 */
export interface ProjectMessageInput {
  id: string;
  sender: MessageSender;
  text?: string;
  thinking?: string;
  toolCalls?: ProjectToolCallInput[];
}

/** 前端派生：Purpose 聚合态 */
export type PurposeStatus = 'running' | 'success' | 'error' | 'partial';

/** 前端派生：Action 分类（仅展示） */
export type ActionKind =
  | 'file'
  | 'shell'
  | 'search'
  | 'edit'
  | 'skill'
  | 'mcp'
  | 'other';

export type TextTone = 'primary' | 'interstitial';

export type FlowNodeStatus = 'running' | 'success' | 'error';

/** 前端派生：折叠动作行 */
export interface ActionNode {
  id: string;
  toolName: string;
  /** 前端派生：时态动词（已查看 / 正在运行） */
  verb: string;
  /** 前端派生：人话对象 */
  objectLabel: string;
  status: ToolCallStatus;
  /** 前端派生 */
  kind: ActionKind;
  /** 前端派生：可展开（有输出） */
  expandable: boolean;
  /** 前端派生：源码路径；search pattern 不进此字段 */
  path?: string;
  /** 前端派生：命令，仅展开显示 */
  command?: string;
  output?: string;
  explanation?: string;
  startedAt?: number;
  completedAt?: number;
  /** 前端派生：同 turnId 并行组 */
  parallelGroupId?: string;
  turnId?: string;
}

/** 前端派生：思考节点 */
export interface ThinkingNode {
  kind: 'thinking';
  id: string;
  /** 前端派生：预览截断 */
  preview: string;
  content: string;
  elapsedMs?: number;
  live?: boolean;
}

export interface TextNode {
  kind: 'text';
  id: string;
  content: string;
  /** 前端派生：助手正文默认 primary；用户气泡亦 primary */
  tone: TextTone;
}

/** 前端派生：调用目的（无 purpose_id） */
export interface PurposeNode {
  kind: 'purpose';
  id: string;
  /** 前端派生：explanation 归一或 humanize 回退 */
  primary: string;
  /** 前端派生：Phase A 无协议次级字段时省略 */
  secondary?: string[];
  /** 前端派生：由 actions 聚合 */
  status: PurposeStatus;
  actions: ActionNode[];
}

/** 类型占位：本轮不从产品消息长出（禁止 demo-data 块协议） */
export interface SubagentNode {
  kind: 'subagent';
  id: string;
  name: string;
  status: FlowNodeStatus;
  elapsedMs?: number;
  /** 前端派生 */
  traces: string[][];
  children: FlowNode[];
}

/** 类型占位：本轮不从产品消息长出 */
export interface ArtifactNode {
  kind: 'artifact';
  id: string;
  title: string;
  mime: 'markdown' | 'text';
  content: string;
}

/** 类型占位：仅 plan 模式后挂；本轮不从消息块发明 plan */
export interface PlanStep {
  id: string;
  title: string;
  status: FlowNodeStatus;
  children: FlowNode[];
}

/** 类型占位：本轮不从产品消息长出 */
export interface PlanNode {
  kind: 'plan';
  id: string;
  title: string;
  status: FlowNodeStatus;
  currentStepIndex: number;
  steps: PlanStep[];
  children: FlowNode[];
}

export type FlowNode =
  | ThinkingNode
  | TextNode
  | PurposeNode
  | SubagentNode
  | ArtifactNode
  | PlanNode;

/** pending_approval 离开 Purpose 树，交给审批条 */
export interface PendingApproval {
  id: string;
  /** 前端派生：人话摘要 */
  summary: string;
  /** 前端派生 */
  command: string;
  toolName: string;
  risk?: string;
}

export interface ProjectMessageResult {
  nodes: FlowNode[];
  pendingApprovals: PendingApproval[];
}

/** Phase A 默认 30s 合并窗 */
export const DEFAULT_PURPOSE_WINDOW_MS = 30_000;

export interface HumanizeHooks {
  /** 工具名 → 中文基础动词；缺省用包内极薄 fallback */
  verb?: (name: string) => string;
  /** 整条 tool → 人话标签（explanation 回退）；缺省用包内极薄 fallback */
  label?: (tc: ProjectToolCallInput) => string;
}

export interface ProjectOptions {
  purposeWindowMs?: number;
  humanize?: HumanizeHooks;
}
