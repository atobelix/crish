import React, { useCallback } from 'react';
import styles from './Dialog.module.css';
import { cn } from '../internal/cn';
import { G2Surface } from '../G2Surface';
import {
  useDialogContext,
  type DialogSize,
  type DialogRole,
  type DialogSurfaceSpec,
} from './dialogContext';

/**
 * 阴影通道说明（裁定 #6(a)）：阴影 token 随主题分叉（如 --shadow-2xl 浅色
 * 2.5%/3.5% 与暗色 30%/40% 是两套值），JS 常量表达不了——形状层 filter 一律
 * 由 CSS 规则承载：基座近似在 Dialog.module.css 的 [data-g2-layer] 规则，
 * 逐面覆盖（如设置壳 --shadow-2xl）在各面模块以更高特异性同名规则给出。
 */

export const SIZE_CLASS: Record<DialogSize, string | undefined> = {
  sm: styles.dialogSm,
  md: styles.dialogMd,
  lg: styles.dialogLg,
  xl: styles.dialogXl,
  '2xl': styles.dialog2xl,
  auto: styles.dialogAuto,
};

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogContent 弹窗卡片容器                                       */
/* -------------------------------------------------------------------------- */
export interface DialogContentProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: DialogSize;
  role?: DialogRole;
  ariaLabel?: string;
  /** G² 形状层表面规格（逐字段覆盖 Dialog 根组件的 surface） */
  surface?: DialogSurfaceSpec;
  ref?: React.Ref<HTMLDivElement>;
}

export function DialogContent({
  size: explicitSize,
  role: explicitRole,
  ariaLabel: explicitAriaLabel,
  surface: surfaceProp,
  className,
  children,
  ref,
  style,
  ...props
}: DialogContentProps) {
  const ctx = useDialogContext();
  const resolvedSize = explicitSize ?? ctx.size;
  const resolvedRole = explicitRole ?? ctx.role;
  const resolvedAriaLabel = explicitAriaLabel ?? ctx.ariaLabel;
  const isExiting = ctx.state === 'exiting';
  const surface: DialogSurfaceSpec = { ...ctx.surface, ...surfaceProp };

  const panelClasses = cn(
    styles.dialog,
    SIZE_CLASS[resolvedSize],
    styles[`size-${resolvedSize}`],
    styles.panel,
    isExiting ? styles.dialogExit : styles.dialogEnter,
    ctx.classNames?.panel,
    className
  );

  const handleRef = useCallback(
    (node: HTMLDivElement | null) => {
      (ctx.panelRef as React.MutableRefObject<HTMLDivElement | null>).current =
        node;
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref && 'current' in ref) {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [ctx.panelRef, ref]
  );

  return (
    <div
      ref={handleRef}
      role={resolvedRole}
      aria-modal="true"
      aria-label={resolvedAriaLabel}
      aria-labelledby={resolvedAriaLabel ? undefined : ctx.titleId}
      aria-describedby={props['aria-describedby'] ?? ctx.descriptionId}
      className={panelClasses}
      data-surface-shadow={surface.shadow === 'none' ? 'none' : undefined}
      style={style}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      {...props}
    >
      {/* G² 形状层（G² 推广第一波槽 C）：面板轮廓的单一生成点——全部经
          ui/Dialog 打开的模态面在此统一挂 modal 档 G² 轮廓 + 同路径描边，
          内容经同路径 clip 承载（面板 CSS 的 box-shadow 由 :has 规则压制，
          改走形状层 filter，避免弧形双影）。 */}
      <G2Surface
        radius="modal"
        fill={surface.fill ?? 'var(--surface-overlay)'}
        stroke={surface.stroke ?? 'var(--border-panel)'}
        clip
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
        contentStyle={{
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          minHeight: 0,
        }}
      >
        {children}
      </G2Surface>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 复合子原语: DialogPopup 别名（等价 DialogContent）                            */
/* -------------------------------------------------------------------------- */
export const DialogPopup = DialogContent;
