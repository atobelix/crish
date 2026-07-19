import * as Lucide from 'lucide-react';
import styles from './CheatsheetModal.module.css';
import { Tooltip } from './settings/SettingsUI';
import { useAnimatedPresence } from '../hooks/useAnimatedPresence';

interface CheatsheetModalProps {
  onClose: () => void;
  isOpen?: boolean;
}

export function CheatsheetModal({ onClose, isOpen = true }: CheatsheetModalProps) {
  const { state, isMounted } = useAnimatedPresence({ visible: isOpen, exitDurationMs: 250 });
  if (!isMounted) return null;

  return (
    <div
      className={`${styles.cheatsheetOverlay} ${styles[state]}`}
      role="presentation"
      onClick={onClose}
    >
      <div
        className={styles.cheatsheetModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cheatsheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.cheatsheetHeader}>
          <div className={styles.cheatsheetTitleWrap}>
            <Lucide.Keyboard
              size={16}
              style={{ color: 'var(--accent-color)' }}
              aria-hidden="true"
            />
            <h3 className={styles.cheatsheetTitle} id="cheatsheet-title">
              快捷键
            </h3>
          </div>
          <Tooltip content="关闭">
            <button
              type="button"
              onClick={onClose}
              className={styles.cheatsheetCloseBtn}
              aria-label="关闭快捷键帮助"
            >
              <Lucide.X size={16} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
        
        <div className={styles.cheatsheetBody}>
          <div className={styles.cheatsheetRow}>
            <span className={styles.cheatsheetLabel}>打开系统设置</span>
            <kbd className={styles.cheatsheetKey}>Ctrl + ,</kbd>
          </div>
          <div className={styles.cheatsheetRow}>
            <span className={styles.cheatsheetLabel}>分支分叉当前会话</span>
            <kbd className={styles.cheatsheetKey}>双击 Escape</kbd>
          </div>
          <div className={styles.cheatsheetRow}>
            <span className={styles.cheatsheetLabel}>聊天命令行提示</span>
            <kbd className={styles.cheatsheetKey}>输入 /</kbd>
          </div>
          <div className={styles.cheatsheetRow}>
            <span className={styles.cheatsheetLabel}>关闭当前选中卡片</span>
            <kbd className={styles.cheatsheetKey}>中键点击标签页</kbd>
          </div>
        </div>
        
        <div className={styles.cheatsheetFooterTip}>
          <strong>布局提示：</strong>
          工作区卡片支持拖拽与合并。拖动标签页在其他卡片边缘悬停即可快速分屏，或在标签栏中拖拽重排。
        </div>
      </div>
    </div>
  );
}
