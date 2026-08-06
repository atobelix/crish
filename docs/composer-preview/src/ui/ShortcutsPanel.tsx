/**
 * ShortcutsPanel — 快捷键速查面板
 *
 * 按类别分组展示所有可用快捷键。
 * 通过 `?` 键或命令面板唤起。
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ShortcutsPanelProps {
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  items: Array<{ keys: string; label: string }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '文本格式',
    items: [
      { keys: 'Ctrl+B', label: '加粗' },
      { keys: 'Ctrl+I', label: '斜体' },
      { keys: 'Ctrl+U', label: '下划线' },
      { keys: 'Ctrl+Shift+S', label: '删除线' },
      { keys: 'Ctrl+E', label: '行内代码' },
      { keys: 'Ctrl+Shift+H', label: '高亮' },
    ],
  },
  {
    title: '块类型',
    items: [
      { keys: 'Ctrl+Alt+0', label: '正文' },
      { keys: 'Ctrl+Alt+1', label: '标题 1' },
      { keys: 'Ctrl+Alt+2', label: '标题 2' },
      { keys: 'Ctrl+Alt+3', label: '标题 3' },
      { keys: 'Ctrl+Shift+7', label: '有序列表' },
      { keys: 'Ctrl+Shift+8', label: '无序列表' },
      { keys: 'Ctrl+Shift+9', label: '任务列表' },
      { keys: 'Ctrl+Shift+B', label: '引用' },
    ],
  },
  {
    title: '编辑',
    items: [
      { keys: 'Ctrl+Z', label: '撤销' },
      { keys: 'Ctrl+Shift+Z', label: '重做' },
      { keys: 'Ctrl+A', label: '全选' },
      { keys: 'Ctrl+C', label: '复制' },
      { keys: 'Ctrl+X', label: '剪切' },
      { keys: 'Ctrl+V', label: '粘贴' },
      { keys: 'Tab', label: '增加缩进' },
      { keys: 'Shift+Tab', label: '减少缩进' },
    ],
  },
  {
    title: '导航与功能',
    items: [
      { keys: '/', label: '打开斜杠菜单' },
      { keys: 'Ctrl+K', label: '命令面板' },
      { keys: 'Ctrl+F', label: '搜索' },
      { keys: 'Ctrl+H', label: '搜索替换' },
      { keys: 'Escape', label: '关闭面板 / 取消操作' },
    ],
  },
];

export const ShortcutsPanel: React.FC<ShortcutsPanelProps> = ({ onClose }) => {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // 点击外部关闭
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <div className="shortcuts-overlay" onClick={handleOverlayClick}>
      <div className="shortcuts-panel" ref={panelRef}>
        <div className="shortcuts-panel__header">
          <h2 className="shortcuts-panel__title">快捷键速查</h2>
          <button type="button" className="shortcuts-panel__close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="shortcuts-panel__body">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.title} className="shortcuts-panel__group">
              <h3 className="shortcuts-panel__group-title">{group.title}</h3>
              <div className="shortcuts-panel__list">
                {group.items.map((item) => (
                  <div key={item.keys} className="shortcuts-panel__item">
                    <span className="shortcuts-panel__label">{item.label}</span>
                    <span className="shortcuts-panel__keys">
                      {item.keys.split('+').map((key, i) => (
                        <span key={i}>
                          {i > 0 && <span className="shortcuts-panel__plus">+</span>}
                          <kbd className="shortcuts-panel__kbd">{key}</kbd>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
