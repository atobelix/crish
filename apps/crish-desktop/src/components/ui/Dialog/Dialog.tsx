/**
 * ui/Dialog 弹窗基座（PE-05 T05.1.3）
 *
 * 后续 7 套核心弹窗（TelemetryDialog/CheatsheetModal/WithdrawConfirmDialog/
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
import React, { useEffect, useId } from 'react';
import { createPortal } from 'react-dom';
import styles from './Dialog.module.css';
import { FocusTrap } from './focusTrap';
import { useAnimatedPresence } from './useAnimatedPresence';
import { useRestoreFocus } from './useRestoreFocus';

export type DialogSize = 'sm' | 'md' | 'lg';
export type DialogRole = 'dialog' | 'alertdialog';
export type DialogVariant = 'modal' | 'fullscreen';

// 嵌套 Dialog Esc 竞态（F7 F5）：打开中的 Dialog 按挂载顺序登记进栈，
// document 层 Esc 监听只允许栈顶响应——一次 Esc 只关最顶层，
// 不会两层同时关闭；退出动画期间已从栈中移除，外层立即恢复响应。
const dialogStack: string[] = [];

export interface DialogProps {
  /** 受控开关 */
  open: boolean;
  /** 关闭回调（Esc/backdrop/关闭按钮均收敛于此） */
  onClose: () => void;
  /** 标题（aria-labelledby 关联；可传带图标的 ReactNode） */
  title?: React.ReactNode;
  /** 描述文案（aria-describedby 关联） */
  description?: React.ReactNode;
  /** 语义角色：alertdialog 供危险操作确认（WithdrawConfirmDialog） */
  role?: DialogRole;
  /** 尺寸档（fullscreen 形态下忽略） */
  size?: DialogSize;
  /** 形态：modal 居中面板（默认）；fullscreen 全屏盖层（SettingsPanel 消费） */
  variant?: DialogVariant;
  /** 初始聚焦元素；不传则聚焦弹窗内首个可交互元素 */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** 是否允许 Esc/backdrop 关闭（FirstRunWizard 强制步进时置 false） */
  dismissible?: boolean;
  /** 是否渲染头部关闭按钮（WithdrawConfirmDialog 设计上无关闭按钮，置 false） */
  showCloseButton?: boolean;
  /** 无 title 时的可访问名称（aria-label；SettingsPanel 全屏盖层用） */
  ariaLabel?: string;
  /** Portal 挂载目标；默认 document.body */
  portalTarget?: HTMLElement | null;
  /** 底部操作区 */
  footer?: React.ReactNode;
  /** 内容区 */
  children?: React.ReactNode;
  /** 自定义类名（追加到弹窗面板；可设 --dialog-width 等覆盖变量） */
  className?: string;
  /** 自定义类名（追加到遮罩壳；可设 --dialog-z 覆盖层级） */
  overlayClassName?: string;
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
  className,
  overlayClassName,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogId = useId();
  const isFullscreen = variant === 'fullscreen';

  // 三件套：进出场动画 + 焦点归还 + 焦点圈定
  // exitDurationMs 与 CSS --duration-exit（150ms）对齐（F7 F5），
  // 退出动画结束即卸载，不留 50ms 空窗
  const { state, isMounted } = useAnimatedPresence({ visible: open, exitDurationMs: 150 });
  useRestoreFocus(open);

  // 登记/退栈：打开且已挂载时入栈，关闭/卸载时出栈（F7 F5）
  useEffect(() => {
    if (!open || !isMounted) return;
    dialogStack.push(dialogId);
    return () => {
      const idx = dialogStack.indexOf(dialogId);
      if (idx >= 0) dialogStack.splice(idx, 1);
    };
  }, [open, isMounted, dialogId]);

  // Esc 关闭：挂在 document 层（与 FocusTrap 的 Tab 循环互不干扰）；
  // 仅最顶层响应（F7 F5：嵌套 Dialog 一次 Esc 只关顶层）；
  // 消费方自定义 Esc 三层级（SettingsPanel/FirstRunWizard）时置 dismissible=false
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dialogStack[dialogStack.length - 1] !== dialogId) return;
      e.preventDefault();
      if (dismissible) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, dismissible, onClose, dialogId]);

  if (!isMounted) return null;

  const target = portalTarget ?? document.body;

  // fullscreen 形态不应用尺寸档与面板进出场动画（盖层整体由遮罩壳动画驱动）
  const panelClasses = [
    styles.dialog,
    isFullscreen ? styles.dialogFullscreen : SIZE_CLASS[size],
    isFullscreen
      ? undefined
      : state === 'exiting'
        ? styles.dialogExit
        : styles.dialogEnter,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const overlayClasses = [
    state === 'exiting' ? styles.overlayExit : styles.overlayEnter,
    overlayClassName,
  ]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    // FocusTrap 容器直接挂在 body 下：兄弟节点（应用主体）被 aria-hidden 旁路
    <FocusTrap active={open} initialFocusRef={initialFocusRef}>
      <div className={overlayClasses}>
        <div
          className={styles.backdrop}
          aria-hidden="true"
          onClick={dismissible ? onClose : undefined}
        />
        <div
          role={role}
          aria-modal="true"
          aria-label={title == null ? ariaLabel : undefined}
          aria-labelledby={title != null ? titleId : undefined}
          aria-describedby={description != null ? descriptionId : undefined}
          className={panelClasses}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
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

          {description != null ? (
            <p className={styles.dialogDescription} id={descriptionId}>
              {description}
            </p>
          ) : null}

          <div className={styles.dialogBody}>{children}</div>

          {footer != null ? <div className={styles.dialogFooter}>{footer}</div> : null}
        </div>
      </div>
    </FocusTrap>,
    target
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
