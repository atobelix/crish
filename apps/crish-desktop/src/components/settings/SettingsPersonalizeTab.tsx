import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 通用设置：对话偏好、界面偏好（含语言）、数据与备份、系统与遥测，
 * 新手引导置于页面最末；成功静默，仅失败提示。
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Settings } from '../../api/clientApi';
import { clientApi } from '../../api/clientApi';
import { getWorkspacePath } from '../../api/projectStore';
import {
  closeSettings,
  useLayoutStore,
  useSettingsField,
} from '../../store/storeAccess';
import {
  SettingsPage,
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from './SettingsUI';
import { Button } from '@/components/ui';
import { SettingsSchemaRenderer } from './SettingsSchemaRenderer';
import type { SchemaSection } from './SettingsSchemaRenderer';
import {
  SettingsShellPrefsSections,
  type ShellPrefKey,
} from './SettingsShellPrefsSections';
import { SettingsDataBackupSection } from './SettingsDataBackupSection';
import { SettingsOnboardingSection } from './SettingsOnboardingSection';
import {
  normalizeSendShortcut,
  persistSendShortcut,
} from '../../store/storeAccess';
import { telemetry } from '../../services/TelemetryService';
import {
  getPreference,
  setPreference,
} from '../../api/preferences/preferencesClient';
import {
  setShowOnboardingOnStartup,
  shouldShowFirstRunWizard,
  type WizardStep,
} from '../firstRunWizardLib';
import {
  readRestoreLastWorkspace,
  setRestoreLastWorkspace,
} from '../../app/hydrateWorkspaceShell';
import { normalizeCodeIndent } from './useAppearanceSettings';
import { useI18n, type SupportedLanguage } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsPersonalizeTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { t, language, setLanguage } = useI18n();

  const { showToast } = useToast();
  const cwd = getWorkspacePath() || '__global__';
  const setTabModeEnabled = useLayoutStore((s) => s.setTabModeEnabled);
  const setAppSettings = useSettingsField((s) => s.setAppSettings);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);
  const [showOnboardingOnStartup, setShowOnboardingOnStartupState] = useState(
    () => shouldShowFirstRunWizard()
  );
  // 「启动时恢复上次工作台」自外观页迁入：真源在 hydrateWorkspaceShell（本地存储 + settings.ui）
  const [restoreLastWorkspace, setRestoreLastWorkspaceState] = useState(() =>
    readRestoreLastWorkspace()
  );

  // ── 托盘/通知批（2026-11-03）：「窗口与启动」「通知」两分区走 prefs
  // SSOT（preferencesClient），不经 clientApi Settings——状态独立加载，
  // 读失败时整组分区缺席（诚实缺席，不渲染假默认值）──
  const [shellPrefs, setShellPrefs] = useState<Record<
    ShellPrefKey,
    boolean
  > | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [
          trayEnabled,
          closeToTray,
          keepAwake,
          notifMaster,
          notifDone,
          autostartEnabled,
          startMinimized,
        ] = await Promise.all([
          getPreference('tray_enabled'),
          getPreference('close_to_tray'),
          getPreference('keep_awake_during_tasks'),
          getPreference('desktop_notifications_enabled'),
          getPreference('notify_on_task_done'),
          getPreference('autostart_enabled'),
          getPreference('start_minimized'),
        ]);
        if (!cancelled) {
          setShellPrefs({
            tray_enabled: trayEnabled,
            close_to_tray: closeToTray,
            keep_awake_during_tasks: keepAwake,
            desktop_notifications_enabled: notifMaster,
            notify_on_task_done: notifDone,
            autostart_enabled: autostartEnabled,
            start_minimized: startMinimized,
          });
        }
      } catch {
        // 读取失败保持 null：两分区不渲染（见上方注释）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleShellPrefToggle = useCallback(
    async (key: ShellPrefKey, next: boolean) => {
      setShellPrefs((prev) => (prev ? { ...prev, [key]: next } : prev));
      try {
        await setPreference(key, next);
      } catch (err) {
        setShellPrefs((prev) => (prev ? { ...prev, [key]: !next } : prev));
        showToast(t('settings.personalize.saveFailed', { error: String(err) }));
      }
    },
    [showToast, t]
  );

  // ── 设置备份（自账号页「数据」分区迁入）：导出 / 导入全部设置 ──
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const handleExportSettings = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const allSettings = await clientApi.getSettings();
      const blob = new Blob([JSON.stringify(allSettings ?? {}, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `crish-settings-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 成功静默（用户裁决：导出/导入成功提示不必每次说）
    } catch (err) {
      showToast(t('settings.personalize.exportFailed', { error: String(err) }));
    } finally {
      setExporting(false);
    }
  };

  /** 选择 JSON 后合并写入本机设置；成功静默并重拉本页设置，失败 toast */
  const handleImportSettings = () => {
    if (importing) return;
    importFileInputRef.current?.click();
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    void (async () => {
      setImporting(true);
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          showToast(t('settings.personalize.invalidJson'));
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          showToast(t('settings.personalize.rootMustBeObject'));
          return;
        }
        await clientApi.saveSettingsEx(
          cwd === '__global__' ? '__global__' : cwd,
          'global',
          parsed as Parameters<typeof clientApi.saveSettingsEx>[2]
        );
        // 成功静默；重拉本页设置使导入值立即反映
        setLoadTick((n) => n + 1);
      } catch (err) {
        showToast(
          t('settings.personalize.importFailed', { error: String(err) })
        );
      } finally {
        setImporting(false);
      }
    })();
  };

  const handleToggleOnboardingOnStartup = useCallback((next: boolean) => {
    setShowOnboardingOnStartup(next);
    setShowOnboardingOnStartupState(next);
  }, []);

  const handleOpenFirstRunWizard = useCallback((step: WizardStep = 0) => {
    closeSettings?.();
    window.dispatchEvent(
      new CustomEvent('crish-open-first-run', { detail: { step } })
    );
  }, []);

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
          const msg = t('settings.personalize.loadFailed', {
            error: String(err),
          });
          setLoadError(msg);
          showToast(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, setAppSettings, setTabModeEnabled, loadTick, showToast, t]);

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
        showToast(t('settings.personalize.saveFailed', { error: String(err) }));
        return false;
      }
    },
    [cwd, setAppSettings, settings, showToast, t]
  );

  const ready = Boolean(settings);

  // JSON-Schema defining general settings dynamically
  const personalizeSchema: SchemaSection[] = useMemo(
    () => [
      {
        title: t('settings.personalize.conversationPrefs'),
        properties: [
          {
            key: 'responseStyle',
            type: 'select',
            title: t('settings.personalize.responseStyleTitle'),
            desc: t('settings.personalize.responseStyleDesc'),
            options: [
              {
                value: 'minimal',
                label: t('settings.personalize.styleMinimal'),
                hint: t('settings.personalize.styleMinimalHint'),
              },
              {
                value: 'low',
                label: t('settings.personalize.styleStandard'),
                hint: t('settings.personalize.styleStandardHint'),
              },
              {
                value: 'medium',
                label: t('settings.personalize.styleDetailed'),
                hint: t('settings.personalize.styleDetailedHint'),
              },
              {
                value: 'high',
                label: t('settings.personalize.styleDeep'),
                hint: t('settings.personalize.styleDeepHint'),
              },
            ],
          },
          {
            key: 'sendShortcut',
            type: 'toggle-group',
            title: t('settings.personalize.sendShortcutTitle'),
            toggleOptions: [
              {
                value: 'enter',
                label: t('settings.personalize.sendShortcutEnter'),
              },
              {
                value: 'ctrlEnter',
                label: t('settings.personalize.sendShortcutCmdEnter'),
              },
            ],
          },
          {
            key: 'maxRetryAttempts',
            type: 'number',
            title: t('settings.personalize.maxRetryTitle'),
            min: 1,
            max: 50,
            step: 1,
            unit: t('settings.personalize.timesUnit'),
          },
          {
            key: 'hideThinkingBlock',
            type: 'boolean',
            title: t('settings.personalize.hideThinkingTitle'),
          },
          {
            // 自「系统与遥测」移入：技能命令是对话输入框行为，归对话偏好
            key: 'enableSkillCommands',
            type: 'boolean',
            title: t('settings.personalize.enableSkillCommandsTitle'),
            desc: t('settings.personalize.enableSkillCommandsDesc'),
          },
          {
            // 自外观页「主题与外观」移入：代码缩进是编辑行为偏好
            key: 'codeIndent',
            type: 'select',
            title: t('settings.personalize.codeIndentTitle'),
            options: [
              {
                value: '  ',
                label: t('settings.personalize.codeIndentTwoSpaces'),
              },
              {
                value: '    ',
                label: t('settings.personalize.codeIndentFourSpaces'),
              },
              {
                value: '\t',
                label: t('settings.personalize.codeIndentTab'),
              },
            ],
          },
        ],
      },
      {
        title: t('settings.personalize.uiPrefs'),
        properties: [
          {
            // 自外观页移入：语言是通用偏好，置于界面偏好首行
            key: 'language',
            type: 'select',
            title: t('settings.general.language'),
            options: [
              {
                value: 'zh-CN',
                label: t('settings.personalize.languageZhHans'),
              },
              { value: 'en-US', label: 'English' },
            ],
          },
          {
            key: 'tabModeEnabled',
            type: 'boolean',
            title: t('settings.personalize.tabModeTitle'),
            desc: t('settings.personalize.tabModeDesc'),
          },
          {
            key: 'collapseChangelog',
            type: 'boolean',
            title: t('settings.personalize.collapseChangelogTitle'),
          },
          {
            // 自外观页「高级」移入：启动时恢复工作台属界面状态偏好
            key: 'restoreLastWorkspace',
            type: 'boolean',
            title: t('settings.personalize.restoreWorkspaceTitle'),
            desc: t('settings.personalize.restoreWorkspaceDesc'),
          },
        ],
      },
      {
        title: t('settings.personalize.systemTelemetry'),
        properties: [
          {
            key: 'quietStartup',
            type: 'boolean',
            title: t('settings.personalize.quietStartupTitle'),
            desc: t('settings.personalize.quietStartupDesc'),
          },
          {
            key: 'enableAnalytics',
            type: 'boolean',
            title: t('settings.personalize.enableAnalyticsTitle'),
            desc: t('settings.personalize.enableAnalyticsDesc'),
          },
          {
            key: 'enableCrashTelemetry',
            type: 'boolean',
            title: t('settings.personalize.enableCrashTelemetryTitle'),
            desc: t('settings.personalize.enableCrashTelemetryDesc'),
          },
        ],
      },
    ],
    [t]
  );

  // Map values correctly to feed the dynamic fields
  const schemaValues = useMemo(() => {
    if (!settings) return null;
    return {
      ...settings,
      maxRetryAttempts: settings.maxRetryAttempts ?? 10,
      sendShortcut: normalizeSendShortcut(settings.sendShortcut),
      language,
      codeIndent: normalizeCodeIndent(settings.markdown?.codeBlockIndent),
      restoreLastWorkspace,
    };
  }, [settings, language, restoreLastWorkspace]);

  const handleSave = useCallback(
    async (updates: Record<string, unknown>) => {
      if ('language' in updates) {
        setLanguage(updates.language as SupportedLanguage);
        return;
      }
      if ('codeIndent' in updates) {
        const next = normalizeCodeIndent(updates.codeIndent);
        if (next !== normalizeCodeIndent(settings?.markdown?.codeBlockIndent)) {
          await save({
            markdown: { ...(settings?.markdown || {}), codeBlockIndent: next },
          });
        }
        return;
      }
      if ('restoreLastWorkspace' in updates) {
        const next = Boolean(updates.restoreLastWorkspace);
        setRestoreLastWorkspaceState(next);
        setRestoreLastWorkspace(next);
        return;
      }
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
    [
      save,
      setTabModeEnabled,
      settings?.sendShortcut,
      settings?.markdown,
      setLanguage,
    ]
  );

  if (loadError && !settings) {
    return (
      <SettingsPage title={t('settings.personalize.title')}>
        <SettingsSection title={t('common.error')}>
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
                  {t('common.retry')}
                </Button>
              }
            />
          </SettingsCard>
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t('settings.personalize.title')}>
      <SettingsSchemaRenderer
        schema={personalizeSchema.slice(0, 2)}
        values={schemaValues}
        onSave={handleSave}
        ready={ready}
      />
      {ready ? (
        <SettingsDataBackupSection
          exporting={exporting}
          importing={importing}
          onExport={handleExportSettings}
          onImport={handleImportSettings}
          fileInputRef={importFileInputRef}
          onFileChange={handleImportFileChange}
        />
      ) : null}
      <SettingsSchemaRenderer
        schema={personalizeSchema.slice(2)}
        values={schemaValues}
        onSave={handleSave}
        ready={ready}
      />
      {shellPrefs ? (
        <SettingsShellPrefsSections
          shellPrefs={shellPrefs}
          onToggle={handleShellPrefToggle}
        />
      ) : null}
      <SettingsOnboardingSection
        showOnboardingOnStartup={showOnboardingOnStartup}
        onToggleOnboarding={handleToggleOnboardingOnStartup}
        onOpenWizard={handleOpenFirstRunWizard}
      />
    </SettingsPage>
  );
};
