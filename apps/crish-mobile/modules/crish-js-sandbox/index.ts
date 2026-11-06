/**
 * crish-js-sandbox: QuickJS 独立原生沙箱模块
 *
 * 架构规范依据：《docs/mobile-web-search-and-sandbox/03-分维-QuickJS沙箱集成与端侧网页正文提纯方案.md》§2
 *
 * 核心能力：
 * 1. 移动端宿主（React Native / Expo）：桥接底层 QuickJS-NG C++ 原生模块，在独立 8MB 原生栈 Worker 线程上运行；
 * 2. 刚性资源熔断：指令级超时中断（timeout）、堆内存硬上限（memory/OOM）、4KB 日志与 256KB 结果截断（由原生侧执行）；
 * 3. 零原生环境污染：无宿主 IO / 文件 / 网络暴露，保护主线程零掉帧与全局原型链安全。
 *
 * 唯一实现真源（2026-11-05 收敛）：端侧 JS 沙箱只有这一套实现，
 * src/adapters/tools/runJsSandboxTool 经本模块消费。原生模块未装配时
 * 显式返回 runtime_unavailable 诚实降级——不在 RN/Hermes 环境回退到
 * require Node 内置模块（node:vm）的实现：该路径在 Hermes 里抛
 * JavascriptException 并被判 FATAL，是现装包崩溃链的一环，已按删除
 * 清单清除；能力探测只针对本原生模块。
 */

declare const require: any;

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
  | 'unsettled'
  | 'runtime_unavailable';

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
 * 跨平台执行 JavaScript 沙箱
 *
 * 原生 QuickJS 模块在场时桥接其独立线程执行；未装配时返回
 * runtime_unavailable 结构化错误（不做任何宿主回退，见文件头）。
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

  // 原生模块未装配 = 运行时不可用：显式诚实降级（结构化错误回给
  // 调用方），永不在 RN/Hermes 环境回退到 require Node 内置模块的
  // 实现——那条路径是现装包 FATAL 崩溃链的一环，已按删除清单清除。
  onSettled?.();
  return {
    status: 'error',
    kind: 'runtime_unavailable',
    message: '端侧脚本执行器不可用（原生 QuickJS 沙箱未装配）',
    logs: '',
    logsTruncated: false,
    durationMs: 0,
  };
}

export default runJsSandbox;
