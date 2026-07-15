/**
 * 设置 · 外观：主题、代码缩进、字体、隐藏思考过程
 */
import React, { useEffect, useState } from 'react';
import type { Settings } from '../api/clientApi';
import { clientApi } from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import { FontSettingsSection } from './FontSettingsSection';
import { SettingsSelect } from './SettingsSelect';

type Props = {
  onShowToast: (msg: string) => void;
};

export const SettingsAppearanceTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (cancelled || !sets) return;
        setSettings(sets);
        if (sets.theme) {
          const { applyTheme, normalizeTheme } = await import('../api/themeStore');
          applyTheme(normalizeTheme(sets.theme));
        }
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

      if (updates.theme) {
        const { setTheme } = await import('../api/themeStore');
        setTheme(updates.theme);
      }
      if (updates.fonts) {
        const { setFontPreferences, normalizeFontPrefs } = await import('../api/fontStore');
        await setFontPreferences(normalizeFontPrefs(updates.fonts));
      }
    } catch (err) {
      onShowToast('更新设置失败：' + String(err));
    }
  };

  if (!settings) {
    return (
      <div style={{ padding: '16px 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
        加载外观设置…
      </div>
    );
  }

  return (
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
  );
};
