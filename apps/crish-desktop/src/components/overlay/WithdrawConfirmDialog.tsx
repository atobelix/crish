/**
 * 撤回二次确认对话框（极简版）。
 *
 * 设计：背景板 + 文字 + 核心按钮。
 * 突出核心：确认撤回按钮（danger 色）。
 * 无图标、无统计、无关闭按钮（Esc 关闭）。
 *
 * 已收敛到 ui/Dialog 基座（PE-05 T05.2 #3）：遮罩/Esc/焦点圈定/动画由基座接管；
 * role='alertdialog' 危险操作语义 + showCloseButton=false 保留「无关闭按钮」设计；
 * 取消按钮为弹窗内首个可交互元素，基座默认初始聚焦（等价原 autoFocus）。
 */
import React from 'react';
import styles from './WithdrawConfirmDialog.module.css';
import { Button, Dialog } from '../ui';
import type { RewindScopeSummary } from '../../api/collectRewindScope';

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
  const files = scope.filePaths;

  return (
    <Dialog
      open={isOpen}
      onClose={onCancel}
      role="alertdialog"
      title="撤回消息"
      description={`将删除此后 ${scope.messageCount} 条消息${files.length > 0 ? `，还原 ${files.length} 个文件` : ''}。`}
      className={styles.dialog}
      overlayClassName={styles.overlay}
      showCloseButton={false}
      footer={
        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={styles.cancelBtn}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            className={styles.confirmBtn}
            onClick={onConfirm}
            data-testid="withdraw-confirm-btn"
          >
            确认撤回
          </Button>
        </div>
      }
    >
      {files.length > 0 ? (
        <ul className={styles.fileList}>
          {files.map((fp) => (
            <li key={fp} className={styles.fileItem} title={fp}>
              {fp}
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
};
