/**
 * 增量状态机引擎核心契约定义 (Conversation Assembler Contracts)
 *
 * 依据: docs/linear-chat-stream-convergence/01-维度详案-数据链路单轨化与列表Props解耦.md §1.1
 * 确立单轨真理源（SSOT），支撑单调序列号窗口、动态 Definition 认领、同帧排他 Echo 互斥物化与不可变快照输出。
 */

/**
 * 会话底层事件信封
 * 携带单调递增序列号与上下文路由信息的标准数据载荷
 */
export interface SessionEventEnvelope {
  /** 单调递增事件序列号（会话内局部严格自增） */
  readonly seq: number;
  /** 活跃会话 ID */
  readonly sessionId: string;
  /** 执行任务 run ID */
  readonly runId?: string;
  /** 轮次 turn 索引或 ID */
  readonly turnId?: string;
  /** 客户端发问请求 ID（用于 echo 互斥匹配） */
  readonly clientMessageId?: string;
  /** 事件类型名（如 'chunk' | 'thought' | 'tool_call' | 'tool_result' | 'message_end' | 'error'） */
  readonly type: string;
  /** 事件原始负载数据 */
  readonly payload: unknown;
  /** 发生时间戳 (毫秒) */
  readonly timestamp: number;
}

/**
 * 节点物化与发布节奏枚举
 * - 'none': 仅更新内部内存状态，不触发视图快照发布与渲染
 * - 'animation-frame': 节流合帧发布（如 3-RAF 批量合流），平抑高频打字/思考链渲染压力
 * - 'immediate': 关键终态事件（如 message_end, tool_call_started, error）同步零延迟物化发布
 */
export type PublicationRhythm = 'none' | 'animation-frame' | 'immediate';

/**
 * 视图节点通用接口定义
 * 提供给虚拟滚动列表与渲染座席（ChatNodeSeat）的不可变只读投影
 */
export interface ConversationNodeViewData {
  /** 节点全局唯一 ID */
  readonly id: string;
  /** 客户端发问 ID (rpcId)，用于同帧排他互斥匹配 */
  readonly rpcId?: string;
  /** 节点领域类型分类 */
  readonly kind: 'user' | 'assistant' | 'thought' | 'tool' | 'turn-process' | 'user-echo' | 'injection' | (string & {});
  /** 消息发送方角色 */
  readonly sender: 'user' | 'assistant' | 'system';
  /** 节点时间戳 */
  readonly timestamp: number;
  /** 主要文本内容（可选） */
  readonly text?: string;
  /** 是否为本地发送回显气泡 */
  readonly isEcho?: boolean;
  /** 发送瞬态状态 */
  readonly submissionStatus?: 'pending' | 'submitting' | 'failed';
  /** 领域专有属性扩展槽 */
  readonly [key: string]: unknown;
}

/**
 * 单节点增量状态机定义契约 (Definition Pattern)
 * 解耦各类型节点的内存状态维护、增量折叠、发布节奏与视图物化逻辑
 */
export interface ConversationNodeDefinition<
  TState = unknown,
  TViewNode extends ConversationNodeViewData = ConversationNodeViewData
> {
  /** 节点领域唯一类型名 */
  readonly kind: string;

  /**
   * 提取或计算事件归属的节点键 (用于区分不同节点实例)
   * 若未实现，Assembler 将采用默认路由规则推导
   */
  getNodeKey?(event: SessionEventEnvelope): string;

  /** 是否认领该事件（判定事件归属） */
  match(event: SessionEventEnvelope): boolean;

  /** 事件首达，初始化该节点的不可变内存 State */
  start(event: SessionEventEnvelope): TState;

  /** 增量事件到达，纯函数折叠生成新不可变 State */
  update(prevState: TState, event: SessionEventEnvelope): TState;

  /** 声明本次状态跃迁后的物化发布节奏 */
  publication(nextState: TState, prevState: TState): PublicationRhythm;

  /** 将内部纯逻辑 State 物化为供视图渲染的不可变 ViewNode */
  buildViewNode(state: TState): TViewNode;
}

/**
 * 不可变视图快照
 * 单轨状态机物化后交付给 UI 渲染层的完整、冻结的只读快照
 */
export interface ConversationSnapshot {
  /** 有序节点 ID 列表（驱动虚拟滚动列表行排序） */
  readonly order: readonly string[];
  /** 节点 ID 到不可变视图节点的映射字典 (O(1) 检索) */
  readonly nodes: ReadonlyMap<string, ConversationNodeViewData>;
  /** 单调递增的版本修订号（便于外部快速浅比较变更） */
  readonly revision: number;
}

/**
 * 用户发问回显模型
 * 用于在后端持久化消息到达前，本地即时渲染乐观气泡并跟踪提交生命周期
 */
export interface SubmissionEcho {
  /** 本地唯一回显 ID */
  readonly echoId: string;
  /** 客户端发问请求 ID（即 clientMessageId），用于与后端持久消息同帧互斥 */
  readonly rpcId: string;
  /** 用户发问文本内容 */
  readonly prompt: string;
  /** 提交时间戳 */
  readonly timestamp: number;
  /** 发送生命周期状态 */
  readonly status: 'pending' | 'submitting' | 'failed';
  /** 失败原因详情（可选） */
  readonly error?: string;
}

/**
 * 序列号断裂（丢包/跳号）容灾记录
 */
export interface SequenceGapRecord {
  readonly expectedSeq: number;
  readonly receivedSeq: number;
  readonly timestamp: number;
}

/**
 * Assembler 运行时统计与告警指标
 */
export interface AssemblerMetrics {
  /** 已成功处理的有效事件总数 */
  processedEventCount: number;
  /** 经单调 seq 窗口判定为重复/过时并静默丢弃的事件数 */
  droppedDeduplicatedCount: number;
  /** 发生的序列号断裂（跳号）次数 */
  sequenceGapsCount: number;
  /** 当前最后处理的单调序列号 */
  lastProcessedSeq: number;
  /** 最近一次序列号断裂详细记录 */
  lastSequenceGap?: SequenceGapRecord;
}

/**
 * 事件处理结果
 */
export interface ProcessEventResult {
  /** 事件是否被有效处理接受 */
  readonly accepted: boolean;
  /** 本次事件处理触发的发布节奏 */
  readonly rhythm: PublicationRhythm;
  /** 归属的节点键（若匹配成功） */
  readonly nodeKey?: string;
  /** 处理结果详细原因 */
  readonly reason: 'duplicate_seq' | 'session_mismatch' | 'no_definition_match' | 'processed';
}

/**
 * 快照发布回调监听器
 */
export type SnapshotListener = (snapshot: ConversationSnapshot, rhythm: PublicationRhythm) => void;
