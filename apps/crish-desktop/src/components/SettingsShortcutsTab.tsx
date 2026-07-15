/**
 * 设置 · 快捷键（现代化列表：大标题、副文案、右侧录制按钮）
 */
import React, { useEffect, useMemo, useState } from 'react';

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
  { id: 'toggle_settings', label: '打开系统设置', desc: '打开或关闭系统设置管理面板', group: '系统' },
  { id: 'branch_session', label: '分支分叉当前会话', desc: '分叉复制当前对话历史到新临时分支', group: '会话' },
  { id: 'command_palette', label: '聊天命令行提示', desc: '在命令行输入框中弹出智能快捷指令', group: '会话' },
  { id: 'close_tab', label: '关闭当前选中卡片', desc: '快速关闭工作区中打开的选显卡片', group: '工作区' },
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
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SHORTCUT_ITEMS.slice();
    return SHORTCUT_ITEMS.filter(
      (sh) =>
        sh.label.toLowerCase().includes(q) ||
        sh.desc.toLowerCase().includes(q) ||
        sh.group.toLowerCase().includes(q) ||
        sh.id.toLowerCase().includes(q) ||
        (customShortcuts[sh.id] || '').toLowerCase().includes(q),
    );
  }, [query, customShortcuts]);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const item of filtered) {
      const list = map.get(item.group) || [];
      list.push(item);
      map.set(item.group, list);
    }
    return Array.from(map.entries());
  }, [filtered]);

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
        <p className="settings-page-desc">
          查看与自定义系统操作中的主要快捷键。点击右侧按键开始录制，Esc 取消。
        </p>
      </header>

      <section className="settings-group" aria-label="搜索">
        <div className="settings-group-label">筛选</div>
        <div className="settings-list settings-list--spaced">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">按名称筛选</div>
              <div className="settings-list-sub">
                显示 {filtered.length} / {SHORTCUT_ITEMS.length} 项
                {query.trim() ? `（匹配「${query.trim()}」）` : ''}
              </div>
            </div>
            <div className="settings-list-stack-controls">
              <input
                type="search"
                className="settings-field-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索快捷键名称、说明或按键…"
                spellCheck={false}
                aria-label="搜索快捷键"
              />
            </div>
          </div>
        </div>
      </section>

      {grouped.length === 0 ? (
        <section className="settings-group" aria-label="无结果">
          <div className="settings-group-label">快捷键</div>
          <div className="settings-list">
            <div className="settings-list-row">
              <div className="settings-list-copy">
                <div className="settings-list-title">无匹配项</div>
                <div className="settings-list-sub">试试更短的关键词，或清空筛选。</div>
              </div>
            </div>
          </div>
        </section>
      ) : (
        grouped.map(([groupName, items]) => (
          <section key={groupName} className="settings-group" aria-label={groupName}>
            <div className="settings-group-label">
              {groupName}（{items.length}）
            </div>
            <div className="settings-list">
              {items.map((sh) => {
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
        ))
      )}
    </div>
  );
};
