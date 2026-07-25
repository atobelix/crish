/**
 * RecoverySteeringStrategy — 恢复纠偏策略
 *
 * 封装现有 detectRecoveryNeed + applySteering 的逻辑。
 * 在 after-tools 阶段评估是否有工具错误循环或重复调用。
 *
 * 关键设计：
 * - 策略只负责"检测是否需要纠偏"和"构建纠偏消息"
 * - 不直接调用 conversation.applySteering()，而是返回 SteeringAction
 * - 实际执行由 SteeringCoordinator.apply() 完成
 */

import type { AgentMessage } from "@crish/shared-types";
import type { RuntimeRecoveryReason } from "../types";
import type { SteeringAction, SteeringContext, SteeringPhase, SteeringStrategy } from "./steering-types";
import { detectRecentToolErrorLoop, detectRepeatedToolCallLoop, runtimeSteeringText } from "../runtime-helpers";
import { createTextMessage } from "../session";

// ─── RecoverySteeringStrategy 配置 ─────────────────────────

export interface RecoverySteeringStrategyOptions {
  /** 最大连续工具错误数（默认 2） */
  maxConsecutiveToolErrors?: number | undefined;
  /** 最大重复调用数（默认 3） */
  maxRepeatedToolCalls?: number | undefined;
  /** 最大纠偏消息数（默认 1） */
  maxSteeringMessages?: number | undefined;
}

// ─── RecoverySteeringStrategy ──────────────────────────────

export class RecoverySteeringStrategy implements SteeringStrategy {
  readonly name = "recovery";
  readonly phases: SteeringPhase[] = ["after-tools", "empty-response"];

  private readonly maxConsecutiveToolErrors: number;
  private readonly maxRepeatedToolCalls: number;
  private readonly maxSteeringMessages: number;

  constructor(options?: RecoverySteeringStrategyOptions) {
    this.maxConsecutiveToolErrors = options?.maxConsecutiveToolErrors ?? 2;
    this.maxRepeatedToolCalls = options?.maxRepeatedToolCalls ?? 3;
    this.maxSteeringMessages = options?.maxSteeringMessages ?? 1;
  }

  evaluate(phase: SteeringPhase, context: SteeringContext): SteeringAction | null {
    if (phase === "empty-response") {
      if (context.steeringCount >= this.maxSteeringMessages) {
        return {
          type: "intervention-required",
          reason: "empty-response",
          message: "The agent did not recover after runtime steering."
        };
      }
      const reason: RuntimeRecoveryReason = "empty-response";
      const steeringMessage = createTextMessage("system", runtimeSteeringText(reason), {
        kind: "runtime-steering",
        reason,
        steeringCount: context.steeringCount + 1,
      });
      return {
        type: "inject-message",
        message: steeringMessage,
        reason,
      };
    }

    if (phase !== "after-tools") return null;

    if (context.steeringCount >= this.maxSteeringMessages) {
      const reason = this.detectRecoveryNeedFromMessages(context.messages);
      if (!reason) return null;
      return {
        type: "intervention-required",
        reason,
        message: "The agent did not recover after runtime steering."
      };
    }

    const reason = this.detectRecoveryNeedFromMessages(context.messages);
    if (!reason) return null;

    const steeringMessage = createTextMessage("system", runtimeSteeringText(reason), {
      kind: "runtime-steering",
      reason,
      steeringCount: context.steeringCount + 1,
    });

    return {
      type: "inject-message",
      message: steeringMessage,
      reason,
    };
  }

  private detectRecoveryNeedFromMessages(messages: AgentMessage[]): RuntimeRecoveryReason | null {
    const errorLoop = detectRecentToolErrorLoop(messages, this.maxConsecutiveToolErrors);
    if (errorLoop) return errorLoop;

    const repeatedLoop = detectRepeatedToolCallLoop(messages, this.maxRepeatedToolCalls);
    return repeatedLoop ?? null;
  }
}