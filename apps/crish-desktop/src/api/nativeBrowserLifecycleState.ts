import type { WebviewBounds } from './nativeBrowserApi';

export interface PendingNavigation {
  url: string;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface BrowserLifecycle {
  status: 'waiting' | 'creating' | 'created' | 'failed' | 'closed';
  leaseCount: number;
  createPromise: Promise<void> | null;
  closePromise: Promise<void> | null;
  reconcilePromise: Promise<void> | null;
  visibilityPromise: Promise<void> | null;
  pendingNavigations: PendingNavigation[];
  initialUrl?: string;
  requestedBounds?: WebviewBounds;
  requestedVisible?: boolean;
  currentUrl?: string;
  bounds?: WebviewBounds;
  visible?: boolean;
  appliedVisible?: boolean;
}

export const browserLifecycles = new Map<string, BrowserLifecycle>();

export function lifecycleFor(tabId: string): BrowserLifecycle {
  let lifecycle = browserLifecycles.get(tabId);
  if (!lifecycle) {
    lifecycle = {
      status: 'waiting',
      leaseCount: 0,
      createPromise: null,
      closePromise: null,
      reconcilePromise: null,
      visibilityPromise: null,
      pendingNavigations: [],
    };
    browserLifecycles.set(tabId, lifecycle);
  }
  return lifecycle;
}

export function rejectPending(lifecycle: BrowserLifecycle, error: Error): void {
  for (const pending of lifecycle.pendingNavigations.splice(0)) {
    pending.reject(error);
  }
}

export function resetNativeBrowserLifecyclesForTesting(): void {
  browserLifecycles.clear();
}
