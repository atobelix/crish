import React, { useState, useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi } from '../api/clientApi';
import type { Settings, ProviderInfo, CronJob, McpServer, PackageSource } from '../api/clientApi';
import { useLayoutStore } from '../store/layoutStore';
import { ensureDaemonConnected } from '../api/daemonChatBridge';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { fetchEngineStatus, type EngineStatus } from '../api/engineConfig';
import {
  activateProfileModel,
  addModelToProfile,
  anyProfileHasKey,
  createCustomProfile,
  getActiveProfileId,
  loadProfiles,
  removeModelFromProfile,
  removeProfile,
  saveProfileKey,
  upsertProfile,
  type ProviderProfile,
} from '../api/providerProfiles';
import { estimateCostUsd, loadPrices, upsertPrice, type ModelPrice } from '../api/pricingStore';
import { isDeveloperEngineUiEnabled } from '../api/productMode';
import { isDemoMode } from '../api/appMode';
import { networkUserMessage } from '../api/userFacingErrors';
import { getWorkspacePath, listProjects } from '../api/projectStore';
import { FontSettingsSection } from './FontSettingsSection';
import { SettingsSelect } from './SettingsSelect';
import {
  createWorkflow,
  defaultTimezone,
  deleteWorkflow,
  listWorkflows,
  scheduleLabel,
  triggerWorkflow,
  updateWorkflow,
  type WorkflowDefinition,
  type WorkflowSchedule,
} from '../api/workflowApi';
import { listMcpServers, type McpServerInfo } from '../api/mcpApi';
import { loadMirrorMeta } from '../api/sessionDiskMirror';
import { PERMISSION_MODES, type PermissionMode } from '../api/permissionModes';

type TabType =
  | 'profile'
  | 'appearance'
  | 'personalize'
  | 'models'
  | 'usage'
  | 'schedule'
  | 'rules'
  | 'shortcuts'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'security';

interface SettingsPanelProps {
  wsId: string;
  onShowToast: (msg: string) => void;
  onClose?: () => void;
  initialTab?: TabType;
}

/** Formal tabs; demo-only tabs only when demo mode */
const FORMAL_TAB_IDS: TabType[] = [
  'profile',
  'appearance',
  'personalize',
  'models',
  'usage',
  'schedule',
  'rules',
  'shortcuts',
  'security',
];
const DEMO_ONLY_TAB_IDS: TabType[] = ['skills', 'plugins'];

function allowedTabIds(mcpAvailable: boolean): TabType[] {
  const base = [...FORMAL_TAB_IDS];
  // H3：引擎已配置 MCP 时，正式版也显示扩展服务页
  if (mcpAvailable || isDemoMode()) base.push('mcp');
  if (isDemoMode()) base.push(...DEMO_ONLY_TAB_IDS);
  return base;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  wsId: _wsId,
  onShowToast,
  onClose,
  initialTab,
}) => {
  const storeTab = useLayoutStore((s) => s.settingsActiveTab);
  const setSettingsActiveTab = useLayoutStore((s) => s.setSettingsActiveTab);
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const scheduledTasks = useLayoutStore((s) => s.scheduledTasks);
  const [mcpAvailable, setMcpAvailable] = useState(false);
  const [mcpServersLive, setMcpServersLive] = useState<McpServerInfo[]>([]);

  const resolveTab = (raw?: string | null): TabType => {
    if (raw && (allowedTabIds(mcpAvailable) as string[]).includes(raw)) return raw as TabType;
    return 'profile';
  };

  const [activeTab, setActiveTab] = useState<TabType>(() =>
    resolveTab(initialTab || storeTab),
  );

  // Deep-link: follow store when settings open with a target tab
  useEffect(() => {
    setActiveTab(resolveTab(initialTab || storeTab));
  }, [initialTab, storeTab]);

  const selectTab = (tab: TabType) => {
    setActiveTab(tab);
    setSettingsActiveTab(tab);
  };
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

  // 全覆盖设置：Esc 返回工作区（二级弹层打开时不抢）
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showAddMcpModal || editingRuleFileType || showAddPluginModal) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, showAddMcpModal, editingRuleFileType, showAddPluginModal]);

  // Daemon endpoint (desktop product, developer only)
  const [daemonWsDraft, setDaemonWsDraft] = useState(() => {
    try {
      return localStorage.getItem('crish_daemon_ws') || 'ws://127.0.0.1:8765';
    } catch {
      return 'ws://127.0.0.1:8765';
    }
  });
  const [daemonConnHint, setDaemonConnHint] = useState('');

  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() => loadProfiles());
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});
  const [draftModelName, setDraftModelName] = useState<Record<string, string>>({});
  const [priceList, setPriceList] = useState<ModelPrice[]>(() => loadPrices());
  const [priceDraft, setPriceDraft] = useState({ model: '', input: '', output: '' });
  const [profileInlineError, setProfileInlineError] = useState('');
  const [profileInlineOk, setProfileInlineOk] = useState('');
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(() => getActiveProfileId());
  const [profileBusyId, setProfileBusyId] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileUrl, setNewProfileUrl] = useState('https://api.openai.com/v1');
  const [showAddProfile, setShowAddProfile] = useState(false);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowsLoading, setWorkflowsLoading] = useState(false);
  const [wfBusy, setWfBusy] = useState(false);
  const [wfError, setWfError] = useState('');
  const [wfOk, setWfOk] = useState('');
  const [showWfForm, setShowWfForm] = useState(false);
  const [wfDraft, setWfDraft] = useState({
    name: '',
    prompt: '',
    scheduleType: 'manual' as 'manual' | 'daily' | 'intervalMinutes',
    dailyTime: '09:00',
    intervalMinutes: '30',
  });
  const [diskMeta, setDiskMeta] = useState(() => loadMirrorMeta());

  useEffect(() => {
    // 启动时探测 MCP 是否可展示
    void listMcpServers().then((r) => {
      setMcpAvailable(r.configured || r.servers.length > 0);
      setMcpServersLive(r.servers);
    });
  }, []);

  useEffect(() => {
    if (activeTab !== 'models' && activeTab !== 'usage') return;
    void fetchEngineStatus().then(setEngineStatus);
    setProfiles(loadProfiles());
    setActiveProfileIdState(getActiveProfileId());
    setPriceList(loadPrices());
    setProfileInlineError('');
    setProfileInlineOk('');
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'schedule') return;
    setWorkflowsLoading(true);
    setWfError('');
    void listWorkflows()
      .then(setWorkflows)
      .finally(() => setWorkflowsLoading(false));
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'mcp') return;
    void listMcpServers().then((r) => {
      setMcpAvailable(r.configured || r.servers.length > 0);
      setMcpServersLive(r.servers);
    });
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'profile') return;
    setDiskMeta(loadMirrorMeta());
  }, [activeTab]);

  const refreshWorkflows = async () => {
    setWorkflowsLoading(true);
    try {
      setWorkflows(await listWorkflows());
    } finally {
      setWorkflowsLoading(false);
    }
  };

  const buildScheduleFromDraft = (): WorkflowSchedule => {
    if (wfDraft.scheduleType === 'daily') {
      return {
        type: 'daily',
        time: wfDraft.dailyTime.trim() || '09:00',
        timezone: defaultTimezone(),
      };
    }
    if (wfDraft.scheduleType === 'intervalMinutes') {
      const n = Math.max(1, Number(wfDraft.intervalMinutes) || 30);
      return { type: 'intervalMinutes', intervalMinutes: n };
    }
    return { type: 'manual' };
  };

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

  // 作用域 cwd：当前真实工作区路径，不用会话 folder 名拼接假路径
  const cwd = getWorkspacePath() || '__global__';

  // Load all configurations on mount / scope switch / cwd switch
  useEffect(() => {
    const loadAll = async () => {
      try {
        setLoading(true);
        const [sets, provs, mcps, crons] = await Promise.all([
          clientApi.getSettingsEx(cwd),
          clientApi.getProviders(),
          clientApi.getMcpServers(),
          clientApi.getScheduledTasks(),
        ]);
        setSettings(sets);
        if (sets && sets.theme) {
          const { applyTheme, normalizeTheme } = await import('../api/themeStore');
          applyTheme(normalizeTheme(sets.theme));
        }
        setProviders(provs);
        setMcpServers(mcps);
        setCronJobs(crons);

        // 规则正文：来自 settings.customRules；无则空模板
        const rulesJoined = (sets?.customRules || []).join('\n');
        setGlobalRules(
          rulesJoined ||
            '# 全局规则\n\n- 在敏感修改前先征得确认\n- 保持既有代码风格与格式\n',
        );
        setProjectRules('# 项目规则\n\n（打开项目后可在此补充项目专属约定）\n');
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
      const targetScope = updates.theme || updates.fonts ? 'global' : scope;
      const merged = await clientApi.saveSettingsEx(cwd, targetScope, updates);
      setSettings(merged);
      // Silent save — errors still toast

      // 主题：立即应用 + 独立 localStorage 记忆
      if (updates.theme) {
        const { setTheme } = await import('../api/themeStore');
        setTheme(updates.theme);
      }
      // 字体：立即应用（FontSettingsSection 也会走 fontStore；此处兼容其它入口）
      if (updates.fonts) {
        const { setFontPreferences, normalizeFontPrefs } = await import('../api/fontStore');
        await setFontPreferences(normalizeFontPrefs(updates.fonts));
      }
    } catch (err) {
      onShowToast('更新设置失败：' + String(err));
    }
  };

  const handleSaveApiKey = async (providerId: string, key: string) => {
    try {
      const updated = await clientApi.updateProviderKey(providerId, key);
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

      const list = await clientApi.saveMcpServer(newServer);
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
        const updatedList = await clientApi.saveMcpServer(newServer);
        setMcpServers(updatedList);
        onShowToast(`MCP 服务已连接: ${newServer.name} (加载 5 个工具)`);
      }, 1500);
    } catch (err) {
      onShowToast('添加 MCP 服务失败');
    }
  };

  const handleDeleteMcpServer = async (id: string, name: string) => {
    try {
      const filtered = await clientApi.deleteMcpServer(id);
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
    // 正式版：仅持久化到本地设置，不假装写入磁盘 AGENTS.md
    const text = scopeType === 'global' ? globalRules : projectRules;
    const lines = text
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter((l) => l && !l.startsWith('#'));
    void handleUpdateSettings({ customRules: lines });
    onShowToast(
      scopeType === 'global'
        ? '全局规则已保存到本机设置'
        : '项目规则已保存到本机设置（尚未写入仓库文件）',
    );
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
      const latest = await clientApi.fetchLatestModels(providerId);
      const list = await clientApi.updateProviderModels(providerId, latest);
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
      const list = await clientApi.updateProviderModels(providerId, updatedModels);
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
      const list = await clientApi.updateProviderModels(providerId, updatedModels);
      setProviders(list);
      if (settings.enabledModels?.includes(modelName)) {
        handleToggleModelEnabled(modelName);
      }
      onShowToast(`已从列表移除模型: ${modelName}`);
    } catch {
      onShowToast('移除模型失败');
    }
  };

  void showAddCustomModel; void setShowAddCustomModel; void draftApiKeys; void setDraftApiKeys;
  void visibleKeyProvider; void configuringProviderId; void fetchingModelsProviderId;
  void customType; void setCustomType; void customName; void setCustomName; void customUrl; void setCustomUrl;
  void customKey; void setCustomKey; void customModelsList; void setCustomModelsList;
  void manualModelId; void setManualModelId; void manualModelDisplayName; void setManualModelDisplayName;
  void fetchingModelsInModal; void setFetchingModelsInModal; void fetchedModels; void setFetchedModels;
  void selectedFetchedModelIds; void setSelectedFetchedModelIds; void testingConnection; void setTestingConnection;
  void handleSaveApiKey; void handleFetchModels; void handleAddManualModel; void handleDeleteModelFromProvider;

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
    <div
      className="settings-panel settings-panel--cover"
      onWheel={handleRootWheel}
    >
      <header className="settings-cover-header">
        <div className="settings-cover-header-left">
          {onClose ? (
            <button
              type="button"
              className="settings-back-btn"
              onClick={onClose}
              title="返回工作区"
            >
              <Lucide.ArrowLeft size={16} />
              <span>返回</span>
            </button>
          ) : null}
          <div className="settings-cover-title-block">
            <h1 className="settings-cover-title">设置</h1>
            <span className="settings-cover-subtitle">偏好与工作区配置</span>
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            className="settings-cover-close"
            onClick={onClose}
            title="关闭"
            aria-label="关闭设置"
          >
            <Lucide.X size={16} />
          </button>
        ) : null}
      </header>

      <div className="settings-cover-body">
        <nav className="settings-cover-nav" aria-label="设置分类">
          {(
            [
              { id: 'profile' as const, label: '账户', icon: Lucide.User, group: '通用' },
              { id: 'appearance' as const, label: '外观', icon: Lucide.Palette, group: '通用' },
              { id: 'personalize' as const, label: '个性化', icon: Lucide.SlidersHorizontal, group: '通用' },
              { id: 'models' as const, label: '模型', icon: Lucide.Cpu, group: '智能' },
              { id: 'usage' as const, label: '用量', icon: Lucide.PieChart, group: '智能' },
              { id: 'rules' as const, label: '规则', icon: Lucide.FileText, group: '智能' },
              { id: 'schedule' as const, label: '定时任务', icon: Lucide.Clock, group: '工作' },
              { id: 'shortcuts' as const, label: '快捷键', icon: Lucide.Keyboard, group: '工作' },
              ...(mcpAvailable || isDemoMode()
                ? ([{ id: 'mcp' as const, label: '扩展服务', icon: Lucide.Server, group: '工作' }] as const)
                : []),
              ...(isDemoMode()
                ? ([
                    { id: 'skills' as const, label: '技能', icon: Lucide.GraduationCap, group: '演示' },
                    { id: 'plugins' as const, label: '插件', icon: Lucide.Blocks, group: '演示' },
                  ] as const)
                : []),
              { id: 'security' as const, label: '安全', icon: Lucide.Shield, group: '安全' },
            ] as const
          ).map((tab, idx, arr) => {
            const isTabActive = activeTab === tab.id;
            const Icon = tab.icon;
            const showGroup = idx === 0 || arr[idx - 1].group !== tab.group;

            return (
              <React.Fragment key={tab.id}>
                {showGroup && (
                  <div className="settings-nav-group">{tab.group}</div>
                )}
                <button
                  type="button"
                  onClick={() => selectTab(tab.id)}
                  className={`settings-sidebar-tab ${isTabActive ? 'active' : ''}`}
                >
                  <Icon size={16} style={{ color: isTabActive ? 'var(--text-primary)' : 'var(--text-tertiary)' }} />
                  <span>{tab.label}</span>
                </button>
              </React.Fragment>
            );
          })}
        </nav>

        <div ref={contentAreaRef} className="settings-cover-content">
          {loading && (
            <div className="settings-loading-bar" aria-hidden>
              <div className="settings-loading-bar-inner" />
            </div>
          )}
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
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                    本机用户
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{cwd}</div>
                </div>
              </div>

              <div className="settings-fields-stack" style={{ gap: 14 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label className="settings-field-label">会话数据</label>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    本机浏览器存储始终保存。
                    {diskMeta.mode === 'tauri' && diskMeta.lastPath
                      ? ` 另已镜像到：${diskMeta.lastPath}`
                      : diskMeta.mode === 'localStorage-only'
                        ? ' 当前环境未启用磁盘镜像（桌面壳下会写入应用数据目录）。'
                        : ' 磁盘镜像状态未知。'}
                  </div>
                </div>
                {/* Product: engine is internal — hide from consumers. Dev only via localStorage flag. */}
                {isDeveloperEngineUiEnabled() && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="settings-field-label">开发者：引擎地址</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        type="text"
                        value={daemonWsDraft}
                        onChange={(e) => setDaemonWsDraft(e.target.value)}
                        className="settings-field-input"
                        placeholder="ws://127.0.0.1:8765"
                        style={{ flex: 1 }}
                      />
                      <button
                        type="button"
                        className="ui-btn ui-btn-secondary ui-btn-sm"
                        onClick={async () => {
                          try {
                            localStorage.setItem('crish_daemon_ws', daemonWsDraft.trim());
                            const client = getDesktopDaemonClient();
                            client.disconnect();
                            client.startKeepAlive();
                            const res = await ensureDaemonConnected();
                            if (res.ok) {
                              setDaemonConnHint(`ok · ${res.url || daemonWsDraft}`);
                              onShowToast('引擎已就绪');
                            } else {
                              setDaemonConnHint(networkUserMessage());
                              onShowToast(networkUserMessage());
                            }
                          } catch {
                            setDaemonConnHint(networkUserMessage());
                            onShowToast(networkUserMessage());
                          }
                        }}
                      >
                        测试
                      </button>
                    </div>
                    {daemonConnHint ? (
                      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: 0 }}>
                        {daemonConnHint}
                      </p>
                    ) : null}
                  </div>
                )}

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

          {/* TAB 2: MODELS — multi profile */}
          {activeTab === 'models' && (
            <>
              <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>AI 模型</h4>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                    配置多个服务商，点击模型即可写入引擎并立即生效。
                    当前引擎：{engineStatus?.model || '未读取'}
                    {engineStatus?.hasApiKey === false ? ' · 未检测到密钥' : engineStatus?.hasApiKey ? ' · 密钥已就绪' : ''}
                    {activeProfileId
                      ? ` · 活动：${profiles.find((x) => x.id === activeProfileId)?.name || activeProfileId}`
                      : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    setShowAddProfile((v) => !v);
                    setProfileInlineError('');
                    setProfileInlineOk('');
                  }}
                >
                  <Lucide.Plus size={16} />
                  添加服务商
                </button>
              </div>

              {!anyProfileHasKey() && (
                <div className="chat-soft-hint" style={{ marginBottom: 12 }}>
                  <span>首次使用：为任意服务商粘贴 API 密钥，再点击一个模型启用即可开始对话。</span>
                </div>
              )}

              {profileInlineError && (
                <div className="model-picker-error" style={{ marginBottom: 10 }}>{profileInlineError}</div>
              )}
              {profileInlineOk && (
                <div className="chat-soft-hint" style={{ marginBottom: 10 }}>
                  <span>{profileInlineOk}</span>
                </div>
              )}

              {showAddProfile && (
                <div className="settings-card-row" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>新的服务商</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label className="settings-field-label">显示名称</label>
                    <input
                      className="settings-field-input"
                      placeholder="例如 公司内网网关"
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label className="settings-field-label">接口地址（OpenAI 兼容）</label>
                    <input
                      className="settings-field-input"
                      placeholder="https://…"
                      value={newProfileUrl}
                      onChange={(e) => setNewProfileUrl(e.target.value)}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost ui-btn-sm"
                      onClick={() => {
                        setShowAddProfile(false);
                        setNewProfileName('');
                        setNewProfileUrl('https://api.openai.com/v1');
                      }}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-sm"
                      onClick={() => {
                        const name = newProfileName.trim();
                        if (!name) {
                          setProfileInlineError('请填写服务商名称');
                          setProfileInlineOk('');
                          return;
                        }
                        const entry = createCustomProfile({
                          name,
                          baseUrl: newProfileUrl.trim() || 'https://api.openai.com/v1',
                        });
                        setProfiles(loadProfiles());
                        setShowAddProfile(false);
                        setNewProfileName('');
                        setNewProfileUrl('https://api.openai.com/v1');
                        setProfileInlineError('');
                        setProfileInlineOk(`已添加「${entry.name}」，请填写密钥并添加模型`);
                      }}
                    >
                      创建
                    </button>
                  </div>
                </div>
              )}

              <div className="settings-fields-stack" style={{ gap: 12 }}>
                {profiles.map((p) => {
                  const isActive = activeProfileId === p.id;
                  const hasKey = Boolean(p.hasKey || p.apiKey);
                  const busy = profileBusyId === p.id;
                  return (
                    <div
                      key={p.id}
                      className={`settings-card-row${isActive ? ' is-active' : ''}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</span>
                          <span className={`status-badge ${hasKey ? 'available' : 'unconfigured'}`}>
                            <span className="status-dot" style={{ width: 5, height: 5, borderRadius: '50%' }} />
                            {hasKey ? '已配置密钥' : '未配置密钥'}
                          </span>
                          {isActive && (
                            <span className="status-badge available" style={{ fontSize: 10 }}>
                              使用中
                            </span>
                          )}
                        </div>
                        {p.id.startsWith('custom-') && (
                          <button
                            type="button"
                            className="ui-btn ui-btn-ghost ui-btn-sm"
                            title="移除服务商"
                            onClick={() => {
                              setProfiles(removeProfile(p.id));
                              setActiveProfileIdState(getActiveProfileId());
                              setProfileInlineOk('已移除自定义服务商');
                              setProfileInlineError('');
                            }}
                          >
                            <Lucide.Trash2 size={16} />
                          </button>
                        )}
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label className="settings-field-label">接口地址</label>
                        <input
                          className="settings-field-input"
                          value={p.baseUrl}
                          onChange={(e) => {
                            const next = profiles.map((x) =>
                              x.id === p.id ? { ...x, baseUrl: e.target.value } : x,
                            );
                            setProfiles(next);
                            upsertProfile({ ...p, baseUrl: e.target.value });
                          }}
                        />
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <label className="settings-field-label">API 密钥</label>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <input
                            type="password"
                            className="settings-field-input"
                            style={{ flex: 1, minWidth: 160 }}
                            placeholder={hasKey ? '已保存 · 输入新密钥以覆盖' : '粘贴 API 密钥'}
                            value={draftKeys[p.id] ?? ''}
                            onChange={(e) => setDraftKeys((d) => ({ ...d, [p.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                (e.target as HTMLInputElement).blur();
                                void (async () => {
                                  const v = (draftKeys[p.id] || '').trim();
                                  if (!v) {
                                    setProfileInlineError('请输入密钥后再保存');
                                    setProfileInlineOk('');
                                    return;
                                  }
                                  setProfileBusyId(p.id);
                                  setProfileInlineError('');
                                  const res = await saveProfileKey(p.id, v, {
                                    activateModel: p.models[0],
                                  });
                                  setProfiles(loadProfiles());
                                  setDraftKeys((d) => ({ ...d, [p.id]: '' }));
                                  setActiveProfileIdState(getActiveProfileId());
                                  if (!res.ok) {
                                    setProfileInlineError(
                                      res.error === 'not_connected'
                                        ? networkUserMessage()
                                        : '密钥已保存，但同步到引擎失败',
                                    );
                                    setProfileInlineOk('');
                                  } else {
                                    setProfileInlineOk(
                                      res.synced
                                        ? '密钥已保存并同步到引擎'
                                        : '密钥已保存',
                                    );
                                    setEngineStatus(await fetchEngineStatus());
                                  }
                                  setProfileBusyId(null);
                                })();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="ui-btn ui-btn-sm ui-btn-secondary"
                            disabled={busy}
                            onClick={async () => {
                              const v = (draftKeys[p.id] || '').trim();
                              if (!v) {
                                setProfileInlineError('请输入密钥后再保存');
                                setProfileInlineOk('');
                                return;
                              }
                              setProfileBusyId(p.id);
                              setProfileInlineError('');
                              const res = await saveProfileKey(p.id, v, {
                                activateModel: p.models[0],
                              });
                              setProfiles(loadProfiles());
                              setDraftKeys((d) => ({ ...d, [p.id]: '' }));
                              setActiveProfileIdState(getActiveProfileId());
                              if (!res.ok) {
                                setProfileInlineError(
                                  res.error === 'not_connected'
                                    ? networkUserMessage()
                                    : '密钥已保存，但同步到引擎失败',
                                );
                                setProfileInlineOk('');
                              } else {
                                setProfileInlineOk(
                                  res.synced
                                    ? p.models[0]
                                      ? `密钥已保存，并启用 ${p.models[0]}`
                                      : '密钥已保存并同步到引擎'
                                    : '密钥已保存',
                                );
                                setEngineStatus(await fetchEngineStatus());
                              }
                              setProfileBusyId(null);
                            }}
                          >
                            {busy ? '保存中…' : '保存密钥'}
                          </button>
                        </div>
                        <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-tertiary)' }}>
                          密钥仅保存在本机。保存时若该服务商为活动项（或尚无活动项），会自动写入引擎。
                        </p>
                      </div>

                      <div>
                        <label className="settings-field-label">模型（点击启用）</label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                          {p.models.length === 0 && (
                            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                              还没有模型，请在下方添加模型 ID
                            </span>
                          )}
                          {p.models.map((m) => {
                            const selected =
                              (engineStatus?.model === m && isActive) ||
                              (engineStatus?.model === m && !activeProfileId);
                            return (
                              <button
                                key={m}
                                type="button"
                                className={`model-chip ${selected ? 'on' : ''}`}
                                disabled={busy}
                                onClick={async () => {
                                  setProfileInlineError('');
                                  setProfileInlineOk('');
                                  setProfileBusyId(p.id);
                                  const res = await activateProfileModel(p.id, m);
                                  setActiveProfileIdState(getActiveProfileId());
                                  if (!res.ok) {
                                    setProfileInlineError(
                                      res.error === 'not_connected'
                                        ? networkUserMessage()
                                        : '启用失败，请检查密钥与地址',
                                    );
                                    setProfileBusyId(null);
                                    return;
                                  }
                                  if (res.warning === 'model_mismatch') {
                                    setProfileInlineOk(
                                      `已请求启用 ${m}，但引擎回报模型不一致，请刷新或检查密钥`,
                                    );
                                  } else if (res.warning === 'no_local_key') {
                                    setProfileInlineOk(
                                      `已切换到 ${m}（本地未保存密钥，将使用引擎现有凭证）`,
                                    );
                                  } else {
                                    setProfileInlineOk(`已启用 ${p.name} · ${m}`);
                                  }
                                  setEngineStatus(await fetchEngineStatus());
                                  setProfileBusyId(null);
                                }}
                              >
                                {m}
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setProfiles(removeModelFromProfile(p.id, m));
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.stopPropagation();
                                      setProfiles(removeModelFromProfile(p.id, m));
                                    }
                                  }}
                                  style={{ marginLeft: 4, opacity: 0.5 }}
                                >
                                  ×
                                </span>
                              </button>
                            );
                          })}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <input
                            className="settings-field-input"
                            style={{ flex: 1 }}
                            placeholder="添加模型 ID，例如 gpt-4o"
                            value={draftModelName[p.id] || ''}
                            onChange={(e) =>
                              setDraftModelName((d) => ({ ...d, [p.id]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const name = (draftModelName[p.id] || '').trim();
                                if (name) {
                                  setProfiles(addModelToProfile(p.id, name));
                                  setDraftModelName((d) => ({ ...d, [p.id]: '' }));
                                  setProfileInlineOk(`已添加模型 ${name}`);
                                  setProfileInlineError('');
                                }
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="ui-btn ui-btn-secondary ui-btn-sm"
                            onClick={() => {
                              const name = (draftModelName[p.id] || '').trim();
                              if (name) {
                                setProfiles(addModelToProfile(p.id, name));
                                setDraftModelName((d) => ({ ...d, [p.id]: '' }));
                                setProfileInlineOk(`已添加模型 ${name}`);
                                setProfileInlineError('');
                              }
                            }}
                          >
                            添加
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* TAB 3: MCP — 正式版读取引擎列表；演示保留本地 mock 管理 */}
          {activeTab === 'mcp' && !isDemoMode() && (
            <>
              <div style={{ marginBottom: 12 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>扩展服务</h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                  来自引擎 MCP 状态（只读）。配置文件与启停由引擎侧管理。
                </p>
              </div>
              <div className="settings-fields-stack" style={{ gap: 8 }}>
                {mcpServersLive.map((srv) => (
                  <div key={srv.id} className="settings-card-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{srv.name}</div>
                      <span className="status-badge available">{srv.status || '已登记'}</span>
                    </div>
                    {srv.tools && srv.tools.length > 0 && (
                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
                        工具：{srv.tools.slice(0, 8).join('、')}
                        {srv.tools.length > 8 ? '…' : ''}
                      </div>
                    )}
                  </div>
                ))}
                {mcpServersLive.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '16px 0' }}>
                    引擎未报告已配置的 MCP 服务。配置完成后此页会自动出现列表。
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'mcp' && isDemoMode() && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>扩展服务</h4>
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                    管理已连接的外部工具服务
                  </p>
                </div>
                <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" onClick={() => setShowAddMcpModal(true)}>
                  <Lucide.Plus size={16} />
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
                              background: isEnabled ? 'var(--text-secondary)' : 'var(--bg-active)',
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
                            <Lucide.Settings size={16} />
                          </button>
                          <div
                            onClick={() =>
                              setEnabledMcpServers((prev) => ({ ...prev, [srv.id]: !isEnabled }))
                            }
                            style={{
                              width: 32,
                              height: 18,
                              borderRadius: 9,
                              backgroundColor: isEnabled ? 'var(--text-secondary)' : 'var(--border-color)',
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
                                backgroundColor: 'var(--bg-primary)',
                              }}
                            />
                          </div>
                          <button
                            type="button"
                            className="ui-btn ui-btn-ghost danger"
                            title="删除"
                            onClick={() => handleDeleteMcpServer(srv.id, srv.name)}
                          >
                            <Lucide.Trash2 size={16} />
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
                            className="ui-btn ui-btn-secondary ui-btn-sm"
                            style={{ alignSelf: 'flex-end' }}
                            onClick={() => {
                              const cmdEl = document.getElementById(`mcp-cmd-${srv.id}`) as HTMLInputElement;
                              const argsEl = document.getElementById(
                                `mcp-args-${srv.id}`,
                              ) as HTMLInputElement;
                              if (cmdEl) {
                                clientApi
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
                  <Lucide.Plus size={16} />
                  安装
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {(settings.packages || []).map((pkg, idx) => {
                  const isObj = typeof pkg !== 'string';
                  const name = isObj ? (pkg as PackageSource).source : (pkg as string);
                  const filters = isObj
                    ? [
                        (pkg as PackageSource).extensions
                          ? `后缀 ${(pkg as PackageSource).extensions?.join(',')}`
                          : null,
                        (pkg as PackageSource).skills
                          ? `技能 ${(pkg as PackageSource).skills?.join(',')}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : '';

                  return (
                    <div
                      key={idx}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '12px 0',
                        borderBottom: '1px solid var(--border-subtle)',
                        gap: 12,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            color: 'var(--text-primary)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {name}
                        </div>
                        {filters && (
                          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                            {filters}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost danger"
                        onClick={() => handleRemovePackage(idx)}
                        title="卸载"
                      >
                        <Lucide.X size={16} />
                      </button>
                    </div>
                  );
                })}
                {(settings.packages || []).length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '16px 0' }}>
                    还没有插件。点击「安装」添加。
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'skills' && (
            <>
              <div style={{ marginBottom: 4 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                  技能
                </h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 12px' }}>
                  加载本地技能目录
                </p>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 0 14px',
                  borderBottom: '1px solid var(--border-subtle)',
                  marginBottom: 8,
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                    注册为快捷命令
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    输入框可用 /skill:name
                  </div>
                </div>
                <label
                  style={{
                    position: 'relative',
                    display: 'inline-block',
                    width: 32,
                    height: 18,
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={settings.enableSkillCommands || false}
                    onChange={(e) =>
                      handleUpdateSettings({ enableSkillCommands: e.target.checked })
                    }
                    style={{ opacity: 0, width: 0, height: 0 }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      inset: 0,
                      backgroundColor: settings.enableSkillCommands
                        ? 'var(--text-secondary)'
                        : 'var(--border-color)',
                      borderRadius: 18,
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        height: 14,
                        width: 14,
                        left: settings.enableSkillCommands ? 16 : 2,
                        bottom: 2,
                        backgroundColor: 'var(--bg-primary)',
                        borderRadius: '50%',
                      }}
                    />
                  </span>
                </label>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 12 }}>
                {(settings.skills || []).map((skPath, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 0',
                      borderBottom: '1px solid var(--border-subtle)',
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={skPath}
                    >
                      {skPath}
                    </span>
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost danger"
                      onClick={() => handleRemoveSkill(idx)}
                      title="移除"
                    >
                      <Lucide.X size={16} />
                    </button>
                  </div>
                ))}
                {(settings.skills || []).length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                    还没有技能路径
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  placeholder="技能目录绝对路径"
                  value={newSkillPath}
                  onChange={(e) => setNewSkillPath(e.target.value)}
                  className="settings-field-input"
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={handleAddSkill}
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                >
                  添加
                </button>
              </div>
            </>
          )}

          {activeTab === 'usage' && (
            <>
              <div style={{ marginBottom: 12 }}>
                <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>用量总览</h4>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
                  优先使用引擎 run snapshot 的 token 样本；无样本时回退字数估算。费用按下方定价表计算。
                </p>
              </div>
              {(() => {
                const tokenUsage = useLayoutStore.getState().tokenUsage;
                const model = engineStatus?.model || 'unknown';
                const cost =
                  tokenUsage.cost > 0
                    ? tokenUsage.cost
                    : estimateCostUsd(model, tokenUsage.input, tokenUsage.output);
                return (
                  <div className="settings-card-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div className="settings-field-label">输入 tokens</div>
                      <div style={{ fontSize: 18, fontWeight: 600 }}>{tokenUsage.input.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="settings-field-label">输出 tokens</div>
                      <div style={{ fontSize: 18, fontWeight: 600 }}>{tokenUsage.output.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="settings-field-label">估算费用 (USD)</div>
                      <div style={{ fontSize: 18, fontWeight: 600 }}>${cost.toFixed(4)}</div>
                    </div>
                    <div>
                      <div className="settings-field-label">计价模型</div>
                      <div style={{ fontSize: 13 }}>{model}</div>
                    </div>
                  </div>
                );
              })()}

              <div style={{ marginTop: 20 }}>
                <h4 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>定价表（每百万 tokens）</h4>
                <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                  默认参考公开标价，可按你的渠道自行修改
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {priceList.map((row) => (
                    <div
                      key={row.model}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1.2fr 1fr 1fr',
                        gap: 8,
                        fontSize: 12,
                        padding: '6px 0',
                        borderBottom: '1px solid var(--border-subtle)',
                      }}
                    >
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{row.model}</span>
                      <span>入 ${row.inputPerMTok}</span>
                      <span>出 ${row.outputPerMTok}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
                  <input
                    className="settings-field-input"
                    placeholder="模型 ID"
                    style={{ flex: 1, minWidth: 120 }}
                    value={priceDraft.model}
                    onChange={(e) => setPriceDraft((d) => ({ ...d, model: e.target.value }))}
                  />
                  <input
                    className="settings-field-input"
                    placeholder="输入 $/M"
                    style={{ width: 90 }}
                    value={priceDraft.input}
                    onChange={(e) => setPriceDraft((d) => ({ ...d, input: e.target.value }))}
                  />
                  <input
                    className="settings-field-input"
                    placeholder="输出 $/M"
                    style={{ width: 90 }}
                    value={priceDraft.output}
                    onChange={(e) => setPriceDraft((d) => ({ ...d, output: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    onClick={() => {
                      const model = priceDraft.model.trim();
                      const inputPerMTok = Number(priceDraft.input);
                      const outputPerMTok = Number(priceDraft.output);
                      if (!model || Number.isNaN(inputPerMTok) || Number.isNaN(outputPerMTok)) {
                        setProfileInlineError('请填写完整的定价');
                        return;
                      }
                      setPriceList(upsertPrice({ model, inputPerMTok, outputPerMTok }));
                      setPriceDraft({ model: '', input: '', output: '' });
                      setProfileInlineError('');
                    }}
                  >
                    保存定价
                  </button>
                </div>
              </div>
            </>
          )}

          {activeTab === 'schedule' && (
            <>
              <div
                style={{
                  marginBottom: 12,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: 12,
                }}
              >
                <div>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>定时任务</h4>
                  <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                    引擎 workflow：手动 / 每天 / 间隔。与运行状态悬浮条分离——这里是计划，悬浮条是当前执行。
                  </p>
                </div>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    setShowWfForm((v) => !v);
                    setWfError('');
                    setWfOk('');
                  }}
                >
                  <Lucide.Plus size={16} />
                  新建
                </button>
              </div>

              {wfError && <div className="model-picker-error" style={{ marginBottom: 8 }}>{wfError}</div>}
              {wfOk && (
                <div className="chat-soft-hint" style={{ marginBottom: 8 }}>
                  <span>{wfOk}</span>
                </div>
              )}

              {showWfForm && (
                <div className="settings-card-row" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>新建计划</div>
                  <input
                    className="settings-field-input"
                    placeholder="名称，例如 每日代码体检"
                    value={wfDraft.name}
                    onChange={(e) => setWfDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                  <textarea
                    className="settings-field-input"
                    style={{ minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }}
                    placeholder="任务提示词：引擎到点会按此 prompt 启动一轮对话"
                    value={wfDraft.prompt}
                    onChange={(e) => setWfDraft((d) => ({ ...d, prompt: e.target.value }))}
                  />
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select
                      className="settings-field-input"
                      style={{ width: 140 }}
                      value={wfDraft.scheduleType}
                      onChange={(e) =>
                        setWfDraft((d) => ({
                          ...d,
                          scheduleType: e.target.value as typeof d.scheduleType,
                        }))
                      }
                    >
                      <option value="manual">手动</option>
                      <option value="daily">每天</option>
                      <option value="intervalMinutes">间隔分钟</option>
                    </select>
                    {wfDraft.scheduleType === 'daily' && (
                      <input
                        className="settings-field-input"
                        style={{ width: 100 }}
                        type="time"
                        value={wfDraft.dailyTime}
                        onChange={(e) => setWfDraft((d) => ({ ...d, dailyTime: e.target.value }))}
                      />
                    )}
                    {wfDraft.scheduleType === 'intervalMinutes' && (
                      <input
                        className="settings-field-input"
                        style={{ width: 100 }}
                        placeholder="分钟"
                        value={wfDraft.intervalMinutes}
                        onChange={(e) => setWfDraft((d) => ({ ...d, intervalMinutes: e.target.value }))}
                      />
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setShowWfForm(false)}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="ui-btn ui-btn-secondary ui-btn-sm"
                      disabled={wfBusy}
                      onClick={async () => {
                        if (!wfDraft.name.trim() || !wfDraft.prompt.trim()) {
                          setWfError('请填写名称与提示词');
                          setWfOk('');
                          return;
                        }
                        setWfBusy(true);
                        setWfError('');
                        const res = await createWorkflow({
                          name: wfDraft.name,
                          prompt: wfDraft.prompt,
                          schedule: buildScheduleFromDraft(),
                          cwd: getWorkspacePath() || undefined,
                        });
                        setWfBusy(false);
                        if (!res.ok) {
                          setWfError(
                            res.error === 'not_connected'
                              ? networkUserMessage()
                              : '创建失败，请检查引擎是否就绪',
                          );
                          return;
                        }
                        setWfOk('已创建计划');
                        setShowWfForm(false);
                        setWfDraft({
                          name: '',
                          prompt: '',
                          scheduleType: 'manual',
                          dailyTime: '09:00',
                          intervalMinutes: '30',
                        });
                        await refreshWorkflows();
                      }}
                    >
                      {wfBusy ? '创建中…' : '创建'}
                    </button>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {workflowsLoading && (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>正在读取引擎计划…</div>
                )}
                {workflows.map((w) => (
                  <div key={w.id} className="settings-card-row">
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{w.name}</div>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <span className={`status-badge ${w.enabled !== false ? 'available' : 'unconfigured'}`}>
                          {w.enabled !== false ? '启用' : '关闭'}
                        </span>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          title={w.enabled === false ? '启用' : '暂停'}
                          disabled={wfBusy}
                          onClick={async () => {
                            setWfBusy(true);
                            const res = await updateWorkflow(w.id, { enabled: w.enabled === false });
                            setWfBusy(false);
                            if (!res.ok) setWfError('更新失败');
                            else {
                              setWfOk(w.enabled === false ? '已启用' : '已暂停');
                              await refreshWorkflows();
                            }
                          }}
                        >
                          {w.enabled === false ? <Lucide.Play size={16} /> : <Lucide.Pause size={16} />}
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          title="立即执行"
                          disabled={wfBusy}
                          onClick={async () => {
                            setWfBusy(true);
                            const res = await triggerWorkflow(w.id);
                            setWfBusy(false);
                            if (!res.ok) setWfError('触发失败');
                            else setWfOk('已触发执行');
                          }}
                        >
                          <Lucide.Zap size={16} />
                        </button>
                        <button
                          type="button"
                          className="ui-btn ui-btn-ghost ui-btn-sm"
                          title="删除"
                          disabled={wfBusy}
                          onClick={async () => {
                            setWfBusy(true);
                            const res = await deleteWorkflow(w.id);
                            setWfBusy(false);
                            if (!res.ok) setWfError('删除失败');
                            else {
                              setWfOk('已删除');
                              await refreshWorkflows();
                            }
                          }}
                        >
                          <Lucide.Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
                      {scheduleLabel(w.schedule)}
                    </div>
                    {w.prompt && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.45 }}>
                        {String(w.prompt).slice(0, 160)}
                        {String(w.prompt).length > 160 ? '…' : ''}
                      </div>
                    )}
                  </div>
                ))}
                {!workflowsLoading && workflows.length === 0 && (
                  <div
                    className="settings-card-row"
                    style={{
                      textAlign: 'center',
                      padding: '28px 16px',
                      color: 'var(--text-tertiary)',
                      fontSize: 12,
                      lineHeight: 1.6,
                    }}
                  >
                    <Lucide.Clock size={22} style={{ opacity: 0.35, marginBottom: 8 }} />
                    <div>暂无计划任务</div>
                    <div style={{ marginTop: 4 }}>点击右上角「新建」创建一条引擎调度。</div>
                  </div>
                )}
              </div>
            </>
          )}

          {/* TAB 6: RULES — contextual: no project → global only; with project → project rules */}
          {activeTab === 'rules' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
                <div>
                  <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
                    {(typeof localStorage !== 'undefined' && localStorage.getItem('crish_workspace'))
                      ? '当前项目规则'
                      : '全局规则'}
                  </h4>
                  <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                    {(typeof localStorage !== 'undefined' && localStorage.getItem('crish_workspace'))
                      ? `作用于：${localStorage.getItem('crish_workspace')}`
                      : '尚未打开项目时，这里编辑的是全局规则'}
                  </p>
                </div>
                
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={() =>
                      setEditingRuleFileType(
                        (typeof localStorage !== 'undefined' && localStorage.getItem('crish_workspace'))
                          ? 'project'
                          : 'global',
                      )
                    }
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                  >
                    编辑规则文件
                  </button>
                </div>
              </div>

              {/* Rules List (零碎的规范内容) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="settings-field-label">已添加的规则规范列表</span>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {(settings.customRules || []).map((rule, idx) => (
                    <div key={idx} className="settings-card-row" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: '11.5px', color: 'var(--text-primary)', lineHeight: '1.4' }}>{rule}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDeleteCustomRule(idx)}
                        className="ui-btn ui-btn-ghost danger"
                        style={{ marginLeft: 12, flexShrink: 0 }}
                        title="删除规则"
                      >
                        <Lucide.Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {(settings.customRules || []).length === 0 && (
                    <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', textAlign: 'center', padding: '24px', border: '1px dashed var(--border-color)', borderRadius: '8px' }}>
                      暂无细化规范，请在下方输入框添加日常开发的零碎规范。
                    </div>
                  )}
                </div>
              </div>

              {/* Add Custom Rule Form */}
              <div className="settings-card-row" style={{ gap: 10 }}>
                <span className="settings-field-label">添加新规范</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    placeholder="输入规则内容，例如: 提交代码前确保完成 lint 测试"
                    value={newRuleText}
                    onChange={e => setNewRuleText(e.target.value)}
                    className="settings-field-input"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={handleAddCustomRule}
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                  >
                    添加
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

              <div className="settings-card-row" style={{ gap: 12 }}>
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

          {/* TAB: APPEARANCE */}
          {activeTab === 'appearance' && (
            <>
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>外观</h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                  主题、密度与字体
                </p>
              </div>

              <div className="settings-rows">
                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-title">主题</span>
                  </div>
                  <div className="settings-row-control">
                    <div className="ui-segment ui-segment--inline">
                      {(
                        [
                          { id: 'default', label: '浅色' },
                          { id: 'dark', label: '深色' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ui-segment-item ${(settings.theme || 'default') === opt.id ? 'active' : ''}`}
                          onClick={() => {
                            void handleUpdateSettings({ theme: opt.id });
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-title">间距密度</span>
                  </div>
                  <div className="settings-row-control">
                    <div className="ui-segment ui-segment--inline">
                      {(
                        [
                          { id: 'small', label: '紧凑' },
                          { id: 'medium', label: '标准' },
                          { id: 'large', label: '宽松' },
                        ] as const
                      ).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ui-segment-item ${useLayoutStore.getState().uiSize === opt.id ? 'active' : ''}`}
                          onClick={() => useLayoutStore.getState().setUiSize(opt.id)}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-label">
                    <span className="settings-row-title">代码缩进</span>
                  </div>
                  <div className="settings-row-control">
                    <SettingsSelect
                      value={settings.markdown?.codeBlockIndent || '  '}
                      options={[
                        { value: '  ', label: '2 空格' },
                        { value: '    ', label: '4 空格' },
                        { value: '\t', label: 'Tab' },
                      ]}
                      onChange={(v) =>
                        void handleUpdateSettings({
                          markdown: { ...settings.markdown, codeBlockIndent: v },
                        })
                      }
                    />
                  </div>
                </div>

                <FontSettingsSection
                  onShowToast={onShowToast}
                  onPersistSettings={(fonts) =>
                    handleUpdateSettings({
                      fonts: {
                        uiFont: fonts.uiFont,
                        monoFont: fonts.monoFont,
                        monoLigatures: fonts.monoLigatures,
                        v: 1,
                      },
                    })
                  }
                />

                <label className="settings-row settings-row--toggle">
                  <div className="settings-row-label">
                    <span className="settings-row-title">隐藏思考过程</span>
                  </div>
                  <div className="settings-row-control">
                    <input
                      type="checkbox"
                      className="settings-switch"
                      checked={!!settings.hideThinkingBlock}
                      onChange={(e) => handleUpdateSettings({ hideThinkingBlock: e.target.checked })}
                    />
                  </div>
                </label>
              </div>
            </>
          )}

          {/* TAB: PERSONALIZE */}
          {activeTab === 'personalize' && (
            <>
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>个性化</h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                  交互习惯与默认权限
                </p>
              </div>
              <div className="settings-fields-stack" style={{ gap: 12 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">默认权限模式</label>
                  <div className="ui-segment" style={{ maxWidth: 420, flexWrap: 'wrap' }}>
                    {PERMISSION_MODES.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`ui-segment-item ${permissionMode === opt.id ? 'active' : ''}`}
                        onClick={() => setPermissionMode(opt.id as PermissionMode)}
                        title={opt.description}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                    {PERMISSION_MODES.find((m) => m.id === permissionMode)?.description}
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">回答风格</label>
                  <div className="ui-segment" style={{ maxWidth: 360 }}>
                    {(
                      [
                        { id: 'minimal', label: '简洁' },
                        { id: 'low', label: '标准' },
                        { id: 'medium', label: '详细' },
                        { id: 'high', label: '深入' },
                      ] as const
                    ).map((opt) => {
                      const current = (settings as any).responseStyle || 'medium';
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ui-segment-item ${current === opt.id ? 'active' : ''}`}
                          onClick={() => handleUpdateSettings({ responseStyle: opt.id } as any)}
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    回答风格属于交互偏好，放在个性化里更合适。
                  </p>
                </div>

                <label className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">优先合并为标签页</div>
                    <div className="settings-toggle-desc">打开右侧工具时尽量并入同一列标签</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={useLayoutStore.getState().tabModeEnabled}
                    onChange={(e) => useLayoutStore.getState().setTabModeEnabled(e.target.checked)}
                  />
                </label>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">默认打开的侧栏工具</label>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    从对话区可随时打开；此处仅作说明。常用：变更、终端、任务。
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(['files', 'preview', 'diff', 'terminal', 'tasks'] as const).map((key) => {
                      const labels: Record<string, string> = {
                        files: '文件',
                        preview: '浏览器',
                        diff: '变更',
                        terminal: '终端',
                        tasks: '任务',
                      };
                      return (
                        <span key={key} className="ui-badge">
                          {labels[key]}
                        </span>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* TAB: SECURITY */}
          {activeTab === 'security' && (
            <>
              <div style={{ marginBottom: 16 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>安全</h4>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 0' }}>
                  命令权限与敏感操作（打开项目即表示信任该目录）
                </p>
              </div>

              <div className="settings-fields-stack" style={{ gap: 16 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">默认权限</label>
                  <div className="ui-segment" style={{ maxWidth: 420, flexWrap: 'wrap' }}>
                    {PERMISSION_MODES.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`ui-segment-item ${permissionMode === opt.id ? 'active' : ''}`}
                        onClick={() => setPermissionMode(opt.id as PermissionMode)}
                        title={opt.description}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                    {PERMISSION_MODES.find((m) => m.id === permissionMode)?.description}
                    {' '}极危命令在「自动 / 完全访问」下仍会征求确认；「计划」模式禁止改文件。
                  </p>
                </div>

                <div>
                  <div className="settings-field-label" style={{ marginBottom: 8 }}>
                    当前工作目录
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(getWorkspacePath()
                      ? [getWorkspacePath()]
                      : listProjects()
                          .slice(0, 3)
                          .map((p) => p.path)
                    ).map((path) => (
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
                      </div>
                    ))}
                    {!getWorkspacePath() && listProjects().length === 0 && (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                        尚未选择项目。可在空对话页的「选择项目」中添加。
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
                        <Lucide.X size={14} />
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
          background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)', zIndex: 20000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: '460px', background: 'var(--bg-elevated, var(--bg-primary))', borderRadius: '12px',
            boxShadow: 'var(--shadow-2xl)',
            border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex', flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <span className="settings-modal-title">注册新 MCP 服务</span>
              <button onClick={() => setShowAddMcpModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color:  'var(--text-tertiary)'  }}>
                <Lucide.X size={16} />
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
          background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)', zIndex: 20000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: '460px', background: 'var(--bg-elevated, var(--bg-primary))', borderRadius: '12px',
            boxShadow: 'var(--shadow-2xl)',
            border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex', flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <span className="settings-modal-title">安装新插件扩展</span>
              <button onClick={() => setShowAddPluginModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color:  'var(--text-tertiary)'  }}>
                <Lucide.X size={16} />
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
          background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(4px)', zIndex: 20000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            width: '580px', background: 'var(--bg-elevated, var(--bg-primary))', borderRadius: '12px',
            boxShadow: 'var(--shadow-2xl)',
            border: '1px solid var(--border-color)', overflow: 'hidden', display: 'flex', flexDirection: 'column'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid var(--border-color)' }}>
              <span className="settings-modal-title">
                {editingRuleFileType === 'global' ? '编辑全局规则' : '编辑当前项目规则'}
              </span>
              <button onClick={() => setEditingRuleFileType(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color:  'var(--text-tertiary)'  }}>
                <Lucide.X size={16} />
              </button>
            </div>
            
            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '11px', color:  'var(--text-tertiary)' , margin: 0 }}>
                {editingRuleFileType === 'global'
                  ? '修改全局规则文本。保存后写入本机设置（正式版暂不自动写仓库 AGENTS.md）。'
                  : '修改当前工作区相关规则。保存后写入本机设置，后续可对接项目文件。'}
              </p>
              
              <textarea
                className="settings-field-input"
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
                  width: '100%',
                  minHeight: 220,
                  height: 'auto',
                  padding: '10px 12px',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  resize: 'vertical',
                  lineHeight: 1.5,
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
