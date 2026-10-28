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
import type { SessionAgentRuntimeMeta } from './sessionAgentRuntimeMeta';
// 维度 3 步骤 1（3-D 第 1 步）：斩断 types.ts → generated/engine 深路径。
// 原先 `import type { AgentMessage } from '../../../../packages/shared-types/src/generated/engine'`
// 是跨包深路径直引；现统一经 @crish/shared-types 公共面。
// 注意：@crish/shared-types 顶层 `AgentMessage` 绑定到 ./message 版本
// （metadata: JsonObject、无 content），与本文件原先取的 generated 版
// （metadata: JsonValue、含 content?: string）字段不对齐。故经 `EngineAgentMessage`
// 别名取 generated 版（与 shared-types/index.ts 的 alias 一致），本地仍用
// `AgentMessage` 名以保持下游引用面稳定。
import type {
  EngineAgentMessage as AgentMessage,
  MessageCacheState,
} from '@crish/shared-types';
export type AppSettings = Settings;
export type GroupState = {
  id: string;
  cards: CardState[];
  activeCardId: string | null;
};

// prettier-ignore
export type SettingsTabType =
  | 'profile' | 'appearance' | 'personalize' | 'models' | 'usage'
  | 'devices' | 'schedule' | 'rules' | 'shortcuts' | 'skills'
  | 'mcp' | 'plugins' | 'browser' | 'security' | 'diagnostics'
  | 'archive' | 'about';

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
  /** 重命名旧路径（若存在） */
  oldPath?: string;
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
  /** 临时/预测 diff 标记（未落盘/不可直接 accept） */
  provisional?: boolean;
}

// ── CronJob 形态（layout scheduledTasks / RuntimePanel；与 clientApi 结构兼容）──

// ── 消息 / 工具 / 审批 ─────────────────────────────────────────────────────

/**
 * 审批风险等级（BE-04 展示用，可选字段）。
 * 与 approvalMeta.ApprovalRiskLevel 取值一致；store 侧全可选，解析后再收成完整 meta。
 */
type MessageApprovalRiskLevel =
  'low' | 'medium' | 'high' | 'critical' | 'unknown';

/** 审批风险来源：后端事实 / 派生 / 未知 */
type MessageApprovalRiskSource = 'backend' | 'derived' | 'unknown';

/** 后端审批风险事实（BE-04）；仅展示，不按工具名猜 */
export interface MessageToolApprovalMeta {
  trustZone?: string;
  risk?: string;
  riskReason?: string;
  riskLevel?: MessageApprovalRiskLevel;
  requiresDoubleConfirm?: boolean;
  recommendSnapshot?: boolean;
  source?: MessageApprovalRiskSource;
  /** S9 审批载荷（revertGate 面积 / 删除影响面），宽容缺失 */
  payload?: MessageToolApprovalPayload;
  /** 原始审批 metadata（倒计时 / 超时策略 / 判点原因，卡片透传展示） */
  metadata?: Record<string, unknown>;
}

/** 回退面积（C3/S6 载荷；字段可空 = 未知，与 revert.rs RevertArea 对齐） */
interface RevertAreaPayload {
  fileCount?: number | null;
  lineCount?: number | null;
  crossDirectory?: boolean | null;
  refAgeSeconds?: number | null;
}

/** 回退审批载荷（revert.rs approval_payload 的 revertGate 形状） */
export interface RevertGatePayload {
  form?: string | null;
  targetRef?: string | null;
  target?: string | null;
  area?: RevertAreaPayload | null;
  thresholds?: {
    maxFiles?: number | null;
    maxLines?: number | null;
    maxRefAgeHours?: number | null;
  } | null;
  /** 审批人标注（C3：裁决权归用户；engine 侧恒为 "user"） */
  approver?: string | null;
  /** 拒绝/载荷统一指引（与 S6 拒绝文案同源） */
  guidance?: string | null;
}

/** 删除影响面（S8 ImpactAssessment；字段可空 = 未知） */
interface DeleteImpactPayload {
  fileCount?: number | null;
  totalSizeBytes?: number | null;
  directoryCount?: number | null;
  crossDirectory?: boolean | null;
  flagged?: boolean | null;
}

/** 删除类审批载荷（delete_file/delete_dir 调用：目标清单 + 影响面） */
export interface DeleteApprovalPayload {
  /** 删除目标路径清单（从工具参数提取） */
  targets: string[];
  /** 影响面（S8 事件载荷；缺失 = 未上报，前端宽容降级） */
  impact?: DeleteImpactPayload | null;
}

/**
 * S9 审批弹窗数据源载荷（宽容解析自 approval-requested 事件）。
 * kind 为判别：revert-gate = 大面积回退审批；delete = 删除确认。
 */
export type MessageToolApprovalPayload =
  | { kind: 'revert-gate'; revertGate: RevertGatePayload }
  | { kind: 'delete'; deleteImpact: DeleteApprovalPayload }
  | { kind: 'unknown' };

// ── 图片引用 ───────────────────────────────────────────────────────────────

/**
 * 结构化图片引用。
 *
 * 设计动机：
 *   - 流式期间从 Markdown/工具输出中增量解析出图片占位，避免每帧全量 reflow
 *   - source 是原始来源（路径/URL/data URI/SVG 文本），id 为 source hash 用于去重
 *   - status 字段支撑异步解析：pending → resolved/error（如本地文件转 blob URL）
 *   - originToolCallId 关联产出该图片的工具调用，便于溯源与按工具分组展示
 *
 * 与 extractImageRefs 的关系：
 *   旧路径返回 string[]（原始来源串），新路径用 MessageImageRef 承载结构化状态，
 *   流式与终态共享同一形状，避免视图层二次归一化。
 */
export interface MessageImageRef {
  /** source hash，用于去重与稳定 key */
  id: string;
  /** 原始来源：本地路径 / http(s) URL / data URI / SVG 文本 / 不安全串 */
  source: string;
  /** 来源类别，决定解析路径与渲染策略 */
  kind: 'local' | 'http' | 'data' | 'svg' | 'unsafe';
  /** 异步解析完成后的可渲染 URL（blob: / object URL / 远端 URL） */
  resolvedUrl?: string;
  /** 异步解析状态；缺省视为 pending */
  status?: 'pending' | 'resolved' | 'error';
  /** MIME 类型（如 image/png），用于选择渲染器与降级 */
  mime?: string;
  /** alt 文本（无障碍 / 加载失败时展示） */
  alt?: string;
  /** 产出该图片的工具调用 id（便于溯源与按工具分组） */
  originToolCallId?: string;
  /** 字节大小（用于配额展示/日志；可能缺省） */
  byteSize?: number;
  /**
   * 工作区外绝对路径已脱敏为 basename。
   * 只读展示用；不可反解为完整本机路径。
   */
  pathRedacted?: boolean;
  /**
   * dataUrl 内容哈希线索（非加密，仅稳定对照/去重）。
   * 刻意不含 dataUrl 本体；不得回写进 prompt。
   */
  contentHint?: string;
}

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
  'running' | 'success' | 'error' | 'pending_approval';

/**
 * 用户审批决定（与工具执行结果解耦）。
 * - approved：用户批准，工具继续执行
 * - rejected：用户拒绝，工具不会执行（与工具执行失败 status='error' 语义不同）
 */
export type MessageToolCallApprovalDecision = 'approved' | 'rejected';

/**
 * 结构化图片引用（替代在 output 字符串里塞路径/base64）。
 * 用于 AI 输出图片的结构化传递。
 */
export interface MessageImageRef {
  /** 唯一 id（基于 source 哈希，用于 React key、缓存、去重） */
  id: string;
  /** 原始来源：本地路径 / http URL / data URL / 工具临时文件路径 */
  source: string;
  /** 来源类型判别（前端据此选择解析策略） */
  kind: 'local' | 'http' | 'data' | 'svg' | 'unsafe';
  /** 解析后可直接写入 <img src> 的 URL（asset:// / data: / http://） */
  resolvedUrl?: string;
  /** 解析状态（流式期间异步解析） */
  status?: 'pending' | 'resolved' | 'error';
  /** MIME（用于安全判定） */
  mime?: string;
  /** 展示用 alt 文本 */
  alt?: string;
  /** 来源工具调用 id（便于追溯） */
  originToolCallId?: string;
  /** 字节大小（用于限制） */
  byteSize?: number;
  /** 图片宽度（可选，用于布局） */
  width?: number;
  /** 图片高度（可选，用于布局） */
  height?: number;
  /** 工作区外绝对路径已脱敏为 basename（只读展示） */
  pathRedacted?: boolean;
  /** dataUrl 内容哈希线索（非加密；不含 dataUrl 本体） */
  contentHint?: string;
}

/** 消息附件（用户发送的图片/文本/代码/文件） */
export interface SessionMessageAttachment {
  name: string;
  path?: string;
  mime?: string;
  text?: string;
  dataUrl?: string;
  /** 工作区外绝对路径已脱敏为 basename（只读展示；新写路径必脱敏） */
  pathRedacted?: boolean;
}

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
  /** 结构化图片输出（替代在 output 字符串中塞图片） */
  images?: MessageImageRef[] | undefined;
}

/** 消息发送方 */
export type MessageSender = 'user' | 'assistant';

/**
 * 用户/助手消息处理状态（可选）。
 * queued=排队待发; processing=流式中; completed=终态（成功收口，不含 error 枚举）。
 */
export type SessionMessageStatus =
  'queued' | 'processing' | 'completed' | 'error';

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

// ── 可见上下文注入卡片契约（Prompt 注入管线 · 全战役唯一卡片契约）────────────

/** 上下文注入来源分类（9 类，snake_case；SSOT：docs/prompt-injection-pipeline 00 总方案 §三） */
export type ContextInjectionKind =
  /** 项目/全局规则注入（AGENTS.md、安全基线） */
  | 'rule'
  /** 专家技能/提示词模板注入（antigravity-guide 等） */
  | 'skill'
  /** 文件引用与代码快照（@file、代码选区） */
  | 'file_context'
  /** Git 工作区状态与改动快照（Diff、分支状态） */
  | 'git_status'
  /** 终端历史上下文与命令回执（错误日志、测试失败输出） */
  | 'terminal_output'
  /** 运行时纠偏与目标模式指令（/goal 状态、steering） */
  | 'runtime_steering'
  /** 定时任务/助手模式唤醒元数据（/schedule、Workflow Grill-Me） */
  | 'schedule_trigger'
  /** 会话记忆与阶段性总结 */
  | 'memory'
  /** 工作区目录拓扑与运行环境契约 */
  | 'workspace_env';

/** 注入项生命周期状态（5 态） */
export type ContextInjectionStatus =
  /** 准备注入（待下发/校验中） */
  | 'pending'
  /** 已成功注入当前 Turn 上下文（活跃生效） */
  | 'injected'
  /** 持续跨轮次生效中（Persistent，如持久规则） */
  | 'active'
  /** 已过期/单次有效已消费（随时间线推进沉淀为历史） */
  | 'expired'
  /** 注入失败（如 Token 超限熔断 / 文件读取错误；卡片标红 + 重试） */
  | 'failed';

/**
 * 上下文状态切换（Context State Switch）结构化元数据标准契约（SSOT 单一真理源）。
 * 取代基于字符串正则匹配（regex scraping）的脆弱打补丁模式，建立类型化元数据。
 */
export interface ContextStateMetadata {
  mode: 'context-state';
  model: string;
  profile?: string;
  permission?: string;
  thinking?: string;
  [key: string]: unknown;
}

/**
 * 统一可见上下文注入卡片实体（对话流一等公民，同构于 ToolCard）。
 * 对应对话流中独立呈现的可见注入卡片，无需 AI 主动调用，由系统直接注入。
 * 字段名契约：`summary`（非 description）、`tokenEstimate`（非 estimatedTokens）。
 */
export interface MessageContextInjection {
  /** 唯一标识符（UUID 或基于内容哈希） */
  id: string;
  /** 注入分类 */
  kind: ContextInjectionKind;
  /** 卡片展示标题（如 "规则注入: AGENTS.md"） */
  title: string;
  /** 简明副标题/摘要（展示于卡片 Header 右侧） */
  summary?: string;
  /** 当前生命周期状态 */
  status: ContextInjectionStatus;
  /** 注入源标识（如 "rule_loader" / "slash_command" / "schedule_panel"） */
  source: string;
  /** 核心正文内容（Markdown / 代码 / 结构化文本） */
  content: string;
  /** 估算的 Token 消耗量（用于 Token 胶囊展示；可能缺省） */
  tokenEstimate?: number;
  /** 关联的文件 Diff 快照列表（可选） */
  diffs?: FileDiff[];
  /** 关联的目标文件路径列表（可选） */
  targetPaths?: string[];
  /** 注入发生时间戳（epoch ms） */
  timestamp: number;
  /** 是否支持展开查看详情（默认 true） */
  isFoldable?: boolean;
  /** 初始是否默认折叠（内容 > 160 字符默认 true） */
  defaultFolded?: boolean;
  /** 失败时的错误诊断信息（status='failed' 时展示） */
  errorMessage?: string;
  /** 结构化扩展元数据（状态切换契约 ContextStateMetadata / 附件截断 / 退出码等） */
  metadata?: Record<string, unknown>;
}

/** 时间线块类型：思维链段 / 正文段 / 工具调用锚点 / 系统注入卡片 / 图片块 / 步骤标记 */
export type MessageTimelineBlockType =
  | 'thought'
  | 'text'
  | 'tool_call'
  | 'context_injection' // 新增：系统上下文注入卡片一等公民
  | 'image'
  | 'step_start'
  | 'step_end';

/**
 * 消息时间线块（按发生顺序交错 thought / text / tool_call / image / context_injection）。
 * - thought：单步思考块（一等公民），content 承载思考文本，turnIndex 标记轮次
 * - text：content 为该段正文；流式时由 streamTextOffset 切分
 * - tool_call：id 对齐 MessageToolCall.id；content 可选摘要
 * - context_injection：id 对齐 MessageContextInjection.id；也可直接挂 injection 全量载荷
 * - image：images 承载结构化图片引用
 */
export interface MessageTimelineBlock {
  type: MessageTimelineBlockType;
  /** tool_call 时对应 toolCall.id；context_injection 时对应 injection.id；thought 时对应 stepId/thoughtId */
  id?: string;
  /** 文本或思考内容 */
  content?: string;
  /** 关联的轮次索引 (0-based) */
  turnIndex?: number;
  /** 起始时间（epoch ms） */
  startTime?: number;
  /** 思考/执行耗时（毫秒） */
  durationMs?: number;
  /** 是否处于流式中 */
  isStreaming?: boolean;
  /** 是否已折叠（历史步骤默认折叠） */
  isHistoricalCollapsed?: boolean;
  /** 是否已被模型安全标记截断 */
  redacted?: boolean;
  /** type === 'image' 时承载结构化图片引用 */
  images?: MessageImageRef[];
  /** type === 'context_injection' 时挂载的结构化数据（或经 id 从 injections 查表） */
  injection?: MessageContextInjection;
}

export interface TimelineThoughtBlock extends MessageTimelineBlock {
  type: 'thought';
  thinkingText?: string;
}

/**
 * 会话内一条用户或助手消息。
 *
 * T3 单源化：`SessionMessage` 是「从 generated AgentMessage 派生的投影装饰」——
 * 身份/溯源字段（id / clientMessageId / metadata）从 generated 派生（extends），
 * 其余为前端投影装饰超集字段（sender / text / thinking / toolCalls / blocks /
 * cacheMetrics 等，generated 无等价物，保留不降级）。禁止用 `type SessionMessage =
 * AgentMessage` 纯别名丢弃超集。消费方字段名不变（引用面稳定）。
 */
export interface SessionMessage extends Pick<
  AgentMessage,
  'id' | 'clientMessageId'
> {
  sender: MessageSender;
  text?: string | undefined;
  /** 消息溯源元数据（generated AgentMessage.metadata 的 flat 承继；避免递归 JsonValue 触 immer draft 命名问题） */
  metadata?: unknown | undefined;
  /** 流式思考过程，与正式正文分离，避免互相覆盖 */
  thinking?: string | undefined;
  /** 结构化思考分段列表（支持多轮回放与交错还原） */
  thinkingTurns?: Array<{
    turnIndex: number;
    content: string;
    durationMs?: number;
    id?: string;
    isStreaming?: boolean;
  }>;
  /** epoch ms */
  timestamp: number;
  /** 引擎事件/持久化存储序列号（因果第一主序键） */
  engineSequence?: number | undefined;
  /** 会话内单调消息序列号（SQLite 消息行主键 seq） */
  seq?: number | undefined;
  toolCalls?: MessageToolCall[] | undefined;
  status?: SessionMessageStatus | undefined;
  /** 预计算 HTML 缓存（Worker 异步 markdown 渲染结果） */
  precomputedHtml?: string | undefined;
  /**
   * 工具调用结果回执：本消息作为某些 toolCall 的结果时，
   * 列出对应 toolCall.id。用于消息淘汰时识别「调用 + 结果」配对一并清理。
   */
  toolCallResults?: SessionMessageToolCallResult[] | undefined;
  /** 本条消息包含的系统上下文注入项集合（与 blocks 中 context_injection 块按 id 对应） */
  injections?: MessageContextInjection[] | undefined;
  /**
   * 时间线：按发生顺序交错 thought / text / tool_call。
   * 流式累计正文用 streamTextOffset 切分到当前 text 段。
   */
  blocks?: MessageTimelineBlock[] | undefined;
  /** 上一工具插入时 text 的长度，用于把累计正文切成段 */
  streamTextOffset?: number | undefined;
  /** 思考耗时（秒或 ms，由 setSessionMessageStatus 写入侧约定） */
  thinkingTime?: number | undefined;
  /** 本条消息中所有图片的结构化索引（跨 text block + tool call 汇总） */
  images?: MessageImageRef[] | undefined;
  /** 本条消息携带的附件信息（用户上传或拖拽的图片/文件/代码段） */
  attachments?: SessionMessageAttachment[] | undefined;
  /**
   * 运行错误诊断详情（历史字段）。
   * @deprecated 只读兼容：新错误展示已单轨收敛至
   * SessionRuntimeStatusStore（ComposerErrorBar / InFlowStatusLine），
   * 本字段不再被任何 UI 渲染，也不再被写入。
   * @see useSessionRuntimeStatusStore
   */
  errorDetail?:
    | {
        message: string;
        kind: string;
        technical?: string;
      }
    | undefined;
  /**
   * 消息级缓存指标（T-48；P6 `MessageCacheState` 契约）。
   * null / undefined = 老数据或引擎未上报 → 渲染层隐藏（不显示 0% 误导，C15）；
   * 写入侧：message-end → computeCacheMetricsFromUsage → 本字段（messageHandlers）。
   */
  cacheMetrics?: MessageCacheState | null;
}

/**
 * 协作子 agent 状态。
 * stopped=用户停止/取消（非失败）；failed=异常失败。
 */
type SessionAgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** 主会话下的协作子 agent（run_subagent） */
export interface SessionAgent extends SessionAgentRuntimeMeta {
  id: string;
  subagentRunId: string;
  parentSessionId: string;
  parentRunId: string;
  parentToolCallId?: string;
  /**
   * 自由文本角色标签（T-D-05 display_label；2-5 字，仅展示不影响调度）。
   * 展示名兜底链优先取本字段：displayLabel → description → mode → id。
   * 缺省/空白视为未提供，由 agentCardUtils.agentDisplayName 等兜底。
   */
  displayLabel?: string;
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
  /** 错误分类标签（kebab-case，如 provider-error / timeout） */
  errorKind?: string | undefined;
  /** 已重试次数 */
  retries?: number | undefined;
  /** 是否需要用户人工介入 */
  needsUser?: boolean | undefined;
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
  /** 错误分类标签（kebab-case，如 provider-error / timeout） */
  errorKind?: string;
  /** 已重试次数 */
  retries?: number;
  /** 是否需要用户人工介入 */
  needsUser?: boolean;
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
  status?: 'active' | 'completed' | 'blocked' | undefined;
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
type SessionTimestampSource = 'local' | 'remote';

/**
 * 外部会话导入溯源（Claude Code / Codex）。
 * 单可选字段挂在 SessionState，避免 schema 膨胀；用于软去重（source + sourceSessionId）。
 */
export type SessionImportMeta = {
  source: 'claude-code' | 'codex';
  sourceSessionId: string;
  /** 源文件路径（可选，仅展示/调试） */
  sourcePath?: string;
  /** 导入时间 ISO */
  importedAt?: string;
};

/**
 * 侧栏/主区会话权威形状（sessions[] 与 sessionsById 同引用）。
 * 持久化索引字段见 sessionPersistence.SessionIndexEntry（子集 + messageCount 等）。
 */
export interface SessionState {
  id: string;
  title: string;
  titleSource?: 'auto-trivial' | 'auto' | 'user';
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
  /** 本会话固定消息对应的自定义/预设颜色映射（messageId -> hex color） */
  pinnedMessageColors?: Record<string, string>;
  /** 本会话拉起的协作 agent 列表（侧栏嵌套展示） */
  agents?: SessionAgent[];
  /** 引擎事件游标（H2 水合 / H3 增量） */
  engineCursor?: number;
  /** 最近 runId，H3 可拉 snapshot usage */
  engineLastRunId?: string;
  /** 已从引擎补全过正文 */
  hydratedFromEngine?: boolean;
  /** 标记该会话是否已经完成从底层 SQLite/Engine 的消息回灌或用户显式清空操作 */
  messagesHydrated?: boolean;
  /**
   * 索引层消息计数（Stage 5b ACT-502）：懒壳未拉正文时供剪枝兼容判定
   * 「未水合但有实质内容」（prepareSessionsForUi keepIds 扩展用）。
   */
  messageCount?: number;
  /** 是否存在未加载的更早历史消息（窗口化懒水合协议） */
  hasOlderMessages?: boolean | undefined;
  /** 当前已水合窗口中最旧一条消息的序列号（供向前拉取契约） */
  oldestLoadedSeq?: number | undefined;
  /**
   * 引擎懒水合「未完整」标记（P1-D2）：hydrate 分页拉全超限/异常截断时置位。
   * 置位期间持久化熔断——禁止截断态正文经 save_session_body 先删后插回写 SQLite
   * （不可逆）；分页拉全成功（truncated=false）时自然清除。
   */
  hydrateTruncated?: boolean;
  /** /goal 目标模式状态（会话级） */
  goalMode?: SessionGoalMode;
  /** 已被截断的工具链 id 列表 */
  truncatedToolChainIds?: string[];
  /**
   * 外部导入溯源。有值时表示该会话由 Claude Code / Codex 导入；
   * 再导入同一 source+sourceSessionId 时软跳过。
   */
  importMeta?: SessionImportMeta;
}

/** 标签拖拽落点预览方向 */
export type DropPreviewDirection =
  'top' | 'bottom' | 'left' | 'right' | 'merge';

/** 工作区 DnD 落点预览（null 表示无预览） */
export interface DropPreviewState {
  colIdx: number;
  groupIdx: number;
  direction: DropPreviewDirection;
  // 可选像素坐标（由调用方计算填入后用于渲染）
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  className?: string;
}

// ── T14 迁移面补全（components 直引 store/ 的白名单类型入口）──────────────
// components 的类型导入统一走本文件（05-detail ④ 白名单三入口之一）：
// 此前经 '../store/layoutStore' 等直引的类型在此集中 re-export，
// 避免 components 触碰 store 内部模块路径。

export type {
  LayoutLeaf,
  LayoutNode,
  FlatBranch,
  DropDirection,
} from './layout-tree/types';
export type { Rect } from './layout-tree/geometry';
export type { LayoutStore } from './layoutStore';
export type { DraggedTabState } from './workspaceStore';
