/**
 * ConversationAssembler 增量状态机引擎
 *
 * 依据: docs/linear-chat-stream-convergence/01-维度详案-数据链路单轨化与列表Props解耦.md §1.1, §1.3
 * 
 * 核心架构特性:
 * 1. 单轨真理源（Single Source of Truth, SSOT）: 统一折叠所有底层事件，彻底清退多套账死局。
 * 2. Monotonic Sequence Window: 滑动序列号单调性校验与幂等去重拦截（seq <= lastProcessedSeq 静默丢弃，窗口断裂记录容灾）。
 * 3. Definition Pattern 动态认领: 遍历注册的 ConversationNodeDefinition，执行 match -> start / update -> publication。
 * 4. 延迟增量物化与引用复用: 仅在脏标记节点上执行 buildViewNode，未变更节点保持对象引用恒定。
 * 5. clientMessageId (rpcId) Echo 同帧排他物化: 彻底终结发送瞬态双气泡与高度突跳。
 * 6. 不可变快照输出: ConversationSnapshot（order, nodes Map, revision）全量冻结，杜绝视图层逆向篡改。
 */

import type {
  AssemblerMetrics,
  ConversationNodeDefinition,
  ConversationNodeViewData,
  ConversationSnapshot,
  ProcessEventResult,
  PublicationRhythm,
  SessionEventEnvelope,
  SnapshotListener,
  SubmissionEcho,
} from './types';

/**
 * 状态机初始化配置项
 */
export interface ConversationAssemblerOptions {
  /** 绑定的会话 ID（若提供，将校验并拒绝跨会话事件） */
  readonly sessionId?: string;
  /** 预置注册的节点状态机定义列表 */
  readonly definitions?: readonly ConversationNodeDefinition<any, any>[];
  /** 初始序列号基线（默认 0） */
  readonly initialSeq?: number;
  /** 快照发布回调监听器 */
  readonly onSnapshot?: SnapshotListener;
}

interface NodeStateEntry {
  readonly definition: ConversationNodeDefinition<any, any>;
  state: unknown;
  readonly nodeKey: string;
}

/**
 * 快照物化同帧互斥纯函数
 * 当且仅当 durableNodes 中尚未出现该 rpcId 时，才放行 echo 节点挂载进快照。
 * 保证在持久化节点到位的同帧内，本地回显气泡被排他抹除，实现零双气泡瞬态。
 */
export function buildSnapshotWithEchoExclusion(
  durableNodes: readonly ConversationNodeViewData[],
  pendingEchoes: readonly SubmissionEcho[],
  revision: number = Date.now()
): ConversationSnapshot {
  // 1. 构建已落定持久消息的 rpcId 与 id 检索集合 (O(1) 查找)
  const durableRpcSet = new Set<string>();
  for (const node of durableNodes) {
    if (node.rpcId) {
      durableRpcSet.add(node.rpcId);
    }
    durableRpcSet.add(node.id);
  }

  // 2. 过滤回显：持久化集合中已存在的 rpcId，当帧绝对抑制
  const activeEchoNodes: ConversationNodeViewData[] = [];
  for (const echo of pendingEchoes) {
    if (!durableRpcSet.has(echo.rpcId)) {
      const echoId = echo.echoId.startsWith('echo:') ? echo.echoId : `echo:${echo.echoId}`;
      activeEchoNodes.push(
        Object.freeze({
          id: echoId,
          rpcId: echo.rpcId,
          kind: 'user-echo',
          sender: 'user',
          text: echo.prompt,
          timestamp: echo.timestamp,
          isEcho: true,
          submissionStatus: echo.status,
          ...(echo.error ? { error: echo.error } : {}),
        })
      );
    }
  }

  // 3. 组合为单一有序视图序列
  const combinedNodes = [...durableNodes, ...activeEchoNodes];
  const order = Object.freeze(combinedNodes.map((n) => n.id));
  const nodeMap = new Map<string, ConversationNodeViewData>(
    combinedNodes.map((n) => [n.id, n])
  );

  // 封禁运行时篡改 Map 的风险，履行严格不可变性
  nodeMap.set = () => {
    throw new Error('Cannot modify read-only ConversationSnapshot.nodes');
  };
  nodeMap.delete = () => {
    throw new Error('Cannot modify read-only ConversationSnapshot.nodes');
  };
  nodeMap.clear = () => {
    throw new Error('Cannot modify read-only ConversationSnapshot.nodes');
  };
  Object.freeze(nodeMap);

  return Object.freeze({
    order,
    nodes: nodeMap,
    revision,
  });
}

export class ConversationAssembler {
  private readonly sessionId?: string;
  private readonly definitions: ConversationNodeDefinition<any, any>[] = [];
  private lastProcessedSeq: number = 0;
  private revisionCounter: number = 0;

  /** 单一内存状态存储：nodeKey -> NodeStateEntry */
  private readonly nodeStates: Map<string, NodeStateEntry> = new Map();
  /** 节点 ID 有序列表，维持对话流物理先后次序 */
  private readonly nodeKeysOrder: string[] = [];
  /** 脏节点标记集，支持按需延迟物化 */
  private readonly dirtyNodeKeys: Set<string> = new Set();
  /** 缓存的不可变视图节点投影 */
  private readonly cachedViewNodes: Map<string, ConversationNodeViewData> = new Map();

  /** 本地用户发问回显暂存队列：rpcId -> SubmissionEcho */
  private readonly pendingEchoes: Map<string, SubmissionEcho> = new Map();

  /** 快照监听器 */
  private readonly listeners: Set<SnapshotListener> = new Set();
  private readonly onSnapshotCallback?: SnapshotListener;

  /** 当前不可变快照缓存与脏标记 */
  private currentSnapshot: ConversationSnapshot | null = null;
  private isSnapshotDirty: boolean = true;

  /** 状态机运行时指标 */
  private readonly metrics: AssemblerMetrics = {
    processedEventCount: 0,
    droppedDeduplicatedCount: 0,
    sequenceGapsCount: 0,
    lastProcessedSeq: 0,
  };

  constructor(options?: ConversationAssemblerOptions) {
    if (options?.sessionId) {
      this.sessionId = options.sessionId;
    }
    if (options?.initialSeq !== undefined) {
      this.lastProcessedSeq = options.initialSeq;
      this.metrics.lastProcessedSeq = options.initialSeq;
    }
    if (options?.onSnapshot) {
      this.onSnapshotCallback = options.onSnapshot;
    }
    if (options?.definitions && options.definitions.length > 0) {
      for (const def of options.definitions) {
        this.registerDefinition(def);
      }
    }
  }

  /**
   * 注册单个节点领域状态机定义
   */
  public registerDefinition(definition: ConversationNodeDefinition<any, any>): this {
    if (!definition || typeof definition.match !== 'function') {
      throw new Error('[ConversationAssembler] Invalid definition: match function is required');
    }
    const existingIndex = this.definitions.findIndex((d) => d.kind === definition.kind);
    if (existingIndex >= 0) {
      this.definitions[existingIndex] = definition;
    } else {
      this.definitions.push(definition);
    }
    return this;
  }

  /**
   * 批量注册节点领域状态机定义
   */
  public registerDefinitions(definitions: readonly ConversationNodeDefinition<any, any>[]): this {
    for (const def of definitions) {
      this.registerDefinition(def);
    }
    return this;
  }

  /**
   * 获取当前所有已注册的 Definition 契约清单
   */
  public getDefinitions(): readonly ConversationNodeDefinition<any, any>[] {
    return Object.freeze([...this.definitions]);
  }

  /**
   * 获取当前最后成功处理的序列号
   */
  public getLastProcessedSeq(): number {
    return this.lastProcessedSeq;
  }

  /**
   * 获取状态机运行时指标（用于监控与单元测试断言）
   */
  public getMetrics(): Readonly<AssemblerMetrics> {
    return Object.freeze({ ...this.metrics });
  }

  /**
   * 核心增量处理入口：处理单条底层网络/领域事件信封
   */
  public processEvent(event: SessionEventEnvelope): ProcessEventResult {
    // 1. 会话隔离校验（若指定了 sessionId）
    if (this.sessionId && event.sessionId !== this.sessionId) {
      return {
        accepted: false,
        rhythm: 'none',
        reason: 'session_mismatch',
      };
    }

    // 2. 单调序列号滑动窗口校验与去重拦截
    if (event.seq <= this.lastProcessedSeq) {
      this.metrics.droppedDeduplicatedCount++;
      return {
        accepted: false,
        rhythm: 'none',
        reason: 'duplicate_seq',
      };
    }

    // 3. 序列号断裂（丢包/跳号）检测容灾
    const expectedSeq = this.lastProcessedSeq === 0 ? 1 : this.lastProcessedSeq + 1;
    if (event.seq > expectedSeq) {
      this.metrics.sequenceGapsCount++;
      this.metrics.lastSequenceGap = {
        expectedSeq,
        receivedSeq: event.seq,
        timestamp: event.timestamp || Date.now(),
      };
    }

    // 推进序列号与指标
    this.lastProcessedSeq = event.seq;
    this.metrics.lastProcessedSeq = event.seq;
    this.metrics.processedEventCount++;

    // 4. Definition 动态认领匹配
    const matchedDef = this.definitions.find((def) => def.match(event));
    if (!matchedDef) {
      return {
        accepted: false,
        rhythm: 'none',
        reason: 'no_definition_match',
      };
    }

    // 5. 解析节点归属键
    const nodeKey = matchedDef.getNodeKey
      ? matchedDef.getNodeKey(event)
      : this.resolveDefaultNodeKey(matchedDef, event);

    let rhythm: PublicationRhythm = 'none';
    const existingEntry = this.nodeStates.get(nodeKey);

    if (!existingEntry) {
      // 节点首达：初始化不可变内存 State
      const initialState = matchedDef.start(event);
      this.nodeKeysOrder.push(nodeKey);
      this.nodeStates.set(nodeKey, {
        definition: matchedDef,
        state: initialState,
        nodeKey,
      });
      this.dirtyNodeKeys.add(nodeKey);
      this.isSnapshotDirty = true;
      rhythm = matchedDef.publication(initialState, initialState);
    } else {
      // 增量到达：纯函数折叠更新 State
      const prevState = existingEntry.state;
      const nextState = matchedDef.update(prevState, event);
      existingEntry.state = nextState;
      this.dirtyNodeKeys.add(nodeKey);
      this.isSnapshotDirty = true;
      rhythm = matchedDef.publication(nextState, prevState);
    }

    // 6. 若事件携带 clientMessageId，检查并触发与 Echo 队列的交接
    if (event.clientMessageId && this.pendingEchoes.has(event.clientMessageId)) {
      this.pendingEchoes.delete(event.clientMessageId);
      this.isSnapshotDirty = true;
    }

    // 7. 关键终态事件零延迟物化保底（immediate 立即发布）
    if (rhythm === 'immediate') {
      this.emitSnapshot('immediate');
    }

    return {
      accepted: true,
      rhythm,
      nodeKey,
      reason: 'processed',
    };
  }

  /**
   * 批量注入事件
   */
  public processEvents(events: readonly SessionEventEnvelope[]): readonly ProcessEventResult[] {
    const results: ProcessEventResult[] = [];
    for (const ev of events) {
      results.push(this.processEvent(ev));
    }
    return results;
  }

  /**
   * 注册用户发问乐观回显节点（用于发送时即刻渲染气泡）
   */
  public addPendingEcho(echo: SubmissionEcho, emitImmediate: boolean = true): ConversationSnapshot {
    this.pendingEchoes.set(echo.rpcId, echo);
    this.isSnapshotDirty = true;
    if (emitImmediate) {
      return this.emitSnapshot('immediate');
    }
    return this.getSnapshot();
  }

  /**
   * 移除或清除特定的回显节点
   */
  public removePendingEcho(rpcIdOrEchoId: string): boolean {
    if (this.pendingEchoes.has(rpcIdOrEchoId)) {
      this.pendingEchoes.delete(rpcIdOrEchoId);
      this.isSnapshotDirty = true;
      return true;
    }
    for (const [key, echo] of this.pendingEchoes.entries()) {
      if (echo.echoId === rpcIdOrEchoId || echo.rpcId === rpcIdOrEchoId) {
        this.pendingEchoes.delete(key);
        this.isSnapshotDirty = true;
        return true;
      }
    }
    return false;
  }

  /**
   * 更新回显节点的生命周期状态（例如 pending -> submitting -> failed）
   */
  public updatePendingEchoStatus(
    rpcId: string,
    status: 'pending' | 'submitting' | 'failed',
    error?: string
  ): boolean {
    const existing = this.pendingEchoes.get(rpcId);
    if (!existing) {
      return false;
    }
    this.pendingEchoes.set(rpcId, {
      ...existing,
      status,
      error,
    });
    this.isSnapshotDirty = true;
    return true;
  }

  /**
   * 获取当前暂存的回显清单
   */
  public getPendingEchoes(): readonly SubmissionEcho[] {
    return Object.freeze(Array.from(this.pendingEchoes.values()));
  }

  /**
   * 清空全部回显队列
   */
  public clearPendingEchoes(): void {
    if (this.pendingEchoes.size > 0) {
      this.pendingEchoes.clear();
      this.isSnapshotDirty = true;
    }
  }

  /**
   * 获取特定节点的纯内存状态（供调试、状态解算与测试使用）
   */
  public getNodeState<T = unknown>(nodeKey: string): T | undefined {
    const entry = this.nodeStates.get(nodeKey);
    return entry ? (entry.state as T) : undefined;
  }

  /**
   * 获取当前已记录的有序节点键列表
   */
  public getNodeKeys(): readonly string[] {
    return Object.freeze([...this.nodeKeysOrder]);
  }

  /**
   * 获取当前不可变快照（带脏检查与延迟增量物化）
   */
  public getSnapshot(): ConversationSnapshot {
    if (!this.isSnapshotDirty && this.currentSnapshot) {
      return this.currentSnapshot;
    }

    // 1. 仅针对脏节点执行 buildViewNode 重新物化，未修改节点复用缓存对象引用
    for (const nodeKey of this.dirtyNodeKeys) {
      const entry = this.nodeStates.get(nodeKey);
      if (entry) {
        const viewNode = entry.definition.buildViewNode(entry.state);
        this.cachedViewNodes.set(nodeKey, Object.freeze(viewNode));
      }
    }
    this.dirtyNodeKeys.clear();

    // 2. 按初始物理次序提取全部持久化视图节点
    const durableNodes: ConversationNodeViewData[] = [];
    for (const key of this.nodeKeysOrder) {
      const viewNode = this.cachedViewNodes.get(key);
      if (viewNode) {
        durableNodes.push(viewNode);
      }
    }

    // 3. 执行同帧 Echo 互斥原子物化
    const pendingEchoesList = Array.from(this.pendingEchoes.values());
    this.revisionCounter++;
    const snapshot = buildSnapshotWithEchoExclusion(
      durableNodes,
      pendingEchoesList,
      this.revisionCounter
    );

    // 4. 清理已在 durableNodes 中匹配并交接完毕的 Echo
    const durableRpcSet = new Set<string>();
    for (const n of durableNodes) {
      if (n.rpcId) durableRpcSet.add(n.rpcId);
      durableRpcSet.add(n.id);
    }
    for (const [key, echo] of this.pendingEchoes.entries()) {
      if (durableRpcSet.has(echo.rpcId)) {
        this.pendingEchoes.delete(key);
      }
    }

    this.currentSnapshot = snapshot;
    this.isSnapshotDirty = false;
    return snapshot;
  }

  /**
   * 主动触发快照物化并广播给所有订阅者
   */
  public emitSnapshot(rhythm: PublicationRhythm = 'immediate'): ConversationSnapshot {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot, rhythm);
      } catch (err) {
        console.error('[ConversationAssembler] Listener callback threw an error:', err);
      }
    }
    if (this.onSnapshotCallback) {
      try {
        this.onSnapshotCallback(snapshot, rhythm);
      } catch (err) {
        console.error('[ConversationAssembler] onSnapshot callback threw an error:', err);
      }
    }
    return snapshot;
  }

  /**
   * 订阅视图快照发布
   */
  public subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 全量水合（Hydration）：回退/全量快照原子替换容灾
   */
  public hydrate(nodes: readonly ConversationNodeViewData[], seq?: number): ConversationSnapshot {
    this.reset({ initialSeq: seq ?? this.lastProcessedSeq });
    for (const node of nodes) {
      this.nodeKeysOrder.push(node.id);
      this.cachedViewNodes.set(node.id, Object.freeze({ ...node }));
      this.nodeStates.set(node.id, {
        definition: {
          kind: node.kind,
          match: () => false,
          start: () => node,
          update: () => node,
          publication: () => 'none',
          buildViewNode: () => node,
        },
        state: node,
        nodeKey: node.id,
      });
    }
    this.isSnapshotDirty = true;
    return this.emitSnapshot('immediate');
  }

  /**
   * 重置状态机（清除所有状态、节点与指标，重新初始化）
   */
  public reset(options?: { initialSeq?: number }): void {
    this.nodeStates.clear();
    this.nodeKeysOrder.length = 0;
    this.dirtyNodeKeys.clear();
    this.cachedViewNodes.clear();
    this.pendingEchoes.clear();
    this.lastProcessedSeq = options?.initialSeq ?? 0;
    this.currentSnapshot = null;
    this.isSnapshotDirty = true;

    this.metrics.processedEventCount = 0;
    this.metrics.droppedDeduplicatedCount = 0;
    this.metrics.sequenceGapsCount = 0;
    this.metrics.lastProcessedSeq = this.lastProcessedSeq;
    this.metrics.lastSequenceGap = undefined;
  }

  /**
   * 默认节点键推导策略
   */
  private resolveDefaultNodeKey(
    definition: ConversationNodeDefinition<any, any>,
    event: SessionEventEnvelope
  ): string {
    if (event.runId && event.turnId) {
      return `${event.sessionId}:${event.runId}:${event.turnId}:${definition.kind}`;
    }
    if (event.turnId) {
      return `${event.sessionId}:${event.turnId}:${definition.kind}`;
    }
    if (event.clientMessageId) {
      return `${event.sessionId}:${event.clientMessageId}`;
    }
    if (event.runId) {
      return `${event.sessionId}:${event.runId}:${definition.kind}`;
    }
    return `${event.sessionId}:${definition.kind}:${event.seq}`;
  }
}
