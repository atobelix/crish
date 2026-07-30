import React, { useEffect } from 'react';
import { toAssetUrl } from '../../api/workspaceFsApi';

/**
 * 解析容器内所有 [data-local-path] 的 <img>，异步转 asset URL。
 * 嵌入 AsyncMarkdownBlock 容器，在 HTML 写入后增强 img。
 */
export const LocalImgResolver: React.FC<{
  containerRef: React.RefObject<HTMLDivElement | null>;
}> = ({ containerRef }) => {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const els = container.querySelectorAll<HTMLImageElement>(
      'img[data-local-path]:not([src])'
    );
    if (!els.length) return;

    const controllers: AbortController[] = [];
    els.forEach(async (el) => {
      const localPath = el.getAttribute('data-local-path');
      if (!localPath) return;
      const ctrl = new AbortController();
      controllers.push(ctrl);
      try {
        const url = await toAssetUrl(localPath);
        if (!ctrl.signal.aborted && url) {
          el.setAttribute('src', url);
          el.removeAttribute('data-local-path');
          el.classList.remove('md-img-pending');
        } else if (!ctrl.signal.aborted) {
          el.classList.add('md-img-error');
        }
      } catch {
        if (!ctrl.signal.aborted) el.classList.add('md-img-error');
      }
    });

    return () => controllers.forEach((c) => c.abort());
  });

  return null;
};
