/**
 * apps/crish-desktop/src/api/nativeBrowserApi.ts
 *
 * 原生多 Webview 浏览器 IPC 强类型 API 封装。
 *
 * 对齐 Tauri 2.11 Multi-Webview 架构与 `05-ipc-and-event-streaming-contract.md` 契约：
 * - 对应 Rust Commands:
 *   - browser_webview_create
 *   - browser_webview_set_bounds
 *   - browser_webview_set_visible
 *   - browser_webview_navigate
 *   - browser_webview_action
 *   - browser_webview_close
 *   - browser_webview_set_muted
 *   - browser_webview_set_hit_test
 * - 对应 Downstream Events:
 *   - browser://navigation-state
 *   - browser://download-progress
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeTyped, type InvokeTypedResult } from './tauriInvoke';
import {
  acquireNativeBrowserLease,
  closeNativeBrowserWebview,
  createNativeBrowserWebview,
  navigateNativeBrowser,
  setNativeBrowserBounds,
  setNativeBrowserVisible,
} from './nativeBrowserLifecycle';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function isTauriEnvironment(): boolean {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

// ──────────────────────────────────────────
// 事件通道常量
// ──────────────────────────────────────────

export const EVENT_BROWSER_NAVIGATION_STATE = 'browser://navigation-state';
export const EVENT_BROWSER_DOWNLOAD_PROGRESS = 'browser://download-progress';

// ──────────────────────────────────────────
// 强类型定义
// ──────────────────────────────────────────

/**
 * 逻辑矩形（CSS 逻辑像素，相对主窗口视口客户区）
 */
export interface WebviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 创建原生子 Webview 实例参数
 */
export interface CreateWebviewArgs {
  tabId: string;
  initialUrl?: string;
  bounds: WebviewBounds;
  /** 原生子 Webview 初始显隐；省略时遵循 Rust 的 visible=true 默认值。 */
  visible?: boolean;
  dataDirectory?: string;
  /** 本地文件导航约束根；省略 = 公网上下文，`file:` 一律拒绝。 */
  workspaceRoot?: string;
  muted?: boolean;
}

/**
 * 浏览器标准导航动作枚举
 */
export type BrowserActionKind =
  'back' | 'forward' | 'reload' | 'reload_ignoring_cache' | 'stop';

export interface NativeBrowserHitTestPayload {
  status: 'unsupported';
  reason: string;
}

/**
 * 导航状态事件载荷
 */
export interface NavigationStatePayload {
  tabId: string;
  url: string;
  title: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  isLoading: boolean;
  faviconUrl?: string | null;
  httpStatus?: number | null;
  isMuted?: boolean;
}

/**
 * 下载进度事件载荷
 */
export interface DownloadProgressPayload {
  tabId: string;
  url: string;
  filename: string;
  receivedBytes: number;
  totalBytes?: number | null;
  state: 'progress' | 'completed' | 'interrupted';
}

function assertBrowserCommandSucceeded(
  command: string,
  result: InvokeTypedResult<void>
): void {
  if (result.status === 'error') throw new Error(result.message);
  if (result.status === 'missing') {
    throw new Error(`Tauri command is unavailable: ${command}`);
  }
}

// ──────────────────────────────────────────
// 强类型 Invoke 封装
// ──────────────────────────────────────────

/**
 * 创建并初始化原生子 Webview 实例
 */
export function browserWebviewCreate(args: CreateWebviewArgs): Promise<void> {
  return createNativeBrowserWebview(args);
}

/** 声明一个 Hook 或组件对指定浏览器生命周期的所有权。 */
export function browserWebviewAcquire(tabId: string): () => void {
  return acquireNativeBrowserLease(tabId);
}

/**
 * 设置子 Webview 物理几何位置与尺寸（CSS 逻辑坐标）
 */
export function browserWebviewSetBounds(
  tabId: string,
  bounds: WebviewBounds
): Promise<void> {
  return setNativeBrowserBounds(tabId, bounds);
}

/**
 * 控制子 Webview 的可见性（激活与挂起休眠）
 */
export function browserWebviewSetVisible(
  tabId: string,
  visible: boolean
): Promise<void> {
  return setNativeBrowserVisible(tabId, visible);
}

/** 请求原生 Hit-Test，并保留后端明确返回的能力状态。 */
export async function browserWebviewSetHitTest(
  tabId: string,
  hitTest: boolean
): Promise<NativeBrowserHitTestPayload> {
  const result = await invokeTyped<NativeBrowserHitTestPayload>(
    'browser_webview_set_hit_test',
    { tabId, hitTest }
  );
  if (result.status === 'error') throw new Error(result.message);
  if (result.status === 'missing') {
    throw new Error(
      'Tauri command is unavailable: browser_webview_set_hit_test'
    );
  }
  if (
    result.data?.status !== 'unsupported' ||
    typeof result.data.reason !== 'string'
  ) {
    throw new Error('Invalid response from browser_webview_set_hit_test');
  }
  return result.data;
}

/**
 * 驱动子 Webview 导航至指定目标 URL
 */
export function browserWebviewNavigate(
  tabId: string,
  url: string
): Promise<void> {
  return navigateNativeBrowser(tabId, url);
}

/**
 * 发送标准浏览器动作（前进、后退、刷新、停止）
 */
export async function browserWebviewAction(
  tabId: string,
  action: BrowserActionKind
): Promise<void> {
  const res = await invokeTyped<void>('browser_webview_action', {
    tabId,
    action,
  });
  assertBrowserCommandSucceeded('browser_webview_action', res);
}

/**
 * 销毁指定 Tab 的子 Webview 并释放原生句柄资源
 */
export function browserWebviewClose(tabId: string): Promise<void> {
  return closeNativeBrowserWebview(tabId);
}

/**
 * 设置子 Webview 的静音状态
 */
export async function browserWebviewSetMuted(
  tabId: string,
  muted: boolean
): Promise<void> {
  const res = await invokeTyped<void>('browser_webview_set_muted', {
    tabId,
    muted,
  });
  assertBrowserCommandSucceeded('browser_webview_set_muted', res);
}

// ──────────────────────────────────────────
// 事件监听订阅器
// ──────────────────────────────────────────

/**
 * 订阅全域原生浏览器导航状态变更事件
 * @returns 同步注销清理函数
 */
export function onNativeBrowserNavigationState(
  callback: (payload: NavigationStatePayload) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  let disposed = false;
  let unlistenFn: UnlistenFn | null = null;

  try {
    listen<NavigationStatePayload>(EVENT_BROWSER_NAVIGATION_STATE, (event) => {
      if (!disposed && event?.payload) {
        callback(event.payload);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      })
      .catch((err) => {
        if (isTauriEnvironment()) {
          console.warn('[nativeBrowserApi] 订阅 navigation-state 失败:', err);
        }
      });
  } catch {
    // 非 Tauri 或无法监听环境容错
  }

  return () => {
    disposed = true;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}

/**
 * 订阅全域原生浏览器下载进度事件
 * @returns 同步注销清理函数
 */
export function onNativeBrowserDownloadProgress(
  callback: (payload: DownloadProgressPayload) => void
): () => void {
  if (typeof window === 'undefined') return () => {};

  let disposed = false;
  let unlistenFn: UnlistenFn | null = null;

  try {
    listen<DownloadProgressPayload>(
      EVENT_BROWSER_DOWNLOAD_PROGRESS,
      (event) => {
        if (!disposed && event?.payload) {
          callback(event.payload);
        }
      }
    )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFn = unlisten;
        }
      })
      .catch((err) => {
        if (isTauriEnvironment()) {
          console.warn('[nativeBrowserApi] 订阅 download-progress 失败:', err);
        }
      });
  } catch {
    // 非 Tauri 或无法监听环境容错
  }

  return () => {
    disposed = true;
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
  };
}
