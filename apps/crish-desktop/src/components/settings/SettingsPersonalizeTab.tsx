/**
 * 设置 · 通用设置：系统选项、回答风格、消息快捷键与界面偏好；成功静默，仅失败提示。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Settings } from '../../api/clientApi';
import { clientApi } from '../../api/clientApi';
import { getWorkspacePath } from '../../api/projectStore';
import { useLayoutStore } from '../../api/store-access/componentAccess';
import { useSettingsField } from '../../store/storeAccess';
import { SettingsPage } from './SettingsUI';
import { SettingsSchemaRenderer } from './SettingsSchemaRenderer';
import type { SchemaSection } from './SettingsSchemaRenderer';

type Props = {
  onShowToast: (msg: string) => void;
};

export const SettingsPersonalizeTab: React.FC<Props> = ({ onShowToast }) => {
  const cwd = getWorkspacePath() || '__global__';
  const setTabModeEnabled = useLayoutStore((s) => s.setTabModeEnabled);
  const setAppSettings = useSettingsField((s) => s.setAppSettings);

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

  const ready = Boolean(settings) && !saving;

  // JSON-Schema defining general settings dynamically
  const personalizeSchema: SchemaSection[] = useMemo(() => [
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
          type: 'select',
          title: '发送消息快捷键',
          desc: '选择对话输入框中的消息发送组合按键',
          options: [
            { value: 'enter', label: 'Enter 发送，Shift+Enter 换行', hint: '默认' },
            { value: 'ctrlEnter', label: 'Ctrl+Enter 发送，Enter 换行', hint: '防止误触' },
          ],
        },
        {
          key: 'hideThinkingBlock',
          type: 'boolean',
          title: '默认折叠思考过程',
          desc: '在对话流中默认隐藏或折叠深度思考模型的大段推理内容',
        },
        {
          key: 'queueMode',
          type: 'boolean',
          title: '排队发送模式',
          desc: 'AI 回复中时，新消息进入队列而不是直接插入对话；可在输入框上方手动发送、编辑或删除排队消息',
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
  ], []);

  // Map values correctly to feed the dynamic fields
  const schemaValues = useMemo(() => {
    if (!settings) return null;
    return settings;
  }, [settings]);

  const handleSave = useCallback(
    async (updates: Record<string, unknown>) => {
      if ('tabModeEnabled' in updates) {
        const on = Boolean(updates.tabModeEnabled);
        setTabModeEnabled(on);
        const ok = await save({ tabModeEnabled: on });
        if (!ok) {
          setTabModeEnabled(!on);
        }
      } else {
        await save(updates);
      }
    },
    [save, setTabModeEnabled],
  );

  if (loadError && !settings) {
    return (
      <SettingsPage title="通用设置">
        <div style={{ padding: '20px', color: 'var(--accent-red)', textAlign: 'center' }}>
          <p>{loadError}</p>
          <button
            type="button"
            className="ui-btn ui-btn-secondary"
            onClick={() => {
              setLoadError(null);
              setLoadTick((n) => n + 1);
            }}
          >
            重试
          </button>
        </div>
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
