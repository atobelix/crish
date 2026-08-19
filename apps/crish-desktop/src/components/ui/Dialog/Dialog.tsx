/**
 * ui/Dialog 弹窗基座（PE-05 T05.1.3）
 *
 * 后续 7 套核心弹窗（TelemetryDialog/CheatsheetModal/
 * SkillEditorModal/SettingsPanel/FirstRunWizard/SettingsRulesTab 编辑器）
 * 的收敛锚点（T05.2）。内部装配 = 私有 FocusTrap 三件套 + Esc 关闭 +
 * backdrop 点击关闭 + aria-modal/labelledby/describedby + 进出场动画
 * （时长由 --duration-* token 驱动）。
 *
 * 与旧三件套（components/FocusTrap.tsx + hooks/useAnimatedPresence +
 * hooks/useRestoreFocus）行为对齐；本目录内的私有实现见 focusTrap.ts /
 * useAnimatedPresence.ts / useRestoreFocus.ts（原子层禁止依赖 hooks/）。
 *
 * 分层契约：只依赖 react/react-dom 与 tokens CSS 变量。
 */
import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as DismissableLayer from '@radix-ui/react-dismissable-layer';
import styles from './Dialog.module.css';
import { DialogOverlayContext } from './dialogOverlayContext';
import { FocusTrap } from './focusTrap';
import { useAnimatedPresence } from './useAnimatedPresence';
import { useRestoreFocus } from './useRestoreFocus';
import { useLayerRegistration } from '../internal/layer-registration/useLayerRegistration';

export type DialogSize = 'sm' | 'md' | 'lg';
export type DialogRole = 'dialog' | 'alertdialog';
export type DialogVariant = 'modal' | 'fullscreen';

export interface DialogProps {
  /** 受控开关 */
  open: boolean;
  /** 关闭回调（Esc/backdrop/关闭按钮均收敛于此） */
  onClose: () => void;
  /** 标题（aria-labelledby 关联；可传带图标的 ReactNode） */
  title?: React.ReactNode;
  /** 描述文案（aria-describedby 关联） */
  description?: React.ReactNode;
  /** 语义角色：alertdialog 供危险操作确认 */
  role?: DialogRole;
  /** 尺寸档（fullscreen 形态下忽略） */
  size?: DialogSize;
  /** 形态：modal 居中面板（默认）；fullscreen 全屏盖层（SettingsPanel 消费） */
  variant?: DialogVariant;
  /** 初始聚焦元素；不传则聚焦弹窗内首个可交互元素 */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** 是否允许 Esc/backdrop 关闭（FirstRunWizard 强制步进时置 false） */
  dismissible?: boolean;
  /** 是否渲染头部关闭按钮（危险操作确认弹窗设计上无关闭按钮，置 false） */
  showCloseButton?: boolean;
  /** 无 title 时的可访问名称（aria-label；SettingsPanel 全屏盖层用） */
  ariaLabel?: string;
  /** Portal 挂载目标；默认 document.body */
  portalTarget?: HTMLElement | null;
  /** 底部操作区 */
  footer?: React.ReactNode;
  /** 内容区 */
  children?: React.ReactNode;
  /**
   * 自定义类名收敛对象（T4-9c Props 收敛）：
   * - panel 追加到弹窗面板（可设 --dialog-width 等覆盖变量）
   * - overlay 追加到遮罩壳（可设 --dialog-z 覆盖层级）
   */
  classNames?: { panel?: string; overlay?: string };
  /**
   * LayerStack 到达本层时的 Esc 钩子（设置壳：先清搜索再关页）。
   * 返回 true / preventDefault 则中枢不再走默认 dismiss。
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => boolean | void;
}

// noUncheckedIndexedAccess 下 CSS Modules 取值类型为 string | undefined
const SIZE_CLASS: Record<DialogSize, string | undefined> = {
  sm: styles.dialogSm,
  md: styles.dialogMd,
  lg: styles.dialogLg,
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  role = 'dialog',
  size = 'md',
  variant = 'modal',
  initialFocusRef,
  dismissible = true,
  showCloseButton = true,
  ariaLabel,
  portalTarget,
  footer,
  children,
  classNames,
  onEscapeKeyDown,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [overlayEl, setOverlayEl] = useState<HTMLElement | null>(null);
  const isFullscreen = variant === 'fullscreen';

  // 三件套：进出场动画 + 焦点归还 + 焦点圈定
  // exitDurationMs 与 CSS --duration-exit（150ms）对齐（F7 F5），
  // 退出动画结束即卸载，不留 50ms 空窗
  const { state, isMounted } = useAnimatedPresence({
    visible: open,
    exitDurationMs: 150,
  });
  useRestoreFocus(open);

  useLayerRegistration(
    {
      id: dialogId,
      type: role === 'alertdialog' ? 'confirm-dialog' : 'modal-dialog',
      modal: true,
      dismissible,
      elementRef: panelRef,
      onDismiss: () => onClose(),
      onEscapeKeyDown,
    },
    open && isMounted
  );

  if (!isMounted) return null;

  const target =
    portalTarget ??
    (typeof document !== 'undefined'
      ? (document.getElementById('modal-root') ?? document.body)
      : null);
  if (!target) return null;

  // fullscreen 形态不应用尺寸档与面板进出场动画（盖层整体由遮罩壳动画驱动）
  const panelClasses = [
    styles.dialog,
    isFullscreen ? styles.dialogFullscreen : SIZE_CLASS[size],
    isFullscreen
      ? undefined
      : state === 'exiting'
        ? styles.dialogExit
        : styles.dialogEnter,
    classNames?.panel,
  ]
    .filter(Boolean)
    .join(' ');

  const overlayClasses = [
    state === 'exiting' ? styles.overlayExit : styles.overlayEnter,
    classNames?.overlay,
  ]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    // FocusTrap 容器直接挂在 body 下：兄弟节点（应用主体）被 aria-hidden 旁路
    <DismissableLayer.Branch asChild>
      <FocusTrap active={open} initialFocusRef={initialFocusRef}>
        <div
          ref={setOverlayEl}
          className={overlayClasses}
          data-dialog-overlay=""
        >
          <DialogOverlayContext.Provider value={overlayEl}>
            <div
              className={styles.backdrop}
              aria-hidden="true"
              onClick={dismissible ? onClose : undefined}
            />
            <div
              ref={panelRef}
              role={role}
              aria-modal="true"
              aria-label={title == null ? ariaLabel : undefined}
              aria-labelledby={title != null ? titleId : undefined}
              aria-describedby={description != null ? descriptionId : undefined}
              className={panelClasses}
            >
              {title != null || (dismissible && showCloseButton) ? (
                <div className={styles.dialogHeader}>
                  {title != null ? (
                    <h2 className={styles.dialogTitle} id={titleId}>
                      {title}
                    </h2>
                  ) : null}
                  {dismissible && showCloseButton ? (
                    <button
                      type="button"
                      className={styles.dialogClose}
                      aria-label="关闭弹窗"
                      onClick={onClose}
                    >
                      <CloseIcon />
                    </button>
                  ) : null}
                </div>
              ) : null}

              {description != null ? (
                <p className={styles.dialogDescription} id={descriptionId}>
                  {description}
                </p>
              ) : null}

              <div className={styles.dialogBody}>{children}</div>

              {footer != null ? (
                <div className={styles.dialogFooter}>{footer}</div>
              ) : null}
            </div>
          </DialogOverlayContext.Provider>
        </div>
      </FocusTrap>
    </DismissableLayer.Branch>,
    target
  );
}

function CloseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
