/**
 * SteeringCoordinator — 统一纠偏协调器
 *
 * 作为所有纠偏行为的统一入口，取代分散在多个层级中的直接纠偏调用。
 *
 * 设计原则：
 * 1. 所有纠偏行为共享同一个上下文视图，避免冲突
 * 2. 全局预算控制（最多注入 N 条纠偏消息）
 * 3. 新策略可以通过 SteeringStrategy 接口添加，无需修改核心循环
 * 4. 策略只决定"是否需要纠偏"和"纠偏内容"，不负责执行
 *
 * 使用方式：
 *   const coordinator = new SteeringCoordinator(conversation, strategies);
 *   // 在特定阶段评估
 *   const result = coordinator.evaluate("after-tools", context);
 *   // 执行纠偏动作
 *   for (const event of coordinator.apply(result.actions)) { ... }
 */

import type { AgentEvent } from "@crish/shared-types";
import type { RuntimeRecoveryReason } from '../core/runtime-options';
import type { ConversationEngine } from "../runtime-components/conversation-engine";
import type {
  SteeringAction,
  SteeringContext,
  SteeringEvaluationResult,
  SteeringPhase,
  SteeringStrategy,
} from "./steering-types";
import { nowIso } from '@crish/agent-context';

// ─── SteeringCoordinator 配置 ──────────────────────────────

export interface SteeringCoordinatorOptions {
  /** 全局最大纠偏消息数（默认 3） */
  maxSteeringBudget?: number;
}

// ─── SteeringCoordinator ──────────────────────────────────

export class SteeringCoordinator {
  private steeringCount = 0;
  private readonly maxSteeringBudget: number;

  constructor(
    private readonly conversation: ConversationEngine,
    private readonly strategies: SteeringStrategy[],
    options?: SteeringCoordinatorOptions,
  ) {
    this.maxSteeringBudget = options?.maxSteeringBudget ?? 3;
  }

  /**
   * 评估所有策略在指定阶段的纠偏需求
   *
   * 只调用关注该阶段的策略，并按注册顺序评估。
   * 如果全局预算已耗尽，不再评估 inject-message 类策略。
   *
   * @param phase - 当前纠偏阶段
   * @param context - 共享上下文
   * @returns 评估结果，包含需要执行的 actions 和新的 steering 计数
   */
  evaluate(phase: SteeringPhase, context: SteeringContext): SteeringEvaluationResult {
    const actions: SteeringAction[] = [];
    let potentialSteeringCount = this.steeringCount;

    for (const strategy of this.strategies) {
      // 只调用关注该阶段的策略
      if (!strategy.phases.includes(phase)) continue;

      // intervention-required 不受预算限制，始终评估
      const action = strategy.evaluate(phase, {
        ...context,
        steeringCount: potentialSteeringCount,
      });

      if (!action) continue;

      // inject-message 受全局预算限制
      if (action.type === "inject-message" && potentialSteeringCount >= this.maxSteeringBudget) {
        // 超预算时跳过注入消息，但不跳过其他类型
        continue;
      }

      actions.push(action);

      // inject-message 消耗预算（仅在此处做预算跟踪，实际计数在 apply 中更新）
      if (action.type === "inject-message") {
        potentialSteeringCount++;
      }
    }

    return {
      actions,
      newSteeringCount: potentialSteeringCount,
    };
  }

  /**
   * 执行纠偏动作
   *
   * - inject-message: 将消息注入到对话引擎中，发射 runtime-steering 事件
   * - emit-diagnostic: 发射诊断事件
   * - intervention-required: 发射 runtime-intervention-required 事件
   *
   * @param actions - 需要执行的纠偏动作列表
   * @param sessionId - 会话 ID（用于事件发射）
   * @returns 纠偏产生的事件列表和是否需要干预
   */
  apply(
    actions: SteeringAction[],
    sessionId: string,
  ): { events: AgentEvent[]; interventionRequired: boolean } {
    const events: AgentEvent[] = [];
    let interventionRequired = false;

    for (const action of actions) {
      switch (action.type) {
        case "inject-message": {
          // 注入消息到对话引擎
          this.conversation.appendMessage(action.message);
          // 更新纠偏计数
          this.steeringCount++;
          events.push({
            type: "runtime-steering",
            sessionId,
            timestamp: nowIso(),
            reason: action.reason as RuntimeRecoveryReason,
            message: action.message,
          });
          break;
        }

        case "emit-diagnostic": {
          // 发射诊断事件（不修改对话）
          events.push({
            type: "runtime-steering",
            sessionId,
            timestamp: nowIso(),
            reason: action.reason as RuntimeRecoveryReason,
            message: {
              id: `diagnostic-${Date.now()}`,
              role: "system",
              createdAt: nowIso(),
              blocks: [{ type: "text", text: JSON.stringify(action.diagnostic) }],
              metadata: { kind: "diagnostic" },
            },
          });
          break;
        }

        case "intervention-required": {
          interventionRequired = true;
          events.push({
            type: "runtime-intervention-required",
            sessionId,
            timestamp: nowIso(),
            reason: action.reason as RuntimeRecoveryReason,
            choices: ["rollback", "pause", "user-instruction"],
            message: action.message ?? "The agent did not recover after runtime steering.",
          });
          break;
        }
      }
    }

    return { events, interventionRequired };
  }

  /**
   * 获取当前纠偏计数
   */
  getSteeringCount(): number {
    return this.steeringCount;
  }

  /**
   * 重置纠偏计数（例如在工具执行成功后）
   */
  resetSteeringCount(): void {
    this.steeringCount = 0;
  }
}