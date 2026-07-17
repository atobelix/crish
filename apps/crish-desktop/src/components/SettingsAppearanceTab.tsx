/**
 * 设置 · 外观：主题、密度、字体与阅读相关选项；改完即生效，仅失败提示。
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../api/clientApi';
import { clientApi } from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import { useLayoutStore } from '../store/layoutStore';
import {
  parseShellChromeMode,
  type ShellChromeMode,
} from '../api/shellChrome';
import { FontSettingsSection } from './FontSettingsSection';
import { SettingsSelect } from './SettingsSelect';

type Props = {
  onShowToast: (msg: string) => void;
};

type UiSize = 'small' | 'medium' | 'large';
type ThemeId = 'default' | 'dark';

/** 密度三档 */
const DENSITY_OPTS: {
  id: UiSize;
  label: string;
  /** 控件 title + 辅助说明 */
  hint: string;
}[] = [
  { id: 'small', label: '紧凑', hint: '更省空间' },
  { id: 'medium', label: '标准', hint: '默认' },
  { id: 'large', label: '宽松', hint: '更易阅读' },
];

const THEME_OPTS: { id: ThemeId; label: string; hint: string }[] = [
  { id: 'default', label: '浅色', hint: '浅色' },
  { id: 'dark', label: '深色', hint: '深色' },
];

const INDENT_OPTS = [
  { value: '  ', label: '2 空格' },
  { value: '    ', label: '4 空格' },
  { value: '\t', label: 'Tab' },
] as const;

const CHROME_OPTS: {
  id: ShellChromeMode;
  label: string;
  hint: string;
}[] = [
  {
    id: 'classic',
    label: '经典',
    hint: '传统布局',
  },
  {
    id: 'inset',
    label: '工作台',
    hint: '推荐布局',
  },
];

/** 非法值回落标准 */
function normalizeUiSize(raw: unknown): UiSize {
  if (raw === 'small' || raw === 'large' || raw === 'medium') return raw;
  return 'medium';
}

function normalizeTheme(raw: unknown): ThemeId {
  return raw === 'dark' ? 'dark' : 'default';
}

/** 代码缩进：仅白名单，防异常 settings 写出非法缩进 */
function normalizeCodeIndent(raw: unknown): string {
  if (raw === '  ' || raw === '    ' || raw === '\t') return raw;
  return '  ';
}

export const SettingsAppearanceTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);
  const uiSize = useLayoutStore((s) => s.uiSize);
  const setUiSize = useLayoutStore((s) => s.setUiSize);
  const shellChromeMode = useLayoutStore((s) => s.shellChromeMode);
  const setShellChromeMode = useLayoutStore((s) => s.setShellChromeMode);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (cancelled || !sets) return;
        setSettings(sets);
        setLoadError(null);
        // 读盘后立即同步 DOM（主题 / 字体），与 local 独立 key 对齐
        try {
          if (sets.theme) {
            const { applyTheme, normalizeTheme: normTheme } = await import('../api/themeStore');
            applyTheme(normTheme(sets.theme));
          }
          if (sets.fonts) {
            const { applyFontStacks, ensureFontsLoaded, normalizeFontPrefs } = await import(
              '../api/fontStore'
            );
            const prefs = normalizeFontPrefs(sets.fonts);
            await ensureFontsLoaded(prefs);
            applyFontStacks(prefs);
          }
        } catch (applyErr) {
          if (!cancelled) {
            onShowToast('外观应用失败：' + String(applyErr));
          }
        }
      } catch (err) {
        if (!cancelled) {
          const msg = '读取失败：' + String(err);
          setLoadError(msg);
          onShowToast(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, onShowToast, loadTick]);

  /** @returns 是否写入成功；失败已 toast，不抛给点击处理器 */
  const save = useCallback(
    async (updates: Partial<Settings>): Promise<boolean> => {
      if (!settings) return false;
      setSaving(true);
      try {
        const merged = await clientApi.saveSettingsEx(cwd, 'global', updates);
        setSettings(merged);
        setAppSettings(merged);
        if (updates.theme) {
          const { setTheme } = await import('../api/themeStore');
          setTheme(updates.theme);
        }
        // fonts：FontSettingsSection 已 setFontPreferences；此处仅当其它入口写入 fonts 时补 apply
        if (updates.fonts) {
          const { setFontPreferences, normalizeFontPrefs } = await import('../api/fontStore');
          await setFontPreferences(normalizeFontPrefs(updates.fonts));
        }
        // 成功静默：不 toast「已保存」
        return true;
      } catch (err) {
        onShowToast('保存失败：' + String(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [cwd, onShowToast, setAppSettings, settings],
  );

  const applyDensity = useCallback(
    (size: UiSize) => {
      try {
        const next = normalizeUiSize(size);
        // 已是目标档：跳过写 LS / DOM，避免无意义回流
        if (normalizeUiSize(uiSize) === next) {
          const cur = document.documentElement.getAttribute('data-ui-size');
          if (cur !== next) {
            document.documentElement.setAttribute('data-ui-size', next);
          }
          return;
        }
        setUiSize(next);
        document.documentElement.setAttribute('data-ui-size', next);
      } catch (err) {
        onShowToast('密度保存失败：' + String(err));
      }
    },
    [onShowToast, setUiSize, uiSize],
  );

  const applyChrome = useCallback(
    (mode: ShellChromeMode) => {
      try {
        const next = parseShellChromeMode(mode);
        if (parseShellChromeMode(shellChromeMode) === next) {
          document.documentElement.setAttribute('data-shell-chrome', next);
          return;
        }
        setShellChromeMode(next);
        document.documentElement.setAttribute('data-shell-chrome', next);
        document.body.setAttribute('data-shell-chrome', next);
      } catch (err) {
        onShowToast('界面形态保存失败：' + String(err));
      }
    },
    [onShowToast, setShellChromeMode, shellChromeMode],
  );

  const applyTheme = useCallback(
    (id: ThemeId) => {
      if (!settings) return;
      if (normalizeTheme(settings.theme) === id) return;
      void save({ theme: id });
    },
    [save, settings],
  );

  if (!settings) {
    return (
      <div className="settings-pane settings-pane--modern settings-pane--appearance">
        <header className="settings-page-head">
          <div className="settings-head-inline">
            <h2 className="settings-page-title">外观</h2>
          </div>
        </header>
        {loadError ? (
          <section className="settings-group" aria-label="错误">
            <div className="settings-list">
              <div className="settings-list-row settings-list-row--single">
                <div className="settings-list-copy">
                  <div className="settings-list-title settings-list-empty" role="alert">
                    {loadError}
                  </div>
                </div>
                <div className="settings-list-control">
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    aria-label="重新加载外观设置"
                    onClick={() => {
                      setLoadError(null);
                      setLoadTick((n) => n + 1);
                    }}
                  >
                    重试
                  </button>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <div className="settings-list" role="status" aria-live="polite" aria-busy="true">
            <div className="settings-list-row settings-list-row--single">
              <div className="settings-list-copy">
                <div className="settings-list-title settings-list-empty">加载中…</div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const theme = normalizeTheme(settings.theme);
  const hideThinking = Boolean(settings.hideThinkingBlock);
  const codeIndent = normalizeCodeIndent(settings.markdown?.codeBlockIndent);
  const density = normalizeUiSize(uiSize);
  const chrome = parseShellChromeMode(shellChromeMode);

  return (
    <div
      className="settings-pane settings-pane--modern settings-pane--appearance"
      aria-busy={saving || undefined}
    >
      <header className="settings-page-head">
        <div className="settings-head-inline">
          <h2 className="settings-page-title">外观</h2>
        </div>
      </header>

      <section className="settings-group" aria-labelledby="settings-appearance-display-label">
        <div className="settings-group-label" id="settings-appearance-display-label">
          主题与阅读
        </div>
        <div className="settings-list">
          <div className="settings-list-row settings-list-row--single" >
            <div className="settings-list-copy">
              <div className="settings-list-title" id="settings-appearance-theme-label">
                主题
              </div>
            </div>
            <div className="settings-list-control">
              <div
                className="ui-segment ui-segment--inline settings-choice-group"
                role="group"
                aria-labelledby="settings-appearance-theme-label"
                aria-label="界面主题"
              >
                {THEME_OPTS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ui-segment-item ${theme === opt.id ? 'active' : ''}`}
                    disabled={saving}
                    aria-pressed={theme === opt.id}
                    title={opt.hint}
                    onClick={() => applyTheme(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div
            className="settings-list-row settings-list-row--single"
            title="界面疏密"
          >
            <div className="settings-list-copy">
              <div className="settings-list-title" id="settings-appearance-density-label">
                密度
              </div>
            </div>
            <div className="settings-list-control">
              <div
                className="ui-segment ui-segment--inline settings-choice-group settings-density-segment"
                role="group"
                aria-labelledby="settings-appearance-density-label"
                aria-label="界面密度"
              >
                {DENSITY_OPTS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ui-segment-item ${density === opt.id ? 'active' : ''}`}
                    disabled={saving}
                    aria-pressed={density === opt.id}
                    aria-label={`${opt.label}：${opt.hint}`}
                    title={opt.hint}
                    onClick={() => applyDensity(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div
            className="settings-list-row settings-list-row--single"
            title="窗口布局风格"
          >
            <div className="settings-list-copy">
              <div className="settings-list-title" id="settings-appearance-chrome-label">
                界面形态
              </div>
            </div>
            <div className="settings-list-control">
              <div
                className="ui-segment ui-segment--inline settings-choice-group"
                role="group"
                aria-labelledby="settings-appearance-chrome-label"
                aria-label="界面形态"
              >
                {CHROME_OPTS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`ui-segment-item ${chrome === opt.id ? 'active' : ''}`}
                    disabled={saving}
                    aria-pressed={chrome === opt.id}
                    title={opt.hint}
                    onClick={() => applyChrome(opt.id)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="settings-list-row settings-list-row--single" title="代码块缩进">
            <div className="settings-list-copy">
              <div className="settings-list-title" id="settings-appearance-indent-label">
                代码缩进
              </div>
            </div>
            <div className="settings-list-control">
              <SettingsSelect
                value={codeIndent}
                disabled={saving}
                options={[...INDENT_OPTS]}
                onChange={(v) => {
                  const next = normalizeCodeIndent(v);
                  if (next === codeIndent) return;
                  void save({
                    markdown: { ...(settings.markdown || {}), codeBlockIndent: next },
                  });
                }}
              />
            </div>
          </div>

          <label
            className="settings-list-row settings-list-row--single settings-list-row--clickable"
            title="对话里不显示思考内容"
          >
            <div className="settings-list-copy">
              <div className="settings-list-title">隐藏思考过程</div>
            </div>
            <div className="settings-list-control">
              <input
                type="checkbox"
                className="settings-switch"
                checked={hideThinking}
                disabled={saving}
                aria-label="隐藏思考过程"
                onChange={(e) => {
                  const next = e.target.checked;
                  if (next === hideThinking) return;
                  void save({ hideThinkingBlock: next });
                }}
              />
            </div>
          </label>
        </div>
      </section>

      <section className="settings-group" aria-label="字体">
        <div className="settings-group-label">字体</div>
        <div className="settings-list settings-list--flush settings-list--fonts">
          <FontSettingsSection
            onShowToast={onShowToast}
            onPersistSettings={async (fonts) => {
              const ok = await save({ fonts });
              if (!ok) {
                // 抛出让字体区知道 settings 未同步（本地栈仍已生效）；toast 已由 save 发出
                throw new Error('字体设置未写入 settings');
              }
            }}
          />
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-appearance-reset-label">
        <div className="settings-group-label" id="settings-appearance-reset-label">
          其他
        </div>
        <div className="settings-list">
          <div
            className="settings-list-row settings-list-row--single"
            title="恢复默认外观"
          >
            <div className="settings-list-copy">
              <div className="settings-list-title">重置外观</div>
            </div>
            <div className="settings-list-control">
              <button
                type="button"
                className="ui-btn ui-btn-secondary ui-btn-sm"
                disabled={saving}
                aria-label="重置外观为默认"
                title="恢复默认"
                onClick={() => {
                  void (async () => {
                    try {
                      const { DEFAULT_FONT_PREFS, setFontPreferences } = await import(
                        '../api/fontStore'
                      );
                      const ok = await save({
                        theme: 'default',
                        hideThinkingBlock: false,
                        markdown: { ...(settings.markdown || {}), codeBlockIndent: '  ' },
                        fonts: { ...DEFAULT_FONT_PREFS },
                      });
                      if (!ok) return;
                      const { setTheme } = await import('../api/themeStore');
                      setTheme('default');
                      await setFontPreferences({ ...DEFAULT_FONT_PREFS });
                      applyDensity('medium');
                    } catch (err) {
                      onShowToast('重置失败：' + String(err));
                    }
                  })();
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
