/**
 * 设置 · 外观：主题、密度、字体与阅读相关选项；改完即生效，仅失败提示。
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
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
import styles from './SettingsAppearanceTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
  Tooltip,
} from './settings/SettingsUI';

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
  const hideThinkingId = useId();
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

  if (loadError && !settings) {
    return (
      <SettingsPage title="外观">
        <SettingsSection title="错误">
          <SettingsCard>
            <SettingsRow
              title={<span className="settings-list-empty" role="alert">{loadError}</span>}
              control={
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  onClick={() => {
                    setLoadError(null);
                    setLoadTick((n) => n + 1);
                  }}
                >
                  重试
                </button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  if (!settings) {
    return (
      <SettingsPage title="外观">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow title={<span className="settings-list-empty">加载中…</span>} />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  const theme = normalizeTheme(settings.theme);
  const hideThinking = Boolean(settings.hideThinkingBlock);
  const codeIndent = normalizeCodeIndent(settings.markdown?.codeBlockIndent);
  const density = normalizeUiSize(uiSize);
  const chrome = parseShellChromeMode(shellChromeMode);

  return (
    <SettingsPage title="外观">
        <SettingsSection title="主题与阅读">
          <SettingsCard>
            <SettingsRow
              title={<span id="settings-appearance-theme-label">主题</span>}
              control={
                <div
                  className={styles.settingsChoiceGroup}
                  role="group"
                  aria-labelledby="settings-appearance-theme-label"
                >
                  {THEME_OPTS.map((opt) => (
                    <Tooltip key={opt.id} content={opt.hint}>
                      <button
                        type="button"
                        className={`${styles.segmentItem}${theme === opt.id ? ` ${styles.active}` : ''}`}
                        disabled={saving}
                        aria-pressed={theme === opt.id}
                        onClick={() => applyTheme(opt.id)}
                      >
                        {opt.label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              }
            />

            <SettingsRow
              title={<span id="settings-appearance-density-label">密度</span>}
              control={
                <div
                  className={`${styles.settingsChoiceGroup} ${styles.settingsDensitySegment}`}
                  role="group"
                  aria-labelledby="settings-appearance-density-label"
                >
                  {DENSITY_OPTS.map((opt) => (
                    <Tooltip key={opt.id} content={opt.hint}>
                      <button
                        type="button"
                        className={`${styles.segmentItem}${density === opt.id ? ` ${styles.active}` : ''}`}
                        disabled={saving}
                        aria-pressed={density === opt.id}
                        onClick={() => applyDensity(opt.id)}
                      >
                        {opt.label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              }
            />

            <SettingsRow
              title={<span id="settings-appearance-chrome-label">界面形态</span>}
              control={
                <div
                  className={styles.settingsChoiceGroup}
                  role="group"
                  aria-labelledby="settings-appearance-chrome-label"
                >
                  {CHROME_OPTS.map((opt) => (
                    <Tooltip key={opt.id} content={opt.hint}>
                      <button
                        type="button"
                        className={`${styles.segmentItem}${chrome === opt.id ? ` ${styles.active}` : ''}`}
                        disabled={saving}
                        aria-pressed={chrome === opt.id}
                        onClick={() => applyChrome(opt.id)}
                      >
                        {opt.label}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              }
            />

            <SettingsRow
              title={<span id="settings-appearance-indent-label">代码缩进</span>}
              control={
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
              }
            />

            <SettingsRow
              title={<label htmlFor={hideThinkingId} className="settings-ui-row-label">隐藏思考过程</label>}
              control={
                <input
                  id={hideThinkingId}
                  type="checkbox"
                  className="settings-switch"
                  checked={hideThinking}
                  disabled={saving}
                  aria-label="隐藏思考过程"
                  onChange={(e) => {
                    void save({ hideThinkingBlock: e.target.checked });
                  }}
                />
              }
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="字体">
          <SettingsCard>
            <FontSettingsSection
              onShowToast={onShowToast}
              onPersistSettings={async (fonts) => {
                const ok = await save({ fonts });
                if (!ok) {
                  throw new Error('字体设置未写入 settings');
                }
              }}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="其他">
          <SettingsCard>
            <SettingsRow
              title="重置外观"
              control={
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary ui-btn-sm"
                  disabled={saving}
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
              }
            />
        </SettingsCard>
        </SettingsSection>
    </SettingsPage>
  );
};
