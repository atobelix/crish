/**
 * ToolTabFavicon — 工具标签 favicon 渲染与浏览器标签 URL 解析。
 *
 * 浏览器类标签（preview:* / browser:*）动态展示站点 favicon；
 * 其余标签回落 viewRegistry 图标语义名（由调用方传入，经 AppIcon 渲染）。
 */

import React, { useEffect, useRef, useState } from 'react';
import { getPreviewFavicon, isAboutBlank } from '../../api/previewBrowserStore';
import {
  shouldConsumeScopedEvent,
  useLeafScope,
} from '../../contexts/LeafScopeContext';
import { AppIcon, type IconName } from '@/components/ui/icons';

export function isBrowserTabId(tabId: string): boolean {
  return (
    tabId === 'preview' ||
    tabId.startsWith('preview:') ||
    tabId.startsWith('browser:') ||
    tabId === 'preview-browser' ||
    tabId.startsWith('preview-browser-')
  );
}

function resolvePinnedBrowserTabUrl(tabId: string): string | null {
  if (
    tabId.startsWith('preview:http://') ||
    tabId.startsWith('preview:https://')
  ) {
    return tabId.substring('preview:'.length);
  }
  if (
    tabId.startsWith('browser:http://') ||
    tabId.startsWith('browser:https://')
  ) {
    return tabId.substring('browser:'.length);
  }
  return null;
}

function resolveBrowserTabUrl(
  tabId: string,
  scopedUrl?: string | null
): string | null {
  const pinned = resolvePinnedBrowserTabUrl(tabId);
  if (pinned) return pinned;
  const candidate = scopedUrl?.trim() || null;
  return candidate && !isAboutBlank(candidate) ? candidate : null;
}

export function ToolTabFavicon({
  tabId,
  iconName,
  isBrowser,
}: {
  tabId: string;
  iconName?: IconName | null;
  isBrowser?: boolean;
}) {
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);
  const leafScope = useLeafScope();
  const scopeRef = useRef(leafScope);
  scopeRef.current = leafScope;
  const scopedUrlRef = useRef<string | null>(null);

  const isBrowserTab =
    isBrowser ?? (isBrowserTabId(tabId) || iconName === 'globe');

  useEffect(() => {
    if (!isBrowserTab) return;

    const refresh = () => {
      const url = resolveBrowserTabUrl(tabId, scopedUrlRef.current);
      if (!url || isAboutBlank(url)) {
        setFaviconUrl(null);
        return;
      }
      const fav = getPreviewFavicon(url);
      setFaviconUrl(fav ?? null);
    };

    refresh();

    const onFavicon = (e: Event) => {
      const customEvent = e as CustomEvent<{ url?: string; favicon?: string }>;
      const targetUrl = resolveBrowserTabUrl(tabId, scopedUrlRef.current);
      if (
        customEvent.detail &&
        targetUrl &&
        customEvent.detail.url === targetUrl &&
        customEvent.detail.favicon
      ) {
        setFaviconUrl(customEvent.detail.favicon);
      } else {
        refresh();
      }
    };
    const onUrlChange = (e: Event) => {
      const customEvent = e as CustomEvent<{
        url?: string;
        leafId?: string;
        sessionId?: string;
      }>;
      const scope = scopeRef.current;
      if (
        !shouldConsumeScopedEvent(customEvent.detail, {
          leafId: scope.leafId,
          sessionId: scope.sessionId,
          isActive: scope.inLeafScope ? scope.isActive : undefined,
        })
      ) {
        return;
      }
      if (typeof customEvent.detail?.url === 'string') {
        scopedUrlRef.current = customEvent.detail.url;
      }
      refresh();
    };

    window.addEventListener('crish-preview-favicon', onFavicon);
    window.addEventListener('crish-preview-url-change', onUrlChange);
    window.addEventListener('crish-preview-url', onUrlChange);
    return () => {
      window.removeEventListener('crish-preview-favicon', onFavicon);
      window.removeEventListener('crish-preview-url-change', onUrlChange);
      window.removeEventListener('crish-preview-url', onUrlChange);
    };
  }, [tabId, isBrowserTab]);

  if (isBrowserTab && faviconUrl) {
    return (
      <img
        src={faviconUrl}
        alt=""
        aria-hidden
        width={13}
        height={13}
        style={{ objectFit: 'contain', flexShrink: 0 }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }

  if (!iconName) return null;
  return <AppIcon name={iconName} size={13} aria-hidden />;
}
