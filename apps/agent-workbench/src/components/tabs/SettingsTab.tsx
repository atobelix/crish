import { useState, useEffect } from 'preact/hooks';
import type { JSX } from 'preact';
import { appState } from '../../core/app-state';
import { eventBus } from '../../core/event-bus';
import ProviderSettingsPanel from '../ProviderSettingsPanel';
import { McpSubTab, MemorySubTab } from './ToolsTab';
import {
  IconPalette, IconMoon, IconSun, IconBot, IconChat, IconShield, IconCheck, IconZap,
  IconSettings, IconKey, IconUser, IconTerminal,
} from '../icons';

type SettingsSubTab = 'general' | 'provider' | 'mcp' | 'memory' | 'skills' | 'account' | 'appearance' | 'permissions' | 'usage';

const SUB_TAB_NAV: { id: SettingsSubTab; label: string; icon: () => JSX.Element }[] = [
  { id: 'general', label: '通用', icon: () => <IconSettings /> },
  { id: 'provider', label: '模型', icon: () => <IconKey /> },
  { id: 'mcp', label: 'MCP', icon: () => <IconTerminal /> },
  { id: 'memory', label: '记忆', icon: () => <IconUser /> },
  { id: 'skills', label: '技能', icon: () => <IconSettings /> },
  { id: 'account', label: '账户', icon: () => <IconUser /> },
  { id: 'appearance', label: '外观', icon: () => <IconPalette /> },
  { id: 'permissions', label: '权限', icon: () => <IconShield /> },
  { id: 'usage', label: '用量', icon: () => <IconZap /> },
];

export default function SettingsTab() {
  const [subTab, setSubTab] = useState<SettingsSubTab>('general');
  const [theme, setTheme] = useState(appState.getState().theme);
  const [permissionMode, setPermissionMode] = useState(appState.getState().permissionMode);
  const [workMode, setWorkMode] = useState(appState.workMode);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [rulesViewOpen, setRulesViewOpen] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(localStorage.getItem('conex:systemPrompt') ?? '');

  useEffect(() => {
    const u1 = appState.subscribe('theme', setTheme);
    const u2 = appState.subscribe('permissionMode', setPermissionMode);
    const u3 = appState.subscribe('workMode', setWorkMode);
    return () => { u1(); u2(); u3(); };
  }, []);

  function handleThemeChange(newTheme: string) {
    appState.setState('theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  }

  function handlePermissionModeChange(mode: 'ask' | 'full-access') {
    appState.setState('permissionMode', mode);
  }

  function handleWorkModeChange(mode: string) {
    // workMode 由 currentSession.projectId 决定，切换模式需要切换到对应类型的 session
    if (mode === 'agent') {
      const cwd = appState.getState().workingDirectory;
      if (cwd) {
        const projectSessions = appState.getProjectSessions(cwd);
        if (projectSessions.length > 0) { appState.switchSession(projectSessions[0].id); return; }
        appState.createSession('新对话', cwd);
        return;
      }
    } else {
      const chatSessions = appState.getState().sessions.filter(s => s.projectId === null);
      if (chatSessions.length > 0) { appState.switchSession(chatSessions[0].id); return; }
      appState.createSession('新对话');
      return;
    }
  }

  function handleOpenToolsSubTab(tab: ToolsSubTab) {
    appState.openRightTab('tools');
    setTimeout(() => eventBus.emit('tools:switch-subtab', tab), 0);
  }

  function handleSavePrompt() {
    localStorage.setItem('conex:systemPrompt', systemPrompt);
    setPromptEditorOpen(false);
  }

  function handleExportSessions() {
    const sessions = appState.getState().sessions;
    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `conex-sessions-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleClearCache() {
    if (confirm('确定要清除所有本地缓存吗？此操作不可恢复。')) {
      localStorage.clear();
      location.reload();
    }
  }

  return (
    <div class="repl-rs-tab-content-inner">
      <div class="repl-rs-sub-tabs">
        {SUB_TAB_NAV.map((nav) => (
          <button
            key={nav.id}
            class={`repl-rs-sub-tab ${subTab === nav.id ? 'active' : ''}`}
            onClick={() => setSubTab(nav.id)}
            title={nav.label}
          >
            {nav.icon()} {nav.label}
          </button>
        ))}
      </div>

      {subTab === 'general' && (
        <div class="repl-rs-settings-list">
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">工作模式</div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">模式</div>
              <div class="repl-rs-setting-row-control">
                <button class={`repl-rs-setting-option ${workMode === 'agent' ? 'active' : ''}`} onClick={() => handleWorkModeChange('agent')}>
                  <IconBot /> Agent
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
      )}

      {subTab === 'provider' && <ProviderSettingsPanel />}

      {subTab === 'mcp' && <McpSubTab />}

      {subTab === 'memory' && <MemorySubTab />}

      {subTab === 'skills' && (
        <div class="repl-rs-settings-list">
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">技能</div>
            <div class="repl-rs-setting-row">
              <span class="repl-rs-setting-value">技能管理待接入（list_skills / set_skill_activation）</span>
            </div>
          </div>
        </div>
      )}

      {subTab === 'account' && (
        <div class="repl-rs-settings-list">
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">账户</div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">凭据</div>
              <div class="repl-rs-setting-row-control">
                <span class="repl-rs-setting-value">在「模型」中配置 API 密钥或账户中心</span>
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
      )}

      {subTab === 'appearance' && (
        <div class="repl-rs-settings-list">
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">外观</div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">主题</div>
              <div class="repl-rs-setting-row-control">
                <button class={`repl-rs-setting-option ${theme === 'dark' ? 'active' : ''}`} onClick={() => handleThemeChange('dark')}>
                  <IconMoon /> 深色
                </button>
                <button class={`repl-rs-setting-option ${theme === 'light' ? 'active' : ''}`} onClick={() => handleThemeChange('light')}>
                  <IconSun /> 浅色
                </button>
                <button class={`repl-rs-setting-option ${theme === 'system' ? 'active' : ''}`} onClick={() => handleThemeChange('system')}>
                  系统
                </button>
              </div>
            </div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">工作模式</div>
              <div class="repl-rs-setting-row-control">
                <button class={`repl-rs-setting-option ${workMode === 'agent' ? 'active' : ''}`} onClick={() => handleWorkModeChange('agent')}>
                  <IconBot /> Agent
                </button>
                <button class={`repl-rs-setting-option ${workMode === 'chat' ? 'active' : ''}`} onClick={() => handleWorkModeChange('chat')}>
                  <IconChat /> Chat
                </button>
              </div>
            </div>
          </div>

          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">智能体</div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">系统提示词</div>
              <div class="repl-rs-setting-row-control">
                <button class="repl-rs-setting-option" onClick={() => setPromptEditorOpen(true)}>编辑</button>
              </div>
            </div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">规则</div>
              <div class="repl-rs-setting-row-control">
                <button class="repl-rs-setting-option" onClick={() => setRulesViewOpen(!rulesViewOpen)}>
                  {rulesViewOpen ? '收起' : '查看'}
                </button>
              </div>
            </div>
          </div>

          {promptEditorOpen && (
            <div class="repl-rs-settings-section">
              <div class="repl-rs-settings-section-title">系统提示词</div>
              <textarea
                class="repl-rs-prompt-editor"
                value={systemPrompt}
                onInput={(e: Event) => setSystemPrompt((e.target as HTMLTextAreaElement).value)}
                placeholder="输入系统提示词..."
                rows={6}
              />
              <div class="repl-rs-setting-row repl-rs-setting-row-actions">
                <button class="repl-rs-setting-option" onClick={handleSavePrompt}>保存</button>
                <button class="repl-rs-setting-option" onClick={() => setPromptEditorOpen(false)}>取消</button>
              </div>
            </div>
          )}

          {rulesViewOpen && (
            <div class="repl-rs-settings-section">
              <div class="repl-rs-settings-section-title">内置规则</div>
              <div class="repl-rs-rules-list">
                <div class="repl-rs-rule-item high">
                  <span class="repl-rs-rule-badge">高危</span>
                  <span class="repl-rs-rule-name">数据破坏</span>
                  <span class="repl-rs-rule-desc">delete_file、remove_dir、rm、bash 等操作</span>
                </div>
                <div class="repl-rs-rule-item high">
                  <span class="repl-rs-rule-badge">高危</span>
                  <span class="repl-rs-rule-name">敏感信息</span>
                  <span class="repl-rs-rule-desc">read_env、get_secret、access_key 等操作</span>
                </div>
                <div class="repl-rs-rule-item medium">
                  <span class="repl-rs-rule-badge">中危</span>
                  <span class="repl-rs-rule-name">外部网络</span>
                  <span class="repl-rs-rule-desc">fetch、curl、wget、http_request 等操作</span>
                </div>
                <div class="repl-rs-rule-item medium">
                  <span class="repl-rs-rule-badge">中危</span>
                  <span class="repl-rs-rule-name">文件写入</span>
                  <span class="repl-rs-rule-desc">edit、create_file、append_file、write_file 等操作</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === 'permissions' && (
        <div class="repl-rs-settings-list">
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">权限</div>
            <div class="repl-rs-setting-row">
              <div class="repl-rs-setting-row-label">权限模式</div>
              <div class="repl-rs-setting-row-control">
                <button class={`repl-rs-setting-option ${permissionMode === 'ask' ? 'active' : ''}`} onClick={() => handlePermissionModeChange('ask')}>
                  <IconShield /> 安全确认
                </button>
                <button class={`repl-rs-setting-option ${permissionMode === 'full-access' ? 'active' : ''}`} onClick={() => handlePermissionModeChange('full-access')}>
                  <IconCheck /> 完全允许
                </button>
              </div>
            </div>
            <div class="repl-rs-setting-desc">
              {permissionMode === 'ask'
                ? '每次工具调用前都需要确认，适合需要精细控制的场景'
                : '自动允许所有工具调用，适合信任 AI 操作的场景'}
            </div>
          </div>
        </div>
      )}

      {subTab === 'usage' && (
        <div class="repl-rs-settings-list">
          <div class="repl-rs-settings-section">
            <div class="repl-rs-settings-section-title">用量统计</div>
            <UsageStatsPanel />
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== Usage Stats Panel ====================

type UsageView = 'overview' | 'models' | 'activity' | 'projects';

export function UsageStatsPanel() {
  const [view, setView] = useState<UsageView>('overview');
  const [sessions, setSessions] = useState(appState.getState().sessions);
  const [runContexts, setRunContexts] = useState(appState.getState().runContexts);

  useEffect(() => {
    const u1 = appState.subscribe('sessions', setSessions);
    const u2 = appState.subscribe('runContexts', setRunContexts);
    return () => { u1(); u2(); };
  }, []);

  const allMessages = sessions.flatMap(s => s.messages);
  const totalMessages = allMessages.length;
  const userMessages = allMessages.filter(m => m.role === 'user').length;
  const assistantMessages = allMessages.filter(m => m.role === 'assistant').length;
  const totalRuns = Object.keys(runContexts).length;
  const completedRuns = Object.values(runContexts).filter(r => r.status === 'completed').length;
  const activeRuns = Object.values(runContexts).filter(r => r.status === 'running').length;

  const modelCounts: Record<string, number> = {};
  Object.values(runContexts).forEach(r => {
    const m = r.model || '未知';
    modelCounts[m] = (modelCounts[m] || 0) + 1;
  });
  const modelEntries = Object.entries(modelCounts).sort((a, b) => b[1] - a[1]);

  const now = Date.now();
  const hourBuckets: number[] = new Array(24).fill(0);
  allMessages.forEach(m => {
    const hoursAgo = Math.floor((now - m.timestamp) / 3600000);
    if (hoursAgo >= 0 && hoursAgo < 24) {
      hourBuckets[hoursAgo]++;
    }
  });
  const maxHour = Math.max(1, ...hourBuckets);

  const projectStats: Record<string, { sessions: number; messages: number; name: string }> = {};
  sessions.forEach(s => {
    const pid = s.projectId ?? 'global';
    if (!projectStats[pid]) {
      projectStats[pid] = { sessions: 0, messages: 0, name: pid === 'global' ? '全局对话' : pid.split('/').pop() || pid };
    }
    projectStats[pid].sessions += 1;
    projectStats[pid].messages += s.messages.length;
  });
  const projectEntries = Object.entries(projectStats).sort((a, b) => b[1].messages - a[1].messages);

  return (
    <div class="repl-rs-usage-stats">
      <div class="repl-rs-usage-tabs">
        <button class={`repl-rs-usage-tab ${view === 'overview' ? 'active' : ''}`} onClick={() => setView('overview')}>概览</button>
        <button class={`repl-rs-usage-tab ${view === 'models' ? 'active' : ''}`} onClick={() => setView('models')}>模型</button>
        <button class={`repl-rs-usage-tab ${view === 'activity' ? 'active' : ''}`} onClick={() => setView('activity')}>活动</button>
        <button class={`repl-rs-usage-tab ${view === 'projects' ? 'active' : ''}`} onClick={() => setView('projects')}>项目</button>
      </div>

      {view === 'overview' && (
        <>
          <div class="repl-rs-usage-grid">
            <div class="repl-rs-usage-stat"><span class="repl-rs-usage-value">{sessions.length}</span><span class="repl-rs-usage-label">会话</span></div>
            <div class="repl-rs-usage-stat"><span class="repl-rs-usage-value">{totalMessages}</span><span class="repl-rs-usage-label">消息</span></div>
            <div class="repl-rs-usage-stat"><span class="repl-rs-usage-value">{userMessages}</span><span class="repl-rs-usage-label">输入</span></div>
            <div class="repl-rs-usage-stat"><span class="repl-rs-usage-value">{assistantMessages}</span><span class="repl-rs-usage-label">输出</span></div>
            <div class="repl-rs-usage-stat"><span class="repl-rs-usage-value">{totalRuns}</span><span class="repl-rs-usage-label">运行</span></div>
            <div class="repl-rs-usage-stat"><span class="repl-rs-usage-value">{completedRuns}</span><span class="repl-rs-usage-label">成功</span></div>
          </div>
          <div class="repl-rs-usage-detail">
            <div class="repl-rs-usage-detail-title">最近活动</div>
            <div class="repl-rs-usage-detail-grid">
              {sessions.slice(-5).reverse().map(s => (
                <div key={s.id} class="repl-rs-usage-session-row">
                  <span class="repl-rs-usage-session-name">{s.title || '未命名会话'}</span>
                  <span class="repl-rs-usage-session-count">{s.messages.length} 消息</span>
                </div>
              ))}
              {sessions.length === 0 && (
                <div class="repl-rs-usage-empty">暂无会话记录</div>
              )}
            </div>
          </div>
        </>
      )}

      {view === 'models' && (
        <div class="repl-rs-usage-detail">
          <div class="repl-rs-usage-detail-title">模型分布</div>
          {modelEntries.length > 0 ? (
            <div class="repl-rs-usage-model-list">
              {modelEntries.map(([model, count]) => {
                const pct = Math.round((count / totalRuns) * 100);
                return (
                  <div key={model} class="repl-rs-usage-model-row">
                    <span class="repl-rs-usage-model-name">{model}</span>
                    <div class="repl-rs-usage-model-bar-wrap">
                      <div class="repl-rs-usage-model-bar" style={{ width: `${pct}%` }} />
                    </div>
                    <span class="repl-rs-usage-model-count">{count}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div class="repl-rs-usage-empty">暂无运行记录</div>
          )}
        </div>
      )}

      {view === 'activity' && (
        <div class="repl-rs-usage-detail">
          <div class="repl-rs-usage-detail-title">24小时活动分布</div>
          <div class="repl-rs-usage-heatmap">
            {hourBuckets.map((count, i) => {
              const intensity = count / maxHour;
              return (
                <div key={i} class="repl-rs-usage-heat-cell" style={{ opacity: 0.15 + intensity * 0.85 }} title={`${i}小时前: ${count} 消息`}>
                  <span class="repl-rs-usage-heat-label">{count > 0 ? count : ''}</span>
                </div>
              );
            })}
          </div>
          <div class="repl-rs-usage-heatmap-axis">
            <span>现在</span>
            <span>12小时前</span>
            <span>24小时前</span>
          </div>
          <div class="repl-rs-usage-detail repl-rs-usage-detail-spaced">
            <div class="repl-rs-usage-detail-title">消息角色分布</div>
            <div class="repl-rs-usage-role-grid">
              <div class="repl-rs-usage-role-item">
                <span class="repl-rs-usage-role-dot user" />
                <span class="repl-rs-usage-role-label">用户</span>
                <span class="repl-rs-usage-role-value">{userMessages}</span>
              </div>
              <div class="repl-rs-usage-role-item">
                <span class="repl-rs-usage-role-dot assistant" />
                <span class="repl-rs-usage-role-label">助手</span>
                <span class="repl-rs-usage-role-value">{assistantMessages}</span>
              </div>
              <div class="repl-rs-usage-role-item">
                <span class="repl-rs-usage-role-dot system" />
                <span class="repl-rs-usage-role-label">系统</span>
                <span class="repl-rs-usage-role-value">{totalMessages - userMessages - assistantMessages}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {view === 'projects' && (
        <div class="repl-rs-usage-detail">
          <div class="repl-rs-usage-detail-title">项目分布</div>
          {projectEntries.length > 0 ? (
            <div class="repl-rs-usage-project-list">
              {projectEntries.map(([pid, stat]) => (
                <div key={pid} class="repl-rs-usage-project-row">
                  <span class="repl-rs-usage-project-name" title={pid}>{stat.name}</span>
                  <span class="repl-rs-usage-project-meta">{stat.sessions} 会话 · {stat.messages} 消息</span>
                </div>
              ))}
            </div>
          ) : (
            <div class="repl-rs-usage-empty">暂无项目记录</div>
          )}
        </div>
      )}
    </div>
  );
}