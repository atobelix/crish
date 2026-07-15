/**
 * 设置 · 快捷键（现代化列表：大标题、副文案、右侧录制按钮）
 */
import React, { useEffect, useState } from 'react';

type Props = {
  onShowToast: (msg: string) => void;
};

const DEFAULT_SHORTCUTS: Record<string, string> = {
  toggle_settings: 'Ctrl + ,',
  branch_session: 'Escape Escape',
  command_palette: '/',
  close_tab: 'MiddleClick',
};

const SHORTCUT_ITEMS = [
  { id: 'toggle_settings', label: '打开系统设置', desc: '打开或关闭系统设置管理面板' },
  { id: 'branch_session', label: '分支分叉当前会话', desc: '分叉复制当前对话历史到新临时分支' },
  { id: 'command_palette', label: '聊天命令行提示', desc: '在命令行输入框中弹出智能快捷指令' },
  { id: 'close_tab', label: '关闭当前选中卡片', desc: '快速关闭工作区中打开的选显卡片' },
] as const;

export const SettingsShortcutsTab: React.FC<Props> = ({ onShowToast }) => {
  const [customShortcuts, setCustomShortcuts] = useState<Record<string, string>>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('conex_custom_shortcuts');
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          // fallback
        }
      }
    }
    return { ...DEFAULT_SHORTCUTS };
  });
  const [recordingShortcutId, setRecordingShortcutId] = useState<string | null>(null);

  useEffect(() => {
    if (!recordingShortcutId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        setRecordingShortcutId(null);
        return;
      }

      const keys = [];
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.shiftKey) keys.push('Shift');
      if (e.altKey) keys.push('Alt');
      if (e.metaKey) keys.push('Meta');
      if (!['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
        let keyName = e.key;
        if (keyName === ' ') keyName = 'Space';
        keys.push(keyName.toUpperCase());
      }

      if (keys.length > 0) {
        const newKey = keys.join(' + ');
        const updated = { ...customShortcuts, [recordingShortcutId]: newKey };
        setCustomShortcuts(updated);
        localStorage.setItem('conex_custom_shortcuts', JSON.stringify(updated));
        setRecordingShortcutId(null);
        onShowToast(`快捷键已更新为: ${newKey}`);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingShortcutId, customShortcuts, onShowToast]);

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">快捷键</h2>
        <p className="settings-page-desc">查看与自定义系统操作中的主要快捷键。点击右侧按键开始录制，Esc 取消。</p>
      </header>

      <section className="settings-group" aria-label="核心快捷键">
        <div className="settings-group-label">核心快捷键</div>
        <div className="settings-list">
          {SHORTCUT_ITEMS.map((sh) => {
            const isRecording = recordingShortcutId === sh.id;
            const displayKey = customShortcuts[sh.id] || '未设置';

            return (
              <div key={sh.id} className="settings-list-row">
                <div className="settings-list-copy">
                  <div className="settings-list-title">{sh.label}</div>
                  <div className="settings-list-sub">{sh.desc}</div>
                </div>
                <div className="settings-list-control">
                  <button
                    type="button"
                    onClick={() => setRecordingShortcutId(isRecording ? null : sh.id)}
                    className={`shortcut-key-btn ${isRecording ? 'recording' : ''}`}
                  >
                    {isRecording ? '录制中...' : displayKey}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
};
