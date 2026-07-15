/**
 * 设置 · 个性化（现代化列表行：大标题、副文案、右侧控件、无脏色块）
 */
import React, { useEffect, useState } from 'react';
import type { Settings } from '../api/clientApi';
import { clientApi } from '../api/clientApi';
import { PERMISSION_MODES, type PermissionMode } from '../api/permissionModes';
import { getWorkspacePath } from '../api/projectStore';
import { useLayoutStore } from '../store/layoutStore';

type Props = {
  onShowToast: (msg: string) => void;
};

export const SettingsPersonalizeTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const permissionMode = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const tabModeEnabled = useLayoutStore((s) => s.tabModeEnabled);
  const setTabModeEnabled = useLayoutStore((s) => s.setTabModeEnabled);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (!cancelled && sets) setSettings(sets);
      } catch (err) {
        onShowToast('读取设置失败：' + String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, onShowToast]);

  const handleUpdateSettings = async (updates: Partial<Settings>) => {
    if (!settings) return;
    try {
      const merged = await clientApi.saveSettingsEx(cwd, 'global', updates);
      setSettings(merged);
    } catch (err) {
      onShowToast('更新设置失败：' + String(err));
    }
  };

  const permissionDesc =
    PERMISSION_MODES.find((m) => m.id === permissionMode)?.description ?? '';
  const responseStyle = settings?.responseStyle || 'medium';

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">个性化</h2>
        <p className="settings-page-desc">交互习惯与默认权限，影响对话与右侧工具的打开方式。</p>
      </header>

      <section className="settings-group" aria-label="权限与交互">
        <div className="settings-group-label">权限与交互</div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">默认权限模式</div>
              <div className="settings-list-sub">{permissionDesc}</div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="ui-segment ui-segment--inline settings-segment-pill">
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
            </div>
          </div>

          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">回答风格</div>
              <div className="settings-list-sub">回答风格属于交互偏好，放在个性化里更合适。</div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="ui-segment ui-segment--inline settings-segment-pill">
                {(
                  [
                    { id: 'minimal', label: '简洁' },
                    { id: 'low', label: '标准' },
                    { id: 'medium', label: '详细' },
                    { id: 'high', label: '深入' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ui-segment-item ${responseStyle === opt.id ? 'active' : ''}`}
                    onClick={() => {
                      void handleUpdateSettings({ responseStyle: opt.id });
                    }}
                    disabled={!settings}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="settings-list-row settings-list-row--clickable">
            <div className="settings-list-copy">
              <div className="settings-list-title">优先合并为标签页</div>
              <div className="settings-list-sub">打开右侧工具时尽量并入同一列标签</div>
            </div>
            <div className="settings-list-control">
              <input
                type="checkbox"
                className="settings-switch"
                checked={tabModeEnabled}
                onChange={(e) => setTabModeEnabled(e.target.checked)}
              />
            </div>
          </label>
        </div>
      </section>

      <section className="settings-group" aria-label="侧栏">
        <div className="settings-group-label">侧栏</div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--stack">
            <div className="settings-list-copy">
              <div className="settings-list-title">默认打开的侧栏工具</div>
              <div className="settings-list-sub">
                从对话区可随时打开；此处仅作说明。常用：变更、终端、任务。
              </div>
            </div>
            <div className="settings-list-stack-controls">
              <div className="settings-list-stack-actions">
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
        </div>
      </section>
    </div>
  );
};
