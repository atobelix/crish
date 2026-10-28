import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '../../services/LoggerService';
import { toast } from '../../services/toast/ToastContext';
import { useI18n } from '../../i18n';
import {
  browserWebviewSetInspector,
  onNativeBrowserInspectorEvent,
} from './nativeBrowserInspectorApi';
import type {
  InspectHoverPayload,
  InspectSelectPayload,
} from './previewProtocol';

export interface UseNativeInspectorBridgeResult {
  isActive: boolean;
  canToggle: boolean;
  hoverElement: InspectHoverPayload | null;
  selectedElement: InspectSelectPayload | null;
  toggle: () => void;
  clearSelection: () => void;
}

export function useNativeInspectorBridge(
  tabId: string,
  isAvailable = true,
  isNavigationReady = true
): UseNativeInspectorBridgeResult {
  const { t } = useI18n();
  const [isActive, setIsActive] = useState(false);
  const [hoverElement, setHoverElement] = useState<InspectHoverPayload | null>(
    null
  );
  const [selectedElement, setSelectedElement] =
    useState<InspectSelectPayload | null>(null);
  const [subscriptionReady, setSubscriptionReady] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(
    null
  );
  const isActiveRef = useRef(false);
  const subscriptionReadyRef = useRef(false);
  const subscriptionTabIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const subscriptionGenerationRef = useRef(0);
  const commandTailRef = useRef<Promise<void>>(Promise.resolve());
  const tabIdRef = useRef(tabId);

  const enqueueCommand = useCallback(
    (enabled: boolean) => {
      const command = commandTailRef.current.then(() =>
        browserWebviewSetInspector(tabId, enabled)
      );
      commandTailRef.current = command.catch(() => undefined);
      return command;
    },
    [tabId]
  );

  const applyActiveState = useCallback((enabled: boolean) => {
    isActiveRef.current = enabled;
    setIsActive(enabled);
    if (!enabled) setHoverElement(null);
  }, []);

  const sendEnabled = useCallback(
    (enabled: boolean, previous: boolean) => {
      const requestId = ++requestIdRef.current;
      applyActiveState(enabled);
      void enqueueCommand(enabled).catch((error) => {
        if (!mountedRef.current || requestIdRef.current !== requestId) return;
        applyActiveState(previous);
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('Native browser inspector toggle failed', {
          module: 'useNativeInspectorBridge',
          err: { message: reason },
          sessionId: tabId,
        });
        const errorMsg = enabled
          ? t(
              'workspace.inspector.startFailed',
              '页面元素拾取启动失败：{reason}',
              { reason }
            )
          : t(
              'workspace.inspector.stopFailed',
              '页面元素拾取停止失败：{reason}',
              { reason }
            );
        toast.error(errorMsg);
      });
    },
    [applyActiveState, enqueueCommand, t, tabId]
  );

  const toggle = useCallback(() => {
    if (
      !isAvailable ||
      !isNavigationReady ||
      !subscriptionReadyRef.current ||
      subscriptionTabIdRef.current !== tabId
    ) {
      return;
    }
    const previous = isActiveRef.current;
    sendEnabled(!previous, previous);
  }, [isAvailable, isNavigationReady, sendEnabled, tabId]);

  const clearSelection = useCallback(() => setSelectedElement(null), []);

  useEffect(() => {
    if (tabIdRef.current !== tabId) {
      tabIdRef.current = tabId;
      requestIdRef.current += 1;
      applyActiveState(false);
      setSelectedElement(null);
      subscriptionReadyRef.current = false;
      subscriptionTabIdRef.current = null;
      setSubscriptionReady(false);
      setSubscriptionError(null);
    }

    mountedRef.current = true;
    const generation = ++subscriptionGenerationRef.current;
    const isCurrentSubscription = () =>
      mountedRef.current &&
      tabIdRef.current === tabId &&
      subscriptionGenerationRef.current === generation;
    const unsubscribe = onNativeBrowserInspectorEvent(
      (event) => {
        if (event.tabId !== tabId) return;

        if (event.type === 'INSPECT_READY') {
          setHoverElement(null);
          setSelectedElement(null);
          if (isActiveRef.current) {
            const requestId = ++requestIdRef.current;
            void enqueueCommand(true).catch((error) => {
              if (
                !isCurrentSubscription() ||
                requestIdRef.current !== requestId ||
                !isActiveRef.current
              ) {
                return;
              }
              requestIdRef.current += 1;
              applyActiveState(false);
              const reason =
                error instanceof Error ? error.message : String(error);
              logger.warn('Native browser inspector restart failed', {
                module: 'useNativeInspectorBridge',
                err: { message: reason },
                sessionId: tabId,
              });
              toast.error(
                t(
                  'workspace.inspector.resumeFailed',
                  '页面重新加载后无法恢复元素拾取：{reason}',
                  { reason }
                )
              );
            });
          }
          return;
        }

        if (event.type === 'INSPECT_TOGGLE') {
          requestIdRef.current += 1;
          applyActiveState(false);
          return;
        }

        if (!isActiveRef.current) return;
        if (event.type === 'INSPECT_HOVER') {
          setHoverElement(event.payload);
          return;
        }

        setHoverElement(null);
        setSelectedElement(event.payload);
      },
      {
        onReady: () => {
          if (!isCurrentSubscription()) return;
          subscriptionReadyRef.current = true;
          subscriptionTabIdRef.current = tabId;
          setSubscriptionReady(true);
          setSubscriptionError(null);
        },
        onError: (error) => {
          if (!isCurrentSubscription()) return;
          subscriptionReadyRef.current = false;
          subscriptionTabIdRef.current = null;
          setSubscriptionReady(false);
          setSubscriptionError(error.message);
          requestIdRef.current += 1;
          const wasActive = isActiveRef.current;
          applyActiveState(false);
          if (wasActive) {
            void enqueueCommand(false).catch((stopError) => {
              const reason =
                stopError instanceof Error
                  ? stopError.message
                  : String(stopError);
              logger.warn(
                'Native browser inspector stop after listen failure failed',
                {
                  module: 'useNativeInspectorBridge',
                  err: { message: reason },
                  sessionId: tabId,
                }
              );
            });
          }
          logger.warn('Native browser inspector event subscription failed', {
            module: 'useNativeInspectorBridge',
            err: { message: error.message },
            sessionId: tabId,
          });
          toast.error(
            t(
              'workspace.inspector.listenerFailed',
              '页面元素拾取事件监听失败：{reason}',
              { reason: error.message }
            )
          );
        },
      }
    );

    return () => {
      mountedRef.current = false;
      subscriptionGenerationRef.current += 1;
      subscriptionReadyRef.current = false;
      subscriptionTabIdRef.current = null;
      requestIdRef.current += 1;
      unsubscribe();
      if (isActiveRef.current) {
        void enqueueCommand(false).catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          if (reason.startsWith('Webview not found:')) return;
          logger.warn('Native browser inspector cleanup failed', {
            module: 'useNativeInspectorBridge',
            err: { message: reason },
            sessionId: tabId,
          });
        });
      }
    };
  }, [applyActiveState, enqueueCommand, t, tabId]);

  useEffect(() => {
    if (isAvailable || !isActiveRef.current) return;

    const requestId = ++requestIdRef.current;
    applyActiveState(false);
    void enqueueCommand(false).catch((error) => {
      if (!mountedRef.current || requestIdRef.current !== requestId) return;
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.startsWith('Webview not found:')) return;
      logger.warn('Native browser inspector stop after surface close failed', {
        module: 'useNativeInspectorBridge',
        err: { message: reason },
        sessionId: tabId,
      });
      toast.error(
        t('workspace.inspector.stopFailed', '页面元素拾取停止失败：{reason}', {
          reason,
        })
      );
    });
  }, [applyActiveState, enqueueCommand, isAvailable, t, tabId]);

  return {
    isActive: tabIdRef.current === tabId && isActive,
    canToggle:
      isAvailable &&
      isNavigationReady &&
      subscriptionReady &&
      subscriptionTabIdRef.current === tabId &&
      !subscriptionError,
    hoverElement: tabIdRef.current === tabId ? hoverElement : null,
    selectedElement: tabIdRef.current === tabId ? selectedElement : null,
    toggle,
    clearSelection,
  };
}
