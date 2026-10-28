import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeTyped } from '../../api/tauriInvoke';
import { logger } from '../../services/LoggerService';
import {
  parseClientToHostMessage,
  type PreviewInspectorEvent,
} from './previewHostBridge';
import { CRISH_PREVIEW_INSPECTOR_SOURCE } from './previewProtocol';

export const EVENT_BROWSER_INSPECTOR = 'browser://inspector-event';

export type NativeBrowserInspectorEvent = PreviewInspectorEvent & {
  tabId: string;
};

export interface NativeBrowserInspectorSubscriptionObserver {
  onReady?: () => void;
  onError?: (error: Error) => void;
}

function parseInspectorEvent(
  value: unknown
): NativeBrowserInspectorEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.tabId !== 'string' || !raw.tabId) return null;

  const message = parseClientToHostMessage({
    source: CRISH_PREVIEW_INSPECTOR_SOURCE,
    type: raw.type,
    payload: raw.payload,
  });
  if (!message) return null;

  switch (message.type) {
    case 'INSPECT_READY':
      return { tabId: raw.tabId, type: message.type };
    case 'INSPECT_TOGGLE':
      return { tabId: raw.tabId, type: message.type, payload: message.payload };
    case 'INSPECT_HOVER':
      return { tabId: raw.tabId, type: message.type, payload: message.payload };
    case 'INSPECT_SELECT':
      return { tabId: raw.tabId, type: message.type, payload: message.payload };
  }
  return null;
}

export async function browserWebviewSetInspector(
  tabId: string,
  enabled: boolean
): Promise<void> {
  const result = await invokeTyped<void>('browser_webview_set_inspector', {
    tabId,
    enabled,
  });
  if (result.status === 'error') throw new Error(result.message);
  if (result.status === 'missing') {
    throw new Error(
      'Tauri command is unavailable: browser_webview_set_inspector'
    );
  }
}

export function onNativeBrowserInspectorEvent(
  callback: (event: NativeBrowserInspectorEvent) => void,
  observer: NativeBrowserInspectorSubscriptionObserver = {}
): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  listen<unknown>(EVENT_BROWSER_INSPECTOR, (event) => {
    if (disposed) return;
    const parsed = parseInspectorEvent(event?.payload);
    if (parsed) callback(parsed);
  })
    .then((stopListening) => {
      if (disposed) stopListening();
      else {
        unlisten = stopListening;
        observer.onReady?.();
      }
    })
    .catch((error) => {
      if (!disposed) {
        const reason =
          error instanceof Error ? error : new Error(String(error));
        logger.warn('Native browser inspector event subscription failed', {
          module: 'nativeBrowserInspectorApi',
          err: { message: reason.message },
        });
        observer.onError?.(reason);
      }
    });

  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
