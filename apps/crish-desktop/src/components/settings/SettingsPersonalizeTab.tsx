import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 通用设置：系统选项、回答风格、消息快捷键与界面偏好；成功静默，仅失败提示。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Button, Switch } from '@/components/ui';
import { SettingsSchemaRenderer } from './SettingsSchemaRenderer';
import type { SchemaSection } from './SettingsSchemaRenderer';
import {
  normalizeSendShortcut,
  persistSendShortcut,
} from '../../api/store-access/settingsAccess';
import { telemetry } from '../../services/TelemetryService';
import {
  setShowOnboardingOnStartup,
  shouldShowFirstRunWizard,
  WIZARD_STEP_META,
  type WizardStep,
} from '../firstRunWizardLib';
import { useI18n } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

export const SettingsPersonalizeTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { t } = useI18n();

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
        ],
      },
      {
        title: t('settings.personalize.uiPrefs'),
        properties: [
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
        ],
      },
      {
        title: t('settings.personalize.systemTelemetry'),
        properties: [
          {
            key: 'enableSkillCommands',
            type: 'boolean',
            title: t('settings.personalize.enableSkillCommandsTitle'),
            desc: t('settings.personalize.enableSkillCommandsDesc'),
          },
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
      <SettingsSection title={t('settings.personalize.onboardingSection')}>
        <SettingsCard>
          <SettingsRow
            title={t('settings.personalize.showOnboardingTitle')}
            control={
              <Switch
                aria-label={t('settings.personalize.showOnboardingTitle')}
                checked={showOnboardingOnStartup}
                onCheckedChange={handleToggleOnboardingOnStartup}
              />
            }
          />
          <SettingsRow
            title={t('settings.personalize.openWizardTitle')}
            control={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  handleOpenFirstRunWizard(0);
                }}
              >
                {t('settings.personalize.openWizardBtn')}
              </Button>
            }
          />
          <SettingsRow
            vertical
            title={t('settings.personalize.previewStepsTitle')}
            control={
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 'var(--space-2)',
                  marginTop: 'var(--space-1_5)',
                }}
                role="group"
                aria-label={t('settings.personalize.previewStepsAria')}
              >
                {WIZARD_STEP_META.map((stepMeta) => (
                  <Button
                    key={stepMeta.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      handleOpenFirstRunWizard(stepMeta.id);
                    }}
                  >
                    {`${stepMeta.id + 1}. ${t(`settings.personalize.wizardStep${stepMeta.id}`)}`}
                  </Button>
                ))}
              </div>
            }
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSchemaRenderer
        schema={personalizeSchema}
        values={schemaValues}
        onSave={handleSave}
        ready={ready}
      />
    </SettingsPage>
  );
};
