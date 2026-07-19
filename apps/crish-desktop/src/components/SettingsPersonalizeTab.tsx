/**
 * 设置 · 通用设置：系统选项、回答风格、消息快捷键与界面偏好；成功静默，仅失败提示。
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ResponseStyle, Settings } from '../api/clientApi';
import {
  clientApi,
  normalizeResponseStyle,
  RESPONSE_STYLE_OPTIONS,
} from '../api/clientApi';
import { getWorkspacePath } from '../api/projectStore';
import { useLayoutStore } from '../store/layoutStore';
import { SettingsSelect } from './SettingsSelect';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './settings/SettingsUI';

type Props = {
  onShowToast: (msg: string) => void;
};

/** 回答风格：中文说明 */
const RESPONSE_STYLE_META: ReadonlyArray<{
  value: ResponseStyle;
  label: string;
  hint: string;
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

function styleLabel(id: ResponseStyle): string {
  return (
    RESPONSE_STYLE_OPTIONS.find((o) => o.value === id)?.label ||
    STYLE_LABEL_FALLBACK[id] ||
    '详细'
  );
}

export const SettingsPersonalizeTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const tabModeEnabled = useLayoutStore((s) => s.tabModeEnabled);
  const setTabModeEnabled = useLayoutStore((s) => s.setTabModeEnabled);
  const setAppSettings = useLayoutStore((s) => s.setAppSettings);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadTick, setLoadTick] = useState(0);

  const [sendShortcut, setSendShortcut] = useState<string>(
    () => (typeof window !== 'undefined' ? localStorage.getItem('crish_send_shortcut') || 'enter' : 'enter')
  );

  const styleLabelId = useId();
  const tabLabelId = useId();
  const hideThinkingId = useId();
  const shortcutLabelId = useId();
  
  const quietId = useId();
  const collapseId = useId();
  const skillId = useId();
  const analyticsId = useId();

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

  const save = useCallback(
    async (updates: Partial<Settings>): Promise<boolean> => {
      if (!settings) return false;
      setSaving(true);
      try {
        const merged = await clientApi.saveSettingsEx(cwd, 'global', updates);
        setSettings(merged);
        setAppSettings(merged);
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
        label: styleLabel(m.value),
        hint: m.hint,
      })),
    [],
  );

  const shortcutOptions = useMemo(
    () => [
      { value: 'enter', label: 'Enter 发送，Shift+Enter 换行', hint: '默认' },
      { value: 'ctrlEnter', label: 'Ctrl+Enter 发送，Enter 换行', hint: '防止误触' },
    ],
    []
  );

  const onResponseStyle = (v: string) => {
    if (!settings) return;
    const next = normalizeResponseStyle(v);
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

  const onShortcutChange = (v: string) => {
    setSendShortcut(v);
    if (typeof window !== 'undefined') {
      localStorage.setItem('crish_send_shortcut', v);
    }
  };

  if (loadError && !settings) {
    return (
      <SettingsPage title="通用设置">
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
      <SettingsPage title="通用设置">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow title={<span className="settings-list-empty">加载中…</span>} />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  const quietStartup = Boolean(settings.quietStartup);
  const collapseChangelog = Boolean(settings.collapseChangelog);
  const enableSkillCommands = Boolean(settings.enableSkillCommands);
  const enableAnalytics = Boolean(settings.enableAnalytics);
  const hideThinking = Boolean(settings.hideThinkingBlock);

  return (
    <SettingsPage title="通用设置">
      <SettingsSection title="对话偏好">
        <SettingsCard>
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
                placeholder="选择风格…"
              />
            }
          />

          <SettingsRow
            title={<span id={shortcutLabelId}>发送消息快捷键</span>}
            desc="选择对话输入框中的消息发送组合按键"
            control={
              <SettingsSelect
                className="settings-personalize-select"
                value={sendShortcut}
                options={shortcutOptions}
                onChange={onShortcutChange}
                disabled={!ready}
                placeholder="选择快捷键…"
              />
            }
          />

          <SettingsRow
            title={<label htmlFor={hideThinkingId} className="settings-ui-row-label">默认折叠思考过程</label>}
            desc="在对话流中默认隐藏或折叠深度思考模型的大段推理内容"
            control={
              <input
                id={hideThinkingId}
                type="checkbox"
                className="settings-switch settings-switch--personalize"
                checked={hideThinking}
                disabled={!ready}
                onChange={(e) => {
                  void save({ hideThinkingBlock: e.target.checked });
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="界面偏好">
        <SettingsCard>
          <SettingsRow
            title={<label htmlFor={tabLabelId} className="settings-ui-row-label">合并右侧面板</label>}
            desc="将总览、文件树等多个侧栏板块收纳合并为统一的右侧标签页栏"
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

          <SettingsRow
            title={<label htmlFor={collapseId} className="settings-ui-row-label">默认折叠更新日志</label>}
            desc="进入工作台时，默认收起右侧的系统版本更新日志抽屉"
            control={
              <input
                id={collapseId}
                type="checkbox"
                className="settings-switch settings-switch--personalize"
                checked={collapseChangelog}
                disabled={!ready}
                onChange={(e) => {
                  void save({ collapseChangelog: e.target.checked });
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="系统与遥测">
        <SettingsCard>
          <SettingsRow
            title={<label htmlFor={skillId} className="settings-ui-row-label">启用行内斜杠命令</label>}
            desc="允许在对话输入框中通过键入 / 触发快速执行的指令与技能菜单"
            control={
              <input
                id={skillId}
                type="checkbox"
                className="settings-switch settings-switch--personalize"
                checked={enableSkillCommands}
                disabled={!ready}
                onChange={(e) => {
                  void save({ enableSkillCommands: e.target.checked });
                }}
              />
            }
          />

          <SettingsRow
            title={<label htmlFor={quietId} className="settings-ui-row-label">启用静默启动日志</label>}
            desc="启动客户端时，自动隐藏环境加载、初始化等冗余调试信息"
            control={
              <input
                id={quietId}
                type="checkbox"
                className="settings-switch settings-switch--personalize"
                checked={quietStartup}
                disabled={!ready}
                onChange={(e) => {
                  void save({ quietStartup: e.target.checked });
                }}
              />
            }
          />

          <SettingsRow
            title={<label htmlFor={analyticsId} className="settings-ui-row-label">分享匿名产品分析</label>}
            desc="传输安全脱敏、完全不包含任何代码或隐私的遥测数据以帮助改进本软件"
            control={
              <input
                id={analyticsId}
                type="checkbox"
                className="settings-switch settings-switch--personalize"
                checked={enableAnalytics}
                disabled={!ready}
                onChange={(e) => {
                  void save({ enableAnalytics: e.target.checked });
                }}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
};
