/**
 * AgentInputQueue - 统一输入队列
 *
 * 统一管理所有输入源：初始 prompt、steer 输入、follow-up、recovery 纠偏消息。
 * 状态机在 awaiting-input 状态不区分来源，只关心队列是否有输入。
 *
 * 底层使用 RingBuffer 替代 Array，将 shift() 从 O(n) 降为 O(1)，
 * 并以固定容量提供背压保护（超容量覆盖最旧，避免长会话下无界增长）。
 */

import type { AgentMessage } from "@crish/shared-types";
import { RingBuffer } from "@crish/shared-utils";

const INPUT_QUEUE_CAPACITY = 1000;

export class AgentInputQueue {
  private readonly items = new RingBuffer<AgentMessage>(INPUT_QUEUE_CAPACITY);

  /** 将消息加入队列（超容量时覆盖最旧以提供背压保护） */
  enqueue(message: AgentMessage): void {
    this.items.pushOverwritingOldest(message);
  }

  /** 取出并移除下一个消息 */
  dequeue(): AgentMessage | undefined {
    return this.items.shift();
  }

  /** 预览下一个消息（不移除） */
  peek(): AgentMessage | null {
    return this.items.peekFirst() ?? null;
  }

  /** 检查是否有待处理的消息 */
  hasPending(): boolean {
    return this.items.size > 0;
  }

  /** 队列中的消息数量 */
  get length(): number {
    return this.items.size;
  }

  /** 清空队列 */
  clear(): void {
    this.items.clear();
  }
}
