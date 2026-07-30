/**
 * 统一纠偏策略 — 类型定义
 *
 * 所有纠偏行为通过 SteeringStrategy 接口注册到 SteeringCoordinator * 由 Coordinator 统一调度和执行 *
 * 设计原则： * 1. 策略只决定?"是否需要纠偏" 和 "纠偏内容"，不负责执行
 * 2. Coordinator 拥有全局预算（最大注入 N 条纠偏消息）
 * 3. 策略间共享同一个上下文视图，避免冲突 */

import type { AgentMessage } from "@crish/shared-types";
import type { RuntimeRecoveryReason } from '../core/runtime-options';

// ─── Steering Phase ────────────────────────────────────────

/**
 * 纠偏评估阶段
 *
 * - after-tools: 工具执行完成后，评估是否有错误循环或重复调用
 * - before-turn: 新一轮开始前，评估是否需要 goal audit
 * - after-compaction: 上下文压缩后，评估是否需要补回丢失的关键信息
 */
export type SteeringPhase = "after-tools" | "before-turn" | "after-compaction" | "empty-response";

// ─── SteeringAction ────────────────────────────────────────

/**
 * 纠偏动作
 *
 * 策略 evaluate() 返回的结果，描述需要执行的纠偏操作 * Coordinator 根据 action 类型决定如何执行 */
export type SteeringAction =
  | {
      /** 注入一条消息到对话*/
      type: "inject-message";
      /** 要注入的消息 */
      message: AgentMessage;
      /** 纠偏原因（用于事件发射） */
      reason: string;
    }
  | {
      /** 发射一个诊断事件（不修改对话） */
      type: "emit-diagnostic";
      /** 诊断内容 */
      diagnostic: unknown;
      /** 纠偏原因 */
      reason: string;
    }
  | {
      /** 需要人工干预，运行应终止*/
      type: "intervention-required";
      /** 干预原因 */
      reason: RuntimeRecoveryReason | string;
      /** 附带消息 */
      message?: string;
    };

// ─── SteeringContext ────────────────────────────────────────

/**
 * 纠偏上下文 *
 * 策略评估时可以访问的共享上下文视图 * 所有策略看到的是同一个快照，避免冲突 */
export interface SteeringContext {
  /** 当前对话消息列表 */
  messages: AgentMessage[];
  /** 当前 turn 编号 */
  turnIndex: number;
  /** 当前已执行的纠偏计数（全局预算跟踪*/
  steeringCount: number;
  /** 当前工具调用数量 */
  toolCallCount: number;
  /** 是否有待处理的新输入 */
  hasPendingInput: boolean;
}

// ─── SteeringStrategy ──────────────────────────────────────

/**
 * 纠偏策略接口
 *
 * 每个策略负责在特定阶段评估是否需要纠偏 * 返回 null 表示不需要纠偏 */
export interface SteeringStrategy {
  /** 策略名称 */
  name: string;

  /** 策略关注的阶段（只在这些阶段触发评估*/
  phases: SteeringPhase[];

  /** 评估是否需要纠偏*/
  evaluate(phase: SteeringPhase, context: SteeringContext): SteeringAction | null;
}

// ─── SteeringResult ────────────────────────────────────────

/**
 * Coordinator.evaluate() 的返回? */
export interface SteeringEvaluationResult {
  /** 需要执行的纠偏动作列表 */
  actions: SteeringAction[];
  /** 评估后的?steering 计数 */
  newSteeringCount: number;
}