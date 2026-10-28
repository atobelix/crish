import { useCallback, useEffect, useRef } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { logger } from '../../services/LoggerService';
import { useI18n } from '../../i18n';
import {
  isAboutBlank,
  isBrowseUrlOk,
  isEmbeddablePreviewUrl,
  setPreviewUrl,
  smartResolveBrowseUrl,
  validateBrowseUrl,
} from '../../api/previewBrowserStore';
import {
  isLifecycleAbortReason,
  formatFriendlyBrowserError,
} from './nativeBrowserError';

type ConfirmedPreviewNavigation = {
  url: string;
  requestId: number;
  fromExternal: boolean;
};

interface UsePreviewNavigationTransactionOptions {
  tabId: string;
  initialUrl: string;
  nativeUrl: string;
  nativeNavigate: (url: string) => Promise<void>;
  clearNativeError: () => void;
  setActiveUrl: (url: string | ((previous: string) => string)) => void;
  setUrlInput: (url: string) => void;
  emitScopedUrlChange: (url: string) => void;
}

export function usePreviewNavigationTransaction({
  tabId,
  initialUrl,
  nativeUrl,
  nativeNavigate,
  clearNativeError,
  setActiveUrl,
  setUrlInput,
  emitScopedUrlChange,
}: UsePreviewNavigationTransactionOptions): (
  raw: string,
  fromExternal?: boolean
) => void {
  const { t } = useI18n();
  const confirmedNavigationRef = useRef<ConfirmedPreviewNavigation>({
    url: initialUrl,
    requestId: 0,
    fromExternal: false,
  });
  const navigationRequestIdRef = useRef(0);
  const pendingNavigationRef = useRef<{
    id: number;
    url: string;
    fromExternal: boolean;
    previous: ConfirmedPreviewNavigation;
  } | null>(null);
  const failedUrlRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingNavigationRef.current = null;
      failedUrlRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!nativeUrl) return;
    if (failedUrlRef.current && nativeUrl === failedUrlRef.current) {
      return;
    }
    const pending = pendingNavigationRef.current;
    if (pending) {
      if (pending.url !== nativeUrl) return;
      // Keep a matching native event provisional until its IPC confirms.
      return;
    }
    const previous = confirmedNavigationRef.current;
    const fromExternal = previous.url === nativeUrl && previous.fromExternal;
    confirmedNavigationRef.current = {
      url: nativeUrl,
      requestId: previous.requestId,
      fromExternal,
    };
    setActiveUrl((url) => (url === nativeUrl ? url : nativeUrl));
    setUrlInput(isAboutBlank(nativeUrl) ? '' : nativeUrl);
    if (!isAboutBlank(nativeUrl) && !fromExternal) {
      setPreviewUrl(nativeUrl, { silent: true });
    }
    emitScopedUrlChange(nativeUrl);
  }, [nativeUrl, emitScopedUrlChange, setActiveUrl, setUrlInput]);

  return useCallback(
    (raw: string, fromExternal = false) => {
      const smartUrl = smartResolveBrowseUrl(raw);
      const checked = validateBrowseUrl(smartUrl);
      if (!isBrowseUrlOk(checked)) {
        toast.show(checked.reason);
        return;
      }
      const url = checked.url;
      const blank = isAboutBlank(url);
      if (!blank && !isEmbeddablePreviewUrl(url)) {
        toast.show(
          t(
            'workspace.browser.unsupportedScheme',
            '仅支持 http/https 网页预览；本地文件路径无法在此处打开'
          )
        );
        return;
      }

      const requestId = ++navigationRequestIdRef.current;
      pendingNavigationRef.current = {
        id: requestId,
        url,
        fromExternal,
        previous: confirmedNavigationRef.current,
      };
      setUrlInput(blank ? '' : url);
      // The optimistic URL mounts NativeBrowserSurface and starts create.
      setActiveUrl((previous) => (previous === url ? previous : url));
      emitScopedUrlChange(url);

      if (blank) {
        return;
      }

      if (failedUrlRef.current === url) {
        failedUrlRef.current = null;
      }

      void nativeNavigate(url)
        .then(() => {
          failedUrlRef.current = null;
          if (!mountedRef.current) return;
          const previous = confirmedNavigationRef.current;
          if (requestId < previous.requestId) return;
          confirmedNavigationRef.current = { url, requestId, fromExternal };
          if (pendingNavigationRef.current?.id === requestId) {
            pendingNavigationRef.current = null;
            setUrlInput(blank ? '' : url);
            if (!fromExternal && !blank) {
              setPreviewUrl(url, { silent: true });
            }
          } else if (!pendingNavigationRef.current) {
            // A late success can become the newest confirmed native page.
            setActiveUrl(url);
            setUrlInput(blank ? '' : url);
            emitScopedUrlChange(url);
            if (!fromExternal && !blank) {
              setPreviewUrl(url, { silent: true });
            }
          }
        })
        .catch((error) => {
          failedUrlRef.current = url;
          if (!mountedRef.current) return;
          const reason = error instanceof Error ? error.message : String(error);
          clearNativeError();
          logger.warn('Preview browser navigation failed', {
            module: 'usePreviewNavigation',
            err: { message: reason },
            sessionId: tabId,
          });
          if (navigationRequestIdRef.current !== requestId) return;

          const pending = pendingNavigationRef.current;
          pendingNavigationRef.current = null;
          const confirmed =
            pending?.id === requestId &&
            confirmedNavigationRef.current.requestId <
              pending.previous.requestId
              ? pending.previous
              : confirmedNavigationRef.current;
          setActiveUrl(confirmed.url);
          setUrlInput(isAboutBlank(confirmed.url) ? '' : confirmed.url);
          emitScopedUrlChange(confirmed.url);
          if (!confirmed.fromExternal) {
            setPreviewUrl(confirmed.url, { silent: true });
          }
          if (isLifecycleAbortReason(reason)) {
            return;
          }
          const friendlyReason = formatFriendlyBrowserError(reason, t);
          toast.error(
            t(
              'workspace.browser.navigationFailed',
              '原生浏览器导航失败：{reason}',
              { reason: friendlyReason }
            )
          );
        });
    },
    [
      clearNativeError,
      emitScopedUrlChange,
      nativeNavigate,
      setActiveUrl,
      setUrlInput,
      t,
      tabId,
    ]
  );
}
