type SettledState = 'idle' | 'ready' | 'blocked';

let state: SettledState | 'pending' = 'idle';
let pendingCount = 0;
let baseState: SettledState = 'idle';
let batchSucceeded = false;
let batchMustBlock = false;
let batchError: Error | null = null;
let barrier: Promise<void> = Promise.resolve();
let releaseBarrier: (() => void) | null = null;

let startupReserved = false;
let startupCompleted = false;
let startupPromise: Promise<void> | null = null;
let resolveStartup: (() => void) | null = null;
let authorizationQueue: Promise<void> = Promise.resolve();

const WORKSPACE_ACCESS_LOCK_NAME = 'crish-workspace-access';

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

function withSharedWorkspaceLock<T>(
  operation: () => Promise<T> | T
): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks) {
    return navigator.locks.request(
      WORKSPACE_ACCESS_LOCK_NAME,
      { mode: 'exclusive' },
      async (lock): Promise<T> => {
        if (!lock) {
          throw new WorkspaceAccessGateError(
            '未能取得工作区授权锁，请重试。' /* i18n-allow */
          );
        }
        return await operation();
      }
    ) as Promise<T>;
  }

  if (isTauriRuntime()) {
    return Promise.reject(
      new WorkspaceAccessGateError(
        '当前桌面窗口无法建立跨窗口工作区授权锁，请重启应用。' /* i18n-allow */
      )
    );
  }

  return Promise.resolve().then(operation) as Promise<T>;
}

function enterPending(initialState?: SettledState): void {
  if (pendingCount === 0) {
    baseState = initialState ?? (state === 'pending' ? 'idle' : state);
    batchSucceeded = false;
    batchMustBlock = false;
    batchError = null;
    state = 'pending';
    barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
  }
  pendingCount += 1;
}

function leavePending(
  succeeded: boolean,
  error?: unknown,
  failClosedOnError = false
): void {
  if (succeeded) {
    batchSucceeded = true;
    batchMustBlock = false;
    batchError = null;
  } else if (error !== undefined) {
    batchError = asError(error);
    if (failClosedOnError) batchMustBlock = true;
  }
  pendingCount = Math.max(0, pendingCount - 1);
  if (pendingCount !== 0) return;

  if (batchMustBlock) {
    state = 'blocked';
    batchError ??= new Error(
      'Workspace authorization is required before file access.'
    );
  } else if (batchSucceeded || baseState === 'ready') {
    state = 'ready';
    batchError = null;
  } else if (baseState === 'blocked') {
    state = 'blocked';
    batchError ??= new Error(
      'Workspace authorization is required before file access.'
    );
  } else {
    state = 'idle';
    batchError = null;
  }

  const release = releaseBarrier;
  releaseBarrier = null;
  release?.();
}

/** 在应用首屏渲染时同步预留启动复授权门闩，避免子组件先发出工作区命令。 */
export function reserveWorkspaceAccessStartup(): void {
  if (startupReserved) return;
  startupReserved = true;
  startupPromise = new Promise<void>((resolve) => {
    resolveStartup = resolve;
  });
  enterPending('blocked');
}

/** 启动复授权完成后释放门闩；失败时工作区命令保持拒绝，直到后续授权成功。 */
export function completeWorkspaceAccessStartup(error?: unknown): void {
  if (!startupReserved || startupCompleted) return;
  startupCompleted = true;
  leavePending(error === undefined, error);
  const resolve = resolveStartup;
  resolveStartup = null;
  resolve?.();
}

/** 对使用当前工作区根的命令执行门闩检查，并在同一微任务中立即发起 IPC。 */
export async function withWorkspaceAccess<T>(
  operation: () => T | Promise<T>
): Promise<T> {
  while (true) {
    const observedBarrier = barrier;
    await observedBarrier;
    if (observedBarrier !== barrier || state === 'pending') continue;

    const result = await withSharedWorkspaceLock(async () => {
      if (observedBarrier !== barrier || state === 'pending') {
        return { retry: true as const };
      }
      if (state === 'blocked') {
        const reason = batchError?.message;
        throw new WorkspaceAccessGateError(
          reason || 'Workspace authorization is required before file access.'
        );
      }
      return { retry: false as const, value: await operation() };
    });
    if (result.retry) continue;
    return result.value;
  }
}

/** 启动复授权持有跨 Webview 锁；调用方负责先同步预留启动门闩。 */
export function withWorkspaceAccessStartupLock<T>(
  operation: () => Promise<T> | T
): Promise<T> {
  return withSharedWorkspaceLock(operation);
}

/** 串行执行显式授权，并在整个授权事务期间阻止工作区命令。 */
export function withWorkspaceAccessTransition<T>(
  operation: () => Promise<T>,
  succeeded: (value: T) => boolean = () => true,
  options: { failClosedOnError?: boolean } = {}
): Promise<T> {
  enterPending();
  const scheduled = authorizationQueue
    .catch(() => undefined)
    .then(async () => {
      await startupPromise;
      return withSharedWorkspaceLock(operation);
    });

  const result = scheduled.then(
    (value) => {
      leavePending(succeeded(value));
      return value;
    },
    (error: unknown) => {
      leavePending(false, error, options.failClosedOnError === true);
      throw error;
    }
  );
  authorizationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** 工作区授权门闩错误，供结构化 IPC 层转换成普通命令错误。 */
export class WorkspaceAccessGateError extends Error {
  readonly kind = 'WorkspaceAccess';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceAccessGateError';
  }
}

/** 隔离测试间的模块级状态。 */
export function __resetWorkspaceAccessGateForTests(): void {
  state = 'idle';
  pendingCount = 0;
  baseState = 'idle';
  batchSucceeded = false;
  batchMustBlock = false;
  batchError = null;
  barrier = Promise.resolve();
  releaseBarrier = null;
  startupReserved = false;
  startupCompleted = false;
  startupPromise = null;
  resolveStartup = null;
  authorizationQueue = Promise.resolve();
}
