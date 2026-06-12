import { useState, useEffect, useRef } from 'preact/hooks';
import { appState } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';

interface CommandItem {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

function getCommands(): CommandItem[] {
  const state = appState.getState();
  return [
    { id: 'new-chat', label: '新建对话', category: '对话', action: () => appState.createSession() },
    { id: 'open-folder', label: '打开文件夹', category: '文件', action: async () => {
      const folder = await tauriBridge.selectFolder();
      if (folder) {
        appState.addOpenedFolder(folder);
        appState.setState('workingDirectory', folder);
        const projectSessions = appState.getProjectSessions(folder);
        if (projectSessions.length > 0) appState.switchSession(projectSessions[0].id);
        else appState.createSession('新对话', folder);
      }
    }},
    { id: 'toggle-mode', label: '切换 Chat/Code 模式', category: '模式', action: () => {
      // workMode 由 currentSession.projectId 决定，切换模式需要切换会话
      const currentWorkMode = appState.workMode;
      if (currentWorkMode === 'agent') {
        const chatSessions = appState.getState().sessions.filter(s => s.projectId === null);
        if (chatSessions.length > 0) appState.switchSession(chatSessions[0].id);
        else appState.createSession('新对话');
      } else {
        const cwd = appState.getState().workingDirectory;
        if (cwd) {
          const projectSessions = appState.getProjectSessions(cwd);
          if (projectSessions.length > 0) appState.switchSession(projectSessions[0].id);
          else appState.createSession('新对话', cwd);
        }
      }
    }},
    { id: 'toggle-permission', label: '切换权限模式', category: '模式', action: () => {
      appState.setState('permissionMode', state.permissionMode === 'ask' ? 'full-access' : 'ask');
    }},
    { id: 'toggle-theme', label: '切换深色/浅色主题', category: '外观', shortcut: 'Ctrl+Shift+T', action: () => {
      appState.setState('theme', state.theme === 'dark' ? 'light' : 'dark');
    }},
    { id: 'toggle-left-sidebar', label: '切换左侧面板', category: '视图', action: () => {
      appState.setState('leftSidebarVisible', !state.leftSidebarVisible);
    }},
    { id: 'toggle-right-sidebar', label: '切换右侧面板', category: '视图', action: () => {
      appState.setState('rightSidebarVisible', !state.rightSidebarVisible);
    }},
    { id: 'open-settings', label: '打开设置', category: '设置', action: () => appState.setState('settingsOpen', true) },
    { id: 'clear-chat', label: '清空当前对话', category: '对话', action: () => {
      const session = appState.getState().currentSession;
      if (session) appState.clearSessionMessages(session.id);
    }},
    { id: 'open-project', label: '打开项目面板', category: '视图', action: () => appState.openRightTab('project') },
    { id: 'open-runs', label: '打开运行面板', category: '视图', action: () => appState.openRightTab('runs') },
    { id: 'open-approvals', label: '打开审批面板', category: '视图', action: () => appState.openRightTab('approvals') },
    { id: 'open-diagnostics', label: '打开诊断面板', category: '视图', action: () => appState.openRightTab('diagnostics') },
    { id: 'open-tools', label: '打开工具面板', category: '视图', action: () => appState.openRightTab('tools') },
    { id: 'open-sessions', label: '打开会话列表', category: '视图', action: () => appState.openRightTab('sessions') },
    { id: 'open-artifacts', label: '打开产物面板', category: '视图', action: () => appState.openRightTab('artifacts') },
    { id: 'open-settings', label: '打开设置面板', category: '视图', action: () => appState.openRightTab('settings') },
  ];
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = getCommands();
  const filtered = query
    ? commands.filter(c =>
        c.label.toLowerCase().includes(query.toLowerCase()) ||
        c.category.toLowerCase().includes(query.toLowerCase())
      )
    : commands;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(prev => !prev);
        setQuery('');
        setSelectedIndex(0);
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const executeCommand = (cmd: CommandItem) => {
    setOpen(false);
    setQuery('');
    cmd.action();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        executeCommand(filtered[selectedIndex]);
      }
    }
  };

  if (!open) return null;

  return (
    <div class="repl-cmd-palette-overlay" onClick={() => setOpen(false)}>
      <div class="repl-cmd-palette" onClick={(e) => e.stopPropagation()}>
        <div class="repl-cmd-palette-input-wrap">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            class="repl-cmd-palette-input"
            placeholder="搜索命令..."
            value={query}
            onInput={(e: any) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <span class="repl-cmd-palette-esc">ESC</span>
        </div>
        <div class="repl-cmd-palette-list">
          {filtered.length === 0 && (
            <div class="repl-cmd-palette-empty">没有匹配的命令</div>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              class={`repl-cmd-palette-item ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => executeCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span class="repl-cmd-palette-item-label">{cmd.label}</span>
              <span class="repl-cmd-palette-item-category">{cmd.category}</span>
              {cmd.shortcut && <span class="repl-cmd-palette-item-shortcut">{cmd.shortcut}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
