/**
 * AgentInputQueue - 统一输入队列
 *
 * 统一管理所有输入源：初始 prompt、steer 输入、follow-up、recovery 纠偏消息。
 * 状态机在 awaiting-input 状态不区分来源，只关心队列是否有输入。
 */

import type { AgentMessage } from "@crish/shared-types";

export class AgentInputQueue {
  private readonly items: AgentMessage[] = [];

  /** 将消息加入队列 */
  enqueue(message: AgentMessage): void {
    this.items.push(message);
  }

  /** 取出并移除下一个消息 */
  dequeue(): AgentMessage | undefined {
    return this.items.shift();
  }

  /** 预览下一个消息（不移除） */
  peek(): AgentMessage | null {
    return this.items.length > 0 ? this.items[0]! : null;
  }

  /** 检查是否有待处理的消息 */
  hasPending(): boolean {
    return this.items.length > 0;
  }

  /** 队列中的消息数量 */
  get length(): number {
    return this.items.length;
  }

  /** 清空队列 */
  clear(): void {
    this.items.length = 0;
  }
}
