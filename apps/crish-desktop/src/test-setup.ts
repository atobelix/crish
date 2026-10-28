import '@testing-library/jest-dom';
import { beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// Tauri invoke mock 基础设施（Stream F）
//
// 系统化方案：直接 mock `@tauri-apps/api/core` 的 invoke 函数，从底层切断
// Tauri IPC。所有上层 wrapper（invokeTyped / invokeResult / rustCore.*）都自动
// 走 mock 路径，无需每个测试文件各自 mock `./tauriInvoke` 模块。
//
// 三态语义（对齐 tauriInvoke.ts 的 InvokeResult）：
//   - ok:      mockTauriCommand(cmd, impl)  → invoke 返回 impl(args)
//   - missing: mockTauriMissing(cmd)         → invoke 抛 "command not found"
//                                             （匹配 isMissingCommandMessage）
//   - error:   mockTauriError(cmd, err)      → invoke 抛 err
//                                             （不匹配 missing 模式 → error 状态）
//
// 默认行为：未注册的命令视为 missing（与 Tauri 后端未注册 command 一致）。
// 每个测试用例前自动 clear（见下方 beforeEach），保证可重置。
// =============================================================================

type TauriMockState = 'ok' | 'missing' | 'error';

interface TauriMockEntry {
  state: TauriMockState;
  impl?: (args: unknown) => unknown | Promise<unknown>;
  error?: unknown;
}

// vi.hoisted 保证 mockState 在 vi.mock 工厂函数执行前就已初始化，
// 且不会被 vitest 的 hoist 机制打乱顺序。
const mockState = vi.hoisted(() => ({
  commands: new Map<string, TauriMockEntry>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    const entry = mockState.commands.get(cmd);
    if (!entry || entry.state === 'missing') {
      // 抛出匹配 tauriInvoke.ts isMissingCommandMessage 正则的消息，
      // 使 invokeResult 走 missing 分支（而非 error 分支）。
      throw new Error(`command ${cmd} not found`);
    }
    if (entry.state === 'error') {
      throw entry.error;
    }
    // ok 状态：调用 impl（若未提供 impl 则返回 null）
    return entry.impl ? entry.impl(args) : null;
  }),
}));

// R2-4 P3-1：Tauri 插件动态 import 模块 mock——vitest 解析不到
// （vite build 已 external，测试环境需 stub；skillsApi/importFsHost
// 的动态 import 在测试中会解析到这些 mock，非 Tauri 环境走 catch 回退）。
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  exists: vi.fn(),
  readDir: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(),
}));

/**
 * 注册一个 ok 状态的 mock command。
 * 调用 invoke(cmd, args) 时，impl(args) 的返回值作为 ok 数据。
 *
 * @example
 *   mockTauriCommand('core_md_render', async (args) => `<p>${args.text}</p>`);
 *   const res = await invokeResult('core_md_render', { text: 'hi' });
 *   // res = { status: 'ok', data: '<p>hi</p>' }
 */
export function mockTauriCommand(
  cmd: string,
  impl: (args: unknown) => unknown | Promise<unknown>
): void {
  mockState.commands.set(cmd, { state: 'ok', impl });
}

/**
 * 显式注册一个 missing 状态的 mock command。
 * invoke(cmd, args) 抛出 "command not found" 错误，invokeResult 返回 missing。
 *
 * 注意：未注册的命令默认就是 missing，所以通常不需要显式调用此函数。
 * 仅用于测试用例需要明确表达 missing 语义时使用。
 *
 * @example
 *   mockTauriMissing('core_md_render');  // 显式标记 command 未注册
 */
export function mockTauriMissing(cmd: string): void {
  mockState.commands.set(cmd, { state: 'missing' });
}

/**
 * 注册一个 error 状态的 mock command。
 * invoke(cmd, args) 抛出指定错误，invokeResult 返回 error 状态。
 *
 * 错误消息不应匹配 missing 模式（/not allowed|command .* not found|.../），
 * 否则 invokeResult 会将其归为 missing。若需测试 missing，请用 mockTauriMissing。
 *
 * @example
 *   mockTauriError('core_md_render', new Error('invalid input'));
 *   const res = await invokeResult('core_md_render', { text: 'hi' });
 *   // res = { status: 'error', message: 'invalid input' }
 */
export function mockTauriError(cmd: string, error: unknown): void {
  mockState.commands.set(cmd, { state: 'error', error });
}

/**
 * 清空所有 mock command 注册。每个测试用例前自动调用。
 *
 * 也可在测试用例中手动调用，以在测试中途重置 mock 状态。
 */
export function clearMockTauriCommands(): void {
  mockState.commands.clear();
}

/**
 * 内部调试工具：返回当前已注册的 command 名称（按状态分组）。
 * 仅用于测试失败时排查 mock 状态，不参与生产逻辑。
 */
export function __inspectMockState(): Record<string, string[]> {
  const byState: Record<string, string[]> = { ok: [], missing: [], error: [] };
  for (const [cmd, entry] of mockState.commands) {
    byState[entry.state]?.push(cmd);
  }
  return byState;
}

function createTestLockManager(): LockManager {
  let queue: Promise<unknown> = Promise.resolve();
  const request = (
    name: string,
    optionsOrCallback:
      LockOptions | ((lock: Lock | null) => Promise<unknown> | unknown),
    callback?: (lock: Lock | null) => Promise<unknown> | unknown
  ): Promise<unknown> => {
    const options =
      typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const onGranted =
      typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (!onGranted)
      return Promise.reject(new Error('Lock callback is required'));
    const scheduled = queue
      .catch(() => undefined)
      .then(() =>
        onGranted({ name, mode: options.mode ?? 'exclusive' } as Lock)
      );
    queue = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  };
  return { request } as unknown as LockManager;
}

// =============================================================================
// DOM 基础辅助垫片
// =============================================================================

// 1. 安全补全 Element.prototype.scrollIntoView
if (
  typeof Element !== 'undefined' &&
  typeof Element.prototype.scrollIntoView !== 'function'
) {
  Element.prototype.scrollIntoView = function (
    arg?: boolean | ScrollIntoViewOptions
  ) {
    (
      this as Element & {
        __lastScrollIntoViewArg?: boolean | ScrollIntoViewOptions;
      }
    ).__lastScrollIntoViewArg = arg;
  };
}

// 2. 安全补全 document.elementFromPoint
if (
  typeof document !== 'undefined' &&
  typeof document.elementFromPoint !== 'function'
) {
  document.elementFromPoint = function (x: number, y: number): Element | null {
    const all = document.body.querySelectorAll('*');
    for (let i = all.length - 1; i >= 0; i--) {
      const el = all[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return el;
      }
    }
    return document.body;
  };
}

// =============================================================================
// 引入真实物理排版仿真引擎与可控 ResizeObserver
// =============================================================================
export {
  MockPhysicalGeometryEngine,
  type TestViewportConfig,
  type ElementGeometryConfig,
} from './test-utils/MockPhysicalGeometryEngine';
export { ControllableResizeObserver } from './test-utils/ControllableResizeObserver';

import { MockPhysicalGeometryEngine } from './test-utils/MockPhysicalGeometryEngine';
import { ControllableResizeObserver } from './test-utils/ControllableResizeObserver';

// 安装驱动型 ResizeObserver
globalThis.ResizeObserver =
  ControllableResizeObserver as unknown as typeof ResizeObserver;

// 安装物理排版仿真引擎
const geometryEngine = MockPhysicalGeometryEngine.getInstance();
geometryEngine.install();

// =============================================================================
// Multi-window shell scope: stable window id for vitest (openTabs / layout tree)
// =============================================================================
try {
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem('crish_shell_window_id', 'vitest-shell');
  }
} catch {
  /* ignore */
}

// =============================================================================
// 每个测试用例前后的严格沙箱重置与还原
// =============================================================================
beforeEach(() => {
  clearMockTauriCommands();
  if (typeof navigator !== 'undefined') {
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: createTestLockManager(),
    });
  }
  geometryEngine.reset();
  ControllableResizeObserver.clearAll();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (typeof document !== 'undefined' && document.body) {
    document.body.innerHTML = '';
  }
});
