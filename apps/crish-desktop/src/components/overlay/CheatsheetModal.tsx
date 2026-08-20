/**
 * 快捷键帮助弹窗（PE-05 T05.2 #2）
 *
 * 已收敛到 ui/Dialog 基座：原 FocusTrap/Esc/restoreFocus/动画三件套由基座接管；
 * 保留搜索分组渲染与键盘布局（cheatsheetBody 等私有形态）。
 * 行为保持：Esc/遮罩/关闭按钮关闭、搜索过滤分组。
 */
import { useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './CheatsheetModal.module.css';
import { ShortcutService } from '../../services/ShortcutService';
import type { ShortcutMeta } from '../../services/ShortcutRegistry';
import { Dialog } from '../ui';

interface CheatsheetModalProps {
  onClose: () => void;
  isOpen?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  navigation: '导航',
  editor: '编辑',
  panel: '面板',
  session: '会话',
  system: '系统',
};

export function CheatsheetModal({ onClose, isOpen = true }: CheatsheetModalProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const grouped = useMemo(() => {
    const actions = ShortcutService.getInstance().getAllActions();
    const groups: Record<string, ShortcutMeta[]> = {};
    for (const s of actions) {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchLabel = s.label.toLowerCase().includes(q);
        const matchKeywords = s.keywords.some((k) => k.toLowerCase().includes(q));
        const matchBinding = s.defaultBinding.toLowerCase().includes(q);
        if (!matchLabel && !matchKeywords && !matchBinding) continue;
      }
      const cat = s.category || 'system';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(s);
    }
    return groups;
  }, [searchQuery]);

  const shortcutService = ShortcutService.getInstance();

  return (
    <Dialog
      open={isOpen}
      onClose={onClose}
      title={
        <span className={styles.cheatsheetTitleWrap}>
          <Lucide.Keyboard size={16} aria-hidden="true" />
          <span className={styles.cheatsheetTitle}>快捷键</span>
        </span>
      }
      classNames={{ panel: styles.cheatsheetModal, overlay: styles.cheatsheetOverlay }}
    >
      <div className={styles.cheatsheetSearch}>
        <Lucide.Search size={14} aria-hidden="true" />
        <input
          type="text"
          className={styles.cheatsheetSearchInput}
          placeholder="搜索快捷键..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          aria-label="搜索快捷键"
        />
      </div>

      <div className={styles.cheatsheetBody}>
        {Object.keys(CATEGORY_LABELS).map((cat) => {
          const items = grouped[cat];
          if (!items?.length) return null;
          return (
            <div key={cat} className={styles.cheatsheetCategory}>
              <div className={styles.cheatsheetCategoryTitle}>
                {CATEGORY_LABELS[cat]}
              </div>
              {items.map((s) => (
                <div key={s.id} className={styles.cheatsheetRow}>
                  <span className={styles.cheatsheetLabel}>{s.label}</span>
                  <kbd className={styles.cheatsheetKey}>
                    {shortcutService.formatForDisplay(s.defaultBinding)}
                  </kbd>
                </div>
              ))}
            </div>
          );
        })}
        {Object.keys(grouped).length === 0 && (
          <div className={styles.cheatsheetEmpty}>未找到匹配的快捷键</div>
        )}
      </div>

      {!searchQuery && (
        <div className={styles.cheatsheetFooterTip}>
          <strong>布局提示：</strong>
          工作区卡片支持拖拽与合并。拖动标签页在其他卡片边缘悬停即可快速分屏，或在标签栏中拖拽重排。
        </div>
      )}
    </Dialog>
  );
}
