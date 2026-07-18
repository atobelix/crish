/**
 * 设置 · 个性化：权限、回答风格与界面偏好；成功静默，仅失败提示。
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ResponseStyle, Settings } from '../api/clientApi';
import {
  clientApi,
  normalizeResponseStyle,
  RESPONSE_STYLE_OPTIONS,
} from '../api/clientApi';
import {
  coercePermissionMode,
  PERMISSION_MODES,
  transitionPermissionMode,
  type PermissionMode,
} from '../api/permissionModes';
import { getWorkspacePath } from '../api/projectStore';
import { useLayoutStore } from '../store/layoutStore';
import { SettingsSelect } from './SettingsSelect';
import styles from './SettingsPersonalizeTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './settings/SettingsUI';
import {
  readStoredTheme,
  readStoredPersonalization,
  writeStoredPersonalization,
  applyPersonalization,
  type PersonalizationSettings,
} from '../api/themeStore';

type Props = {
  onShowToast: (msg: string) => void;
};

/** 回答风格：中文说明（本页本地；值仍走 clientApi normalize，不改 clientApi） */
const RESPONSE_STYLE_META: ReadonlyArray<{
  value: ResponseStyle;
  label: string;
  /** 下拉副文案 */
  hint: string;
  /** 行简述 */
  description: string;
}> = [
  {
    value: 'minimal',
    label: '简洁',
    hint: '尽量短',
    description: '少铺垫，直接给结论',
  },
  {
    value: 'low',
    label: '标准',
    hint: '适中',
    description: '要点清楚，篇幅适中',
  },
  {
    value: 'medium',
    label: '详细',
    hint: '分步',
    description: '步骤更完整，便于跟着做',
  },
  {
    value: 'high',
    label: '深入',
    hint: '展开',
    description: '分析更充分，篇幅更长',
  },
];

const STYLE_LABEL_FALLBACK: Record<ResponseStyle, string> = {
  minimal: '简洁',
  low: '标准',
  medium: '详细',
  high: '深入',
};

function styleMeta(id: ResponseStyle) {
  return (
    RESPONSE_STYLE_META.find((m) => m.value === id) ||
    RESPONSE_STYLE_META.find((m) => m.value === 'medium')!
  );
}

/** 选项中文标签 */
function styleLabel(id: ResponseStyle): string {
  return (
    RESPONSE_STYLE_OPTIONS.find((o) => o.value === id)?.label ||
    STYLE_LABEL_FALLBACK[id] ||
    '详细'
  );
}

export const SettingsPersonalizeTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const permissionModeRaw = useLayoutStore((s) => s.permissionMode);
  const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
  const tabModeEnabled = useLayoutStore((s) => s.tabModeEnabled);
  const setTabModeEnabled = useLayoutStore((s) => s.setTabModeEnabled);
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadTick, setLoadTick] = useState(0);

  const permLabelId = useId();
  const styleLabelId = useId();
  const tabLabelId = useId();
  const skinLabelId = useId();

  const [activeTheme, setActiveTheme] = useState<'default' | 'dark'>(() => readStoredTheme());
  const [personalization, setPersonalization] = useState<PersonalizationSettings>(() => readStoredPersonalization());

  // 同步黑夜白天主题的变化
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvt = e as CustomEvent<{ theme: 'default' | 'dark' }>;
      if (customEvt?.detail?.theme) {
        setActiveTheme(customEvt.detail.theme);
      }
    };
    window.addEventListener('crish-theme-changed', handler);
    return () => {
      window.removeEventListener('crish-theme-changed', handler);
    };
  }, []);

  const updatePersonalization = (updates: Partial<PersonalizationSettings>) => {
    const next = { ...personalization, ...updates };
    setPersonalization(next);
    writeStoredPersonalization(next);
    applyPersonalization(next, activeTheme);
  };

  const skinOptions = useMemo(() => {
    const list = activeTheme === 'dark'
      ? [
          { value: 'dark-cozy', label: '护眼暗灰' },
          { value: 'deep-night', label: '深邃夜空' },
          { value: 'dark-forest', label: '森林绿影' },
        ]
      : [
          { value: 'warm-gray', label: '护眼暖灰' },
          { value: 'cream', label: '杏仁奶油' },
          { value: 'paper', label: '极简纸质' },
          { value: 'classic-gray', label: '经典浅灰' },
        ];
    
    list.push({ value: 'custom', label: '自定义颜色' });
    return list;
  }, [activeTheme]);

  // 非法权限值回落 ask
  const permissionMode = coercePermissionMode(permissionModeRaw);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const sets = await clientApi.getSettingsEx(cwd);
        if (cancelled || !sets) return;
        setSettings(sets);
        setLoadError(null);
        setAppSettings(sets);
        if (typeof sets.tabModeEnabled === 'boolean') {
          setTabModeEnabled(sets.tabModeEnabled);
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
  }, [cwd, onShowToast, setAppSettings, setTabModeEnabled, loadTick]);

  /**
   * 本机写入；成功静默（列表/头栏即时反馈）。
   * @returns 是否写入成功；失败已 toast
   */
  const save = useCallback(
    async (updates: Partial<Settings>): Promise<boolean> => {
      if (!settings) return false;
      setSaving(true);
      try {
        const merged = await clientApi.saveSettingsEx(cwd, 'global', updates);
        setSettings(merged);
        setAppSettings(merged);
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

  const responseStyle = normalizeResponseStyle(settings?.responseStyle);
  const style = styleMeta(responseStyle);
  const ready = Boolean(settings) && !saving;

  const responseStyleOptions = useMemo(
    () =>
      RESPONSE_STYLE_META.map((m) => ({
        value: m.value,
        // 标签与 clientApi 对齐（中文）
        label: styleLabel(m.value),
        hint: m.hint,
      })),
    [],
  );

  const permissionOptions = useMemo(
    () =>
      PERMISSION_MODES.map((m) => ({
        value: m.id,
        label: m.label,
        hint: m.matrixHint,
      })),
    [],
  );

  const onPermissionChange = (v: string) => {
    try {
      const next = transitionPermissionMode(permissionMode, v);
      // 已是目标模式：跳过写 store
      if (next === permissionMode) return;
      setPermissionMode(next as PermissionMode);
      // 权限走 layoutStore（LS），成功静默
    } catch (err) {
      onShowToast('权限切换失败：' + String(err));
    }
  };

  const onResponseStyle = (v: string) => {
    if (!settings) return;
    const next = normalizeResponseStyle(v);
    // 已是目标档：跳过写盘
    if (next === responseStyle) return;
    void save({ responseStyle: next });
  };

  const onTabMode = (on: boolean) => {
    if (!settings) return;
    if (on === tabModeEnabled) return;
    const prev = tabModeEnabled;
    setTabModeEnabled(on);
    void (async () => {
      const ok = await save({ tabModeEnabled: on });
      if (!ok) {
        setTabModeEnabled(prev);
      }
    })();
  };



  if (loadError && !settings) {
    return (
      <SettingsPage title="个性化">
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
      <SettingsPage title="个性化">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow title={<span className="settings-list-empty">加载中…</span>} />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="个性化">
      <SettingsSection title="外观与字号">
        <SettingsCard>
          <SettingsRow
            title={<span id={skinLabelId}>外观主题皮肤</span>}
            desc={activeTheme === 'dark' ? '深色模式下可选的预设皮肤' : '浅色模式下可选的预设皮肤'}
            control={
              <SettingsSelect
                className="settings-personalize-select"
                value={personalization.skin}
                options={skinOptions}
                onChange={(v) => updatePersonalization({ skin: v })}
                disabled={!ready}
                placeholder="选择预设…"
              />
            }
          />

          {personalization.skin === 'custom' && (
            <>
              <SettingsRow
                title="自定义背景色"
                control={
                  <input
                    type="color"
                    value={personalization.customBg}
                    onChange={(e) => updatePersonalization({ customBg: e.target.value })}
                    disabled={!ready}
                    className={styles.colorInput}
                  />
                }
              />
              <SettingsRow
                title="自定义文本色"
                desc="自适应计算副文本、边框与悬浮文本色"
                control={
                  <input
                    type="color"
                    value={personalization.customFg}
                    onChange={(e) => updatePersonalization({ customFg: e.target.value })}
                    disabled={!ready}
                    className={styles.colorInput}
                  />
                }
              />
            </>
          )}

          <SettingsRow
            title="字号大小微调"
            desc={`基准字号为 14px，当前字号: ${14 + personalization.fontSizeAdjust}px`}
            control={
              <div className={styles.adjustContainer}>
                <input
                  type="range"
                  min="-2"
                  max="4"
                  step="1"
                  value={personalization.fontSizeAdjust}
                  onChange={(e) => updatePersonalization({ fontSizeAdjust: parseInt(e.target.value, 10) })}
                  disabled={!ready}
                  className={styles.adjustSlider}
                />
                <span className={styles.adjustLabel}>
                  {personalization.fontSizeAdjust >= 0 ? '+' : ''}{personalization.fontSizeAdjust}px
                </span>
              </div>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="对话与界面">
        <SettingsCard>
          <SettingsRow
            title={<span id={permLabelId}>权限模式</span>}
            desc="工具调用前要不要先问你"
            control={
              <SettingsSelect
                className="settings-personalize-select"
                value={permissionMode}
                options={permissionOptions}
                onChange={onPermissionChange}
                disabled={!ready}
                placeholder="选择…"
              />
            }
          />

          <SettingsRow
            title={<span id={styleLabelId}>回答风格</span>}
            desc={style.description}
            control={
              <SettingsSelect
                className="settings-personalize-select"
                value={responseStyle}
                options={responseStyleOptions}
                onChange={onResponseStyle}
                disabled={!ready}
                placeholder="选择…"
              />
            }
          />

          <SettingsRow
            title={<label htmlFor={tabLabelId} className="settings-ui-row-label">合并右侧面板</label>}
            desc="总览、文件等收成标签"
            control={
              <input
                id={tabLabelId}
                type="checkbox"
                className="settings-switch settings-switch--personalize"
                checked={tabModeEnabled}
                disabled={!ready}
                aria-label="合并右侧面板"
                onChange={(e) => {
                  onTabMode(e.target.checked);
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
};

