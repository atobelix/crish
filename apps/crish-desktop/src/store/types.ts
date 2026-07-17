/**
 * Store 公共类型入口。
 *
 * 新代码优先：`import type { ... } from '../store/types'`
 * 兼容旧路径：`layoutStore` 仍 re-export 本文件全部类型。
 *
 * 形态约定：
 * - FileDiff / DiffChange 与 `api/storeAccess` isFileDiff·normalizeFileDiff 对齐
 * - CronJob 与 `api/clientApi.CronJob` / isCronJob 字段一致（结构兼容，不发明字段）
 * - Session* 与 sessionActions / sessionPersistence 水合路径对齐
 */

/**
 * 设置侧栏 tab id — store / openSettings / SettingsPanel 共用，
 * 避免 App 侧 `as SettingsTabType` 与 string 漂移。
 */
export type SettingsTabType =
  | 'profile'
  | 'appearance'
  | 'personalize'
  | 'models'
  | 'usage'
  | 'schedule'
  | 'rules'
  | 'shortcuts'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'security';

/**
 * 工作区已知面板 card id（文档/收窄用）。
 * CardState.id 仍为 string：允许扩展 id，勿强制只列本联合。
 */
export type KnownPanelCardId =
  | 'chat'
  | 'agent'
  | 'overview'
  | 'files'
  | 'preview'
  | 'diff'
  | 'terminal'
  | 'tasks'
  | 'runtime'
  | 'settings'
  | 'plan';

/** 工作区单卡：id 为面板 key，title 为展示名 */
export interface CardState {
  /** 面板 id；常见值见 {@link KnownPanelCardId} */
  id: string;
  title: string;
}

/** 同一列内的卡片分组（tab 组）；activeCardId 指向 cards 内某 id */
export interface CardGroupState {
  id: string;
  activeCardId: string;
  cards: CardState[];
  /** 列内相对高度比例 */
  heightRatio: number;
}

/** 工作区一列；widthRatio 为列间相对宽度 */
export interface ColumnState {
  id: string;
  /** 工作区内相对宽度比例 */
  widthRatio: number;
  groups: CardGroupState[];
}

export interface WorkspaceState {
  id: string;
  columns: ColumnState[];
}

// ── FileDiff 形态（工具结果 / Git / 落盘 apply / pushDiffFile 共用）──────────

/**
 * 行级 diff 变更类型。
 * 与 storeAccess.isDiffChange、applyFileDiff.partitionChanges 白名单一致。
 */
export type DiffChangeType = 'addition' | 'deletion' | 'normal';

/**
 * 单行 diff。
 * - type：判别（增/删/上下文）
 * - lineNum：1-based 行号；context 或工具未报时可能缺失
 * - content：行文本（是否带 +/- 前缀由解析器决定）
 */
export interface DiffChange {
  type: DiffChangeType;
  /** 1-based 行号；缺省表示未知/纯上下文 */
  lineNum?: number;
  content: string;
}

/**
 * 单文件 diff 快照。
 * 推入 store 前须通过 isFileDiff：filePath trim 非空、additions/deletions 为有限 number、
 * changes 每项为合法 DiffChange。空路径或非法 changes 会被 pushDiffFile 静默丢弃。
 */
export interface FileDiff {
  /** 工作区相对或绝对路径；规范化侧会 trim */
  filePath: string;
  /** 新增行统计（可与 changes 不完全一致，以工具上报为准） */
  additions: number;
  /** 删除行统计 */
  deletions: number;
  changes: DiffChange[];
}

// ── CronJob 形态（layout scheduledTasks / RuntimePanel；与 clientApi 结构兼容）──

/**
 * 定时任务目标会话策略。
 * - current-session：在触发时的活动会话执行
 * - new-session：新建会话执行
 */
export type CronTargetSession = 'current-session' | 'new-session';

/** 定时任务启停状态（demo / RuntimePanel；非引擎 workflow 状态机） */
export type CronJobStatus = 'active' | 'paused';

/**
 * 本地/演示用计划任务（store.scheduledTasks）。
 * 正式引擎 workflow 另有形状；本类型不发明远端 cron 列表字段。
 * 字段与 `clientApi.CronJob` / storeAccess.isCronJob 一致，可结构互赋。
 */
export interface CronJob {
  /** 非空 id（normalize 时 trim） */
  id: string;
  /** cron 表达式，如 `0 3 * * *` */
  cronExpression: string;
  /** 触发时注入的提示/任务描述 */
  prompt: string;
  targetSession: CronTargetSession;
  status: CronJobStatus;
  /** 下次运行时间展示串（ISO 或本地格式化文本） */
  nextRun: string;
}

// ── 消息 / 工具 / 审批 ─────────────────────────────────────────────────────

/**
 * 审批风险等级（BE-04 展示用，可选字段）。
 * 与 approvalMeta.ApprovalRiskLevel 取值一致；store 侧全可选，解析后再收成完整 meta。
 */
export type MessageApprovalRiskLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'unknown';

/** 审批风险来源：后端事实 / 派生 / 未知 */
export type MessageApprovalRiskSource = 'backend' | 'derived' | 'unknown';

/** 后端审批风险事实（BE-04）；仅展示，不按工具名猜 */
export interface MessageToolApprovalMeta {
  trustZone?: string;
  risk?: string;
  riskReason?: string;
  riskLevel?: MessageApprovalRiskLevel;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  source?: MessageApprovalRiskSource;
}

/**
 * 工具调用生命周期状态。
 * running → success|error；审批路径可经 pending_approval。
 */
export type MessageToolCallStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'pending_approval';

/** 助手消息上的单次工具调用（含可选 diff / 审批元数据） */
export interface MessageToolCall {
  id: string;
  name: string;
  /** JSON 或原始参数串（以引擎/工具上报为准） */
  arguments: string;
  status: MessageToolCallStatus;
  output?: string;
  diffs?: FileDiff[];
  explanation?: string;
  /** approval-requested 带来的后端风险元数据 */
  approvalMeta?: MessageToolApprovalMeta;
}

/** 消息发送方 */
export type MessageSender = 'user' | 'assistant';

/**
 * 用户/助手消息处理状态（可选）。
 * queued=排队待发; processing=流式中; completed=终态（成功收口，不含 error 枚举）。
 */
export type SessionMessageStatus = 'queued' | 'processing' | 'completed';

/** 时间线块类型：正文段 vs 工具调用锚点 */
export type MessageTimelineBlockType = 'text' | 'tool_call';

/**
 * 消息时间线块（按发生顺序交错 text / tool_call）。
 * - text：content 为该段正文；流式时由 streamTextOffset 切分
 * - tool_call：id 对齐 MessageToolCall.id；content 可选摘要
 */
export interface MessageTimelineBlock {
  type: MessageTimelineBlockType;
  /** tool_call 时对应 toolCall.id；text 段可省略 */
  id?: string;
  content?: string;
}

/** 会话内一条用户或助手消息 */
export interface SessionMessage {
  id: string;
  sender: MessageSender;
  text?: string;
  /** 流式思考过程，与正式正文分离，避免互相覆盖 */
  thinking?: string;
  /** epoch ms */
  timestamp: number;
  toolCalls?: MessageToolCall[];
  status?: SessionMessageStatus;
  /**
   * 时间线：按发生顺序交错 text / tool_call。
   * 流式累计正文用 streamTextOffset 切分到当前 text 段。
   */
  blocks?: MessageTimelineBlock[];
  /** 上一工具插入时 text 的长度，用于把累计正文切成段 */
  streamTextOffset?: number;
  /** 思考耗时（秒或 ms，由 setSessionMessageStatus 写入侧约定） */
  thinkingTime?: number;
}

/**
 * 协作子 agent 状态。
 * stopped=用户停止/取消（非失败）；failed=异常失败。
 */
export type SessionAgentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

/** 主会话下的协作子 agent（run_subagent） */
export interface SessionAgent {
  id: string;
  subagentRunId: string;
  parentSessionId: string;
  parentRunId: string;
  parentToolCallId?: string;
  description: string;
  /** 引擎 mode 字符串（如 explore / implement）；不在此收窄枚举 */
  mode: string;
  /** running=执行中; completed=成功结束; failed=异常失败; stopped=用户停止/取消（非失败） */
  status: SessionAgentStatus;
  summary?: string;
  /** 子 agent 时间线（与主对话同结构，便于复用渲染） */
  messages: SessionMessage[];
  /** 启动时刻 epoch ms */
  startedAt: number;
  /** 结束时刻 epoch ms；运行中缺省 */
  endedAt?: number;
}

/** /goal 任务清单项（与 TasksCard `- [ ]` 解析对齐） */
export interface SessionGoalTask {
  id: string;
  text: string;
  done: boolean;
}

/**
 * /goal 长期目标模式：自动多轮推进直至 DONE 或达上限。
 * 注意：blockedReason / completed 等生命周期字段在 goalModeController 本地状态，
 * 不进入本 store 形状（避免与会话持久化字段漂移）。
 */
export interface SessionGoalMode {
  active: boolean;
  goal: string;
  /** 已完成的自动续写轮次（0-based 计数语义见 goalModeController） */
  iteration: number;
  maxIterations?: number;
  /** 绑定任务板：续写时注入未完成项；助手 checklist 回写进度 */
  tasks?: SessionGoalTask[];
}

/**
 * 侧栏/主区会话权威形状（sessions[] 与 sessionsById 同引用）。
 * 持久化索引字段见 sessionPersistence.SessionIndexEntry（子集 + messageCount 等）。
 */
export interface SessionState {
  id: string;
  title: string;
  /** 侧栏文件夹/项目归组键；缺省「常规会话」由创建路径写入 */
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  /** 分叉来源会话 id */
  branchParentId?: string;
  /** ISO 时间串（侧栏相对时间）；创建时用 nowIsoTimestamp，勿写死「刚刚」 */
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

/** 标签拖拽落点预览方向 */
export type DropPreviewDirection =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'merge';

/** 工作区 DnD 落点预览（null 表示无预览） */
export interface DropPreviewState {
  colIdx: number;
  groupIdx: number;
  direction: DropPreviewDirection;
}
