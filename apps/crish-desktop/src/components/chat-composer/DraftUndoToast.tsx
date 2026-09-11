/**
 * apps/crish-desktop/src/components/chat-composer/DraftUndoToast.tsx
 * 模板注入后的 Inline 撤销悬浮条（详案 03 §2.3 / 不变量三）。
 * - 仅在外部模板覆盖产生可撤销历史时由宿主置 show=true；
 * - 默认 6 秒自动淡出（autoDismissMs=6000）；
 * - 点击撤销调用 onUndo（undoDraft 100% 原位无损恢复）后立即隐藏；
 * - 视觉遵循 UI 铁律：无重阴影、焦点/激活边框 ≤10% 混入、HSLA。
 * CI Guardrail: UI Component (Max 500 lines of effective code, Max 12 useState)
 */
import React, { useEffect, useState } from 'react';

import styles from './DraftUndoToast.module.css';
import { AppIcon } from '../ui/icons/index';

export interface DraftUndoToastProps {
  /** 是否存在可撤销历史（外部模板覆盖后为 true） */
  show: boolean;
  /** 点击撤销恢复原草稿 */
  onUndo: () => void;
  message?: string;
  autoDismissMs?: number;
}

export const DraftUndoToast: React.FC<DraftUndoToastProps> = ({
  show,
  onUndo,
  message = '已应用模板并保留原草稿快照',
  autoDismissMs = 6000,
}) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (show) {
      setVisible(true);
      const timer = window.setTimeout(() => setVisible(false), autoDismissMs);
      return () => window.clearTimeout(timer);
    }
    setVisible(false);
    return undefined;
  }, [show, autoDismissMs]);

  if (!visible) return null;

  const dismiss = () => setVisible(false);

  return (
    <div
      className={styles.undoToast}
      role="status"
      aria-live="polite"
      data-draft-undo-toast=""
    >
      <span className={styles.toastText}>{message}</span>
      <button
        type="button"
        className={styles.undoBtn}
        onClick={() => {
          onUndo();
          dismiss();
        }}
      >
        <AppIcon name="undo" size={12} aria-hidden />
        <span>撤销恢复</span>
      </button>
      <button
        type="button"
        className={styles.closeBtn}
        onClick={dismiss}
        aria-label="关闭提示"
      >
        <AppIcon name="x" size={12} aria-hidden />
      </button>
    </div>
  );
};

DraftUndoToast.displayName = 'DraftUndoToast';
