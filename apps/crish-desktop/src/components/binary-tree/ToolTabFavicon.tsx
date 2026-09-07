/**
 * ToolTabFavicon — 工具标签 favicon 渲染与浏览器标签 URL 解析。
 *
 * 浏览器类标签（preview:* / browser:*）动态展示站点 favicon；
 * 其余标签回落 viewRegistry 图标（由调用方传入 Icon）。
 */

import React, { useEffect, useState } from 'react';
import {
  getPreviewFavicon,
  getPreviewUrl,
  isAboutBlank,
} from '../../api/previewBrowserStore';
import { viewRegistry } from '../../services/view-registry';

export function isBrowserTabId(tabId: string): boolean {
  return (
    tabId === 'preview' ||
    tabId.startsWith('preview:') ||
    tabId.startsWith('browser:') ||
    tabId === 'preview-browser' ||
    tabId.startsWith('preview-browser-')
  );
}

function resolveBrowserTabUrl(tabId: string): string | null {
  if (tabId.startsWith('preview:http://') || tabId.startsWith('preview:https://')) {
    return tabId.substring('preview:'.length);
  }
  if (tabId.startsWith('browser:http://') || tabId.startsWith('browser:https://')) {
    return tabId.substring('browser:'.length);
  }
  const current = getPreviewUrl();
  return current && !isAboutBlank(current) ? current : null;
}

export function ToolTabFavicon({
  tabId,
  Icon,
}: {
  tabId: string;
  Icon?: ReturnType<typeof viewRegistry.getIcon> | null;
}) {
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null);

  const isBrowserTab = isBrowserTabId(tabId);

  useEffect(() => {
    if (!isBrowserTab) return;

    const refresh = () => {
      const url = resolveBrowserTabUrl(tabId);
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
      const targetUrl = resolveBrowserTabUrl(tabId);
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
    const onUrl = () => refresh();

    window.addEventListener('crish-preview-favicon', onFavicon);
    window.addEventListener('crish-preview-url', onUrl);
    return () => {
      window.removeEventListener('crish-preview-favicon', onFavicon);
      window.removeEventListener('crish-preview-url', onUrl);
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

  if (!Icon) return null;
  return <Icon size={13} aria-hidden />;
}
