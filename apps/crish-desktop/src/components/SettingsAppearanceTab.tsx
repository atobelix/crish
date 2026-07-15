/**
 * 设置 · 外观（现代化列表行：大标题、副文案、右侧控件、无脏色块）
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

const THEME_LABELS: Record<string, string> = {
  default: '浅色',
  dark: '深色',
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

  const handleResetAppearance = async () => {
    if (!settings) return;
    try {
      const merged = await clientApi.saveSettingsEx(cwd, 'global', {
        theme: 'default',
        hideThinkingBlock: false,
      });
      setSettings(merged);
      const { setTheme } = await import('../api/themeStore');
      setTheme('default');
      onShowToast('已重置外观为默认（浅色主题，显示思考过程）');
    } catch (err) {
      onShowToast('重置失败：' + String(err));
    }
  };

  if (!settings) {
    return (
      <div className="settings-pane settings-pane--loading">
        <div className="settings-page-head">
          <h2 className="settings-page-title">外观</h2>
          <p className="settings-page-desc">加载中…</p>
        </div>
      </div>
    );
  }

  const theme = settings.theme || 'default';
  const themeLabel = THEME_LABELS[theme] || theme || '浅色';
  const hideThinking = Boolean(settings.hideThinkingBlock);
  const codeIndent = settings.markdown?.codeBlockIndent || '  ';

  return (
    <div className="settings-pane settings-pane--modern">
      <header className="settings-page-head">
        <h2 className="settings-page-title">外观</h2>
        <p className="settings-page-desc">主题、字体与阅读偏好，影响整个应用的视觉感受。</p>
      </header>

      <section className="settings-group" aria-label="主题与布局">
        <div className="settings-group-label">主题与布局</div>
        <div className="settings-list">
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">主题</div>
              <div className="settings-list-sub">
                当前主题：{themeLabel} · 浅色适合白天；深色适合弱光环境
              </div>
            </div>
            <div className="settings-list-control">
              <div className="ui-segment ui-segment--inline settings-segment-pill">
                {(
                  [
                    { id: 'default', label: '浅色' },
                    { id: 'dark', label: '深色' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ui-segment-item ${theme === opt.id ? 'active' : ''}`}
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

          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">代码缩进</div>
              <div className="settings-list-sub">Markdown / 代码块展示时的缩进字符</div>
            </div>
            <div className="settings-list-control">
              <SettingsSelect
                value={codeIndent}
                options={[
                  { value: '  ', label: '2 空格' },
                  { value: '    ', label: '4 空格' },
                  { value: '\t', label: 'Tab' },
                ]}
                onChange={(v) =>
                  void handleUpdateSettings({
                    markdown: { ...(settings.markdown || {}), codeBlockIndent: v },
                  })
                }
              />
            </div>
          </div>

          <label className="settings-list-row settings-list-row--clickable">
            <div className="settings-list-copy">
              <div className="settings-list-title">隐藏思考过程</div>
              <div className="settings-list-sub">开启后对话中不展示模型思考区</div>
            </div>
            <div className="settings-list-control">
              <input
                type="checkbox"
                className="settings-switch"
                checked={hideThinking}
                onChange={(e) => {
                  void handleUpdateSettings({
                    hideThinkingBlock: e.target.checked,
                  });
                }}
              />
            </div>
          </label>
        </div>
      </section>

      <section className="settings-group" aria-label="字体">
        <div className="settings-group-label">字体</div>
        <div className="settings-list settings-list--spaced settings-list--flush">
          <FontSettingsSection
            onShowToast={onShowToast}
            onPersistSettings={async (fonts) => {
              try {
                await handleUpdateSettings({ fonts });
              } catch (err) {
                onShowToast('保存字体失败：' + String(err));
              }
            }}
          />
        </div>
      </section>

      <section className="settings-group" aria-label="重置">
        <div className="settings-group-label">重置</div>
        <div className="settings-list settings-list--spaced">
          <div className="settings-list-row">
            <div className="settings-list-copy">
              <div className="settings-list-title">重置外观为默认</div>
              <div className="settings-list-sub">
                恢复浅色主题，并显示思考过程（不影响字体与代码缩进）
              </div>
            </div>
            <div className="settings-list-control">
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                onClick={() => {
                  void handleResetAppearance();
                }}
              >
                重置
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
