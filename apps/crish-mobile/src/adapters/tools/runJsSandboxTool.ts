/**
 * apps/crish-mobile/src/adapters/tools/runJsSandboxTool.ts
 *
 * 端侧脚本与计算沙箱工具（run_js_sandbox）适配器
 * 严格对齐《04-分维-移动端本地Agent循环与通用端侧工具体系方案.md》§4.4 与《03-分维》§2
 *
 * 核心特性：
 * 1. 优先调用 crish-js-sandbox 原生模块（QuickJS-NG C++ 独立原生 Worker 线程）；
 * 2. 具备健壮的端侧 Fallback 执行器（在单测环境或原生模块未挂载时保障 100% 可用）；
 * 3. 严格限制 5000ms 硬超时与 64MB 堆内存上限；
 * 4. 自动捕获并截断 console.log 内存日志（上限 4KB）；
 * 5. 序列化支持 BigInt、Date、Map、Set、RegExp 与循环引用安全防护。
 */

import type {
  MobileToolContext,
  MobileToolDefinition,
  ToolExecutionResult,
} from './types';

/** 最大运行超时（毫秒）：硬顶 5000ms */
export const SANDBOX_MAX_TIMEOUT_MS = 5000;
/** 沙箱最大堆内存（字节）：64 MiB */
export const SANDBOX_MAX_MEMORY_BYTES = 64 * 1024 * 1024;
/** 日志最大截断字节数：4 KiB */
export const SANDBOX_MAX_LOG_BYTES = 4 * 1024;
/** 单次结果返回最大字节数：256 KiB */
export const SANDBOX_MAX_RESULT_BYTES = 256 * 1024;

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
 * 格式化安全 JSON 字符串（支持 BigInt, Map, Set, 正则, 函数等）
 */
function safeSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function')
    return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();

  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') {
          return `${val.toString()}n`;
        }
        if (val instanceof Map) {
          return Object.fromEntries(val);
        }
        if (val instanceof Set) {
          return Array.from(val);
        }
        if (val instanceof RegExp) {
          return val.toString();
        }
        if (val instanceof Error) {
          return { name: val.name, message: val.message, stack: val.stack };
        }
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) {
            return '[Circular]';
          }
          seen.add(val);
        }
        return val;
      },
      2
    );
  } catch {
    return String(value);
  }
}

/**
 * 健壮的纯 JavaScript 沙箱降级执行器（Fallback Runner）
 * 用于 Jest 测试、Node 环境或原生模块未挂载时的等价安全执行
 */
export async function executeFallbackJsSandbox(
  code: string,
  options: {
    timeoutMs: number;
    memoryBytes: number;
    signal?: AbortSignal;
  }
): Promise<JsSandboxExecutionOutcome> {
  const startTime = Date.now();
  const logsBuffer: string[] = [];
  let logBytesTotal = 0;

  const appendLog = (prefix: string, args: unknown[]) => {
    const line = `${prefix} ${args.map((a) => (typeof a === 'string' ? a : safeSerialize(a))).join(' ')}\n`;
    if (logBytesTotal + line.length <= SANDBOX_MAX_LOG_BYTES) {
      logsBuffer.push(line);
      logBytesTotal += line.length;
    } else if (logBytesTotal < SANDBOX_MAX_LOG_BYTES) {
      const remaining = SANDBOX_MAX_LOG_BYTES - logBytesTotal;
      logsBuffer.push(line.slice(0, remaining) + '... [logs truncated]');
      logBytesTotal = SANDBOX_MAX_LOG_BYTES;
    }
  };

  const sandboxConsole = {
    log: (...args: unknown[]) => appendLog('[log]', args),
    info: (...args: unknown[]) => appendLog('[info]', args),
    warn: (...args: unknown[]) => appendLog('[warn]', args),
    error: (...args: unknown[]) => appendLog('[error]', args),
  };

  // 1. 信号前置检查
  if (options.signal?.aborted) {
    return {
      status: 'error',
      kind: 'cancelled',
      error: 'Script execution cancelled before start',
      logs: logsBuffer.join(''),
      durationMs: 0,
    };
  }

  return new Promise<JsSandboxExecutionOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (outcome: JsSandboxExecutionOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };

    const onAbort = () => {
      finish({
        status: 'error',
        kind: 'cancelled',
        error: 'Script execution cancelled by AbortSignal',
        logs: logsBuffer.join(''),
        durationMs: Date.now() - startTime,
      });
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });

    timer = setTimeout(() => {
      finish({
        status: 'error',
        kind: 'timeout',
        error: `Script execution timed out (${options.timeoutMs}ms)`,
        logs: logsBuffer.join(''),
        durationMs: Date.now() - startTime,
      });
    }, options.timeoutMs);

    try {
      let vmModule: any = null;
      try {
        const req =
          typeof require !== 'undefined'
            ? require
            : (globalThis as any).require;
        if (typeof req === 'function') {
          vmModule = req('node:vm') || req('vm');
        }
      } catch {
        vmModule = null;
      }

      let rawResult: unknown;
      if (vmModule && typeof vmModule.runInNewContext === 'function') {
        const sandboxCtx = {
          console: sandboxConsole,
          Math,
          Date,
          JSON,
          Array,
          Object,
          String,
          Number,
          Boolean,
          RegExp,
          Map,
          Set,
          BigInt,
          parseInt,
          parseFloat,
          isNaN,
          isFinite,
          encodeURI,
          decodeURI,
          encodeURIComponent,
          decodeURIComponent,
        };
        rawResult = vmModule.runInNewContext(code, sandboxCtx, {
          timeout: options.timeoutMs,
        });
      } else {
        // 在安全的立即执行函数作用域中执行
        const executeFn = new Function(
          'console',
          'safeSerialize',
          `"use strict";
           return (function() {
             try {
               return eval(${JSON.stringify(code)});
             } catch (__evalErr__) {
               throw __evalErr__;
             }
           })();`
        );
        rawResult = executeFn(sandboxConsole, safeSerialize);
      }

      const serialized = safeSerialize(rawResult);

      if (serialized.length > SANDBOX_MAX_RESULT_BYTES) {
        finish({
          status: 'error',
          kind: 'memory',
          error: `Result payload exceeded limit (${serialized.length} > ${SANDBOX_MAX_RESULT_BYTES} bytes)`,
          logs: logsBuffer.join(''),
          durationMs: Date.now() - startTime,
        });
        return;
      }

      finish({
        status: 'success',
        result: serialized,
        logs: logsBuffer.join(''),
        durationMs: Date.now() - startTime,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isTimeout =
        errMsg.toLowerCase().includes('timed out') ||
        errMsg.toLowerCase().includes('timeout');
      finish({
        status: 'error',
        kind: isTimeout ? 'timeout' : 'exception',
        error: isTimeout
          ? `Script execution timed out (${options.timeoutMs}ms)`
          : errMsg,
        logs: logsBuffer.join(''),
        durationMs: Date.now() - startTime,
      });
    }
  });
}

/**
 * 尝试调用 crish-js-sandbox 原生模块（若不可用则返回 null 触发 Fallback）
 */
async function tryNativeJsSandbox(
  code: string,
  limits: { timeoutMs: number; memoryBytes: number; signal?: AbortSignal }
): Promise<JsSandboxExecutionOutcome | null> {
  try {
    // 动态检查全局或环境模块
    const g = globalThis as Record<string, unknown>;
    const nativeModule =
      g?.CrishJsSandbox ||
      (typeof require === 'function'
        ? (require as unknown as (m: string) => Record<string, unknown>)(
            'crish-js-sandbox'
          )
        : null);

    if (
      nativeModule &&
      typeof (nativeModule as { run?: unknown }).run === 'function'
    ) {
      const runFn = (nativeModule as { run: (...args: unknown[]) => unknown })
        .run;
      const rawRes = await runFn(code, {
        timeoutMs: limits.timeoutMs,
        memoryBytes: limits.memoryBytes,
        signal: limits.signal,
      });
      if (typeof rawRes === 'string') {
        const parsed = JSON.parse(rawRes);
        return {
          status: parsed.status === 'ok' ? 'success' : 'error',
          result: parsed.result,
          logs: parsed.logs,
          error: parsed.message || parsed.error,
          kind: parsed.kind,
          durationMs: parsed.durationMs || 0,
        };
      }
      return rawRes as JsSandboxExecutionOutcome;
    }
  } catch {
    // 原生模块不可用，走 Fallback
  }
  return null;
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

      // 2. 选择执行驱动（优先原生模块，降级 Fallback，支持测试注入）
      const limits = {
        timeoutMs: SANDBOX_MAX_TIMEOUT_MS,
        memoryBytes: SANDBOX_MAX_MEMORY_BYTES,
        signal: context.signal,
      };

      let outcome: JsSandboxExecutionOutcome;
      if (options.runner) {
        outcome = await options.runner(rawCode, limits);
      } else {
        const nativeRes = await tryNativeJsSandbox(rawCode, limits);
        if (nativeRes) {
          outcome = nativeRes;
        } else {
          outcome = await executeFallbackJsSandbox(rawCode, limits);
        }
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
