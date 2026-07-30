import React, { useEffect, useRef, useState } from 'react';
import type { MessageImageRef } from '../../store/types';
import { toAssetUrl } from '../../api/workspaceFsApi';
import styles from './ImageGallery.module.css';

export const ImageTile: React.FC<{ image: MessageImageRef }> = React.memo(
  ({ image }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [inView, setInView] = useState(false);
    const [resolvedUrl, setResolvedUrl] = useState<string | null>(
      image.resolvedUrl ||
        (image.kind === 'http' || image.kind === 'data' ? image.source : null)
    );
    const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>(
      'loading'
    );

    // IntersectionObserver 懒加载（对 data URL 有效，loading="lazy" 无效）
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      const io = new IntersectionObserver(
        ([entry]) => {
          if (entry?.isIntersecting) {
            setInView(true);
            io.disconnect();
          }
        },
        { rootMargin: '200px' }
      );
      io.observe(el);
      return () => io.disconnect();
    }, []);

    // 本地路径异步解析
    useEffect(() => {
      if (!inView) return;
      if (image.kind !== 'local' || resolvedUrl) return;
      let cancelled = false;
      void toAssetUrl(image.source)
        .then((url) => {
          if (cancelled) return;
          if (url) {
            setResolvedUrl(url);
          } else {
            setStatus('error');
          }
        })
        .catch(() => {
          if (!cancelled) setStatus('error');
        });
      return () => {
        cancelled = true;
      };
    }, [inView, image.kind, image.source, resolvedUrl]);

    if (!inView) {
      return <div ref={ref} className={styles.tilePlaceholder} aria-hidden />;
    }

    if (status === 'error' || !resolvedUrl) {
      return (
        <div
          ref={ref}
          className={styles.tileError}
          title={image.alt || image.source}
        >
          {image.alt || '图片加载失败'}
        </div>
      );
    }

    return (
      <div ref={ref} className={styles.tile}>
        <img
          src={resolvedUrl}
          alt={image.alt || ''}
          className={styles.tileImg}
          onLoad={() => setStatus('loaded')}
          onError={() => setStatus('error')}
        />
      </div>
    );
  }
);
