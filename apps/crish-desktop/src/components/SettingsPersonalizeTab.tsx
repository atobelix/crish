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
  permissionModeMeta,
  transitionPermissionMode,
  type PermissionMode,
} from '../api/permissionModes';
import { getWorkspacePath } from '../api/projectStore';
import { useLayoutStore } from '../store/layoutStore';
import { SettingsSelect } from './SettingsSelect';

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

  const interactLabelId = useId();
  const permLabelId = useId();
  const styleLabelId = useId();
  const tabLabelId = useId();

  // 非法权限值回落 ask
  const permissionMode = coercePermissionMode(permissionModeRaw);
  const permMeta = permissionModeMeta(permissionMode);

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

  const permissionTitle = [permMeta.description, permMeta.matrixHint]
    .filter(Boolean)
    .join(' · ');

  if (!settings) {
    return (
      <div className="settings-pane settings-pane--modern settings-pane--personalize">
        <header className="settings-page-head">
          <div className="settings-head-inline">
            <h2 className="settings-page-title">个性化</h2>
          </div>
        </header>
        {loadError ? (
          <section className="settings-group" aria-label="错误">
            <div className="settings-list settings-list--personalize">
              <div className="settings-list-row settings-list-row--single settings-list-row--personalize">
                <div className="settings-list-copy">
                  <div
                    className="settings-list-title settings-list-empty"
                    role="alert"
                  >
                    {loadError}
                  </div>
                </div>
                <div className="settings-list-control settings-list-control--personalize">
                  <button
                    type="button"
                    className="ui-btn ui-btn-secondary ui-btn-sm"
                    aria-label="重新加载个性化设置"
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
          <div
            className="settings-list settings-list--personalize"
            role="status"
            aria-live="polite"
            aria-busy="true"
          >
            <div className="settings-list-row settings-list-row--single settings-list-row--personalize">
              <div className="settings-list-copy">
                <div className="settings-list-title settings-list-empty">加载中…</div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="settings-pane settings-pane--modern settings-pane--personalize"
      aria-busy={saving || undefined}
    >
      <header className="settings-page-head">
        <div className="settings-head-inline">
          <h2 className="settings-page-title">个性化</h2>
        </div>
      </header>

      <section className="settings-group" aria-labelledby={interactLabelId}>
        <div className="settings-group-label" id={interactLabelId}>
          对话与界面
        </div>
        <div className="settings-list settings-list--personalize">
          <div
            className="settings-list-row settings-list-row--single settings-list-row--personalize"
            title={permissionTitle}
          >
            <div className="settings-list-copy">
              <div className="settings-list-title" id={permLabelId}>
                权限模式
              </div>
              <div className="settings-list-sub settings-list-sub--force settings-personalize-desc">
                工具调用前要不要先问你
              </div>
            </div>
            <div className="settings-list-control settings-list-control--personalize">
              <SettingsSelect
                className="settings-personalize-select"
                value={permissionMode}
                options={permissionOptions}
                onChange={onPermissionChange}
                disabled={!ready}
                placeholder="选择…"
              />
            </div>
          </div>

          <div
            className="settings-list-row settings-list-row--single settings-list-row--personalize"
            title={style.description}
          >
            <div className="settings-list-copy">
              <div className="settings-list-title" id={styleLabelId}>
                回答风格
              </div>
              <div className="settings-list-sub settings-list-sub--force settings-personalize-desc">
                {style.description}
              </div>
            </div>
            <div className="settings-list-control settings-list-control--personalize">
              <SettingsSelect
                className="settings-personalize-select"
                value={responseStyle}
                options={responseStyleOptions}
                onChange={onResponseStyle}
                disabled={!ready}
                placeholder="选择…"
              />
            </div>
          </div>

          <label
            className="settings-list-row settings-list-row--single settings-list-row--personalize settings-list-row--clickable"
            title="右侧多个面板合成标签，少占空间"
          >
            <div className="settings-list-copy">
              <div className="settings-list-title" id={tabLabelId}>
                合并右侧面板
              </div>
              <div className="settings-list-sub settings-list-sub--force settings-personalize-desc">
                总览、文件等收成标签
              </div>
            </div>
            <div className="settings-list-control settings-list-control--personalize">
              <input
                type="checkbox"
                className="settings-switch settings-switch--personalize"
                checked={tabModeEnabled}
                disabled={!ready}
                aria-labelledby={tabLabelId}
                aria-label="合并右侧面板"
                onChange={(e) => onTabMode(e.target.checked)}
              />
            </div>
          </label>
        </div>
      </section>
    </div>
  );
};
