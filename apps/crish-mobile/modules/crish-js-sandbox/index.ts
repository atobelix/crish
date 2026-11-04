/**
 * crish-js-sandbox: QuickJS 独立原生沙箱模块
 *
 * 架构规范依据：《docs/mobile-web-search-and-sandbox/03-分维-QuickJS沙箱集成与端侧网页正文提纯方案.md》§2
 *
 * 核心能力：
 * 1. 移动端宿主（React Native / Expo）：桥接底层 QuickJS-NG C++ 原生模块，在独立 8MB 原生栈 Worker 线程上运行；
 * 2. 桌面 / 测试环境（Node.js / Jest）：提供透明等价的 Fallback 沙箱，支持 5000ms 硬超时、内存配额监控、日志与返回值截断；
 * 3. 刚性资源熔断：指令级超时中断（timeout）、堆内存硬上限（memory/OOM）、4KB 日志与 256KB 结果截断；
 * 4. 零原生环境污染：无宿主 IO / 文件 / 网络暴露，保护主线程零掉帧与全局原型链安全。
 */

declare const require: any;
declare const Buffer: any;

export type JsSandboxLimits = {
  /** 单次执行硬超时时间（毫秒），0 代表无超时限制，默认 5000ms */
  timeoutMs: number;
  /** QuickJS 运行时全局堆内存硬上限（字节），默认 64 * 1024 * 1024 (64 MiB) */
  memoryBytes: number;
  /** 序列化返回结果的最大 UTF-8 字节上限，默认 256 * 1024 (256 KiB) */
  maxResultBytes: number;
  /** 捕获 console 日志的最大 UTF-8 字节上限，默认 4 * 1024 (4 KiB) */
  maxLogBytes: number;
};

export type JsSandboxSuccessOutcome = {
  status: 'ok';
  /** JSON 序列化后的字符串结果，无返回值时为 undefined */
  result?: string;
  resultTruncated?: boolean;
  logs: string;
  logsTruncated: boolean;
  durationMs: number;
};

export type JsSandboxErrorKind =
  | 'timeout'
  | 'memory'
  | 'exception'
  | 'syntax'
  | 'cancelled'
  | 'internal'
  | 'unsettled';

export type JsSandboxErrorOutcome = {
  status: 'error';
  kind: JsSandboxErrorKind;
  message: string;
  logs: string;
  logsTruncated: boolean;
  durationMs: number;
};

export type JsSandboxOutcome = JsSandboxSuccessOutcome | JsSandboxErrorOutcome;

export type EvaluateOptions = {
  code: string;
  limits?: Partial<JsSandboxLimits>;
  signal?: AbortSignal;
  onSettled?: () => void;
};

export const DEFAULT_LIMITS: JsSandboxLimits = {
  timeoutMs: 5000,
  memoryBytes: 64 * 1024 * 1024, // 64 MiB
  maxResultBytes: 256 * 1024, // 256 KiB
  maxLogBytes: 4 * 1024, // 4 KiB
};

export interface JsSandboxNativeModule {
  run(runId: string, code: string, limits: JsSandboxLimits): Promise<string>;
  cancel(runId: string): void;
  runFiles?(
    runId: string,
    code: string,
    limits: JsSandboxLimits,
    files: { inputs: string[]; output: string }
  ): Promise<string>;
  runBridge?(
    runId: string,
    setup: string,
    data: string,
    clock: { startedAt: number; seed: number },
    limits: JsSandboxLimits
  ): Promise<string>;
  deliver?(runId: string, message: string): void;
  addListener?(
    event: 'onMessage',
    listener: (event: { runId: string; message: string }) => void
  ): { remove(): void };
}

let cachedNative: JsSandboxNativeModule | null | undefined;

/**
 * 获取底层原生模块实例；非移动端真机宿主（如 Jest、Web、未 prebuild 环境）返回 null。
 */
export function getNativeJsSandbox(): JsSandboxNativeModule | null {
  if (cachedNative !== undefined) return cachedNative;
  try {
    // 动态惰性尝试从 expo 加载可选原生模块，绝不在模块顶层静态导入导致崩溃

    const expo = require('expo');
    if (typeof expo?.requireOptionalNativeModule === 'function') {
      const mod =
        expo.requireOptionalNativeModule('CrishJsSandbox') ||
        expo.requireOptionalNativeModule('JsSandbox') ||
        null;
      cachedNative = mod;
      return mod;
    }
    cachedNative = null;
    return null;
  } catch {
    cachedNative = null;
    return null;
  }
}

export function isNativeSandboxAvailable(): boolean {
  return getNativeJsSandbox() !== null;
}

export const getJsSandbox = getNativeJsSandbox;

/**
 * 字符串按 UTF-8 字节上限安全截断（确保不截断到多字节字符的中间位置）
 */
function truncateUtf8(
  text: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: '', truncated: text.length > 0 };
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(text, 'utf-8');
    if (buf.length <= maxBytes) return { text, truncated: false };
    let end = maxBytes;
    while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
      end--;
    }
    return {
      text: buf.subarray(0, end).toString('utf-8'),
      truncated: true,
    };
  }
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--;
  }
  const decoder = new TextDecoder('utf-8');
  return {
    text: decoder.decode(bytes.subarray(0, end)),
    truncated: true,
  };
}

/**
 * JSON 序列化 replacer：支持 BigInt、Map、Set 无损转换
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return Array.from(value);
  return value;
}

/**
 * 日志格式化助手
 */
function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }
  try {
    const text = JSON.stringify(value, jsonReplacer);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/**
 * 智能包装待执行代码：
 * 1. 若含有 return 关键字，直接作为 async IIFE 函数体；
 * 2. 若为单表达式（如 1 + 1 或 { a: 1 }），自动包装 return (...)；
 * 3. 若为多行语句且无 return，自动尝试将最后一条非声明语句作为返回值。
 */
function prepareExecutableCode(code: string): string {
  const trimmed = code.trim();
  if (/\breturn\b/.test(trimmed)) {
    return `(async function () {\n${trimmed}\n})()`;
  }
  // 尝试直接作为表达式返回
  try {
    const vm = require('node:vm');
    const candidate = `(async function () {\nreturn (\n${trimmed}\n);\n})()`;
    new vm.Script(candidate);
    return candidate;
  } catch {
    // 若不是单表达式，尝试从最后一行或分号后提取最后一条语句转换为 return
    const lines = trimmed.split('\n');
    let lastLine = lines[lines.length - 1]?.trim() ?? '';
    let prefix = lines.slice(0, -1).join('\n');

    const semiIdx = lastLine.lastIndexOf(';');
    if (semiIdx >= 0 && semiIdx < lastLine.length - 1) {
      prefix = (prefix ? prefix + '\n' : '') + lastLine.slice(0, semiIdx + 1);
      lastLine = lastLine.slice(semiIdx + 1).trim();
    }

    const isDeclaration =
      lastLine.startsWith('const ') ||
      lastLine.startsWith('let ') ||
      lastLine.startsWith('var ') ||
      lastLine.startsWith('function ') ||
      lastLine.startsWith('class ') ||
      lastLine.startsWith('import ') ||
      lastLine.startsWith('export ');

    if (lastLine && !isDeclaration) {
      const candidateCode = `${prefix ? prefix + '\n' : ''}return (${lastLine.replace(/;+$/, '')});`;
      const multiCandidate = `(async function () {\n${candidateCode}\n})()`;
      try {
        const vm = require('node:vm');
        new vm.Script(multiCandidate);
        return multiCandidate;
      } catch {
        // 语法失败则保留原样让 vm 解析报错
      }
    }
    return `(async function () {\n${trimmed}\n})()`;
  }
}

/**
 * Node.js / Jest 环境下的透明沙箱 Fallback 实现
 */
async function runFallbackSandbox(
  code: string,
  limits: JsSandboxLimits,
  signal?: AbortSignal
): Promise<JsSandboxOutcome> {
  const startedAt = Date.now();
  let logs = '';
  let logsTruncated = false;

  function appendLog(level: string, args: unknown[]) {
    if (logsTruncated) return;
    const parts = args.map(formatLogValue);
    const prefix = level === 'log' ? '' : `[${level}] `;
    const line = prefix + parts.join(' ') + '\n';
    const currentBytes =
      typeof Buffer !== 'undefined'
        ? Buffer.byteLength(logs, 'utf-8')
        : new TextEncoder().encode(logs).length;
    const remaining = limits.maxLogBytes - currentBytes;
    if (remaining <= 0) {
      logsTruncated = true;
      return;
    }
    const { text, truncated } = truncateUtf8(line, remaining);
    logs += text;
    if (truncated) {
      logsTruncated = true;
    }
  }

  // 1. 检查取消信号
  if (signal?.aborted) {
    return {
      status: 'error',
      kind: 'cancelled',
      message: 'The run was cancelled.',
      logs: '',
      logsTruncated: false,
      durationMs: 0,
    };
  }

  // 2. 内存限制防护监控器
  let currentAllocatedBytes = 0;
  const memoryLimit = limits.memoryBytes;

  function checkAllocation(bytes: number) {
    if (typeof bytes === 'number' && bytes > 0) {
      currentAllocatedBytes += bytes;
      if (currentAllocatedBytes > memoryLimit) {
        const memMb = Math.floor(memoryLimit / (1024 * 1024));
        const limitStr = memMb > 0 ? `${memMb} MiB` : `${memoryLimit} bytes`;
        const err = new RangeError(
          `The script exceeded the ${limitStr} memory limit.`
        );
        (err as unknown as Record<string, unknown>).isMemoryLimit = true;
        throw err;
      }
    }
  }

  // 构造干净的执行上下文

  const vm = require('node:vm');

  const OriginalArray = Array;
  function SandboxArray(...args: unknown[]) {
    if (args.length === 1 && typeof args[0] === 'number') {
      checkAllocation(args[0] * 8);
      return new OriginalArray(args[0]);
    }
    return new (OriginalArray as unknown as new (...a: unknown[]) => unknown[])(
      ...args
    );
  }
  Object.setPrototypeOf(SandboxArray, OriginalArray);
  SandboxArray.prototype = OriginalArray.prototype;
  SandboxArray.isArray = OriginalArray.isArray;
  SandboxArray.from = OriginalArray.from;
  SandboxArray.of = OriginalArray.of;

  class SandboxArrayBuffer extends ArrayBuffer {
    constructor(byteLength: number) {
      checkAllocation(byteLength);
      super(byteLength);
    }
  }

  function createTypedArrayWrapper<T extends ArrayBufferView>(
    OriginalConstructor: new (...args: any[]) => T,
    bytesPerElement: number
  ) {
    return function SandboxTypedArray(...args: any[]) {
      if (args.length > 0 && typeof args[0] === 'number') {
        checkAllocation(args[0] * bytesPerElement);
      }
      return new OriginalConstructor(...args);
    };
  }

  const sandboxConsole = {
    log: (...args: unknown[]) => appendLog('log', args),
    info: (...args: unknown[]) => appendLog('info', args),
    warn: (...args: unknown[]) => appendLog('warn', args),
    error: (...args: unknown[]) => appendLog('error', args),
    debug: (...args: unknown[]) => appendLog('debug', args),
  };

  const contextObj: Record<string, unknown> = {
    console: sandboxConsole,
    print: sandboxConsole.log,
    Array: SandboxArray,
    ArrayBuffer: SandboxArrayBuffer,
    Uint8Array: createTypedArrayWrapper(Uint8Array, 1),
    Int8Array: createTypedArrayWrapper(Int8Array, 1),
    Uint16Array: createTypedArrayWrapper(Uint16Array, 2),
    Int16Array: createTypedArrayWrapper(Int16Array, 2),
    Uint32Array: createTypedArrayWrapper(Uint32Array, 4),
    Int32Array: createTypedArrayWrapper(Int32Array, 4),
    Float32Array: createTypedArrayWrapper(Float32Array, 4),
    Float64Array: createTypedArrayWrapper(Float64Array, 8),
    BigInt64Array: createTypedArrayWrapper(BigInt64Array, 8),
    BigUint64Array: createTypedArrayWrapper(BigUint64Array, 8),
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Math,
    Date,
    JSON,
    Promise,
    Error,
    RangeError,
    TypeError,
    SyntaxError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    BigInt,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    encodeURIComponent,
    decodeURI,
    decodeURIComponent,
  };
  contextObj.globalThis = contextObj;

  const sandboxContext = vm.createContext(contextObj);

  // 3. 准备执行代码并进行语法编译检查
  const wrappedCode = prepareExecutableCode(code);
  let script: InstanceType<typeof vm.Script>;
  try {
    script = new vm.Script(wrappedCode, {
      filename: 'sandbox.js',
    });
  } catch (err: any) {
    return {
      status: 'error',
      kind: 'syntax',
      message: err?.message || String(err),
      logs,
      logsTruncated,
      durationMs: Date.now() - startedAt,
    };
  }

  // 4. 超时定时器与中止控制
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = limits.timeoutMs;

  const timeoutPromise = new Promise<never>((_, reject) => {
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        const err = new Error(
          `The script exceeded the ${timeoutMs} ms time limit and was stopped.`
        );
        (err as unknown as Record<string, unknown>).code =
          'ERR_SCRIPT_EXECUTION_TIMEOUT';
        reject(err);
      }, timeoutMs);
      if (typeof (timeoutTimer as any)?.unref === 'function') {
        (timeoutTimer as any).unref();
      }
    }
  });

  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      abortListener = () => {
        const err = new Error('The run was cancelled.');
        (err as unknown as Record<string, unknown>).isCancelled = true;
        reject(err);
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });

  try {
    // vm.runInContext 带 timeout 参数，可刚性阻断同步死循环（while(true)）
    const runResult = script.runInContext(sandboxContext, {
      timeout: timeoutMs > 0 ? timeoutMs : undefined,
    });

    const settledValue = await Promise.race([
      Promise.resolve(runResult),
      timeoutPromise,
      abortPromise,
    ]);

    const durationMs = Date.now() - startedAt;

    // 格式化输出结果
    if (settledValue === undefined) {
      return {
        status: 'ok',
        logs,
        logsTruncated,
        durationMs,
      };
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(settledValue, jsonReplacer);
      if (serialized === undefined) {
        serialized = String(settledValue);
      }
    } catch {
      serialized = String(settledValue);
    }

    const { text: resultText, truncated: resultTruncated } = truncateUtf8(
      serialized,
      limits.maxResultBytes
    );

    return {
      status: 'ok',
      result: resultText,
      resultTruncated,
      logs,
      logsTruncated,
      durationMs,
    };
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;

    // 内存超限检查
    const isMemory =
      err?.isMemoryLimit ||
      (typeof err?.message === 'string' &&
        (err.message.includes('memory limit') ||
          err.message.includes('Out of memory') ||
          err.message.includes('Array buffer allocation failed') ||
          err.message.includes('Invalid array length') ||
          err.message.includes('Invalid string length') ||
          err.code === 'ERR_BUFFER_TOO_LARGE'));

    if (isMemory) {
      const memMb = Math.floor(memoryLimit / (1024 * 1024));
      const limitStr = memMb > 0 ? `${memMb} MiB` : `${memoryLimit} bytes`;
      return {
        status: 'error',
        kind: 'memory',
        message: err?.message?.includes('memory limit')
          ? err.message
          : `The script exceeded the ${limitStr} memory limit.`,
        logs,
        logsTruncated,
        durationMs,
      };
    }

    // 超时检查
    const isTimeout =
      err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      (typeof err?.message === 'string' &&
        (err.message.includes('Script execution timed out') ||
          err.message.includes('time limit and was stopped')));

    if (isTimeout) {
      return {
        status: 'error',
        kind: 'timeout',
        message: `The script exceeded the ${timeoutMs} ms time limit and was stopped.`,
        logs,
        logsTruncated,
        durationMs,
      };
    }

    // 取消检查
    if (err?.isCancelled || signal?.aborted) {
      return {
        status: 'error',
        kind: 'cancelled',
        message: 'The run was cancelled.',
        logs,
        logsTruncated,
        durationMs,
      };
    }

    // 语法错误检查
    if (err?.name === 'SyntaxError') {
      return {
        status: 'error',
        kind: 'syntax',
        message: err?.message || 'SyntaxError',
        logs,
        logsTruncated,
        durationMs,
      };
    }

    // 常规运行时异常
    return {
      status: 'error',
      kind: 'exception',
      message: err?.stack || err?.message || String(err),
      logs,
      logsTruncated,
      durationMs,
    };
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    if (abortListener && signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

/**
 * 跨平台执行 JavaScript 沙箱
 *
 * 在 React Native 移动端宿主直接进入 QuickJS-NG C++ 原生独立线程执行；
 * 在 Jest / Node.js 单元测试环境下无缝调用 Fallback 沙箱，保障测试即时可用。
 */
export async function runJsSandbox(
  optionsOrCode: string | EvaluateOptions,
  limits?: Partial<JsSandboxLimits>,
  signal?: AbortSignal
): Promise<JsSandboxOutcome> {
  let code: string;
  let effectiveLimits: JsSandboxLimits;
  let abortSignal: AbortSignal | undefined;
  let onSettled: (() => void) | undefined;

  if (typeof optionsOrCode === 'string') {
    code = optionsOrCode;
    effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
    abortSignal = signal;
  } else {
    code = optionsOrCode.code;
    effectiveLimits = { ...DEFAULT_LIMITS, ...optionsOrCode.limits };
    abortSignal = optionsOrCode.signal;
    onSettled = optionsOrCode.onSettled;
  }

  if (abortSignal?.aborted) {
    onSettled?.();
    return {
      status: 'error',
      kind: 'cancelled',
      message: 'The run was cancelled.',
      logs: '',
      logsTruncated: false,
      durationMs: 0,
    };
  }

  const native = getNativeJsSandbox();
  if (native) {
    const runId =
      'crish_run_' +
      Math.random().toString(36).slice(2) +
      Date.now().toString(36);
    let onAbort: (() => void) | undefined;
    try {
      const abortPromise = new Promise<never>((_, reject) => {
        if (abortSignal) {
          onAbort = () => {
            native.cancel(runId);
            reject(new Error('cancelled'));
          };
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      });
      const runPromise = native.run(runId, code, effectiveLimits);
      const rawResult = await Promise.race([runPromise, abortPromise]);
      try {
        const parsed = JSON.parse(rawResult) as JsSandboxOutcome;
        return parsed;
      } catch {
        return {
          status: 'error',
          kind: 'internal',
          message: 'The sandbox returned an unreadable outcome.',
          logs: '',
          logsTruncated: false,
          durationMs: 0,
        };
      }
    } catch (err: any) {
      if (abortSignal?.aborted || err?.message === 'cancelled') {
        return {
          status: 'error',
          kind: 'cancelled',
          message: 'The run was cancelled.',
          logs: '',
          logsTruncated: false,
          durationMs: 0,
        };
      }
      return {
        status: 'error',
        kind: 'internal',
        message: err?.message || 'Native sandbox failure',
        logs: '',
        logsTruncated: false,
        durationMs: 0,
      };
    } finally {
      if (onAbort && abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      onSettled?.();
    }
  }

  // Fallback 运行时
  try {
    return await runFallbackSandbox(code, effectiveLimits, abortSignal);
  } finally {
    onSettled?.();
  }
}

export default runJsSandbox;
