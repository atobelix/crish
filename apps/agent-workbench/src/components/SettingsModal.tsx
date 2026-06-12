import { useState, useEffect, useCallback } from 'preact/hooks';
import type { JSX } from 'preact';
import { appState } from '../core/app-state';
import ProviderSettingsPanel from './ProviderSettingsPanel';
import { McpSubTab, MemorySubTab } from './tabs/ToolsTab';
import { UsageStatsPanel } from './tabs/SettingsTab';
import {
  IconSettings,
  IconKey,
  IconPalette,
  IconShield,
  IconArrowLeft,
  IconMoon,
  IconSun,
  IconTerminal,
  IconChat,
  IconUser,
} from './icons';

type SettingsTab = 'general' | 'provider' | 'mcp' | 'memory' | 'skills' | 'appearance' | 'permissions' | 'account' | 'usage';

interface NavItem {
  id: SettingsTab;
  label: string;
  icon: () => JSX.Element;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'general', label: '通用', icon: () => <IconSettings /> },
  { id: 'provider', label: '模型与供应商', icon: () => <IconKey /> },
  { id: 'mcp', label: 'MCP 服务', icon: () => <IconKey /> },
  { id: 'memory', label: '记忆', icon: () => <IconUser /> },
  { id: 'skills', label: '技能', icon: () => <IconSettings /> },
  { id: 'account', label: '账户', icon: () => <IconUser /> },
  { id: 'appearance', label: '外观', icon: () => <IconPalette /> },
  { id: 'permissions', label: '权限', icon: () => <IconShield /> },
  { id: 'usage', label: '用量', icon: () => <IconSettings /> },
];

export default function SettingsModal() {
  const [settingsOpen, setSettingsOpen] = useState(appState.getState().settingsOpen);
  const [settingsTab, setSettingsTab] = useState<string>(appState.getState().settingsTab);
  const [model, setModel] = useState(appState.getState().model);
  const [theme, setTheme] = useState(appState.getState().theme);
  const [workMode, setWorkMode] = useState(appState.workMode);
  const [permissionMode, setPermissionMode] = useState(appState.getState().permissionMode);


  useEffect(() => {
    const u1 = appState.subscribe('settingsOpen', setSettingsOpen);
    const u2 = appState.subscribe('settingsTab', setSettingsTab);
    const u3 = appState.subscribe('model', setModel);
    const u4 = appState.subscribe('theme', setTheme);
    const u5 = appState.subscribe('workMode', setWorkMode);
    const u6 = appState.subscribe('permissionMode', setPermissionMode);
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); };
  }, []);

  const handleClose = useCallback(() => { appState.setState('settingsOpen', false); }, []);
  const handleTabChange = useCallback((tab: SettingsTab) => { appState.setState('settingsTab', tab); }, []);
  const handleWorkModeChange = useCallback((mode: string) => {
    // workMode 由 currentSession.projectId 决定，切换模式需要切换到对应类型的 session
    if (mode === 'agent') {
      const cwd = appState.getState().workingDirectory;
      if (cwd) {
        const projectSessions = appState.getProjectSessions(cwd);
        if (projectSessions.length > 0) {
          appState.switchSession(projectSessions[0].id);
        } else {
          appState.createSession('新对话', cwd);
        }
      }
    } else {
      // chat 模式：创建或切换到无项目的会话
      const chatSessions = appState.getState().sessions.filter(s => s.projectId === null);
      if (chatSessions.length > 0) {
        appState.switchSession(chatSessions[0].id);
      } else {
        appState.createSession('新对话');
      }
    }
  }, []);
  const handleThemeChange = useCallback((newTheme: string) => { appState.setState('theme', newTheme); document.documentElement.setAttribute('data-theme', newTheme); }, []);
  const handlePermissionModeChange = useCallback((mode: 'ask' | 'full-access') => { appState.setState('permissionMode', mode); }, []);

  const handleExportSessions = useCallback(() => {
    const sessions = appState.getState().sessions;
    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `crish-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleClearCache = useCallback(() => {
    if (confirm('确定清除所有本地缓存吗？此操作不可恢复。')) {
      localStorage.clear();
      location.reload();
    }
  }, []);

  if (!settingsOpen) return null;

  const renderGeneral = () => (
    <div class="repl-rs-settings-list">
      <div class="repl-rs-settings-section">
        <div class="repl-rs-settings-section-title">工作模式</div>
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-label">模式</div>
          <div class="repl-rs-setting-row-control">
            <button class={`repl-rs-setting-option ${workMode === 'agent' ? 'active' : ''}`} onClick={() => handleWorkModeChange('agent')}>
              <IconTerminal /> Agent
            </button>
            <button class={`repl-rs-setting-option ${workMode === 'chat' ? 'active' : ''}`} onClick={() => handleWorkModeChange('chat')}>
              <IconChat /> Chat
            </button>
          </div>
        </div>
        <div class="repl-rs-setting-desc">Agent 模式可执行工具与文件操作；Chat 模式仅对话。</div>
      </div>
      <div class="repl-rs-settings-section">
        <div class="repl-rs-settings-section-title">数据</div>
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-label">导出对话</div>
          <div class="repl-rs-setting-row-control">
            <button class="repl-rs-setting-option" onClick={handleExportSessions}>导出 JSON</button>
          </div>
        </div>
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-label">本地缓存</div>
          <div class="repl-rs-setting-row-control">
            <button class="repl-rs-setting-option" onClick={handleClearCache}>清除并重载</button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderAppearance = () => (
    <div class="repl-rs-settings-list">
      <div class="repl-rs-settings-section">
        <div class="repl-rs-settings-section-title">主题</div>
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-label">主题风格</div>
          <div class="repl-rs-setting-row-control">
            <button class={`repl-rs-setting-option ${theme === 'dark' ? 'active' : ''}`} onClick={() => handleThemeChange('dark')}>
              <IconMoon /> 深色
            </button>
            <button class={`repl-rs-setting-option ${theme === 'light' ? 'active' : ''}`} onClick={() => handleThemeChange('light')}>
              <IconSun /> 浅色
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderPermissions = () => (
    <div class="repl-rs-settings-list">
      <div class="repl-rs-settings-section">
        <div class="repl-rs-settings-section-title">权限模式</div>
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-label">模式</div>
          <div class="repl-rs-setting-row-control">
            <button class={`repl-rs-setting-option ${permissionMode === 'ask' ? 'active' : ''}`} onClick={() => handlePermissionModeChange('ask')}>
              <IconShield /> 确认
            </button>
            <button class={`repl-rs-setting-option ${permissionMode === 'full-access' ? 'active' : ''}`} onClick={() => handlePermissionModeChange('full-access')}>
              <IconTerminal /> 自动
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  const renderAccount = () => (
    <div class="repl-rs-settings-list">
      <div class="repl-rs-settings-section">
        <div class="repl-rs-settings-section-title">账户</div>
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-label">凭据</div>
          <div class="repl-rs-setting-row-control">
            <span class="repl-rs-setting-value">在「模型与供应商」中配置 API 密钥或账户中心</span>
          </div>
        </div>
      </div>
      <div class="repl-rs-settings-section">
        <div class="repl-rs-settings-section-title">账单与用量</div>
        <div class="repl-rs-setting-row">
          <div class="repl-rs-setting-row-control">
            <span class="repl-rs-setting-value">账户中心 / 账单明细尚未接入</span>
          </div>
        </div>
      </div>
    </div>
  );

  const renderTabContent = () => {
    switch (settingsTab as SettingsTab) {
      case 'general': return renderGeneral();
      case 'provider': return <ProviderSettingsPanel />;
      case 'mcp': return <McpSubTab />;
      case 'memory': return <MemorySubTab />;
      case 'skills': return (
        <div class="repl-rs-settings-list">
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">技能</div>
            <div class="repl-rs-setting-row">
              <span class="repl-rs-setting-value">技能管理待接入（list_skills / set_skill_activation，见 BE-15）</span>
            </div>
          </div>
        </div>
      );
      case 'usage': return <UsageStatsPanel />;
      case 'account': return renderAccount();
      case 'appearance': return renderAppearance();
      case 'permissions': return renderPermissions();
      default: return renderGeneral();
    }
  };

  const currentNavLabel = NAV_ITEMS.find(n => n.id === settingsTab)?.label || '通用';

  return (
    <div class="repl-settings-panel">
      <div class="repl-settings-shell">
        <nav class="repl-settings-nav">
          <button class="repl-settings-back-btn" onClick={handleClose} title="返回">
            <IconArrowLeft />
            <span>返回</span>
          </button>
          <div class="repl-settings-nav-list">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                class={`repl-settings-nav-item ${settingsTab === item.id ? 'active' : ''}`}
                onClick={() => handleTabChange(item.id)}
              >
                <span class="repl-settings-nav-icon">{item.icon()}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <div class="repl-settings-content">
          <div class="repl-settings-header">
            <span class="repl-settings-header-title">{currentNavLabel}</span>
          </div>
          <div class="repl-settings-scroll-area">
            {renderTabContent()}
          </div>
        </div>
      </div>
    </div>
  );
}
