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
import type { Settings } from '../api/clientApi';
export type AppSettings = Settings;
export type GroupState = { id: string; cards: any[]; activeCardId: string | null };

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
 *
 * 可选字段约定（exactOptionalPropertyTypes: true）：
 * `field?: T` 表示字段可以不存在，若存在则必须是 T（不接受 undefined）。
 * 调用方持有可能为 undefined 的源值时，应使用 compactObj / 条件展开剔除 undefined 键。
 */
export interface FileDiff {
  /** 工作区相对或绝对路径；规范化侧会 trim */
  filePath: string;
  /** 新增行统计（可与 changes 不完全一致，以工具上报为准） */
  additions: number;
  /** 删除行统计 */
  deletions: number;
  changes: DiffChange[];
  /** Git 暂存状态（乐观 UI 更新用） */
  staged?: boolean;
  /** Git 未暂存状态 */
  unstaged?: boolean;
  /** 是否未跟踪文件 */
  untracked?: boolean;
  /** Git 状态字母标识（M/A/D/?? 等） */
  gitStatus?: string;
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
 * 审批 meta 的「显式可空」形态：所有字段都允许 undefined，
 * 适用于从原始事件水合时部分字段未提供的场景。
 * 转入 store 时应使用 compactObj 剔除 undefined 字段，得到 MessageToolApprovalMeta。
 */
export type MessageToolApprovalMetaInput = {
  trustZone?: string | undefined;
  risk?: string | undefined;
  riskReason?: string | undefined;
  riskLevel?: MessageApprovalRiskLevel | undefined;
  requiresDoubleConfirm?: boolean | undefined;
  recommendSnapshot?: boolean | undefined;
  source?: MessageApprovalRiskSource | undefined;
};

/**
 * 工具调用生命周期状态。
 * running → success|error；审批路径可经 pending_approval。
 *
 * 语义单一性约定：
 *   - 'success' / 'error' 仅表示「工具执行结果」，不含「用户审批决定」
 *   - 用户审批决定（approved / rejected）由 {@link MessageToolCall.approvalDecision} 独立承载
 *   - 当用户拒绝审批（approvalDecision='rejected'）时，status 仍保留为 'pending_approval'，
 *     由调用方根据 approvalDecision 决定后续流转（重试 / 终止）
 */
export type MessageToolCallStatus =
  | 'running'
  | 'success'
  | 'error'
  | 'pending_approval';

/**
 * 用户审批决定（与工具执行结果解耦）。
 * - approved：用户批准，工具继续执行
 * - rejected：用户拒绝，工具不会执行（与工具执行失败 status='error' 语义不同）
 */
export type MessageToolCallApprovalDecision = 'approved' | 'rejected';

/** 助手消息上的单次工具调用（含可选 diff / 审批元数据） */
export interface MessageToolCall {
  id: string;
  name: string;
  /** JSON 或原始参数串（以引擎/工具上报为准） */
  arguments?: string | undefined;
  status: MessageToolCallStatus;
  output?: string | undefined;
  diffs?: FileDiff[] | undefined;
  explanation?: string | undefined;
  /** approval-requested 带来的后端风险元数据 */
  approvalMeta?: MessageToolApprovalMeta | undefined;
  /**
   * 用户审批决定（与 status 解耦）。
   * 仅在 status === 'pending_approval' 后用户已响应时存在；
   * undefined 表示未走过审批路径或用户尚未响应。
   * 调用方据此区分「拒绝」与「执行失败」两种语义。
   */
  approvalDecision?: MessageToolCallApprovalDecision | undefined;
  /** 开始执行时刻（epoch ms） */
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  durationMs?: number | undefined;
  /** 完成时刻（epoch ms） */
  completedAt?: number | undefined;
  /** 同一轮并行调用的 turn 标识 */
  turnId?: string | undefined;
}

/**
 * MessageToolCall 的「输入形态」：所有可选字段允许显式 undefined。
 * 适用于从原始事件流构造 toolCall 时部分字段尚未提供的场景。
 * 转入 store 前应使用 compactObj 剔除 undefined 字段，得到 MessageToolCall。
 */
export interface MessageToolCallInput {
  id: string;
  name: string;
  arguments: string;
  status: MessageToolCallStatus;
  output?: string | undefined;
  diffs?: FileDiff[] | undefined;
  explanation?: string | undefined;
  approvalMeta?: MessageToolApprovalMetaInput | undefined;
  approvalDecision?: MessageToolCallApprovalDecision | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  turnId?: string | undefined;
}

/** 消息发送方 */
export type MessageSender = 'user' | 'assistant';

/**
 * 用户/助手消息处理状态（可选）。
 * queued=排队待发; processing=流式中; completed=终态（成功收口，不含 error 枚举）。
 */
export type SessionMessageStatus = 'queued' | 'processing' | 'completed' | 'error';

/**
 * 工具调用结果回执：当一条消息是工具调用的「结果回执」时，
 * 通过 toolCallResults 关联到对应的 toolCall.id。
 *
 * 设计动机：
 *   - 助手消息携带 toolCalls（调用发起）
 *   - 后续消息（user 或 tool 角色）可能携带 toolCallResults（调用结果）
 *   - 消息淘汰时需要识别配对的「调用 + 结果」消息，一并清理避免孤儿结果
 *
 * 字段：
 *   - id：对应 MessageToolCall.id（必填，用于配对）
 *   - output：结果输出文本（可选）
 *   - isError：是否为错误结果（可选）
 */
export interface SessionMessageToolCallResult {
  /** 对应 MessageToolCall.id */
  id: string;
  /** 结果输出文本（可选） */
  output?: string;
  /** 是否为错误结果（可选） */
  isError?: boolean;
}

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

/**
 * SessionMessage 的「输入形态」：从原始事件流构造消息时，
 * 字段值可能为 undefined（事件未携带）。转入 store 前应使用 compactObj
 * 剔除 undefined 字段，得到结构干净的 SessionMessage。
 *
 * 字段语义与 SessionMessage 一一对应，仅是允许显式 undefined。
 */
export interface SessionMessageInput {
  id: string;
  sender: MessageSender;
  text?: string | undefined;
  thinking?: string | undefined;
  timestamp: number;
  toolCalls?: MessageToolCallInput[] | undefined;
  status?: SessionMessageStatus | undefined;
  blocks?: MessageTimelineBlock[] | undefined;
  streamTextOffset?: number | undefined;
  thinkingTime?: number | undefined;
  toolCallResults?: SessionMessageToolCallResult[] | undefined;
}

/** 会话内一条用户或助手消息 */
export interface SessionMessage {
  id: string;
  sender: MessageSender;
  text?: string | undefined;
  /** 流式思考过程，与正式正文分离，避免互相覆盖 */
  thinking?: string | undefined;
  /** epoch ms */
  timestamp: number;
  toolCalls?: MessageToolCall[] | undefined;
  status?: SessionMessageStatus | undefined;
  /** 预计算 HTML 缓存（Worker 异步 markdown 渲染结果） */
  precomputedHtml?: string | undefined;
  /**
   * 工具调用结果回执：本消息作为某些 toolCall 的结果时，
   * 列出对应 toolCall.id。用于消息淘汰时识别「调用 + 结果」配对一并清理。
   */
  toolCallResults?: SessionMessageToolCallResult[] | undefined;
  /**
   * 时间线：按发生顺序交错 text / tool_call。
   * 流式累计正文用 streamTextOffset 切分到当前 text 段。
   */
  blocks?: MessageTimelineBlock[] | undefined;
  /** 上一工具插入时 text 的长度，用于把累计正文切成段 */
  streamTextOffset?: number | undefined;
  /** 思考耗时（秒或 ms，由 setSessionMessageStatus 写入侧约定） */
  thinkingTime?: number | undefined;
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
  endedAt?: number | undefined;
  /** 嵌套深度：0=主会话直接子 agent，n=第 n+1 级嵌套子 agent */
  depth?: number | undefined;
  /** 从根 agent 到当前 agent 的 id 路径链（含自身），用于树结构追踪 */
  subagentPath?: string[] | undefined;
}

/**
 * SessionAgent 的「输入形态」：从原始事件构造时部分字段可能为 undefined。
 * 转入 store 前应使用 compactObj 剔除 undefined 字段，得到 SessionAgent。
 */
export interface SessionAgentInput {
  id: string;
  subagentRunId: string;
  parentSessionId: string;
  parentRunId: string;
  parentToolCallId?: string | undefined;
  description: string;
  mode: string;
  status: SessionAgentStatus;
  summary?: string | undefined;
  messages: SessionMessageInput[];
  startedAt: number | undefined;
  endedAt?: number | undefined;
  depth?: number | undefined;
  subagentPath?: string[] | undefined;
}

/**
 * SessionAgent 的「可 patch 字段白名单」。
 *
 * 设计动机：
 *   - {@link SessionAgent} 中 id / parentSessionId / parentRunId 是创建时确定的不可变身份字段，
 *     禁止通过 patchSessionAgent 修改
 *   - messages 是数组结构，应通过 appendSessionAgentMessage 增量更新，禁止整段覆盖
 *   - 仅允许更新生命周期与展示字段（status / summary / endedAt / description 等）
 *   - subagentRunId 例外：daemon 异步确认 run 时回填，仅允许由 onRunMeta 路径写入一次
 *
 * 治理防线 #1（类型逃逸）：用白名单类型替代 `Partial<SessionAgent>` + Object.assign，
 * 编译期即杜绝任意 key 写入。
 */
export interface SessionAgentPatch {
  /** agent 生命周期状态（running / completed / failed / stopped） */
  status?: SessionAgentStatus;
  /** 完成摘要（completed / failed / stopped 时由引擎或调用方写入） */
  summary?: string;
  /** 结束时刻 epoch ms（终态写入；running 时缺省） */
  endedAt?: number;
  /** 当前阶段描述（可随执行进度更新） */
  description?: string;
  /** 嵌套深度（极少 patch；保留以备父 agent 重链时调整） */
  depth?: number;
  /** 子 agent 路径链（极少 patch；保留以备父 agent 重链时调整） */
  subagentPath?: string[];
  /**
   * 子 agent 的 runId（由 daemon 在 onRunMeta 事件中异步回填）。
   *
   * 治理防线 #1（身份字段例外）：
   *   - id / parentSessionId / parentRunId 在 upsertSessionAgent 时一次性确定，永不 patch
   *   - subagentRunId 由于 daemon 协议设计：onSubagentStarted 先创建本地 agent（占位 runId），
   *     onRunMeta 随后回填真实 runId——是合法的「创建后一次性写入」字段
   *   - 调用方应仅在 onRunMeta 路径写入；重复写入以最后一次为准（daemon runId 不会变更）
   */
  subagentRunId?: string;
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
 * 会话时间戳来源标记。
 *
 * 治理防线 #6（数据水合与时间戳类型漂移）& #35（状态枚举语义重载）：
 *   - 旧实现中 `SessionState.timestamp` 字段同时承载 ISO 时间串与 `'远程'` 字面量，
 *     既破坏类型语义又导致下游相对时间计算（`刚刚` / `5 分钟前`）拿到非数字 → NaN
 *   - 改用独立 `timestampSource` discriminator 字段标记来源；timestamp 始终是 ISO 串
 *   - 侧栏显示层根据 source 决定渲染「远程」徽标还是相对时间
 */
export type SessionTimestampSource = 'local' | 'remote';

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
  /**
   * ISO 时间串（侧栏相对时间计算源）。
   * 始终为合法 ISO 串，禁止写入「刚刚」/「远程」等字面量。
   * 来源由 {@link timestampSource} 标记；远程会话水合后由显示层根据 source 渲染徽标。
   */
  timestamp: string;
  /**
   * 时间戳来源标记。
   * - local：本机创建 / 本机活动触达更新（缺省）
   * - remote：远程引擎水合后写入（侧栏展示「远程」徽标，相对时间仍由 timestamp 计算）
   */
  timestampSource?: SessionTimestampSource;
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
  /** 已被截断的工具链 id 列表 */
  truncatedToolChainIds?: string[];
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

/**
 * 流式渲染运行态：仅承载与「正在流式输出的消息」相关的临时渲染指针。
 *
 * 设计动机：
 *   - SessionMessage.streamTextOffset 是「消息自身持久化字段」，用于回放历史时切分 text 段
 *   - StreamingMessageRenderState 是「会话级运行态」，由 session-actions 在工具插入 /
 *     文本更新时同步维护，避免反复在 message 上读改写
 *   - 二者语义相关但用途不同：前者是数据快照，后者是当前流式上下文
 *
 * 字段：
 *   - streamTextOffset：当前已切分到 text 段的起始偏移；当文本被截断或回退时重置为 0
 */
export interface StreamingMessageRenderState {
  streamTextOffset: number;
}
