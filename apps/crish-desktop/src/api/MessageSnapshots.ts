/**
 * 消息快照系统 —— 支持撤回/重生成等操作的快照保存与撤销。
 *
 * 每会话维护一个独立栈，保存截断/修改前的消息副本及关联 diff 状态。
 * 栈深度上限 20，超出时自动移除最旧条目。
 *
 * @file MessageSnapshots.ts
 */

import type { SessionMessage } from '../store/types';

/** 快照条目 */
export interface SnapshotEntry {
  /** 快照唯一标识 */
  id: string;
  /** 所属会话 id */
  sessionId: string;
  /** 触发快照的操作类型 */
  operation: 'withdraw' | 'regenerate' | 'archive' | 'batch-pin' | 'edit';
  /** 被截断或修改前的消息副本 */
  messages: SessionMessage[];
  /** 快照时的置顶消息 id 列表 */
  pinnedMessageIds?: string[];
  /** 关联的 diffFiles 路径列表 */
  diffFilePaths: string[];
  /** 快照创建时间（epoch ms） */
  timestamp: number;
  /** 用户可见的操作描述（如 "撤回消息"、"重新生成"） */
  description?: string;
}

/**
 * 消息快照管理类。
 * 每会话独立栈，保存 msg 操作前的消息副本，供撤销恢复。
 */
export class MessageSnapshots {
  private stacks: Map<string, SnapshotEntry[]>;
  private readonly MAX_STACK_DEPTH = 20;

  constructor() {
    this.stacks = new Map();
  }

  /**
   * 保存快照。
   * @param sessionId 会话 id
   * @param entry      除 id 外的快照数据
   * @returns 生成的快照 id
   */
  save(sessionId: string, entry: Omit<SnapshotEntry, 'id'>): string {
    const id = crypto.randomUUID();
    const snapshot: SnapshotEntry = { id, ...entry };

    let stack = this.stacks.get(sessionId);
    if (!stack) {
      stack = [];
      this.stacks.set(sessionId, stack);
    }

    stack.push(snapshot);

    // 超出上限时移除最旧条目
    if (stack.length > this.MAX_STACK_DEPTH) {
      stack.shift();
    }

    return id;
  }

  /**
   * 撤销 —— 弹出最近一次快照并返回。
   * @param sessionId 会话 id
   * @returns 被恢复的快照条目，无可用快照时返回 null
   */
  undo(sessionId: string): SnapshotEntry | null {
    const stack = this.stacks.get(sessionId);
    if (!stack || stack.length === 0) {
      return null;
    }
    return stack.pop() ?? null;
  }

  /**
   * 查看指定会话的快照堆栈（返回副本，防止外部篡改）。
   * @param sessionId 会话 id
   */
  getStack(sessionId: string): SnapshotEntry[] {
    const stack = this.stacks.get(sessionId);
    return stack ? [...stack] : [];
  }

  /**
   * 查看最近一次快照但不弹出。
   * @param sessionId 会话 id
   */
  peek(sessionId: string): SnapshotEntry | null {
    const stack = this.stacks.get(sessionId);
    if (!stack || stack.length === 0) {
      return null;
    }
    return stack[stack.length - 1] ?? null;
  }

  /**
   * 清除指定会话的快照栈（会话删除时调用）。
   * @param sessionId 会话 id
   */
  clearSession(sessionId: string): void {
    this.stacks.delete(sessionId);
  }

  /** 清除所有会话的快照栈。 */
  clearAll(): void {
    this.stacks.clear();
  }
}

/** 全局单例 */
export const messageSnapshots = new MessageSnapshots();
