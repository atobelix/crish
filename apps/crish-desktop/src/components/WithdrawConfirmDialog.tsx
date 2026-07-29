/**
 * 撤回二次确认对话框（极简版）。
 *
 * 设计：背景板 + 文字 + 核心按钮。
 * 突出核心：确认撤回按钮（danger 色）。
 * 无图标、无统计、无关闭按钮（Esc 关闭）。
 */
import React, { useEffect } from 'react';
import styles from './WithdrawConfirmDialog.module.css';
import { useAnimatedPresence } from '../hooks/useAnimatedPresence';
import { useRestoreFocus } from '../hooks/useRestoreFocus';
import { FocusTrap } from './FocusTrap';
import type { RewindScopeSummary } from '../api/collectRewindScope';

export interface WithdrawConfirmDialogProps {
  scope: RewindScopeSummary;
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const WithdrawConfirmDialog: React.FC<WithdrawConfirmDialogProps> = ({
  scope,
  isOpen,
  onConfirm,
  onCancel,
}) => {
  const { state, isMounted } = useAnimatedPresence({
    visible: isOpen,
    exitDurationMs: 160,
  });
  useRestoreFocus(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onCancel]);

  if (!isMounted) return null;

  const files = scope.filePaths;

  return (
    <FocusTrap active={isOpen}>
      <div
        className={`${styles.overlay} ${styles[state]}`}
        role="presentation"
        onClick={onCancel}
      >
        <div
          className={styles.dialog}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="withdraw-title"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className={styles.title} id="withdraw-title">
            撤回消息
          </h3>

          <p className={styles.desc}>
            将删除此后 {scope.messageCount} 条消息
            {files.length > 0 ? `，还原 ${files.length} 个文件` : ''}。
          </p>

          {files.length > 0 ? (
            <ul className={styles.fileList}>
              {files.map((fp) => (
                <li key={fp} className={styles.fileItem} title={fp}>
                  {fp}
                </li>
              ))}
            </ul>
          ) : null}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={onCancel}
              autoFocus
            >
              取消
            </button>
            <button
              type="button"
              className={styles.confirmBtn}
              onClick={onConfirm}
              data-testid="withdraw-confirm-btn"
            >
              确认撤回
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
};
