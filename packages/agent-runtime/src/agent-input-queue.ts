/**
 * AgentInputQueue - 统一输入队列
 *
 * 统一管理所有输入源：初始 prompt、steer 输入、follow-up、recovery 纠偏消息。
 * 状态机在 awaiting-input 状态不区分来源，只关心队列是否有可运行输入。
 *
 * 底层使用 RingBuffer 替代 Array，将 shift() 从 O(n) 降为 O(1)，
 * 并以固定容量提供背压保护（超容量覆盖最旧，避免长会话下无界增长）。
 *
 * 三环语义（对齐 pi agent steer / followUp，见 CHANGELOG #403）：
 * - force：可在 streaming 中途打断（历史 mid-stream 行为；legacy）
 * - steer（soft）：下一安全点注入（provider 消费结束 / tool 批后），不杀当前 stream
 * - followUp：仅在 run 即将 idle 时注入（无 tool、无 steer/force；agent 本会结束）
 *
 * @see docs/architecture/run-control.md
 * @see reference/pi/packages/agent (steer vs followUp)
 */

import type { AgentMessage } from "@crish/shared-types";
import { RingBuffer } from "@crish/shared-utils";

const INPUT_QUEUE_CAPACITY = 1000;

/**
 * 入队模式：
 * - force：mid-stream 可打断
 * - soft / steer：安全点注入（soft 为 steer 的兼容别名）
 * - followUp：仅 run idle 时注入
 */
export type InputEnqueueMode = "soft" | "force" | "steer" | "followUp";

export class AgentInputQueue {
  /** 可中断路径（默认 enqueue；legacy mid-stream） */
  private readonly forceItems = new RingBuffer<AgentMessage>(INPUT_QUEUE_CAPACITY);
  /** 下一安全点注入（pi steer） */
  private readonly steerItems = new RingBuffer<AgentMessage>(INPUT_QUEUE_CAPACITY);
  /** 仅 idle 注入（pi followUp） */
  private readonly followUpItems = new RingBuffer<AgentMessage>(INPUT_QUEUE_CAPACITY);

  /**
   * 将消息加入队列。
   * @param mode 默认 force（low-level / legacy mid-stream）。
   *   公共产品路径请用 {@link enqueueSteer} / {@link enqueueFollowUp}；
   *   AgentRuntime.enqueueSteerInput 固定走 steer，勿依赖本默认。
   */
  enqueue(message: AgentMessage, mode: InputEnqueueMode = "force"): void {
    switch (mode) {
      case "soft":
      case "steer":
        this.steerItems.pushOverwritingOldest(message);
        break;
      case "followUp":
        this.followUpItems.pushOverwritingOldest(message);
        break;
      default:
        this.forceItems.pushOverwritingOldest(message);
        break;
    }
  }

  /** 显式 force 环（mid-stream 可打断）；公共 steer 勿用 */
  enqueueForce(message: AgentMessage): void {
    this.enqueue(message, "force");
  }

  /** L1 soft inject 兼容别名 → steer 环 */
  enqueueSoft(message: AgentMessage): void {
    this.enqueue(message, "steer");
  }

  /** pi steer：下一安全点（provider 结束 / tool 批后） */
  enqueueSteer(message: AgentMessage): void {
    this.enqueue(message, "steer");
  }

  /** pi followUp：仅当 agent 本将结束（无 tool、无 steer）时注入 */
  enqueueFollowUp(message: AgentMessage): void {
    this.enqueue(message, "followUp");
  }

  /**
   * 取出并移除下一条可运行消息（force 优先，再 steer）。
   * 不取出 followUp — 须在 idle 安全点经 drainFollowUp / promoteFollowUp 消费。
   */
  dequeue(): AgentMessage | undefined {
    return this.forceItems.shift() ?? this.steerItems.shift();
  }

  /** 仅取出 force 消息（streaming 中断路径） */
  dequeueForce(): AgentMessage | undefined {
    return this.forceItems.shift();
  }

  /**
   * 取出全部 steer（soft）消息（安全点批量注入）。
   * soft 为历史名；语义 = drainSteer。
   */
  drainSoft(): AgentMessage[] {
    return this.drainSteer();
  }

  /** 取出全部 steer 消息（安全点） */
  drainSteer(): AgentMessage[] {
    const out: AgentMessage[] = [];
    while (this.steerItems.size > 0) {
      const m = this.steerItems.shift();
      if (m) out.push(m);
    }
    return out;
  }

  /** 取出全部 followUp 消息（仅 run idle 时调用） */
  drainFollowUp(): AgentMessage[] {
    const out: AgentMessage[] = [];
    while (this.followUpItems.size > 0) {
      const m = this.followUpItems.shift();
      if (m) out.push(m);
    }
    return out;
  }

  /**
   * 将 followUp 提升为 steer，使后续 dequeue / awaiting-input 可消费。
   * 仅应在「本将 SHOULD_STOP」的 idle 点调用（对齐 pi getFollowUpMessages）。
   * @returns 提升条数
   */
  promoteFollowUp(): number {
    const msgs = this.drainFollowUp();
    for (const m of msgs) {
      this.steerItems.pushOverwritingOldest(m);
    }
    return msgs.length;
  }

  /** 预览下一条可运行消息（force 优先；不移除；不含 followUp） */
  peek(): AgentMessage | null {
    return this.forceItems.peekFirst() ?? this.steerItems.peekFirst() ?? null;
  }

  /** 是否有任意待处理消息（含 followUp） */
  hasPending(): boolean {
    return (
      this.forceItems.size > 0 ||
      this.steerItems.size > 0 ||
      this.followUpItems.size > 0
    );
  }

  /**
   * 是否有 mid-run 可继续消息（force 或 steer）。
   * tool 批后 / stream 后安全点应使用此谓词，避免过早消费 followUp。
   */
  hasRunnablePending(): boolean {
    return this.forceItems.size > 0 || this.steerItems.size > 0;
  }

  /** 是否有 force 消息（streaming 中途可打断） */
  hasForcePending(): boolean {
    return this.forceItems.size > 0;
  }

  /** 是否有 steer（soft）消息 — soft 兼容名 */
  hasSoftPending(): boolean {
    return this.hasSteerPending();
  }

  /** 是否有 steer 消息 */
  hasSteerPending(): boolean {
    return this.steerItems.size > 0;
  }

  /** 是否有 followUp 消息（仅 idle 应消费） */
  hasFollowUpPending(): boolean {
    return this.followUpItems.size > 0;
  }

  /** 队列中的消息数量（三环合计） */
  get length(): number {
    return this.forceItems.size + this.steerItems.size + this.followUpItems.size;
  }

  /** 清空三环 */
  clear(): void {
    this.forceItems.clear();
    this.steerItems.clear();
    this.followUpItems.clear();
  }
}
