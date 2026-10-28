import { invokeTyped } from './tauriInvoke';
import { logger } from '../services/LoggerService';
import type { CreateWebviewArgs, WebviewBounds } from './nativeBrowserApi';
import {
  browserLifecycles,
  lifecycleFor,
  rejectPending,
  type BrowserLifecycle,
} from './nativeBrowserLifecycleState';

export { resetNativeBrowserLifecyclesForTesting } from './nativeBrowserLifecycleState';

export function acquireNativeBrowserLease(tabId: string): () => void {
  const lifecycle = lifecycleFor(tabId);
  lifecycle.leaseCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    if (browserLifecycles.get(tabId) !== lifecycle) return;

    lifecycle.leaseCount = Math.max(0, lifecycle.leaseCount - 1);
    if (lifecycle.leaseCount > 0) return;

    if (lifecycle.status === 'waiting' && !lifecycle.createPromise) {
      rejectPending(
        lifecycle,
        new Error(
          `Browser lifecycle lease released before create for tab ${tabId}`
        )
      );
      browserLifecycles.delete(tabId);
      return;
    }
    if (
      (lifecycle.status === 'failed' || lifecycle.status === 'closed') &&
      !lifecycle.closePromise
    ) {
      browserLifecycles.delete(tabId);
      return;
    }
    if (lifecycle.status === 'creating') {
      rejectPending(
        lifecycle,
        new Error(
          `Navigation cancelled because tab ${tabId} has no active owner`
        )
      );
      void closeNativeBrowserWebview(tabId).catch((error) => {
        logger.warn('Native browser close after final lease release failed', {
          module: 'nativeBrowserLifecycle',
          err: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    }
  };
}

function unwrapInvoke<T>(
  result:
    | { status: 'ok'; data: T }
    | { status: 'error'; message: string }
    | { status: 'missing' },
  command: string
): T {
  if (result.status === 'error') throw new Error(result.message);
  if (result.status === 'missing') {
    throw new Error(`Tauri command is unavailable: ${command}`);
  }
  return (result as { status: 'ok'; data: T }).data;
}

function navigateNow(tabId: string, url: string): Promise<void> {
  return invokeTyped<void>('browser_webview_navigate', { tabId, url }).then(
    (r) => unwrapInvoke(r, 'browser_webview_navigate')
  );
}

function setVisibleNow(tabId: string, visible: boolean): Promise<void> {
  return invokeTyped<void>('browser_webview_set_visible', {
    tabId,
    visible,
  }).then((r) => unwrapInvoke(r, 'browser_webview_set_visible'));
}

function setBoundsNow(tabId: string, bounds: WebviewBounds): Promise<void> {
  return invokeTyped<void>('browser_webview_set_bounds', {
    tabId,
    bounds,
  }).then((r) => unwrapInvoke(r, 'browser_webview_set_bounds'));
}

function queueOperation(
  lifecycle: BrowserLifecycle,
  operation: () => Promise<void>
): Promise<void> {
  const previous = lifecycle.reconcilePromise ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  lifecycle.reconcilePromise = next;
  return next;
}

function sameBounds(left: WebviewBounds | undefined, right: WebviewBounds) {
  return Boolean(
    left &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function queueVisibility(
  tabId: string,
  lifecycle: BrowserLifecycle,
  visible: boolean
): Promise<void> {
  lifecycle.visible = visible;
  const previous = lifecycle.visibilityPromise ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (lifecycle.appliedVisible === visible) return;
      await setVisibleNow(tabId, visible);
      lifecycle.appliedVisible = visible;
    });
  lifecycle.visibilityPromise = next;
  return next;
}

async function reconcileCreated(
  tabId: string,
  lifecycle: BrowserLifecycle,
  args: CreateWebviewArgs
): Promise<void> {
  if (!sameBounds(lifecycle.bounds, args.bounds)) {
    await setBoundsNow(tabId, args.bounds);
    lifecycle.bounds = args.bounds;
  }
  if (args.initialUrl && lifecycle.currentUrl !== args.initialUrl) {
    await navigateNow(tabId, args.initialUrl);
    lifecycle.currentUrl = args.initialUrl;
  }
  if (
    args.visible !== undefined &&
    (lifecycle.visible !== args.visible ||
      lifecycle.appliedVisible !== args.visible)
  ) {
    await queueVisibility(tabId, lifecycle, args.visible);
  }
}

function queueReconcile(
  tabId: string,
  lifecycle: BrowserLifecycle,
  args: CreateWebviewArgs
): Promise<void> {
  return queueOperation(lifecycle, () =>
    reconcileCreated(tabId, lifecycle, args)
  );
}

function isSameCreate(lifecycle: BrowserLifecycle, args: CreateWebviewArgs) {
  return Boolean(
    lifecycle.initialUrl === args.initialUrl &&
    sameBounds(lifecycle.requestedBounds, args.bounds) &&
    (args.visible === undefined || lifecycle.requestedVisible === args.visible)
  );
}

export async function createNativeBrowserWebview(
  args: CreateWebviewArgs
): Promise<void> {
  let lifecycle = browserLifecycles.get(args.tabId);
  if (lifecycle?.closePromise) {
    await lifecycle.closePromise;
    lifecycle = browserLifecycles.get(args.tabId);
  }
  if (lifecycle?.status === 'closed' || lifecycle?.status === 'failed') {
    lifecycle.status = 'waiting';
    lifecycle.createPromise = null;
    lifecycle.closePromise = null;
    lifecycle.reconcilePromise = null;
    lifecycle.visibilityPromise = null;
    lifecycle.initialUrl = undefined;
    lifecycle.requestedBounds = undefined;
    lifecycle.requestedVisible = undefined;
    lifecycle.currentUrl = undefined;
    lifecycle.bounds = undefined;
    lifecycle.visible = undefined;
    lifecycle.appliedVisible = undefined;
  }
  if (lifecycle?.status === 'created') {
    return queueReconcile(args.tabId, lifecycle, args);
  }
  if (lifecycle?.createPromise) {
    if (isSameCreate(lifecycle, args)) return lifecycle.createPromise;
    return lifecycle.createPromise.then(() =>
      queueReconcile(args.tabId, lifecycle!, args)
    );
  }

  lifecycle ??= lifecycleFor(args.tabId);
  lifecycle.status = 'creating';
  lifecycle.initialUrl = args.initialUrl;
  lifecycle.requestedBounds = { ...args.bounds };
  lifecycle.requestedVisible = args.visible;
  const current = lifecycle;
  const creation = (async () => {
    try {
      const createRes = await invokeTyped<void>('browser_webview_create', {
        ...args,
      });
      unwrapInvoke(createRes, 'browser_webview_create');
      current.currentUrl = args.initialUrl;
      current.bounds = args.bounds;
      // Rust defaults legacy calls without this field to visible=true.
      current.visible = args.visible ?? true;
      current.appliedVisible = current.visible;

      let firstNavigation = true;
      while (current.pendingNavigations.length > 0) {
        const pending = current.pendingNavigations.shift()!;
        if (firstNavigation && pending.url === args.initialUrl) {
          firstNavigation = false;
          pending.resolve();
          continue;
        }
        firstNavigation = false;
        try {
          await navigateNow(args.tabId, pending.url);
          current.currentUrl = pending.url;
          pending.resolve();
        } catch (error) {
          pending.reject(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
      current.status = 'created';
    } catch (error) {
      const createError =
        error instanceof Error ? error : new Error(String(error));
      rejectPending(current, createError);
      current.status = current.closePromise ? 'closed' : 'failed';
      current.createPromise = null;
      if (
        browserLifecycles.get(args.tabId) === current &&
        current.leaseCount === 0 &&
        !current.closePromise
      ) {
        browserLifecycles.delete(args.tabId);
      }
      throw createError;
    }
  })();
  lifecycle.createPromise = creation;
  return creation;
}

export async function setNativeBrowserBounds(
  tabId: string,
  bounds: WebviewBounds
): Promise<void> {
  const lifecycle = browserLifecycles.get(tabId);
  if (lifecycle?.closePromise || lifecycle?.status === 'closed') {
    throw new Error(`Cannot update bounds for closed browser tab ${tabId}`);
  }
  if (lifecycle?.status === 'failed') {
    throw new Error(
      `Cannot update bounds before browser tab ${tabId} is recreated`
    );
  }
  if (lifecycle?.createPromise && lifecycle.status !== 'created') {
    await lifecycle.createPromise;
  }
  if (lifecycle?.status === 'created') {
    return queueOperation(lifecycle, async () => {
      await setBoundsNow(tabId, bounds);
      lifecycle.bounds = bounds;
    });
  }
  await setBoundsNow(tabId, bounds);
  if (lifecycle) lifecycle.bounds = bounds;
}

export async function setNativeBrowserVisible(
  tabId: string,
  visible: boolean
): Promise<void> {
  const lifecycle = browserLifecycles.get(tabId);
  if (lifecycle?.closePromise || lifecycle?.status === 'closed') {
    if (!visible) return;
    throw new Error(`Cannot show closed browser tab ${tabId}`);
  }
  if (lifecycle?.status === 'failed') {
    if (!visible) return;
    throw new Error(`Cannot show browser tab ${tabId} before retrying create`);
  }
  if (lifecycle?.createPromise && lifecycle.status !== 'created') {
    await lifecycle.createPromise;
  }
  if (lifecycle?.status === 'created') {
    return queueVisibility(tabId, lifecycle, visible);
  }
  await setVisibleNow(tabId, visible);
  if (lifecycle) {
    lifecycle.visible = visible;
    lifecycle.appliedVisible = visible;
  }
}

export async function navigateNativeBrowser(
  tabId: string,
  url: string
): Promise<void> {
  const lifecycle = browserLifecycles.get(tabId);
  if (!lifecycle) {
    throw new Error(
      `Cannot navigate browser tab ${tabId} without an active lifecycle lease`
    );
  }
  if (lifecycle.closePromise || lifecycle.status === 'closed') {
    throw new Error(`Cannot navigate closed browser tab ${tabId}`);
  }
  if (lifecycle.status === 'failed') {
    throw new Error(
      `Cannot navigate browser tab ${tabId} until create is retried`
    );
  }
  const current = lifecycle;

  if (current.status === 'created') {
    return queueOperation(current, async () => {
      if (current.currentUrl === url) return;
      await navigateNow(tabId, url);
      current.currentUrl = url;
    });
  }
  if (current.leaseCount === 0) {
    throw new Error(
      `Cannot queue navigation for browser tab ${tabId} without an active lifecycle lease`
    );
  }
  return new Promise<void>((resolve, reject) => {
    current.pendingNavigations.push({ url, resolve, reject });
  });
}

export async function closeNativeBrowserWebview(tabId: string): Promise<void> {
  let lifecycle = browserLifecycles.get(tabId);
  if (lifecycle?.closePromise) return lifecycle.closePromise;
  if (lifecycle?.status === 'closed') return;
  lifecycle ??= lifecycleFor(tabId);
  const current = lifecycle;
  current.status = 'closed';
  rejectPending(
    current,
    new Error(`Navigation cancelled because tab ${tabId} is closing`)
  );
  const closing = (async () => {
    if (current.createPromise) {
      try {
        await current.createPromise;
      } catch {
        // Close still runs in case the failed create partially allocated a child.
      }
    }
    for (const pending of [
      current.reconcilePromise,
      current.visibilityPromise,
    ]) {
      if (!pending) continue;
      try {
        await pending;
      } catch {
        // Close still releases the native child if a state update failed.
      }
    }
    const closeRes = await invokeTyped<void>('browser_webview_close', {
      tabId,
    });
    unwrapInvoke(closeRes, 'browser_webview_close');
  })();
  current.closePromise = closing;
  try {
    await closing;
  } finally {
    current.status = 'closed';
    current.createPromise = null;
    current.closePromise = null;
    if (browserLifecycles.get(tabId) === current && current.leaseCount === 0) {
      browserLifecycles.delete(tabId);
    }
  }
}
