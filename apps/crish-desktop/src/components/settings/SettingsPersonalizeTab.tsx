import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 通用设置：系统选项、回答风格、消息快捷键与界面偏好；成功静默，仅失败提示。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Settings } from '../../api/clientApi';
import { clientApi } from '../../api/clientApi';
import { getWorkspacePath } from '../../api/projectStore';
import { useLayoutStore, useSettingsField } from '../../store/storeAccess';
import {
  SettingsPage,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from './SettingsUI';
import { Button } from '../ui';
import { SettingsSchemaRenderer } from './SettingsSchemaRenderer';
import type { SchemaSection } from './SettingsSchemaRenderer';
import {
  normalizeSendShortcut,
  persistSendShortcut,
} from '../../api/store-access/settingsAccess';
import { telemetry } from '../../services/TelemetryService';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsPersonalizeTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { showToast } = useToast();
  const cwd = getWorkspacePath() || '__global__';
  const setTabModeEnabled = useLayoutStore((s) => s.setTabModeEnabled);
  const setAppSettings = useSettingsField((s) => s.setAppSettings);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

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
          showToast(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, setAppSettings, setTabModeEnabled, loadTick, showToast]);

  const save = useCallback(
    async (updates: Partial<Settings>): Promise<boolean> => {
      if (!settings) return false;
      const previous = settings;
      const optimistic = { ...settings, ...updates };
      setSettings(optimistic);
      setAppSettings(optimistic);
      try {
        const merged = await clientApi.saveSettingsEx(cwd, 'global', updates);
        setSettings(merged);
        setAppSettings(merged);
        return true;
      } catch (err) {
        setSettings(previous);
        setAppSettings(previous);
        showToast('保存失败：' + String(err));
        return false;
      }
    },
    [cwd, setAppSettings, settings, showToast]
  );

  const ready = Boolean(settings);

  // JSON-Schema defining general settings dynamically
  const personalizeSchema: SchemaSection[] = useMemo(
    () => [
      {
        title: '对话偏好',
        properties: [
          {
            key: 'responseStyle',
            type: 'select',
            title: '回答风格',
            desc: '回答的篇幅、详细程度与分步要点说明',
            options: [
              { value: 'minimal', label: '简洁', hint: '尽量短，直接给结论' },
              { value: 'low', label: '标准', hint: '适中，要点清楚篇幅适中' },
              { value: 'medium', label: '详细', hint: '分步，步骤更完整' },
              { value: 'high', label: '深入', hint: '展开，分析更充分' },
            ],
          },
          {
            key: 'sendShortcut',
            type: 'toggle-group',
            title: '发送消息快捷键',
            desc: 'Enter 发送（Shift+Enter 换行），或 Ctrl+Enter 发送（Enter 换行）',
            toggleOptions: [
              { value: 'enter', label: 'Enter 发送' },
              { value: 'ctrlEnter', label: 'Ctrl+Enter 发送' },
            ],
          },
          {
            key: 'maxRetryAttempts',
            type: 'number',
            title: '单次重试上限次数',
            desc: '手动重试的最大尝试次数（默认 10 次，配合指数退避保护；调整数字即实时保存）',
            min: 1,
            max: 50,
            step: 1,
            unit: '次',
          },
          {
            key: 'hideThinkingBlock',
            type: 'boolean',
            title: '默认折叠思考过程',
            desc: '在对话流中默认隐藏或折叠深度思考模型的大段推理内容',
          },
        ],
      },
      {
        title: '界面偏好',
        properties: [
          {
            key: 'tabModeEnabled',
            type: 'boolean',
            title: '合并右侧面板',
            desc: '将总览、文件树等多个侧栏板块收纳合并为统一的右侧标签页栏',
          },
          {
            key: 'collapseChangelog',
            type: 'boolean',
            title: '默认折叠更新日志',
            desc: '进入工作台时，默认收起右侧的系统版本更新日志抽屉',
          },
        ],
      },
      {
        title: '系统与遥测',
        properties: [
          {
            key: 'enableSkillCommands',
            type: 'boolean',
            title: '启用行内斜杠命令',
            desc: '允许在对话输入框中通过键入 / 触发快速执行的指令与技能菜单',
          },
          {
            key: 'quietStartup',
            type: 'boolean',
            title: '启用静默启动日志',
            desc: '启动客户端时，自动隐藏环境加载、初始化等冗余调试信息',
          },
          {
            key: 'enableAnalytics',
            type: 'boolean',
            title: '分享匿名产品分析',
            desc: '传输安全脱敏、完全不包含任何代码或隐私的遥测数据以帮助改进本软件',
          },
          {
            key: 'enableCrashTelemetry',
            type: 'boolean',
            title: '自动收集错误日志',
            desc: '检测到异常退出时自动收集诊断日志并上传，用于排查崩溃与稳定性问题',
          },
        ],
      },
    ],
    []
  );

  // Map values correctly to feed the dynamic fields
  const schemaValues = useMemo(() => {
    if (!settings) return null;
    return {
      ...settings,
      maxRetryAttempts: settings.maxRetryAttempts ?? 10,
      sendShortcut: normalizeSendShortcut(settings.sendShortcut),
    };
  }, [settings]);

  const handleSave = useCallback(
    async (updates: Record<string, unknown>) => {
      if ('sendShortcut' in updates) {
        const prev = normalizeSendShortcut(settings?.sendShortcut);
        const next = persistSendShortcut(updates.sendShortcut);
        const ok = await save({ sendShortcut: next });
        if (!ok) persistSendShortcut(prev);
        return;
      }
      if ('maxRetryAttempts' in updates) {
        const count = Math.max(
          1,
          Math.min(50, Number(updates.maxRetryAttempts) || 10)
        );
        await save({ maxRetryAttempts: count });
        return;
      }
      if ('tabModeEnabled' in updates) {
        const on = Boolean(updates.tabModeEnabled);
        setTabModeEnabled(on);
        const ok = await save({ tabModeEnabled: on });
        if (!ok) {
          setTabModeEnabled(!on);
        }
        return;
      }
      const ok = await save(updates);
      if (!ok) return;
      if ('enableSkillCommands' in updates) {
        window.dispatchEvent(new CustomEvent('crish-skills-changed'));
      }
      if ('enableCrashTelemetry' in updates) {
        telemetry.setEnabled(Boolean(updates.enableCrashTelemetry));
      }
    },
    [save, setTabModeEnabled, settings?.sendShortcut]
  );

  if (loadError && !settings) {
    return (
      <SettingsPage title="通用设置">
        <SettingsSection title="错误">
          <SettingsCard>
            <SettingsRow
              title={<span role="alert">{loadError}</span>}
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setLoadError(null);
                    setLoadTick((n) => n + 1);
                  }}
                >
                  重试
                </Button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title="通用设置">
      <SettingsSchemaRenderer
        schema={personalizeSchema}
        values={schemaValues}
        onSave={handleSave}
        ready={ready}
      />
    </SettingsPage>
  );
};
