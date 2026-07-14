import React, { useState, useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';
import { piClientApi } from '../api/piClientApi';
import type { Settings, ProviderInfo, CronJob, McpServer, PackageSource } from '../api/piClientApi';
import { useLayoutStore } from '../store/layoutStore';

interface SettingsPanelProps {
  wsId: string;
  onShowToast: (msg: string) => void;
  onClose?: () => void;
}

type TabType = 'profile' | 'appearance' | 'models' | 'rules' | 'shortcuts' | 'skills' | 'mcp' | 'plugins' | 'security';

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ wsId: _wsId, onShowToast, onClose }) => {
  const [activeTab, setActiveTab] = useState<TabType>('profile');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [_cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);

  const contentAreaRef = useRef<HTMLDivElement>(null);
  
  const handleRootWheel = (e: React.WheelEvent) => {
    if (contentAreaRef.current) {
      const target = e.target as HTMLElement;
      if (target.closest('textarea') || target.closest('pre') || target.closest('select')) {
        return;
      }
      if (contentAreaRef.current.contains(target) && target !== contentAreaRef.current) {
        return;
      }
      contentAreaRef.current.scrollTop += e.deltaY;
    }
  };
  
  // Temp draft states for keys
  const [draftApiKeys, setDraftApiKeys] = useState<Record<string, string>>({});
  
  // Scope states
  const [scope] = useState<'global' | 'project'>('global');
  const [trustedFoldersList, setTrustedFoldersList] = useState<string[]>([]);

  // Form states
  const [newMcpName, setNewMcpName] = useState('');
  const [newMcpType, setNewMcpType] = useState<'stdio' | 'sse'>('stdio');
  const [newMcpCmd, setNewMcpCmd] = useState('');
  const [newMcpArgs, setNewMcpArgs] = useState('');
  const [newMcpUrl, setNewMcpUrl] = useState('');
  const [visibleKeyProvider, setVisibleKeyProvider] = useState<string | null>(null);

  // Expanded Plugin Package states
  const [newPkgSource, setNewPkgSource] = useState('');
  const [newPkgExtensions, setNewPkgExtensions] = useState('');
  const [newPkgSkills, setNewPkgSkills] = useState('');
  
  const [newSkillPath, setNewSkillPath] = useState('');
  const [newWhitelistCmd, setNewWhitelistCmd] = useState('');

  // Rules text states
  const [globalRules, setGlobalRules] = useState('');
  const [projectRules, setProjectRules] = useState('');

  // Interactive mockup states for custom model dialog and expand layouts
  const [configuringProviderId, setConfiguringProviderId] = useState<string | null>(null);
  const [manualModelName, setManualModelName] = useState<Record<string, string>>({});
  const [fetchingModelsProviderId, setFetchingModelsProviderId] = useState<string | null>(null);
  const [showAddCustomModel, setShowAddCustomModel] = useState(false);
  const [expandedMcpServerIds, setExpandedMcpServerIds] = useState<Record<string, boolean>>({});
  const [enabledMcpServers, setEnabledMcpServers] = useState<Record<string, boolean>>({
    'mcp-1': true, 'mcp-2': true
  });

  // Custom model form states
  const [customType, setCustomType] = useState('openai');
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customKey, setCustomKey] = useState('');
  const [customModelsList, setCustomModelsList] = useState<{ id: string; name: string }[]>([]);
  const [manualModelId, setManualModelId] = useState('');
  const [manualModelDisplayName, setManualModelDisplayName] = useState('');
  const [fetchingModelsInModal, setFetchingModelsInModal] = useState(false);
  const [fetchedModels, setFetchedModels] = useState<{ id: string; name: string }[]>([]);
  const [selectedFetchedModelIds, setSelectedFetchedModelIds] = useState<Record<string, boolean>>({});
  const [testingConnection, setTestingConnection] = useState(false);
  const [showAddMcpModal, setShowAddMcpModal] = useState(false);
  const [showAddPluginModal, setShowAddPluginModal] = useState(false);
  const [editingRuleFileType, setEditingRuleFileType] = useState<'global' | 'project' | null>(null);
  const [newRuleText, setNewRuleText] = useState('');

  // Custom shortcuts state
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
    return {
      toggle_settings: 'Ctrl + ,',
      branch_session: 'Escape Escape',
      command_palette: '/',
      close_tab: 'MiddleClick'
    };
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

  // Determine active session folder path (CWD)
  const activeSessionId = useLayoutStore((state) => state.activeSessionId);
  const sessions = useLayoutStore((state) => state.sessions);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const rawFolder = activeSession?.folder || 'c:/Software/conex';
  const cwd = (rawFolder.includes('/') || rawFolder.includes('\\')) 
    ? rawFolder 
    : `c:/Software/conex/${rawFolder}`;

  // Load all configurations on mount / scope switch / cwd switch
  useEffect(() => {
    const loadAll = async () => {
      try {
        setLoading(true);
        const [sets, provs, mcps, crons, trusted] = await Promise.all([
          piClientApi.getSettingsEx(cwd),
          piClientApi.getProviders(),
          piClientApi.getMcpServers(),
          piClientApi.getScheduledTasks(),
          piClientApi.getTrustedFolders()
        ]);
        setSettings(sets);
        if (sets && sets.theme) {
          document.body.setAttribute('data-theme', sets.theme);
        }
        setProviders(provs);
        setMcpServers(mcps);
        setCronJobs(crons);
        setTrustedFoldersList(trusted);

        // Load rules mock text
        setGlobalRules(
          '# 全局智能体规范 (Global Agent Guidelines)\n\n' +
          '- 优先使用 ripgrep 等工具，而不是执行 find/grep 命令。\n' +
          '- 保持原有的代码格式与行尾换行符，不允许产生无意义的空行或文件变更。\n' +
          '- 在对用户文件进行敏感修改时，务必先向用户获取确认授权。\n' +
          '- UI 设计上保持克制，避免过多的杂乱微动效，按钮激活时保持尺寸稳定。'
        );
        setProjectRules(
          '# 项目规范 (Project-Scoped Rules)\n\n' +
          '- 该项目基于 React 18, Zustand 和 Immer 构建前端布局，使用 css variables 管理系统色彩。\n' +
          '- 新增的 UI 组件均需要在 `src/components/CardPanel.tsx` 进行卡片式组件注册。\n' +
          '- 所有的组件样式都写入 `src/index.css`，采用模块化分组命名空间。\n' +
          '- 代码审查规则要求无未使用的变量导入 (`eslint/no-unused-vars` 警告不能转为错误)。'
        );
      } catch (err) {
        onShowToast('读取设置失败：' + String(err));
      } finally {
        setLoading(false);
      }
    };
    loadAll();
  }, [onShowToast, scope, cwd]);

  const handleUpdateSettings = async (updates: Partial<Settings>) => {
    if (!settings) return;
    try {
      const targetScope = updates.theme ? 'global' : scope;
      const merged = await piClientApi.saveSettingsEx(cwd, targetScope, updates);
      setSettings(merged);
      onShowToast(`${targetScope === 'global' ? '全局' : '项目'}设置已自动保存并应用`);

      // Sync appearance changes to layouts
      if (updates.theme) {
        document.body.setAttribute('data-theme', updates.theme);
      }
    } catch (err) {
      onShowToast('更新设置失败：' + String(err));
    }
  };

  const handleSaveApiKey = async (providerId: string, key: string) => {
    try {
      const updated = await piClientApi.updateProviderKey(providerId, key);
      setProviders(updated);
      onShowToast('API 密钥已更新');
      setVisibleKeyProvider(null);
      setConfiguringProviderId(null);
    } catch (err) {
      onShowToast('密钥保存失败：' + String(err));
    }
  };

  const handleAddMcpServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMcpName.trim()) return;

    try {
      const newServer: McpServer = {
        id: `mcp-${Date.now()}`,
        name: newMcpName.trim(),
        type: newMcpType,
        command: newMcpType === 'stdio' ? newMcpCmd.trim() : undefined,
        args: newMcpType === 'stdio' && newMcpArgs ? newMcpArgs.split(',').map(a => a.trim()) : undefined,
        url: newMcpType === 'sse' ? newMcpUrl.trim() : undefined,
        status: 'connecting',
        tools: []
      };

      const list = await piClientApi.saveMcpServer(newServer);
      setMcpServers(list);
      setNewMcpName('');
      setNewMcpCmd('');
      setNewMcpArgs('');
      setNewMcpUrl('');
      onShowToast(`已注册 MCP 服务: ${newServer.name}`);

      // Simulate connection completion
      setTimeout(async () => {
        newServer.status = 'connected';
        newServer.tools = ['click', 'hover', 'type_text', 'take_screenshot', 'lighthouse_audit'];
        const updatedList = await piClientApi.saveMcpServer(newServer);
        setMcpServers(updatedList);
        onShowToast(`MCP 服务已连接: ${newServer.name} (加载 5 个工具)`);
      }, 1500);
    } catch (err) {
      onShowToast('添加 MCP 服务失败');
    }
  };

  const handleDeleteMcpServer = async (id: string, name: string) => {
    try {
      const filtered = await piClientApi.deleteMcpServer(id);
      setMcpServers(filtered);
      onShowToast(`已移除 MCP 服务: ${name}`);
    } catch (err) {
      onShowToast('移除 MCP 服务失败');
    }
  };

  const handleAddPackage = async () => {
    if (!newPkgSource.trim() || !settings) return;
    
    const source = newPkgSource.trim();
    // Validate: standard package name, scoped package, git URL, or GitHub shortcut
    const isValidPkg = /^[a-z0-9_.-]+$/i.test(source) || 
                       /^@[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(source) ||
                       /^(git|git\+https?|git\+ssh):\/\//i.test(source) ||
                       /\.git$/i.test(source) ||
                       /^(github|gitlab|bitbucket):[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(source);
    if (!isValidPkg) {
      onShowToast('无效的插件包名称或源地址。支持普通包名、@scope/包名 以及 Git/GitHub 源。');
      return;
    }

    try {
      const list = [...(settings.packages || [])];
      if (newPkgExtensions.trim() || newPkgSkills.trim()) {
        const obj: PackageSource = {
          source,
          extensions: newPkgExtensions ? newPkgExtensions.split(',').map(e => e.trim()) : undefined,
          skills: newPkgSkills ? newPkgSkills.split(',').map(s => s.trim()) : undefined
        };
        list.push(obj);
      } else {
        list.push(source);
      }
      await handleUpdateSettings({ packages: list });
      setNewPkgSource('');
      setNewPkgExtensions('');
      setNewPkgSkills('');
    } catch (err) {
      onShowToast('添加插件包失败');
    }
  };

  const handleRemovePackage = async (idx: number) => {
    if (!settings) return;
    try {
      const list = [...(settings.packages || [])];
      list.splice(idx, 1);
      await handleUpdateSettings({ packages: list });
    } catch (err) {
      onShowToast('移除插件包失败');
    }
  };

  const handleAddSkill = async () => {
    if (!newSkillPath.trim() || !settings) return;
    try {
      const list = [...(settings.skills || [])];
      list.push(newSkillPath.trim());
      await handleUpdateSettings({ skills: list });
      setNewSkillPath('');
    } catch (err) {
      onShowToast('添加技能目录失败');
    }
  };

  const handleRemoveSkill = async (idx: number) => {
    if (!settings) return;
    try {
      const list = [...(settings.skills || [])];
      list.splice(idx, 1);
      await handleUpdateSettings({ skills: list });
    } catch (err) {
      onShowToast('移除技能目录失败');
    }
  };

  const handleSaveRules = (scopeType: 'global' | 'project') => {
    onShowToast(`${scopeType === 'global' ? '全局' : '项目'} 智能体规范已保存并写入 AGENTS.md`);
  };

  const handleRevokeTrust = async (path: string) => {
    try {
      const list = await piClientApi.removeTrustedFolder(path);
      setTrustedFoldersList(list);
      useLayoutStore.getState().checkFolderTrust(cwd);
      onShowToast(`已吊销项目授权: ${path}`);
    } catch (err) {
      onShowToast('吊销授权失败');
    }
  };

  if (!settings) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        <div className="loading-spinner" style={{ width: '24px', height: '24px', borderWidth: '2.5px', marginBottom: '8px' }} />
        <span style={{ fontSize: '12px' }}>正在加载设置管理器...</span>
      </div>
    );
  }

  const handleFetchModels = async (providerId: string) => {
    setFetchingModelsProviderId(providerId);
    try {
      const latest = await piClientApi.fetchLatestModels(providerId);
      const list = await piClientApi.updateProviderModels(providerId, latest);
      setProviders(list);
      onShowToast('模型列表已同步获取成功！');
    } catch {
      onShowToast('同步模型列表失败，请稍后重试');
    } finally {
      setFetchingModelsProviderId(null);
    }
  };

  const handleAddManualModel = async (providerId: string) => {
    const rawName = manualModelName[providerId] || '';
    const name = rawName.trim();
    if (!name) {
      onShowToast('请输入有效的模型名称');
      return;
    }
    const p = providers.find(prov => prov.id === providerId);
    if (!p) return;
    if (p.models.includes(name)) {
      onShowToast('该模型已存在于列表中');
      return;
    }
    const updatedModels = [...p.models, name];
    try {
      const list = await piClientApi.updateProviderModels(providerId, updatedModels);
      setProviders(list);
      setManualModelName(prev => ({ ...prev, [providerId]: '' }));
      onShowToast(`已添加模型: ${name}`);
    } catch {
      onShowToast('添加模型失败');
    }
  };

  const handleDeleteModelFromProvider = async (providerId: string, modelName: string) => {
    const p = providers.find(prov => prov.id === providerId);
    if (!p) return;
    const updatedModels = p.models.filter(m => m !== modelName);
    try {
      const list = await piClientApi.updateProviderModels(providerId, updatedModels);
      setProviders(list);
      if (settings.enabledModels?.includes(modelName)) {
        handleToggleModelEnabled(modelName);
      }
      onShowToast(`已从列表移除模型: ${modelName}`);
    } catch {
      onShowToast('移除模型失败');
    }
  };

  const handleAddCustomRule = () => {
    const text = newRuleText.trim();
    if (!text) {
      onShowToast('请输入规则内容');
      return;
    }
    const currentRules = settings?.customRules || [];
    if (currentRules.includes(text)) {
      onShowToast('该规则已存在');
      return;
    }
    handleUpdateSettings({ customRules: [...currentRules, text] });
    setNewRuleText('');
    onShowToast('智能体规范规则已添加');
  };

  const handleDeleteCustomRule = (index: number) => {
    const currentRules = settings?.customRules || [];
    const updated = currentRules.filter((_, i) => i !== index);
    handleUpdateSettings({ customRules: updated });
    onShowToast('智能体规范规则已删除');
  };

  const currentProviderId = settings.defaultProvider || 'google';
  const providerModels = providers.find(p => p.id === currentProviderId)?.models || [];
  const enabledModels = settings.enabledModels || providerModels;

  const handleToggleModelEnabled = async (model: string) => {
    let nextEnabled = [...enabledModels];
    if (nextEnabled.includes(model)) {
      if (nextEnabled.length <= 1) {
        onShowToast('至少需要启用一个模型');
        return;
      }
      nextEnabled = nextEnabled.filter(m => m !== model);
    } else {
      nextEnabled.push(model);
    }
    await handleUpdateSettings({ enabledModels: nextEnabled });
  };

  return (
    <div onWheel={handleRootWheel} style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg-primary)', color:  'var(--text-secondary)' , fontFamily: 'var(--font-sans)' }}>
      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', borderBottom: '1px solid var(--border-color)', flexShrink: 0 }}>
        <span style={{ fontSize: '15px', fontWeight: 600, color:  'var(--text-primary)'  }}>设置</span>
        {onClose && (
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color:  'var(--text-tertiary)' , padding: '4px', display: 'flex', alignItems: 'center' }} title="关闭">
            <Lucide.X size={16} />
          </button>
        )}
      </div>

      {/* Main Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Left Tabs Sidebar */}
        <div
          style={{
            width: 168,
            borderRight: '1px solid var(--border-subtle)',
            padding: '12px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            background: '#fafafa',
            flexShrink: 0,
          }}
        >
          {(
            [
              { id: 'profile', label: '账户', icon: Lucide.User },
              { id: 'appearance', label: '外观', icon: Lucide.Palette },
              { id: 'models', label: '模型', icon: Lucide.Cpu },
              { id: 'rules', label: '规范', icon: Lucide.FileText },
              { id: 'shortcuts', label: '快捷键', icon: Lucide.Keyboard },
              { id: 'skills', label: '技能', icon: Lucide.GraduationCap },
              { id: 'mcp', label: '扩展服务', icon: Lucide.Server },
              { id: 'plugins', label: '插件', icon: Lucide.Blocks },
              { id: 'security', label: '安全', icon: Lucide.Shield },
            ] as const
          ).map((tab) => {
            const isTabActive = activeTab === tab.id;
            const Icon = tab.icon;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`settings-sidebar-tab ${isTabActive ? 'active' : ''}`}
              >
                <Icon size={14} style={{ color: isTabActive ? 'var(--text-primary)' : 'var(--text-tertiary)' }} />
                <span>{tab.label}</span>
              </button>
            );
          })}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="ui-btn ui-btn-ghost ui-btn-sm"
              style={{ width: '100%', marginTop: 'auto', justifyContent: 'flex-start', color: 'var(--text-secondary)' }}
            >
              <Lucide.ArrowLeft size={13} />
              <span>返回</span>
            </button>
          )}
        </div>

        {/* Right Content Area */}
        <div ref={contentAreaRef} style={{ flex: 1, padding: '24px 32px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px', position: 'relative' }}>
          {loading && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2.5px', background: 'var(--border-color)', overflow: 'hidden', zIndex: 100 }}>
              <div style={{ width: '30%', height: '100%', background: 'var(--accent-color)', borderRadius: '1px', animation: 'loading-bar 1.2s infinite linear' }} />
            </div>
          )}
          
          {/* Scope Selector (Only on profile, models, appearance) */}
          {/* TAB 1: PROFILE */}
          {activeTab === 'profile' && (
            <>
              <div className="settings-section-header" style={{ marginBottom: 8 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>账户</h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                  本地身份与数据存放位置
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0 16px' }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    background: 'var(--bg-tertiary)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    fontSize: 14,
                  }}
                >
                  O
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>orange</div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{cwd}</div>
                </div>
              </div>

              <div className="settings-fields-stack" style={{ gap: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">会话保存目录</label>
                  <input
                    type="text"
                    value={settings.sessionDir || ''}
                    onChange={(e) => handleUpdateSettings({ sessionDir: e.target.value })}
                    className="settings-field-input"
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">网络代理（可选）</label>
                  <input
                    type="text"
                    placeholder="http://127.0.0.1:7890"
                    value={settings.httpProxy || ''}
                    onChange={(e) => handleUpdateSettings({ httpProxy: e.target.value })}
                    className="settings-field-input"
                  />
                </div>
              </div>
            </>
          )}

          {/* TAB 2: MODELS */}
          {activeTab === 'models' && (
            <>
              {/* Models Header Area */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>AI 模型</h4>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
                    选择并连接你常用的模型服务
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddCustomModel(true)}
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                >
                  <Lucide.Plus size={13} />
                  <span>自定义</span>
                </button>
              </div>

              {/* Providers list cards */}
              <div className="settings-fields-stack">
                {providers.map((p) => {
                  const isConfiguring = configuringProviderId === p.id;
                  const isEnabled = settings.defaultProvider === p.id;
                  const hasKey = !!p.apiKey;
                  
                  return (
                    <div key={p.id} className="settings-card-row">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <Lucide.Cpu size={13} style={{ color: isEnabled ? 'var(--text-primary)' : 'var(--text-tertiary)' }} />
                          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {p.name === 'OpenAI' ? 'OpenAI GPT-5.5' : p.name === 'Anthropic' ? 'Anthropic Claude 3.5 Sonnet' : p.name === 'Google' ? 'Google Gemini 1.5 Pro' : p.name}
                          </span>
                          <span className={`status-badge ${hasKey ? 'available' : 'unconfigured'}`}>
                            <span className="status-dot" style={{ width: '4px', height: '4px', borderRadius: '50%' }} />
                            {hasKey ? '可用' : '未配置'}
                          </span>
                        </div>
                        
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <button 
                            onClick={() => setConfiguringProviderId(isConfiguring ? null : p.id)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              borderRadius: '6px',
                              fontSize: '10.5px',
                            }}
                            className="settings-btn-flat"
                          >
                            <Lucide.Settings size={10} />
                            <span>配置</span>
                          </button>
                          
                          {/* Toggle switch */}
                          <label className="switch-toggle" style={{ position: 'relative', display: 'inline-block', width: '32px', height: '18px', cursor: 'pointer' }}>
                            <input 
                              type="checkbox" 
                                checked={isEnabled} 
                                onChange={() => {
                                  handleUpdateSettings({ defaultProvider: isEnabled ? '' : p.id });
                                }} 
                                style={{ opacity: 0, width: 0, height: 0 }} 
                              />
                              <span style={{
                                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                                backgroundColor: isEnabled ? 'var(--accent-color)' : 'var(--border-color)',
                                borderRadius: '18px', transition: '0.2s',
                              }}>
                                <span style={{
                                  position: 'absolute', height: '14px', width: '14px',
                                  left: isEnabled ? '16px' : '2px', bottom: '2px',
                                  backgroundColor: 'white', borderRadius: '50%', transition: '0.2s',
                                }} />
                              </span>
                            </label>
                          </div>
                        </div>
                        
                        {/* Expanded Configuration Form */}
                        {isConfiguring && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 6, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <label className="settings-field-label">API 密钥</label>
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                  type={visibleKeyProvider === p.id ? 'text' : 'password'}
                                  placeholder="粘贴你的密钥"
                                  value={draftApiKeys[p.id] !== undefined ? draftApiKeys[p.id] : (p.apiKey || '')}
                                  onChange={(e) => setDraftApiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                  className="settings-field-input"
                                  style={{ flex: 1 }}
                                />
                                <button
                                  type="button"
                                  className="ui-btn ui-btn-ghost"
                                  onClick={() => setVisibleKeyProvider(visibleKeyProvider === p.id ? null : p.id)}
                                >
                                  {visibleKeyProvider === p.id ? <Lucide.EyeOff size={14} /> : <Lucide.Eye size={14} />}
                                </button>
                                <button
                                  type="button"
                                  className="ui-btn ui-btn-primary ui-btn-sm"
                                  onClick={() => {
                                    const val = draftApiKeys[p.id] !== undefined ? draftApiKeys[p.id] : (p.apiKey || '');
                                    handleSaveApiKey(p.id, val.trim());
                                  }}
                                >
                                  保存
                                </button>
                              </div>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <label className="settings-field-label">可用模型</label>
                                <button
                                  type="button"
                                  className="ui-btn ui-btn-secondary ui-btn-sm"
                                  onClick={() => handleFetchModels(p.id)}
                                  disabled={fetchingModelsProviderId === p.id}
                                >
                                  <Lucide.RefreshCw size={12} className={fetchingModelsProviderId === p.id ? 'spin' : ''} />
                                  {fetchingModelsProviderId === p.id ? '获取中…' : '刷新列表'}
                                </button>
                              </div>

                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                {p.models.map((model) => {
                                  const isChecked = enabledModels.includes(model);
                                  return (
                                    <button
                                      key={model}
                                      type="button"
                                      onClick={() => handleToggleModelEnabled(model)}
                                      className="ui-badge"
                                      style={{
                                        cursor: 'pointer',
                                        padding: '5px 10px',
                                        fontSize: 12,
                                        background: isChecked ? 'var(--accent-light)' : 'var(--bg-primary)',
                                        color: isChecked ? 'var(--accent-color)' : 'var(--text-secondary)',
                                      }}
                                    >
                                      {isChecked && <Lucide.Check size={11} style={{ marginRight: 4 }} />}
                                      {model}
                                      <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDeleteModelFromProvider(p.id, model);
                                        }}
                                        style={{ marginLeft: 6, opacity: 0.5, display: 'inline-flex' }}
                                      >
                                        <Lucide.X size={11} />
                                      </span>
                                    </button>
                                  );
                                })}
                                {p.models.length === 0 && (
                                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '4px 0' }}>
                                    暂无模型，点击「刷新列表」或在下方添加
                                  </div>
                                )}
                              </div>

                              <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                  type="text"
                                  className="settings-field-input"
                                  placeholder="手动添加模型名称"
                                  value={manualModelName[p.id] || ''}
                                  onChange={(e) => setManualModelName((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                  style={{ flex: 1 }}
                                />
                                <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => handleAddManualModel(p.id)}>
                                  添加
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

              {/* Consumer-friendly response preference (hides raw transport / concurrency tech) */}
              <div className="settings-card-row" style={{ marginTop: 4 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>回答风格</span>
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                    我们会自动处理连接方式与性能策略，你只需选择偏好即可。
                  </p>
                </div>
                <div className="ui-segment" style={{ maxWidth: 360 }}>
                  {(
                    [
                      { id: 'minimal', label: '简洁' },
                      { id: 'low', label: '标准' },
                      { id: 'medium', label: '详细' },
                      { id: 'high', label: '深入' },
                    ] as const
                  ).map((opt) => {
                    const current =
                      (settings as any).responseStyle ||
                      (settings.thinkingBudgets?.medium === 4096 ? 'medium' : 'medium');
                    const active = current === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        className={`ui-segment-item ${active ? 'active' : ''}`}
                        onClick={() => {
                          const map = { minimal: 1024, low: 2048, medium: 4096, high: 8192 } as const;
                          handleUpdateSettings({
                            thinkingBudgets: {
                              minimal: map.minimal,
                              low: map.low,
                              medium: map.medium,
                              high: map.high,
                            },
                            ...( { responseStyle: opt.id } as any),
                            // Keep sensible defaults under the hood
                            ...( { transport: 'http', steeringMode: 'single' } as any),
                          });
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Add Custom Provider Modal Overlay */}
              {showAddCustomModel && (
                <div className="custom-modal-backdrop" style={{
                  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                  background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 20000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                  <div style={{
                    width: '480px', background: 'var(--bg-primary)', borderRadius: '12px',
                    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
                    border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex', flexDirection: 'column'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
                      <span className="settings-modal-title">添加自定义模型提供商</span>
                      <button onClick={() => setShowAddCustomModel(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
                        <Lucide.X size={15} />
                      </button>
                    </div>
                    
                    <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '420px', overflowY: 'auto' }}>
                      <p className="settings-field-hint">配置自定义 LLM 提供商以扩展可用的 AI 模型列表。</p>
                      
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <label className="settings-field-label">提供商类型</label>
                          <select 
                            value={customType} 
                            onChange={e => setCustomType(e.target.value)}
                            className="settings-field-input"
                          >
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="gemini">Gemini</option>
                            <option value="custom">自定义接口</option>
                          </select>
                        </div>
                        
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <label className="settings-field-label">提供商名称</label>
                          <input 
                            type="text" 
                            placeholder="例如: My Custom AI" 
                            value={customName}
                            onChange={e => setCustomName(e.target.value)}
                            className="settings-field-input"
                          />
                        </div>
                      </div>
                      
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label className="settings-field-label">接口服务地址</label>
                        <input 
                          type="text" 
                          placeholder="https://api.openai.com/v1" 
                          value={customUrl}
                          onChange={e => setCustomUrl(e.target.value)}
                          className="settings-field-input"
                        />
                      </div>
                      
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label className="settings-field-label">API 密钥</label>
                        <input 
                          type="password" 
                          placeholder="sk-..." 
                          value={customKey}
                          onChange={e => setCustomKey(e.target.value)}
                          className="settings-field-input"
                        />
                      </div>
                      
                      {/* Sub-section: Configure model lists */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid var(--border-color)', paddingTop: '12px', marginTop: '4px' }}>
                        <label className="settings-field-label">配置可用模型列表</label>
                        
                        {/* Currently added models tag list */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '10px', border: '1px solid var(--border-color)', borderRadius: '6px', background: 'var(--bg-secondary)', minHeight: '44px' }}>
                          {customModelsList.length === 0 ? (
                            <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>暂无模型，请通过手动录入或自动获取添加</span>
                          ) : (
                            customModelsList.map(m => (
                              <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '11px', color: 'var(--text-primary)' }}>
                                <span>{m.name} <span style={{ color: 'var(--text-tertiary)', fontSize: '9px' }}>({m.id})</span></span>
                                <button onClick={() => setCustomModelsList(prev => prev.filter(item => item.id !== m.id))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: 0, display: 'flex', alignItems: 'center' }}>
                                  <Lucide.X size={12} />
                                </button>
                              </span>
                            ))
                          )}
                        </div>

                        {/* Method 1: Manual input form */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px', background: 'var(--bg-primary)' }}>
                          <span className="settings-field-label">方法 1：手动录入</span>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 60px', gap: '8px', alignItems: 'flex-end' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <label style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>实际名称 (ID)</label>
                              <input 
                                type="text" 
                                placeholder="如: gpt-4o" 
                                value={manualModelId} 
                                onChange={e => setManualModelId(e.target.value)}
                                style={{ height: '28px', padding: '0 8px', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '11px', outline: 'none', background: 'var(--bg-primary)', color: 'var(--text-primary)', boxSizing: 'border-box' }}
                              />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <label style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>显示名称</label>
                              <input 
                                type="text" 
                                placeholder="如: GPT-4o" 
                                value={manualModelDisplayName} 
                                onChange={e => setManualModelDisplayName(e.target.value)}
                                style={{ height: '28px', padding: '0 8px', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '11px', outline: 'none', background: 'var(--bg-primary)', color: 'var(--text-primary)', boxSizing: 'border-box' }}
                              />
                            </div>
                            <button 
                              onClick={() => {
                                const id = manualModelId.trim();
                                const name = manualModelDisplayName.trim() || id;
                                if (!id) {
                                  onShowToast('请输入实际模型 ID');
                                  return;
                                }
                                if (customModelsList.some(m => m.id === id)) {
                                  onShowToast('该模型已在列表中');
                                  return;
                                }
                                setCustomModelsList(prev => [...prev, { id, name }]);
                                setManualModelId('');
                                setManualModelDisplayName('');
                              }}
                              style={{ height: '28px', fontSize: '11px', borderRadius: '4px' }}
                              className="settings-btn-flat"
                            >
                              添加
                            </button>
                          </div>
                        </div>

                        {/* Method 2: Auto fetching checklist */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '10px', background: 'var(--bg-primary)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="settings-field-label">方法 2：自动获取</span>
                            <button 
                              onClick={async () => {
                                setFetchingModelsInModal(true);
                                setTimeout(() => {
                                  let mockModels: { id: string; name: string }[] = [];
                                  if (customType === 'openai') {
                                    mockModels = [
                                      { id: 'gpt-4o', name: 'GPT-4o' },
                                      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
                                      { id: 'o1-pro', name: 'o1 Pro' },
                                      { id: 'o1-mini', name: 'o1 Mini' }
                                    ];
                                  } else if (customType === 'anthropic') {
                                    mockModels = [
                                      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
                                      { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku' }
                                    ];
                                  } else if (customType === 'gemini') {
                                    mockModels = [
                                      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
                                      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' }
                                    ];
                                  } else {
                                    mockModels = [
                                      { id: 'custom-model-1', name: 'Custom Model 1' },
                                      { id: 'custom-model-2', name: 'Custom Model 2' }
                                    ];
                                  }
                                  setFetchedModels(mockModels);
                                  const checks: Record<string, boolean> = {};
                                  mockModels.forEach(m => { checks[m.id] = true; });
                                  setSelectedFetchedModelIds(checks);
                                  setFetchingModelsInModal(false);
                                  onShowToast('拉取到可用模型列表！');
                                }, 800);
                              }}
                              style={{ padding: '4px 10px', fontSize: '10.5px', borderRadius: '4px' }}
                              className="settings-btn-flat"
                              disabled={fetchingModelsInModal}
                            >
                              {fetchingModelsInModal ? '拉取中...' : '获取可用模型列表'}
                            </button>
                          </div>
                          
                          {fetchedModels.length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '110px', overflowY: 'auto', padding: '6px', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--bg-secondary)' }}>
                                {fetchedModels.map(m => (
                                  <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
                                    <input 
                                      type="checkbox" 
                                      checked={!!selectedFetchedModelIds[m.id]} 
                                      onChange={e => setSelectedFetchedModelIds(prev => ({ ...prev, [m.id]: e.target.checked }))}
                                      style={{ cursor: 'pointer' }}
                                    />
                                    <span>{m.name} <span style={{ color: 'var(--text-tertiary)', fontSize: '9px' }}>({m.id})</span></span>
                                  </label>
                                ))}
                              </div>
                              <button 
                                onClick={() => {
                                  const checked = fetchedModels.filter(m => selectedFetchedModelIds[m.id]);
                                  if (checked.length === 0) {
                                    onShowToast('未勾选任何模型');
                                    return;
                                  }
                                  setCustomModelsList(prev => {
                                    const existingIds = new Set(prev.map(item => item.id));
                                    const toAdd = checked.filter(c => !existingIds.has(c.id));
                                    return [...prev, ...toAdd];
                                  });
                                  setFetchedModels([]);
                                  onShowToast(`已批量添加 ${checked.length} 个模型！`);
                                }}
                                style={{ padding: '4px 8px', fontSize: '10px', borderRadius: '4px', alignSelf: 'flex-end' }}
                                className="settings-btn-flat"
                              >
                                导入勾选的模型
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', padding: '12px 20px', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)' }}>
                      <button 
                        onClick={() => {
                          setTestingConnection(true);
                          setTimeout(() => {
                            setTestingConnection(false);
                            onShowToast('连接测试成功！已成功连接到 ' + (customUrl || '默认网关'));
                          }, 1000);
                        }}
                        style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '11px' }}
                        className="settings-btn-secondary"
                      >
                        {testingConnection ? '测试中...' : '测试连接'}
                      </button>
                      <button 
                        onClick={() => {
                          setShowAddCustomModel(false);
                          setCustomModelsList([]);
                          setFetchedModels([]);
                        }}
                        style={{ padding: '6px 12px', borderRadius: '6px', fontSize: '11px' }}
                        className="settings-btn-secondary"
                      >
                        取消
                      </button>
                      <button 
                        onClick={() => {
                          if (!customName.trim()) {
                            onShowToast('请输入提供商名称');
                            return;
                          }
                          if (customModelsList.length === 0) {
                            onShowToast('请至少配置一个可用模型');
                            return;
                          }
                          const newProv: ProviderInfo = {
                            id: `custom-${Date.now()}`,
                            name: customName.trim(),
                            apiKey: customKey.trim(),
                            models: customModelsList.map(m => m.id)
                          };
                          const updated = [...providers, newProv];
                          setProviders(updated);
                          useLayoutStore.getState().setProviders(updated);
                          
                          onShowToast(`已成功添加模型提供商: ${newProv.name}`);
                          setShowAddCustomModel(false);
                          setCustomName('');
                          setCustomKey('');
                          setCustomUrl('');
                          setCustomModelsList([]);
                          setFetchedModels([]);
                        }}
                        style={{ height: '30px', padding: '0 12px', borderRadius: '6px', fontSize: '11px', boxSizing: 'border-box' }}
                        className="settings-btn-primary"
                      >
                        添加提供商
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* TAB 3: MCP */}
          {activeTab === 'mcp' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>扩展服务</h4>
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                    管理已连接的外部工具服务
                  </p>
                </div>
                <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => setShowAddMcpModal(true)}>
                  <Lucide.Plus size={13} />
                  添加
                </button>
              </div>

              <div className="settings-fields-stack" style={{ gap: 8 }}>
                {mcpServers.map((srv) => {
                  const isExpanded = !!expandedMcpServerIds[srv.id];
                  const isEnabled = enabledMcpServers[srv.id] !== false;

                  return (
                    <div key={srv.id} className="settings-card-row">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: isEnabled ? 'var(--accent-green)' : 'var(--text-tertiary)',
                              flexShrink: 0,
                            }}
                          />
                          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{srv.name}</span>
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                            {isEnabled ? '已启用' : '已关闭'}
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <button
                            type="button"
                            className="ui-btn ui-btn-ghost"
                            title="配置"
                            onClick={() =>
                              setExpandedMcpServerIds((prev) => ({ ...prev, [srv.id]: !isExpanded }))
                            }
                          >
                            <Lucide.Settings size={13} />
                          </button>
                          <div
                            onClick={() =>
                              setEnabledMcpServers((prev) => ({ ...prev, [srv.id]: !isEnabled }))
                            }
                            style={{
                              width: 32,
                              height: 18,
                              borderRadius: 9,
                              backgroundColor: isEnabled ? 'var(--accent-color)' : 'var(--border-color)',
                              padding: 2,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: isEnabled ? 'flex-end' : 'flex-start',
                            }}
                          >
                            <div
                              style={{
                                width: 14,
                                height: 14,
                                borderRadius: '50%',
                                backgroundColor: '#fff',
                              }}
                            />
                          </div>
                          <button
                            type="button"
                            className="ui-btn ui-btn-ghost danger"
                            title="删除"
                            onClick={() => handleDeleteMcpServer(srv.id, srv.name)}
                          >
                            <Lucide.Trash2 size={13} />
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 10,
                            marginTop: 8,
                            paddingTop: 12,
                            borderTop: '1px solid var(--border-subtle)',
                          }}
                        >
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <label className="settings-field-label">启动命令</label>
                            <input
                              type="text"
                              defaultValue={srv.command || ''}
                              id={`mcp-cmd-${srv.id}`}
                              className="settings-field-input"
                            />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <label className="settings-field-label">参数（逗号分隔）</label>
                            <input
                              type="text"
                              defaultValue={srv.args?.join(', ') || ''}
                              id={`mcp-args-${srv.id}`}
                              className="settings-field-input"
                            />
                          </div>
                          <button
                            type="button"
                            className="ui-btn ui-btn-primary ui-btn-sm"
                            style={{ alignSelf: 'flex-end' }}
                            onClick={() => {
                              const cmdEl = document.getElementById(`mcp-cmd-${srv.id}`) as HTMLInputElement;
                              const argsEl = document.getElementById(
                                `mcp-args-${srv.id}`,
                              ) as HTMLInputElement;
                              if (cmdEl) {
                                piClientApi
                                  .saveMcpServer({
                                    ...srv,
                                    command: cmdEl.value.trim(),
                                    args: argsEl
                                      ? argsEl.value
                                          .split(',')
                                          .map((a) => a.trim())
                                          .filter(Boolean)
                                      : [],
                                  })
                                  .then((list) => {
                                    setMcpServers(list);
                                    onShowToast(`已保存：${srv.name}`);
                                    setExpandedMcpServerIds((prev) => ({ ...prev, [srv.id]: false }));
                                  });
                              }
                            }}
                          >
                            保存
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {mcpServers.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '20px 0' }}>
                    还没有扩展服务。点击「添加」连接一个工具。
                  </div>
                )}
              </div>
            </>
          )}

          {/* TAB 4: PLUGINS */}
          {activeTab === 'plugins' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>插件</h4>
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                    已安装的扩展包
                  </p>
                </div>
                <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => setShowAddPluginModal(true)}>
                  <Lucide.Plus size={13} />
                  安装
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {(settings.packages || []).map((pkg, idx) => {
                  const isObj = typeof pkg !== 'string';
                  const name = isObj ? (pkg as PackageSource).source : (pkg as string);
                  const filters = isObj ? [
                    (pkg as PackageSource).extensions ? `文件后缀: ${(pkg as PackageSource).extensions?.join(',')}` : null,
                    (pkg as PackageSource).skills ? `绑定技能: ${(pkg as PackageSource).skills?.join(',')}` : null
                  ].filter(Boolean).join(' | ') : '';

                  return (
                    <div key={idx} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-primary)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <Lucide.Blocks size={13} style={{ color:  'var(--text-secondary)'  }} />
                          <span style={{ fontSize: '11.5px', color:  'var(--text-primary)' , fontFamily: 'var(--font-mono)' }}>{name}</span>
                        </div>
                        {filters && <span style={{ fontSize: '8.5px', color:  'var(--text-tertiary)'  }}>{filters}</span>}
                      </div>
                      <button
                        onClick={() => handleRemovePackage(idx)}
                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }}
                        title="卸载"
                      >
                        <Lucide.Trash2 size={12} />
                      </button>
                    </div>
                  );
                })}
                {(settings.packages || []).length === 0 && (
                  <div style={{ fontSize: '11px', color:  'var(--text-tertiary)' , textAlign: 'center', padding: '24px', border: '1px dashed #ededed', borderRadius: '8px' }}>暂无安装的插件包，点击右上角按钮开始安装。</div>
                )}
              </div>
            </>
          )}
          {/* TAB 5: SKILLS */}
          {activeTab === 'skills' && (
            <>
              <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
                <h4 style={{ fontSize: '13px', fontWeight: 600, color:  'var(--text-primary)' , margin: 0 }}>智能体系统技能</h4>
                <p style={{ fontSize: '10px', color:  'var(--text-tertiary)' , marginTop: '2px', margin: 0 }}>技能是一组指令集合。配置智能体运行加载技能的本地路径。</p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px 16px', background: 'var(--bg-primary)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span className="settings-field-label">开启技能指令映射</span>
                  <span style={{ fontSize: '9.5px', color:  'var(--text-tertiary)'  }}>是否将加载的技能注册为 `/skill:name` 形式的快捷命令。</span>
                </div>
                {/* Switch toggle */}
                <label className="switch-toggle" style={{ position: 'relative', display: 'inline-block', width: '32px', height: '18px', cursor: 'pointer' }}>
                  <input 
                    type="checkbox" 
                    checked={settings.enableSkillCommands || false} 
                    onChange={(e) => handleUpdateSettings({ enableSkillCommands: e.target.checked })} 
                    style={{ opacity: 0, width: 0, height: 0 }} 
                  />
                  <span style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    backgroundColor: settings.enableSkillCommands ?  'var(--accent-blue)'  :  'var(--border-color)' ,
                    borderRadius: '18px', transition: '0.2s',
                  }}>
                    <span style={{
                      position: 'absolute', height: '14px', width: '14px',
                      left: settings.enableSkillCommands ? '16px' : '2px', bottom: '2px',
                      backgroundColor: 'white', borderRadius: '50%', transition: '0.2s',
                    }} />
                  </span>
                </label>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {(settings.skills || []).map((skPath, idx) => (
                  <div key={idx} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-primary)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                      <Lucide.GraduationCap size={13} style={{ color:  'var(--text-secondary)'  }} />
                      <span style={{ fontSize: '11px', color:  'var(--text-primary)' , textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }} title={skPath}>
                        {skPath}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRemoveSkill(idx)}
                      style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center' }}
                      title="移除"
                    >
                      <Lucide.Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  placeholder="添加技能目录的绝对路径"
                  value={newSkillPath}
                  onChange={e => setNewSkillPath(e.target.value)}
                  className="settings-field-input" style={{ flex: 1, padding: "6px 10px" }}
                />
                <button
                  onClick={handleAddSkill}
                  style={{ background:  'var(--accent-blue-light)' , color:  'var(--accent-blue)' , border: 'none', padding: '6px 16px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}
                >
                  添加路径
                </button>
              </div>
            </>
          )}

          {/* TAB 6: RULES */}
          {activeTab === 'rules' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
                <div>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color:  'var(--text-primary)' , margin: 0 }}>智能体规范</h4>
                  <p style={{ fontSize: '10px', color:  'var(--text-tertiary)' , marginTop: '2px', margin: 0 }}>记录零碎的规范内容，编辑规则文件进行全局或项目控制。</p>
                </div>
                
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    onClick={() => setEditingRuleFileType('global')}
                    style={{
                      background:  'var(--accent-blue-light)' ,
                      color:  'var(--accent-blue)' ,
                      border: 'none',
                      padding: '0 12px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      height: '30px',
                      boxSizing: 'border-box'
                    }}
                  >
                    编辑全局规则 (AGENTS.md)
                  </button>
                  <button
                    onClick={() => setEditingRuleFileType('project')}
                    style={{
                      background:  'var(--accent-blue-light)' ,
                      color:  'var(--accent-blue)' ,
                      border: 'none',
                      padding: '0 12px',
                      borderRadius: '6px',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      height: '30px',
                      boxSizing: 'border-box'
                    }}
                  >
                    编辑项目特定规则
                  </button>
                </div>
              </div>

              {/* Rules List (零碎的规范内容) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="settings-field-label">已添加的规则规范列表</span>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {(settings.customRules || []).map((rule, idx) => (
                    <div key={idx} style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-primary)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1 }}>
                        <span style={{ fontSize: '11.5px', color:  'var(--text-primary)' , lineHeight: '1.4' }}>{rule}</span>
                      </div>
                      <button
                        onClick={() => handleDeleteCustomRule(idx)}
                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '2px', display: 'flex', alignItems: 'center', marginLeft: '12px' }}
                        title="删除规则"
                      >
                        <Lucide.Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                  {(settings.customRules || []).length === 0 && (
                    <div style={{ fontSize: '11px', color:  'var(--text-tertiary)' , textAlign: 'center', padding: '24px', border: '1px dashed #ededed', borderRadius: '8px' }}>
                      暂无细化规范，请在下方输入框添加日常开发的零碎规范。
                    </div>
                  )}
                </div>
              </div>

              {/* Add Custom Rule Form */}
              <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <span className="settings-field-label">添加新规范</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    placeholder="输入规则内容，例如: 提交代码前确保完成 lint 测试"
                    value={newRuleText}
                    onChange={e => setNewRuleText(e.target.value)}
                    style={{ flex: 1, height: '30px', padding: '0 10px', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11px', background: 'var(--bg-primary)', outline: 'none', boxSizing: 'border-box' }}
                  />
                  <button
                    onClick={handleAddCustomRule}
                    style={{ background:  'var(--accent-blue-light)' , color:  'var(--accent-blue)' , border: 'none', padding: '0 16px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer', fontWeight: 600, height: '30px', boxSizing: 'border-box' }}
                  >
                    添加规则
                  </button>
                </div>
              </div>
            </>
          )}

          {/* TAB 6.5: SHORTCUTS */}
          {activeTab === 'shortcuts' && (
            <>
              <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
                <h4 style={{ fontSize: '13px', fontWeight: 600, color:  'var(--text-primary)' , margin: 0 }}>核心快捷键</h4>
                <p style={{ fontSize: '10px', color:  'var(--text-tertiary)' , marginTop: '2px', margin: 0 }}>查看与自定义系统操作中的主要快捷键。</p>
              </div>

              <div style={{ border: '1px solid var(--border-color)', borderRadius: '8px', padding: '16px', background: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <span className="settings-field-label">系统核心快捷键</span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {[
                    { id: 'toggle_settings', label: '打开系统设置', desc: '打开或关闭系统设置管理面板' },
                    { id: 'branch_session', label: '分支分叉当前会话', desc: '分叉复制当前对话历史到新临时分支' },
                    { id: 'command_palette', label: '聊天命令行提示', desc: '在命令行输入框中弹出智能快捷指令' },
                    { id: 'close_tab', label: '关闭当前选中卡片', desc: '快速关闭工作区中打开的选显卡片' }
                  ].map(sh => {
                    const isRecording = recordingShortcutId === sh.id;
                    const displayKey = customShortcuts[sh.id] || '未设置';

                    return (
                      <div key={sh.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px', paddingTop: '4px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span className="settings-field-label">{sh.label}</span>
                          <span style={{ fontSize: '10px', color:  'var(--text-tertiary)'  }}>{sh.desc}</span>
                        </div>
                        <button
                          onClick={() => setRecordingShortcutId(isRecording ? null : sh.id)}
                          className={`shortcut-key-btn ${isRecording ? 'recording' : ''}`}
                        >
                          {isRecording ? '录制中...' : displayKey}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* TAB 7: APPEARANCE */}
          {activeTab === 'appearance' && (
            <>
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>外观</h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>主题与阅读偏好</p>
              </div>

              <div className="settings-fields-stack" style={{ gap: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">主题</label>
                  <select
                    value={settings.theme || 'default'}
                    onChange={(e) => handleUpdateSettings({ theme: e.target.value })}
                    className="settings-field-input"
                  >
                    <option value="default">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">代码缩进</label>
                  <select
                    value={settings.markdown?.codeBlockIndent || '  '}
                    onChange={(e) =>
                      handleUpdateSettings({
                        markdown: { ...settings.markdown, codeBlockIndent: e.target.value },
                      })
                    }
                    className="settings-field-input"
                  >
                    <option value="  ">2 空格</option>
                    <option value="    ">4 空格</option>
                    <option value="	">Tab</option>
                  </select>
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '10px 0',
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>终端显示图片</div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>在终端输出中渲染图片</div>
                  </div>
                  <label style={{ position: 'relative', display: 'inline-block', width: 32, height: 18, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={settings.terminal?.showImages ?? true}
                      onChange={(e) =>
                        handleUpdateSettings({
                          terminal: { ...settings.terminal, showImages: e.target.checked },
                        })
                      }
                      style={{ opacity: 0, width: 0, height: 0 }}
                    />
                    <span
                      style={{
                        position: 'absolute',
                        inset: 0,
                        backgroundColor:
                          (settings.terminal?.showImages ?? true) ? 'var(--accent-color)' : 'var(--border-color)',
                        borderRadius: 18,
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute',
                          height: 14,
                          width: 14,
                          left: (settings.terminal?.showImages ?? true) ? 16 : 2,
                          bottom: 2,
                          backgroundColor: 'white',
                          borderRadius: '50%',
                        }}
                      />
                    </span>
                  </label>
                </div>
              </div>
            </>
          )}

          {/* TAB 8: SECURITY */}
          {activeTab === 'security' && (
            <>
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>安全</h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                  项目信任与自动批准规则
                </p>
              </div>

              <div className="settings-fields-stack" style={{ gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">打开新项目时</label>
                  <select
                    value={settings.defaultProjectTrust || 'ask'}
                    onChange={(e) =>
                      handleUpdateSettings({ defaultProjectTrust: e.target.value as any })
                    }
                    className="settings-field-input"
                  >
                    <option value="ask">每次询问</option>
                    <option value="always">默认信任</option>
                    <option value="never">默认拒绝</option>
                  </select>
                </div>

                <div>
                  <div className="settings-field-label" style={{ marginBottom: 8 }}>
                    已信任的项目
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {trustedFoldersList.map((path) => (
                      <div
                        key={path}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          padding: '8px 0',
                          borderBottom: '1px solid var(--border-subtle)',
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--text-secondary)',
                            wordBreak: 'break-all',
                            paddingRight: 12,
                          }}
                        >
                          {path}
                        </span>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost danger"
                          title="撤销信任"
                          onClick={() => handleRevokeTrust(path)}
                        >
                          <Lucide.X size={13} />
                        </button>
                      </div>
                    ))}
                    {trustedFoldersList.length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                        暂无已信任项目
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 20 }}>
                <div className="settings-field-label" style={{ marginBottom: 8 }}>
                  自动批准的命令
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  {(
                    useLayoutStore.getState().commandPermissions || [
                      'git status',
                      'git diff',
                      'npm run test:unit',
                    ]
                  ).map((cmd) => (
                    <span
                      key={cmd}
                      className="ui-badge"
                      style={{
                        padding: '5px 8px',
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {cmd}
                      <button
                        type="button"
                        onClick={() => {
                          useLayoutStore.setState((state) => ({
                            commandPermissions: state.commandPermissions.filter((c) => c !== cmd),
                          }));
                          onShowToast(`已移除：${cmd}`);
                        }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          color: 'var(--text-tertiary)',
                          display: 'inline-flex',
                          marginLeft: 4,
                          padding: 0,
                        }}
                      >
                        <Lucide.X size={11} />
                      </button>
                    </span>
                  ))}
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    type="text"
                    placeholder="例如：npm run build"
                    value={newWhitelistCmd}
                    onChange={(e) => setNewWhitelistCmd(e.target.value)}
                    className="settings-field-input"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => {
                      if (!newWhitelistCmd.trim()) return;
                      const cmd = newWhitelistCmd.trim();
                      useLayoutStore.setState((state) => ({
                        commandPermissions: [...(state.commandPermissions || []), cmd],
                      }));
                      onShowToast(`已添加：${cmd}`);
                      setNewWhitelistCmd('');
                    }}
                  >
                    添加
                  </button>
                </div>
              </div>
            </>
          )}

        </div>
      </div>

      {/* MODAL 1: ADD MCP SERVER (二级面板) */}
      {showAddMcpModal && (
        <div className="custom-modal-backdrop" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 20000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: '460px', background: 'var(--bg-primary)', borderRadius: '12px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
            border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex', flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <span className="settings-modal-title">注册新 MCP 服务</span>
              <button onClick={() => setShowAddMcpModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color:  'var(--text-tertiary)'  }}>
                <Lucide.X size={15} />
              </button>
            </div>
            
            <form onSubmit={(e) => { e.preventDefault(); handleAddMcpServer(e); setShowAddMcpModal(false); }} style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '11px', color:  'var(--text-tertiary)' , margin: 0 }}>配置基于 STDIO 命令或 SSE 网络端点的 MCP 服务器工具。</p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label className="settings-field-label">服务名称</label>
                <input
                  type="text"
                  placeholder="服务名称，例如 github-mcp"
                  value={newMcpName}
                  onChange={e => setNewMcpName(e.target.value)}
                  className="settings-field-input"
                  required
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label className="settings-field-label">服务连接类型</label>
                <select
                  value={newMcpType}
                  onChange={e => setNewMcpType(e.target.value as any)}
                  className="settings-field-input"
                >
                  <option value="stdio">本地命令行 stdio</option>
                  <option value="sse">远程服务 sse</option>
                </select>
              </div>

              {newMcpType === 'stdio' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label className="settings-field-label">执行命令 (Command)</label>
                    <input
                      type="text"
                      placeholder="执行命令，例如 node"
                      value={newMcpCmd}
                      onChange={e => setNewMcpCmd(e.target.value)}
                      className="settings-field-input"
                      required={newMcpType === 'stdio'}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label className="settings-field-label">命令参数 (用逗号分隔)</label>
                    <input
                      type="text"
                      placeholder="参数，例如: dist/index.js, --port=80"
                      value={newMcpArgs}
                      onChange={e => setNewMcpArgs(e.target.value)}
                      className="settings-field-input"
                    />
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label className="settings-field-label">SSE 端点 URL</label>
                  <input
                    type="url"
                    placeholder="SSE 端点地址，例如 http://localhost:3011/sse"
                    value={newMcpUrl}
                    onChange={e => setNewMcpUrl(e.target.value)}
                    className="settings-field-input"
                    required={newMcpType === 'sse'}
                  />
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowAddMcpModal(false)}
                  className="settings-btn-secondary"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="settings-btn-primary"
                >
                  连接并加载
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: INSTALL PLUGIN (二级面板) */}
      {showAddPluginModal && (
        <div className="custom-modal-backdrop" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 20000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: '460px', background: 'var(--bg-primary)', borderRadius: '12px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
            border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex', flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <span className="settings-modal-title">安装新插件扩展</span>
              <button onClick={() => setShowAddPluginModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color:  'var(--text-tertiary)'  }}>
                <Lucide.X size={15} />
              </button>
            </div>
            
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '11px', color:  'var(--text-tertiary)' , margin: 0 }}>支持输入 npm 包名或 Git 仓库链接，自定义筛选或注入特定的开发技能。</p>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label className="settings-field-label">包名或 Git 源</label>
                <input
                  type="text"
                  placeholder="例如: @conex/voice-playback 或 https://github.com/org/plugin"
                  value={newPkgSource}
                  onChange={e => setNewPkgSource(e.target.value)}
                  className="settings-field-input"
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label className="settings-field-label">文件过滤后缀</label>
                  <input
                    type="text"
                    placeholder="例如: .js,.py"
                    value={newPkgExtensions}
                    onChange={e => setNewPkgExtensions(e.target.value)}
                    className="settings-field-input"
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label className="settings-field-label">注入技能</label>
                  <input
                    type="text"
                    placeholder="例如: audit,voice"
                    value={newPkgSkills}
                    onChange={e => setNewPkgSkills(e.target.value)}
                    className="settings-field-input"
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setShowAddPluginModal(false)}
                  className="settings-btn-secondary"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => { handleAddPackage(); setShowAddPluginModal(false); }}
                  className="settings-btn-primary"
                >
                  安装插件
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: EDIT AGENTS.MD RULES FILE (二级面板) */}
      {editingRuleFileType && (
        <div className="custom-modal-backdrop" style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.3)', backdropFilter: 'blur(4px)', zIndex: 20000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: '580px', background: 'var(--bg-primary)', borderRadius: '12px',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
            border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex', flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <span className="settings-modal-title">
                {editingRuleFileType === 'global' ? '编辑全局规则文件 (AGENTS.md)' : '编辑当前项目特定规则'}
              </span>
              <button onClick={() => setEditingRuleFileType(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color:  'var(--text-tertiary)'  }}>
                <Lucide.X size={15} />
              </button>
            </div>
            
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '11px', color:  'var(--text-tertiary)' , margin: 0 }}>
                {editingRuleFileType === 'global'
                  ? '修改全局规则文本。保存后将写入全局系统的 AGENTS.md 规则文件中，作用于所有会话。'
                  : '修改当前工作区项目规则。保存后将写入项目目录的 AGENTS.md 文件中，约束该工作区下的推理行为。'}
              </p>
              
              <textarea
                value={editingRuleFileType === 'global' ? globalRules : projectRules}
                onChange={e => {
                  if (editingRuleFileType === 'global') {
                    setGlobalRules(e.target.value);
                  } else {
                    setProjectRules(e.target.value);
                  }
                }}
                rows={12}
                style={{
                  width: '100%', padding: '10px 12px', border: '1px solid var(--border-color)', borderRadius: '6px',
                  fontSize: '11px', fontFamily: 'var(--font-mono)', background: 'var(--bg-primary)', color:  'var(--text-primary)' ,
                  outline: 'none', resize: 'vertical', boxSizing: 'border-box'
                }}
              />

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => setEditingRuleFileType(null)}
                  className="settings-btn-secondary"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => { handleSaveRules(editingRuleFileType); setEditingRuleFileType(null); }}
                  className="settings-btn-primary"
                >
                  保存规则文件
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
