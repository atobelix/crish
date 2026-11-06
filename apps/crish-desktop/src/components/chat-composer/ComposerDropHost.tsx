/**
 * 叶内拖放包含块：遮罩只盖 composer，无彩 inset / 整页绿框。
 * 与 Tiptap handleDrop 分工：编辑器内由 PM 拦截；页脚/附件条由本宿主收。
 */
import React, { useCallback, useRef, useState } from 'react';

import styles from './ChatComposer.module.css';
import { useI18n } from '../../i18n';
import { AppIcon } from '@/components/ui/icons';
import { G2Surface } from '../ui/G2Surface';

export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      if (dt.items[i]?.kind === 'file') return true;
    }
  }
  const types = Array.from(dt.types ?? []);
  return types.some((t) => t.toLowerCase() === 'files');
}

export type ComposerDropHostProps = {
  onDropFiles: (files: File[]) => void;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onDrop' | 'onDragOver'>;

export const ComposerDropHost = React.forwardRef<
  HTMLDivElement,
  ComposerDropHostProps
>(function ComposerDropHost(
  { onDropFiles, className, children, onDragEnter, onDragLeave, ...rest },
  ref
) {
  const { t } = useI18n();
  const [over, setOver] = useState(false);
  const depthRef = useRef(0);

  const reset = useCallback(() => {
    depthRef.current = 0;
    setOver(false);
  }, []);

  return (
    <div
      {...rest}
      ref={ref}
      className={className}
      data-drop-over={over ? '1' : undefined}
      onDragEnter={(e) => {
        onDragEnter?.(e);
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        depthRef.current += 1;
        setOver(true);
      }}
      onDragLeave={(e) => {
        onDragLeave?.(e);
        depthRef.current = Math.max(0, depthRef.current - 1);
        if (depthRef.current === 0) setOver(false);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        const files = Array.from(e.dataTransfer.files ?? []);
        reset();
        if (files.length) onDropFiles(files);
      }}
    >
      {children}
      {over ? (
        <div
          className={styles.dropMask}
          data-testid="composer-drop-mask"
          aria-hidden
        >
          {/* G² 形状层（枢纽档）：拖放遮罩与 composer 卡同 dock 档轮廓——
              填充 + 同路径描边（原 inset box-shadow 环改走描边，CSS 侧
              [data-g2-mode] 规则压制旧环）；遮罩无边框，层盒 inset 0 即
              与遮罩 border box 重合。负 z 绘于遮罩底之上、图标文案之下。 */}
          <G2Surface
            radius="dock"
            fill="var(--bg-elevated, var(--composer-bg))"
            stroke="var(--state-hover)"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: -1,
              pointerEvents: 'none',
            }}
          />
          <AppIcon name="upload" size={20} aria-hidden />
          <span>{t('chat.composer.dropToAttach')}</span>
        </div>
      ) : null}
    </div>
  );
});
