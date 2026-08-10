// =======================================================================
// mock daemon v0（R0-06）——夹具场景注册表
//
// 场景 = 典型联调事件的完整序列。每个场景在「首个客户端订阅其会话」时启动
// （idle 场景除外），事件按时间线逐步发射并进入会话事件存储（支持续传）。
//
// 场景清单（v0）：
//   idle      默认场景：不自动发射事件，仅回应用户消息（测试与手动联调基座）
//   approval  审批流完整序列：run 启动 → 审批请求（闸门）→ 客户端决策 →
//             approval-resolved → 工具执行 → run 收口（交互式）
//   run       run 生命周期：agent-start → 消息流 → 工具执行 → run-terminal
//             （可 --loop 循环播放）
//   cache     缓存指标事件：冷缓存预警 → 缓存浪费告警 → cache-stats-updated
//             （可 --loop 循环播放）
// =======================================================================

import type { JsonValue } from '../../../../packages/shared-types/src/primitive-types';
import type { PendingApproval } from '../../../../packages/shared-types/src/generated/device/types';
import type { ApprovalDecisionResult } from '../state.js';
import { approvalScenario } from './approval.js';
import { runScenario } from './run.js';
import { cacheScenario } from './cache.js';

export type ScenarioId = 'idle' | 'approval' | 'run' | 'cache';

/** 场景运行上下文（由 server 实现并注入） */
export interface ScenarioContext {
  /**
   * 发射持久化事件：分配 sequence、写入会话存储、广播给已订阅该会话的连接。
   * 返回分配的 sequence。
   */
  emit(sessionId: string, event: JsonValue): Promise<number>;
  /**
   * 发射预览帧：不推进游标、不进存储（preview=true，D3 §7.3 实时预览帧语义）。
   */
  emitPreview(sessionId: string, event: JsonValue): Promise<void>;
  /**
   * 审批闸门：登记待审批项 + 发射 approval-requested，等待客户端
   * approve/deny 命令决策后返回；决策由命令处理器注入。
   */
  requestApproval(request: PendingApproval): Promise<ApprovalDecisionResult>;
  /** 场景内延时（受 CLI --scenario-speed 影响） */
  sleep(ms: number): Promise<void>;
}

export interface ScenarioDefinition {
  id: ScenarioId;
  /** 场景说明（README / --list 展示） */
  description: string;
  /** 场景主会话 id */
  sessionId: string;
  /** 场景主 run id */
  runId: string;
  /** 是否可 --loop 重复播放（交互式审批场景不可循环） */
  loopable: boolean;
  /** 场景是否交互（含审批闸门） */
  interactive: boolean;
  /** 场景时间线 */
  run(ctx: ScenarioContext): Promise<void>;
}

/** 场景注册表（id 唯一） */
export const SCENARIOS: Record<ScenarioId, ScenarioDefinition> = {
  idle: {
    id: 'idle',
    description: '默认场景：不自动发射事件，仅回应用户消息（测试与手动联调基座）',
    sessionId: 's-mock-idle',
    runId: 'r-mock-idle-1',
    loopable: false,
    interactive: false,
    async run(): Promise<void> {
      // idle 场景没有自动时间线；事件由测试/联调方通过 server 手动发射
    },
  },
  approval: approvalScenario,
  run: runScenario,
  cache: cacheScenario,
};

/** 场景 id 清单（CLI --list 输出） */
export function scenarioIds(): ScenarioId[] {
  return (Object.keys(SCENARIOS) as ScenarioId[]).sort();
}
