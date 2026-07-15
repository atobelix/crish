/**
 * Store 公共类型入口。
 *
 * 新代码优先：`import type { ... } from '../store/types'`
 * 兼容旧路径：`layoutStore` 仍 re-export 本文件全部类型。
 */

export interface CardState {
  id: string; // 'plan' | 'preview' | 'diff' | 'tasks' | 'terminal'
  title: string;
}

export interface CardGroupState {
  id: string;
  activeCardId: string;
  cards: CardState[];
  heightRatio: number; // relative height ratio within the column
}

export interface ColumnState {
  id: string;
  widthRatio: number; // relative width ratio within the workspace
  groups: CardGroupState[];
}

export interface WorkspaceState {
  id: string;
  columns: ColumnState[];
}

export interface DiffChange {
  type: 'addition' | 'deletion' | 'normal';
  lineNum?: number;
  content: string;
}

export interface FileDiff {
  filePath: string;
  additions: number;
  deletions: number;
  changes: DiffChange[];
}

export interface MessageToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'running' | 'success' | 'error' | 'pending_approval';
  output?: string;
  diffs?: FileDiff[];
  explanation?: string;
}

export interface SessionMessage {
  id: string;
  sender: 'user' | 'assistant';
  text?: string;
  /** 流式思考过程，与正式正文分离，避免互相覆盖 */
  thinking?: string;
  timestamp: number;
  toolCalls?: MessageToolCall[];
  status?: 'queued' | 'processing' | 'completed';
  /**
   * 时间线：按发生顺序交错 text / tool_call。
   * 流式累计正文用 streamTextOffset 切分到当前 text 段。
   */
  blocks?: { type: 'text' | 'tool_call'; id?: string; content?: string }[];
  /** 上一工具插入时 text 的长度，用于把累计正文切成段 */
  streamTextOffset?: number;
  thinkingTime?: number;
}

/** 主会话下的协作子 agent（run_subagent） */
export interface SessionAgent {
  id: string;
  subagentRunId: string;
  parentSessionId: string;
  parentRunId: string;
  parentToolCallId?: string;
  description: string;
  mode: string;
  /** running=执行中; completed=成功结束; failed=异常失败; stopped=用户停止/取消（非失败） */
  status: 'running' | 'completed' | 'failed' | 'stopped';
  summary?: string;
  /** 子 agent 时间线（与主对话同结构，便于复用渲染） */
  messages: SessionMessage[];
  startedAt: number;
  endedAt?: number;
}

/** /goal 任务清单项（与 TasksCard `- [ ]` 解析对齐） */
export interface SessionGoalTask {
  id: string;
  text: string;
  done: boolean;
}

/** /goal 长期目标模式：自动多轮推进直至 DONE 或达上限 */
export interface SessionGoalMode {
  active: boolean;
  goal: string;
  iteration: number;
  maxIterations?: number;
  /** 绑定任务板：续写时注入未完成项；助手 checklist 回写进度 */
  tasks?: SessionGoalTask[];
}

export interface SessionState {
  id: string;
  title: string;
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  branchParentId?: string;
  timestamp: string;
  messages: SessionMessage[];
  /** 本会话固定的消息 id 列表（置顶快捷跳转） */
  pinnedMessageIds?: string[];
  /** 本会话拉起的协作 agent 列表（侧栏嵌套展示） */
  agents?: SessionAgent[];
  /** 引擎事件游标（H2 水合 / H3 增量） */
  engineCursor?: number;
  /** 最近 runId，H3 可拉 snapshot usage */
  engineLastRunId?: string;
  /** 已从引擎补全过正文 */
  hydratedFromEngine?: boolean;
  /** /goal 目标模式状态（会话级） */
  goalMode?: SessionGoalMode;
}

export interface DropPreviewState {
  colIdx: number;
  groupIdx: number;
  direction: 'top' | 'bottom' | 'left' | 'right' | 'merge';
}
