/**
 * Conex / Crish — UI Playground Virtual Native Mock Barrier
 *
 * 拦截所有 @tauri-apps/api 与 @tauri-apps/plugin-* 调用，
 * 防止 UI 组件在独立免打包 Vite 预览环境下因缺失 Tauri 宿主环境导致白屏或抛错。
 */

export const invoke = async (
  cmd: string,
  args?: Record<string, unknown>
): Promise<unknown> => {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug(`[Tauri Mock Barrier] invoke('${cmd}') intercepted:`, args);
  }
  return null;
};

export const convertFileSrc = (
  filePath: string,
  _protocol = 'asset'
): string => {
  return filePath;
};

export const transformCallback = (
  _callback?: unknown,
  _once = false
): number => {
  return 0;
};

export class Channel<T = unknown> {
  onmessage: (data: T) => void = () => {};
  send(_data: T): void {}
}

export type UnlistenFn = () => void;

export const listen = async <T = unknown>(
  event: string,
  _handler: (event: { event: string; payload: T; id: number }) => void
): Promise<UnlistenFn> => {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug(`[Tauri Mock Barrier] listen('${event}') registered`);
  }
  return () => {};
};

export const once = async <T = unknown>(
  event: string,
  _handler: (event: { event: string; payload: T; id: number }) => void
): Promise<UnlistenFn> => {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug(`[Tauri Mock Barrier] once('${event}') registered`);
  }
  return () => {};
};

export const emit = async (event: string, payload?: unknown): Promise<void> => {
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.debug(`[Tauri Mock Barrier] emit('${event}') called:`, payload);
  }
};

export const getCurrentWindow = () => ({
  label: 'playground-window',
  isMaximized: async () => false,
  minimize: async () => {},
  maximize: async () => {},
  toggleMaximize: async () => {},
  close: async () => {},
  hide: async () => {},
  show: async () => {},
  setFocus: async () => {},
  scaleFactor: async () => 1,
  innerSize: async () => ({ width: 1280, height: 800 }),
  outerSize: async () => ({ width: 1280, height: 800 }),
  onResized: async () => () => {},
  onMoved: async () => () => {},
  onCloseRequested: async () => () => {},
  onFocusChanged: async () => () => {},
});

export const getCurrentWebview = () => ({
  label: 'playground-webview',
});

export const open = async () => null;
export const save = async () => null;
export const message = async () => {};
export const ask = async () => false;
export const confirm = async () => false;

export const appDataDir = async () => '/mock/appDataDir';
export const homeDir = async () => '/mock/homeDir';
export const join = async (...parts: string[]) => parts.join('/');
export const resolve = async (...parts: string[]) => parts.join('/');

// 兜底代理，防止解构或直接访问未知属性抛错
const fallbackMockHandler: ProxyHandler<object> = {
  get: (_target, prop) => {
    if (prop === '__esModule') return true;
    if (prop === 'then') return undefined;
    return (...args: unknown[]) => {
      // eslint-disable-next-line no-console
      console.debug(
        `[Tauri Mock Barrier] fallback access: ${String(prop)}`,
        args
      );
      return Promise.resolve(null);
    };
  },
};

const defaultExport = new Proxy({}, fallbackMockHandler);
export default defaultExport;
