/**
 * apps/crish-desktop/src/components/chat-composer/DraftUndoToast.tsx
 * 模板注入后的 Inline 撤销悬浮条（详案 03 §2.3 / 不变量三）。
 * - 仅在外部模板覆盖产生可撤销历史时由宿主置 show=true；
 * - 默认 6 秒自动淡出（autoDismissMs=6000）；
 * - 点击撤销调用 onUndo（undoDraft 100% 原位无损恢复）后立即隐藏；
 * - 视觉遵循 UI 铁律：无重阴影、焦点/激活边框 ≤10% 混入、HSLA。
 * CI Guardrail: UI Component (Max 500 lines of effective code, Max 12 useState)
 */
import React, { useEffect, useRef, useState } from 'react';

import styles from './DraftUndoToast.module.css';
import { Button } from '@/components/ui';
import { useI18n } from '../../i18n';
import { AppIcon } from '@/components/ui/icons';
import { useClosingFlag } from '../motion/useExitReveal';
import { DURATION_POPOVER_EXIT_MS } from '../../utils/motionTokens';

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
  message,
  autoDismissMs = 6000,
}) => {
  const { t } = useI18n();
  const displayMessage = message ?? t('chat.composer.appliedTemplateSnapshot');

  // S4 退场宿主：show 翻 false（自动淡出/撤销/关闭）时不立即隐藏——
  // 先播 120ms 退场再卸载。自动淡出（6s）与撤销/关闭均走同一 closing
  // （170ms 后隐藏）；show 再翻 true 即取消退场（新一次可撤销历史）。
  // toast 不走入场通道（本地 undoToastIn），entered 取「曾经显示过」。
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!show) {
      setDismissed(false);
      return undefined;
    }
    setDismissed(false);
    const timer = window.setTimeout(() => setDismissed(true), autoDismissMs);
    return () => window.clearTimeout(timer);
  }, [show, autoDismissMs]);

  const shownRef = useRef(false);
  if (show && !dismissed) shownRef.current = true;
  const toastClosing = useClosingFlag(show && !dismissed, {
    key: 'draft-undo',
    durationMs: DURATION_POPOVER_EXIT_MS,
    entered: shownRef.current,
  });

  if (!toastClosing.visible) return null;

  const dismiss = () => setDismissed(true);

  return (
    <div
      className={styles.undoToast}
      role="status"
      aria-live="polite"
      aria-hidden={toastClosing.closing ? true : undefined}
      data-draft-undo-toast=""
      data-closing={toastClosing.closing ? 'true' : undefined}
    >
      <span className={styles.toastText}>{displayMessage}</span>
      <Button
        type="button"
        variant="ghost"
        className={styles.undoBtn}
        onClick={() => {
          onUndo();
          dismiss();
        }}
      >
        <AppIcon name="undo" size={12} aria-hidden />
        <span>{t('chat.composer.undoRestore')}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={styles.closeBtn}
        onClick={dismiss}
        aria-label={t('common.closeNotice')}
      >
        <AppIcon name="x" size={12} aria-hidden />
      </Button>
    </div>
  );
};

DraftUndoToast.displayName = 'DraftUndoToast';
