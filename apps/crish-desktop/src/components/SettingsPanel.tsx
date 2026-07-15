import React, { useState, useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';
import { clientApi } from '../api/clientApi';
import type { Settings, PackageSource } from '../api/clientApi';
import { useLayoutStore } from '../store/layoutStore';
import { isDemoMode } from '../api/appMode';
import { getWorkspacePath } from '../api/projectStore';
import {
  getCachedCapabilities,
  refreshProductCapabilities,
} from '../api/capabilitiesStore';
import { ModelsSettingsTab } from './ModelsSettingsTab';
import { SkillsSettingsTab } from './SkillsSettingsTab';
import { McpSettingsTab } from './McpSettingsTab';
import { SettingsScheduleTab } from './SettingsScheduleTab';
import { SettingsRulesTab } from './SettingsRulesTab';
import { SettingsSecurityTab } from './SettingsSecurityTab';
import { SettingsProfileTab } from './SettingsProfileTab';
import { SettingsAppearanceTab } from './SettingsAppearanceTab';
import { SettingsUsageTab } from './SettingsUsageTab';
import { SettingsShortcutsTab } from './SettingsShortcutsTab';
import { SettingsPersonalizeTab } from './SettingsPersonalizeTab';

/** Settings sidebar tab ids — shared for openSettings / initialTab typing */
export type SettingsTabType =
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

type TabType = SettingsTabType;

interface SettingsPanelProps {
  wsId: string;
  onShowToast: (msg: string) => void;
  onClose?: () => void;
  initialTab?: SettingsTabType;
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

  // Expanded Plugin Package states (demo plugins tab)
  const [packages, setPackages] = useState<(string | PackageSource)[]>([]);
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

  useEffect(() => {
    // T7：打开设置时探测 list-capabilities + MCP probe（60s 缓存，诚实状态）
    void refreshProductCapabilities().then(() => {
      const c = getCachedCapabilities();
      setMcpAvailable(Boolean(c?.probe?.configured));
    });
  }, []);

  // Demo plugins：仅在需要时读 packages
  const cwd = getWorkspacePath() || '__global__';
  useEffect(() => {
    if (!isDemoMode() || activeTab !== 'plugins') return;
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (!cancelled && sets) setPackages(sets.packages || []);
      } catch (err) {
        onShowToast('读取设置失败：' + String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, cwd, onShowToast]);

  const handleUpdatePackages = async (list: (string | PackageSource)[]) => {
    try {
      const merged: Settings = await clientApi.saveSettingsEx(cwd, 'global', { packages: list });
      setPackages(merged.packages || list);
    } catch {
      onShowToast('更新插件包失败');
    }
  };

  const handleAddPackage = async () => {
    if (!newPkgSource.trim()) return;

    const source = newPkgSource.trim();
    // Validate: standard package name, scoped package, git URL, or GitHub shortcut
    const isValidPkg =
      /^[a-z0-9_.-]+$/i.test(source) ||
      /^@[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(source) ||
      /^(git|git\+https?|git\+ssh):\/\//i.test(source) ||
      /\.git$/i.test(source) ||
      /^(github|gitlab|bitbucket):[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(source);
    if (!isValidPkg) {
      onShowToast('无效的插件包名称或源地址。支持普通包名、@scope/包名 以及 Git/GitHub 源。');
      return;
    }

    try {
      const list = [...packages];
      if (newPkgExtensions.trim() || newPkgSkills.trim()) {
        const obj: PackageSource = {
          source,
          extensions: newPkgExtensions ? newPkgExtensions.split(',').map((e) => e.trim()) : undefined,
          skills: newPkgSkills ? newPkgSkills.split(',').map((s) => s.trim()) : undefined,
        };
        list.push(obj);
      } else {
        list.push(source);
      }
      await handleUpdatePackages(list);
      setNewPkgSource('');
      setNewPkgExtensions('');
      setNewPkgSkills('');
    } catch {
      onShowToast('添加插件包失败');
    }
  };

  const handleRemovePackage = async (idx: number) => {
    try {
      const list = [...packages];
      list.splice(idx, 1);
      await handleUpdatePackages(list);
    } catch {
      onShowToast('移除插件包失败');
    }
  };

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
          {activeTab === 'profile' && (
            <SettingsProfileTab onShowToast={onShowToast} />
          )}

          {activeTab === 'appearance' && (
            <SettingsAppearanceTab onShowToast={onShowToast} />
          )}

          {activeTab === 'personalize' && (
            <SettingsPersonalizeTab onShowToast={onShowToast} />
          )}

          {activeTab === 'models' && (
            <ModelsSettingsTab onShowToast={onShowToast} />
          )}

          {activeTab === 'mcp' && (
            <McpSettingsTab
              onShowToast={onShowToast}
              onAvailabilityChange={(ok) => {
                setMcpAvailable(ok);
              }}
            />
          )}

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
                {packages.map((pkg, idx) => {
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
                {packages.length === 0 && (
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
            <SettingsUsageTab onShowToast={onShowToast} />
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

          {activeTab === 'shortcuts' && (
            <SettingsShortcutsTab onShowToast={onShowToast} />
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
              <button onClick={() => setShowAddPluginModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)' }}>
                <Lucide.X size={16} />
              </button>
            </div>

            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <p style={{ fontSize: '11px', color: 'var(--text-tertiary)', margin: 0 }}>支持输入 npm 包名或 Git 仓库链接，自定义筛选或注入特定的开发技能。</p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label className="settings-field-label">包名或 Git 源</label>
                <input
                  type="text"
                  placeholder="例如: @conex/voice-playback 或 https://github.com/org/plugin"
                  value={newPkgSource}
                  onChange={(e) => setNewPkgSource(e.target.value)}
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
                    onChange={(e) => setNewPkgExtensions(e.target.value)}
                    className="settings-field-input"
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label className="settings-field-label">注入技能</label>
                  <input
                    type="text"
                    placeholder="例如: audit,voice"
                    value={newPkgSkills}
                    onChange={(e) => setNewPkgSkills(e.target.value)}
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
                  onClick={() => { void handleAddPackage(); setShowAddPluginModal(false); }}
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
