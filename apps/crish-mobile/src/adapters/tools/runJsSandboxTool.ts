/**
 * apps/crish-mobile/src/adapters/tools/runJsSandboxTool.ts
 *
 * 端侧脚本与计算沙箱工具（run_js_sandbox）适配器
 * 严格对齐《04-分维-移动端本地Agent循环与通用端侧工具体系方案.md》§4.4 与《03-分维》§2
 *
 * 核心特性：
 * 1. 经 crish-js-sandbox 模块（端侧沙箱唯一实现真源）调用原生 QuickJS
 *    （独立原生 Worker 线程）；本文件只做工具面适配与结果整形，不再
 *    自带任何执行器；
 * 2. 原生模块未装配时，模块返回 runtime_unavailable 结构化错误，本工具
 *    原样透传为工具错误结果（诚实降级）——旧自带 Node vm 回退执行器与
 *    错误接线的原生探测（找不存在的 `.run` / globalThis）已于
 *    2026-11-05 收敛删除；
 * 3. 严格限制 5000ms 硬超时与 64MB 堆内存上限（限额真源为模块
 *    DEFAULT_LIMITS，本文件常量仅转引）；
 * 4. 测试可经 options.runner 注入执行器替身；生产恒走模块。
 */

import {
  DEFAULT_LIMITS,
  runJsSandbox,
  type JsSandboxOutcome,
} from 'crish-js-sandbox';
import type {
  MobileToolContext,
  MobileToolDefinition,
  ToolExecutionResult,
} from './types';

/** 最大运行超时（毫秒）：硬顶 5000ms（真源：模块 DEFAULT_LIMITS） */
export const SANDBOX_MAX_TIMEOUT_MS = DEFAULT_LIMITS.timeoutMs;
/** 沙箱最大堆内存（字节）：64 MiB（真源：模块 DEFAULT_LIMITS） */
export const SANDBOX_MAX_MEMORY_BYTES = DEFAULT_LIMITS.memoryBytes;
/** 日志最大截断字节数：4 KiB（真源：模块 DEFAULT_LIMITS） */
export const SANDBOX_MAX_LOG_BYTES = DEFAULT_LIMITS.maxLogBytes;
/** 单次结果返回最大字节数：256 KiB（真源：模块 DEFAULT_LIMITS） */
export const SANDBOX_MAX_RESULT_BYTES = DEFAULT_LIMITS.maxResultBytes;

export interface JsSandboxExecutionOutcome {
  status: 'success' | 'error';
  result?: string;
  logs?: string;
  error?: string;
  kind?: string;
  durationMs: number;
}

export type JsSandboxRunner = (
  code: string,
  options: {
    timeoutMs: number;
    memoryBytes: number;
    signal?: AbortSignal;
  }
) => Promise<JsSandboxExecutionOutcome>;

export interface RunJsSandboxToolOptions {
  /** 自定义沙箱运行器注入（供测试使用） */
  runner?: JsSandboxRunner;
}

/**
 * 模块结果 → 工具面结果（状态 / kind / 日志口径对齐）：
 * ok → success；error 的 kind 与 message 原样透传（含
 * runtime_unavailable 诚实降级）。
 */
export function mapJsSandboxOutcome(
  outcome: JsSandboxOutcome
): JsSandboxExecutionOutcome {
  if (outcome.status === 'ok') {
    return {
      status: 'success',
      result: outcome.result,
      logs: outcome.logs,
      durationMs: outcome.durationMs,
    };
  }
  return {
    status: 'error',
    error: outcome.message,
    kind: outcome.kind,
    logs: outcome.logs,
    durationMs: outcome.durationMs,
  };
}

/**
 * 创建通用端侧脚本与计算沙箱工具实例
 */
export function createRunJsSandboxTool(
  options: RunJsSandboxToolOptions = {}
): MobileToolDefinition {
  return {
    name: 'run_js_sandbox',
    description:
      '在手机本地安全隔离沙箱中运行纯 JavaScript (ES2023) 代码。' +
      '支持 Math, Date, JSON, RegExp, BigInt 等标准对象。' +
      '适用于精确数学计算、日期时区运算、数据清洗、正则匹配或算法模拟。' +
      '最后一条表达式的值或 return 的结果将作为输出，支持 console.log 输出。',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            '要在端侧沙箱中执行的 JavaScript 代码字符串。例如 "Math.sqrt(144) * 5" 或 "new Date().toISOString()"',
        },
      },
      required: ['code'],
    },
    approval: 'auto',
    concurrency: 'parallel',
    timeoutMs: SANDBOX_MAX_TIMEOUT_MS,

    async execute(
      args: Record<string, unknown>,
      context: MobileToolContext
    ): Promise<ToolExecutionResult> {
      const rawCode = typeof args.code === 'string' ? args.code.trim() : '';

      // 1. 空代码校验
      if (!rawCode) {
        return {
          toolCallId: '',
          toolName: 'run_js_sandbox',
          ok: false,
          output: JSON.stringify({
            status: 'error',
            error: 'JavaScript code parameter cannot be empty.',
            system_note: 'Please provide valid JavaScript code to execute.',
          }),
          error: 'empty_code',
          metadata: { durationMs: 0 },
        };
      }

      context.onProgress?.('Executing JavaScript in mobile sandbox...');

      // 2. 选择执行驱动（生产恒走 crish-js-sandbox 模块；runner 仅测试注入）
      const limits = {
        timeoutMs: SANDBOX_MAX_TIMEOUT_MS,
        memoryBytes: SANDBOX_MAX_MEMORY_BYTES,
        signal: context.signal,
      };

      let outcome: JsSandboxExecutionOutcome;
      if (options.runner) {
        outcome = await options.runner(rawCode, limits);
      } else {
        outcome = mapJsSandboxOutcome(
          await runJsSandbox({
            code: rawCode,
            limits: {
              timeoutMs: limits.timeoutMs,
              memoryBytes: limits.memoryBytes,
            },
            signal: limits.signal,
          })
        );
      }

      // 3. 组织标准工具返回
      const ok = outcome.status === 'success';
      const outputObj: Record<string, unknown> = {
        status: outcome.status,
        result: outcome.result ?? null,
      };

      if (outcome.logs && outcome.logs.trim()) {
        outputObj.logs = outcome.logs.trim();
      }

      if (!ok) {
        outputObj.error = outcome.error || 'Execution failed';
        outputObj.kind = outcome.kind || 'runtime_error';
        outputObj.system_note =
          'JavaScript execution failed in sandbox. ' +
          'Review the error and syntax before attempting any change, or compute the answer directly without tools.';
      }

      return {
        toolCallId: '',
        toolName: 'run_js_sandbox',
        ok,
        output: JSON.stringify(outputObj, null, 2),
        error: ok ? undefined : outcome.error || 'sandbox_execution_error',
        metadata: {
          durationMs: outcome.durationMs,
          kind: outcome.kind,
          hasLogs: Boolean(outcome.logs && outcome.logs.trim().length > 0),
        },
      };
    },
  };
}

/** 默认端侧脚本与计算沙箱工具单例定义 */
export const runJsSandboxTool: MobileToolDefinition = createRunJsSandboxTool();
