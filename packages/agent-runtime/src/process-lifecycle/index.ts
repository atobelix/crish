/**
 * 进程生命周期 - 公共导出
 *
 * 本模块整合了两个子模块：
 * 1. process-manager.ts - 进程生命周期管理（注册、两阶段终止、钩子）
 * 2. process-executor.ts - 进程执行（运行命令、捕获输出、终止进程树）
 */

// ─── 进程生命周期管理 ─────────────────────────────────────

export {
  ProcessManager,
} from "./process-manager";

export type {
  ManagedProcessState,
  ProcessExitKind,
  ManagedProcessOptions,
  ManagedProcessRecord,
  ProcessLifecycleHooks,
} from "./process-manager";

// ─── 进程执行 ─────────────────────────────────────────────

export {
  BoundedProcessOutput,
  runProcessCommand,
  terminateChild,
  normalizeProcessGuard,
  createGuardedProcessEnv,
  defaultProcessShell,
  formatProcessPreview,
  normalizePowerShellCommand,
  encodePowerShellEncodedCommand,
  buildWindowsPowerShellScript,
} from "./process-executor";

export type {
  ProcessShell,
  ProcessGuardOptions,
  ProcessTerminationDiagnostic,
  ProcessRunResult,
  ProcessRunOptions,
} from "./process-executor";
