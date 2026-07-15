import React, { useState, useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi } from '../api/clientApi';
import type { Settings, PackageSource } from '../api/clientApi';
import { useLayoutStore } from '../store/layoutStore';
import { ensureDaemonConnected } from '../api/daemonChatBridge';
import { getDesktopDaemonClient } from '../api/daemonClient';
import { fetchEngineStatus, type EngineStatus } from '../api/engineConfig';
import { estimateCostUsd, loadPrices, upsertPrice, type ModelPrice } from '../api/pricingStore';
import { isDeveloperEngineUiEnabled } from '../api/productMode';
import { isDemoMode } from '../api/appMode';
import { networkUserMessage } from '../api/userFacingErrors';
import { getWorkspacePath } from '../api/projectStore';
import { FontSettingsSection } from './FontSettingsSection';
import { ModelsSettingsTab } from './ModelsSettingsTab';
import { SkillsSettingsTab } from './SkillsSettingsTab';
import { McpSettingsTab } from './McpSettingsTab';
import { SettingsScheduleTab } from './SettingsScheduleTab';
import { SettingsRulesTab } from './SettingsRulesTab';
import { SettingsSecurityTab } from './SettingsSecurityTab';
import { SettingsSelect } from './SettingsSelect';
import { loadMirrorMeta } from '../api/sessionDiskMirror';
import {
  getCachedCapabilities,
  refreshProductCapabilities,
} from '../api/capabilitiesStore';
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
  'skills',
  'mcp',
  'usage',
  'schedule',
  'rules',
  'shortcuts',
  'security',
];
const DEMO_ONLY_TAB_IDS: TabType[] = ['plugins'];

function allowedTabIds(_mcpAvailable: boolean): TabType[] {
  const base = [...FORMAL_TAB_IDS];
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
  const [mcpAvailable, setMcpAvailable] = useState(false);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);

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
  
  // Scope states
  const [scope] = useState<'global' | 'project'>('global');

  // Expanded Plugin Package states (demo plugins tab)
  const [newPkgSource, setNewPkgSource] = useState('');
  const [newPkgExtensions, setNewPkgExtensions] = useState('');
  const [newPkgSkills, setNewPkgSkills] = useState('');

  const [showAddPluginModal, setShowAddPluginModal] = useState(false);

  // 全覆盖设置：Esc 返回工作区（二级弹层打开时不抢）
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (rulesModalOpen || showAddPluginModal) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, rulesModalOpen, showAddPluginModal]);

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
  const [priceList, setPriceList] = useState<ModelPrice[]>(() => loadPrices());
  const [priceDraft, setPriceDraft] = useState({ model: '', input: '', output: '' });
  const [diskMeta, setDiskMeta] = useState(() => loadMirrorMeta());

  useEffect(() => {
    // T7：打开设置时探测 list-capabilities + MCP probe（60s 缓存，诚实状态）
    void refreshProductCapabilities().then(() => {
      const c = getCachedCapabilities();
      setMcpAvailable(Boolean(c?.probe?.configured));
    });
  }, []);

  useEffect(() => {
    if (activeTab !== 'models' && activeTab !== 'usage') return;
    void fetchEngineStatus().then(setEngineStatus);
    if (activeTab === 'usage') setPriceList(loadPrices());
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'profile') return;
    setDiskMeta(loadMirrorMeta());
  }, [activeTab]);

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
        // 模型/密钥走 ModelsSettingsTab；规则/调度走各自 tab
        const sets = await clientApi.getSettingsEx(cwd);
        setSettings(sets);
        if (sets && sets.theme) {
          const { applyTheme, normalizeTheme } = await import('../api/themeStore');
          applyTheme(normalizeTheme(sets.theme));
        }
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

  if (!settings) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        <div className="loading-spinner" style={{ width: '24px', height: '24px', borderWidth: '2.5px', marginBottom: '8px' }} />
        <span style={{ fontSize: '12px' }}>正在加载设置管理器...</span>
      </div>
    );
  }

  return (
    <div
      className="settings-panel settings-panel--cover"
      onWheel={handleRootWheel}
    >
      <header className="settings-cover-header" data-tauri-drag-region>
        <div className="settings-cover-header-left" data-tauri-drag-region>
          {onClose ? (
            <button
              type="button"
              className="settings-back-btn no-drag"
              data-tauri-drag-region="false"
              onClick={onClose}
              title="返回工作区"
            >
              <Lucide.ArrowLeft size={16} />
              <span>返回</span>
            </button>
          ) : null}
          <div className="settings-cover-title-block" data-tauri-drag-region>
            <h1 className="settings-cover-title">设置</h1>
            <span className="settings-cover-subtitle">偏好与工作区配置</span>
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            className="settings-cover-close no-drag"
            data-tauri-drag-region="false"
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
              { id: 'skills' as const, label: '技能', icon: Lucide.GraduationCap, group: '智能' },
              { id: 'usage' as const, label: '用量', icon: Lucide.PieChart, group: '智能' },
              { id: 'rules' as const, label: '规则', icon: Lucide.FileText, group: '智能' },
              { id: 'schedule' as const, label: '定时任务', icon: Lucide.Clock, group: '工作' },
              { id: 'shortcuts' as const, label: '快捷键', icon: Lucide.Keyboard, group: '工作' },
              { id: 'mcp' as const, label: '扩展服务', icon: Lucide.Server, group: '工作' },
              ...(isDemoMode()
                ? ([{ id: 'plugins' as const, label: '插件', icon: Lucide.Blocks, group: '演示' }] as const)
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
            <div className="settings-pane">
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
                  <label className="settings-field-label">会话数据位置</label>
                  <input
                    type="text"
                    readOnly
                    value={
                      diskMeta?.lastPath ||
                      (diskMeta?.mode === 'localStorage-only'
                        ? '浏览器 localStorage（桌面壳可镜像到应用数据目录）'
                        : '本机应用数据目录（自动管理）')
                    }
                    className="settings-field-input"
                    title="自定义目录尚未接入引擎；当前为只读展示"
                  />
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    会话正文由本机保存；自定义路径尚未接入，故不可编辑以免无效配置。
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label className="settings-field-label">网络代理</label>
                  <input
                    type="text"
                    disabled
                    placeholder="尚未接入引擎代理配置"
                    value={settings.httpProxy || ''}
                    className="settings-field-input"
                  />
                  <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
                    代理需在系统或引擎侧配置；此处暂不提供无效输入。
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: MODELS */}
          {activeTab === 'models' && (
            <ModelsSettingsTab onShowToast={onShowToast} />
          )}

          {/* TAB 3: MCP */}
          {activeTab === 'mcp' && (
            <McpSettingsTab
              onShowToast={onShowToast}
              onAvailabilityChange={(ok) => {
                setMcpAvailable(ok);
              }}
            />
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
            <SkillsSettingsTab onShowToast={onShowToast} />
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
                        onShowToast('请填写完整的定价');
                        return;
                      }
                      setPriceList(upsertPrice({ model, inputPerMTok, outputPerMTok }));
                      setPriceDraft({ model: '', input: '', output: '' });
                    }}
                  >
                    保存定价
                  </button>
                </div>
              </div>
            </>
          )}

          {activeTab === 'schedule' && (
            <SettingsScheduleTab onShowToast={onShowToast} />
          )}

          {activeTab === 'rules' && (
            <SettingsRulesTab
              onShowToast={onShowToast}
              onBlockingOverlayChange={setRulesModalOpen}
            />
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
              <div className="settings-section-header" style={{ marginBottom: 4 }}>
                <h4 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>外观</h4>
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

                <label className="settings-row settings-row--toggle settings-row--rich">
                  <div className="settings-row-label">
                    <span className="settings-row-title">隐藏思考过程</span>
                    <span className="settings-row-desc">关闭后对话中不展示「思考中」状态</span>
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
                      const current = settings.responseStyle || 'medium';
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`ui-segment-item ${current === opt.id ? 'active' : ''}`}
                          onClick={() => handleUpdateSettings({ responseStyle: opt.id })}
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

          {activeTab === 'security' && (
            <SettingsSecurityTab onShowToast={onShowToast} />
          )}

        </div>
      </div>

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

    </div>
  );
};

