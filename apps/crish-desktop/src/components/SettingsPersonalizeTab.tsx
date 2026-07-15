/**
 * 设置 · 个性化：默认权限、回答风格、标签页合并、侧栏说明
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

  return (
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
              const current = settings?.responseStyle || 'medium';
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`ui-segment-item ${current === opt.id ? 'active' : ''}`}
                  onClick={() => handleUpdateSettings({ responseStyle: opt.id })}
                  disabled={!settings}
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
            checked={tabModeEnabled}
            onChange={(e) => setTabModeEnabled(e.target.checked)}
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
  );
};
