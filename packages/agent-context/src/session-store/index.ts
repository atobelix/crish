/**
 * Session 存储与分支模式
 *
 * 解决的问题：
 * 1. Session 消息线性存储，无法高效查询特定范围
 * 2. 分支切换逻辑散落在多处，缺乏统一管理
 * 3. 大量消息时的内存和性能问题
 * 4. 分支恢复时缺乏一致性保证
 *
 * 设计原则：
 * 1. 索引分片：消息按 turn 分片存储，支持快速范围查询
 * 2. BranchManager：统一的分支管理器，基于 SessionBranch 状态机
 * 3. 不可变消息：消息一旦写入不可修改
 * 4. 分支快照：每个分支有独立的快照，支持快速恢复
 */

import type { AgentMessage, SessionBranchState } from '@crish/shared-types';
import {
  BoundedMap,
  MAX_BRANCHES,
  MAX_SHARDS_PER_BRANCH,
  MAX_MESSAGES_PER_SESSION,
} from '@crish/shared-utils';
import type { ISessionStore } from '../ISessionStore';
import { StoreCapacityError } from './types';
import type { AppendResult } from './types';
export type { ISessionStore, AppendResult };

/**
 * 分支状态机最小接口（结构性接口）。
 *
 * agent-context 是 Layer 2 leaf，不持有状态机实现（ConexStateMachine 属于
 * agent-runtime）。BranchManager 通过此接口解耦，由运行时注入工厂函数。
 */
export interface SessionBranchMachineLike {
  send(event: string, payload?: unknown): void;
  getCurrent(): SessionBranchState;
  getHistory(): unknown[];
}

/**
 * 分支状态机工厂函数类型。
 * 由运行时层注入，负责创建具体的状态机实例。
 */
export type SessionBranchMachineFactory = (
  branchId: string,
  sessionId: string
) => SessionBranchMachineLike;

// ─── 消息分片 ─────────────────────────────────────────────

export interface MessageShard {
  /** 分片 ID */
  shardId: string;
  /** 所有 session */
  sessionId: string;
  /** 所属分支*/
  branchId: string;
  /** 起始 turn 索引 */
  startTurnIndex: number;
  /** 结束 turn 索引 */
  endTurnIndex: number;
  /** 消息列表 */
  messages: AgentMessage[];
  /** 创建时间 */
  createdAt: string;
  /** 消息数*/
  messageCount: number;
  /** 估算 token 数*/
  estimatedTokens: number;
}

// ─── 分支定义 ─────────────────────────────────────────────

export interface SessionBranch {
  /** 分支 ID */
  branchId: string;
  /** 父分支 ID（main 分支为 null）*/
  parentBranchId: string | null;
  /** 分叉点消息 ID */
  forkPointMessageId: string | null;
  /** 分叉点 turn 索引 */
  forkPointTurnIndex: number | null;
  /** 分支状态*/
  state: SessionBranchState;
  /** 创建时间 */
  createdAt: string;
  /** 最后活跃时间*/
  lastActiveAt: string;
  /** 消息分片列表 */
  shards: MessageShard[];
  /** 总消息数 */
  totalMessageCount: number;
  /** 总估算 token 数*/
  totalEstimatedTokens: number;
}

// ─── 分支快照 ─────────────────────────────────────────────

export interface BranchSnapshot {
  branchId: string;
  state: SessionBranchState;
  totalMessageCount: number;
  totalEstimatedTokens: number;
  shardCount: number;
  lastShardEndTurnIndex: number;
  snapshotAt: string;
}

// ─── 查询范围 ─────────────────────────────────────────────

export interface MessageRangeQuery {
  /** 起始 turn 索引（含）*/
  fromTurn?: number;
  /** 结束 turn 索引（含）*/
  toTurn?: number;
  /** 最大消息数 */
  limit?: number;
  /** 是否包含系统消息 */
  includeSystem?: boolean;
}

export interface MessageRangeResult {
  messages: AgentMessage[];
  totalInBranch: number;
  returnedCount: number;
  fromTurn: number;
  toTurn: number;
}

// ─── SessionStore ─────────────────────────────────────────

/**
 * Session 存储引擎
 *
 * 使用索引分片策略管理消息
 * - 消息按 turn 分片，每个分片包含一个 turn 的所有消息
 * - 查询时按 turn 范围定位分片，避免全量扫描
 * - 支持多分支，每个分支有独立的分片
 */
export class SessionStore implements ISessionStore {
  private branches = new BoundedMap<string, SessionBranch>(
    MAX_BRANCHES,
    undefined
  );
  private activeBranchId: string;

  constructor(private readonly sessionId: string) {
    // 创建 main 分支
    const mainBranch: SessionBranch = {
      branchId: 'main',
      parentBranchId: null,
      forkPointMessageId: null,
      forkPointTurnIndex: null,
      state: 'active',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      shards: [],
      totalMessageCount: 0,
      totalEstimatedTokens: 0,
    };
    this.branches.set('main', mainBranch);
    this.activeBranchId = 'main';
  }

  /** 获取 Session ID */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * 追加消息到当前活跃分支
   * @throws {StoreCapacityError} 当分支分片数或分片消息数达到上限时抛出
   */
  appendMessage(
    message: AgentMessage,
    turnIndex: number,
    estimatedTokens: number = 0
  ): AppendResult {
    const branch = this.branches.get(this.activeBranchId);
    if (!branch)
      throw new Error(`Active branch "${this.activeBranchId}" not found`);

    // 查找或创建当前的 turn 的分片
    const shard = branch.shards.find(
      (s) => s.endTurnIndex === turnIndex || s.startTurnIndex === turnIndex
    );
    if (!shard || shard.endTurnIndex < turnIndex) {
      if (branch.shards.length >= MAX_SHARDS_PER_BRANCH)
        throw new StoreCapacityError('branch shard limit reached');
      shard = {
        shardId: createShardId(),
        sessionId: this.sessionId,
        branchId: branch.branchId,
        startTurnIndex: turnIndex,
        endTurnIndex: turnIndex,
        messages: [],
        createdAt: new Date().toISOString(),
        messageCount: 0,
        estimatedTokens: 0,
      };
      branch.shards.push(shard);
    }

    if (shard.messages.length >= MAX_MESSAGES_PER_SESSION)
      throw new StoreCapacityError('shard message limit reached');
    shard.messages.push(message);
    shard.messageCount++;
    shard.endTurnIndex = turnIndex;
    shard.estimatedTokens += estimatedTokens;

    branch.totalMessageCount++;
    branch.totalEstimatedTokens += estimatedTokens;
    branch.lastActiveAt = new Date().toISOString();

    return {
      totalMessageCount: branch.totalMessageCount,
      totalEstimatedTokens: branch.totalEstimatedTokens,
    };
  }

  /**
   * 批量追加消息（全成功或全失败）
   * @throws {StoreCapacityError} 当容量不足时抛出，不会部分写入
   */
  appendMessages(
    messages: AgentMessage[],
    turnIndex: number,
    estimatedTokens: number = 0
  ): AppendResult {
    const branch = this.branches.get(this.activeBranchId);
    if (!branch)
      throw new Error(`Active branch "${this.activeBranchId}" not found`);

    // 预检容量：全部通过才执行，保证全成功或全失败
    const shard = branch.shards.find(
      (s) => s.endTurnIndex === turnIndex || s.startTurnIndex === turnIndex
    );
    if (!shard || shard.endTurnIndex < turnIndex) {
      if (branch.shards.length >= MAX_SHARDS_PER_BRANCH) {
        throw new StoreCapacityError('branch shard limit reached');
      }
    } else {
      if (shard.messages.length + messages.length > MAX_MESSAGES_PER_SESSION) {
        throw new StoreCapacityError('shard message limit reached');
      }
    }

    for (const message of messages) {
      this.appendMessage(message, turnIndex, estimatedTokens);
    }

    const activeBranch = this.branches.get(this.activeBranchId)!;
    return {
      totalMessageCount: activeBranch.totalMessageCount,
      totalEstimatedTokens: activeBranch.totalEstimatedTokens,
    };
  }

  /**
   * 按范围查询消息
   */
  queryRange(query: MessageRangeQuery = {}): MessageRangeResult {
    const branch = this.branches.get(this.activeBranchId);
    if (!branch) {
      return {
        messages: [],
        totalInBranch: 0,
        returnedCount: 0,
        fromTurn: 0,
        toTurn: 0,
      };
    }

    const fromTurn = query.fromTurn ?? 0;
    const toTurn =
      query.toTurn ??
      (branch.shards.length > 0 ? branch.shards.at(-1)!.endTurnIndex : 0);
    const includeSystem = query.includeSystem ?? true;

    let messages: AgentMessage[] = [];

    for (const shard of branch.shards) {
      if (shard.endTurnIndex < fromTurn) continue;
      if (shard.startTurnIndex > toTurn) break;

      for (const msg of shard.messages) {
        if (!includeSystem && msg.role === 'system') continue;
        messages.push(msg);
      }
    }

    const totalInBranch = branch.totalMessageCount;
    if (query.limit && messages.length > query.limit) {
      messages = messages.slice(-query.limit);
    }

    return {
      messages,
      totalInBranch,
      returnedCount: messages.length,
      fromTurn,
      toTurn,
    };
  }

  /**
   * 获取所有消息
   */
  getAllMessages(): AgentMessage[] {
    return this.queryRange({}).messages;
  }

  /**
   * 获取当前活跃分支
   */
  getActiveBranch(): SessionBranch {
    const branch = this.branches.get(this.activeBranchId);
    if (!branch)
      throw new Error(`Active branch "${this.activeBranchId}" not found`);
    return branch;
  }

  /**
   * 获取指定分支
   */
  getBranch(branchId: string): SessionBranch | undefined {
    return this.branches.get(branchId);
  }

  /**
   * 列出所有分支
   */
  listBranches(): SessionBranch[] {
    return [...this.branches.values()];
  }

  /**
   * 获取活跃分支 ID
   */
  getActiveBranchId(): string {
    return this.activeBranchId;
  }

  /**
   * 获取 Session 统计
   */
  getStats(): SessionStats {
    return {
      sessionId: this.sessionId,
      branchCount: this.branches.size,
      activeBranchId: this.activeBranchId,
      totalMessages: [...this.branches.values()].reduce(
        (sum, b) => sum + b.totalMessageCount,
        0
      ),
      totalEstimatedTokens: [...this.branches.values()].reduce(
        (sum, b) => sum + b.totalEstimatedTokens,
        0
      ),
    };
  }

  /**
   * 注册新分支
   */
  registerBranch(branch: SessionBranch): void {
    if (this.branches.has(branch.branchId)) {
      throw new Error(`Branch "${branch.branchId}" already exists`);
    }
    this.branches.set(branch.branchId, branch);
  }

  /**
   * 切换活跃分支
   */
  setActiveBranch(branchId: string): void {
    if (!this.branches.has(branchId)) {
      throw new Error(`Branch "${branchId}" not found`);
    }
    this.activeBranchId = branchId;
  }

  setArchiveStore(_store: import('./archive-store').ArchiveStore): void {
    // no-op: archiving not yet implemented
  }
}

// ─── BranchManager ────────────────────────────────────────

/**
 * 分支管理器
 *
 * 基于 SessionBranch 状态机管理分支切换和恢复
 * 确保分支操作的一致性和可追踪性
 */
export class BranchManager {
  private branchMachines = new BoundedMap<string, SessionBranchMachineLike>(
    MAX_BRANCHES,
    undefined
  );

  constructor(
    private readonly store: ISessionStore,
    private readonly machineFactory?: SessionBranchMachineFactory
  ) {
    // 为 main 分支创建状态机
    this.getOrCreateMachine('main');
  }

  /**
   * 创建新分支
   */
  createBranch(
    branchId: string,
    forkPointMessageId: string,
    forkPointTurnIndex: number
  ): SessionBranch {
    if (this.store.getBranch(branchId)) {
      throw new Error(`Branch "${branchId}" already exists`);
    }

    // 创建分支状态机
    this.getOrCreateMachine(branchId);

    // 创建分支
    const newBranch: SessionBranch = {
      branchId,
      parentBranchId: this.store.getActiveBranchId(),
      forkPointMessageId,
      forkPointTurnIndex,
      state: 'active',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      shards: [],
      totalMessageCount: 0,
      totalEstimatedTokens: 0,
    };

    // 注册到 store
    this.store.registerBranch(newBranch);

    // 通过状态机切换活跃分支
    const activeMachine = this.branchMachines.get(
      this.store.getActiveBranchId()
    );
    if (activeMachine) {
      activeMachine.send('BRANCH_SWITCH', {
        targetBranchId: branchId,
        targetLeafId: forkPointMessageId,
      });
    }

    // 切换 store 的活跃分支
    this.store.setActiveBranch(branchId);

    return newBranch;
  }

  /**
   * 切换到指定分支
   */
  switchBranch(branchId: string): void {
    const branch = this.store.getBranch(branchId);
    if (!branch) throw new Error(`Branch "${branchId}" not found`);

    const currentMachine = this.branchMachines.get(
      this.store.getActiveBranchId()
    );
    if (currentMachine && currentMachine.getCurrent() === 'active') {
      currentMachine.send('BRANCH_SWITCH', {
        targetBranchId: branchId,
        targetLeafId: '',
      });
    }

    const targetMachine = this.getOrCreateMachine(branchId);
    if (targetMachine && targetMachine.getCurrent() === 'suspended') {
      targetMachine.send('BRANCH_RESTORE', { restoredLeafId: '' });
    }

    // 更新 store 的活跃分支
    this.store.setActiveBranch(branchId);
  }

  /**
   * 放弃分支
   */
  abandonBranch(branchId: string): void {
    if (branchId === 'main') throw new Error('Cannot abandon the main branch');

    const machine = this.branchMachines.get(branchId);
    if (machine && machine.getCurrent() !== 'abandoned') {
      machine.send('BRANCH_ABANDON');
    }
  }

  /**
   * 获取分支状态
   */
  getBranchState(branchId: string): SessionBranchState | undefined {
    return this.branchMachines.get(branchId)?.getCurrent();
  }

  /**
   * 获取分支历史
   */
  getBranchHistory(branchId: string) {
    const machine = this.branchMachines.get(branchId);
    return machine?.getHistory() ?? [];
  }

  private getOrCreateMachine(
    branchId: string
  ): SessionBranchMachineLike | undefined {
    let machine = this.branchMachines.get(branchId);
    if (!machine && this.machineFactory) {
      machine = this.machineFactory(branchId, this.store.getSessionId());
      this.branchMachines.set(branchId, machine);
    }
    return machine;
  }
}

// ─── 统计信息 ─────────────────────────────────────────────

export interface SessionStats {
  sessionId: string;
  branchCount: number;
  activeBranchId: string;
  totalMessages: number;
  totalEstimatedTokens: number;
}

// ─── 工具函数 ─────────────────────────────────────────────

function createShardId(): string {
  return `shard-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
