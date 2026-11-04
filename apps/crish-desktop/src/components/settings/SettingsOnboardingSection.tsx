/**
 * apps/crish-desktop/src/components/settings/SettingsOnboardingSection.tsx
 *
 * 设置 · 个性化页的「新手引导」分区（自 SettingsPersonalizeTab 抽出以
 * 满足行数门禁）：启动时显示引导开关 + 打开向导 / 预览各步入口；状态与
 * 打开动作由宿主持有，本组件只负责呈现。
 */
import React from 'react';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsUI';
import { Button, Switch } from '@/components/ui';
import { useI18n } from '../../i18n';
import { WIZARD_STEP_META, type WizardStep } from '../firstRunWizardLib';

export interface SettingsOnboardingSectionProps {
  showOnboardingOnStartup: boolean;
  onToggleOnboarding: (next: boolean) => void;
  onOpenWizard: (step: WizardStep) => void;
}

export const SettingsOnboardingSection: React.FC<
  SettingsOnboardingSectionProps
> = ({ showOnboardingOnStartup, onToggleOnboarding, onOpenWizard }) => {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('settings.personalize.onboardingSection')}>
      <SettingsCard>
        <SettingsRow
          title={t('settings.personalize.showOnboardingTitle')}
          control={
            <Switch
              aria-label={t('settings.personalize.showOnboardingTitle')}
              checked={showOnboardingOnStartup}
              onCheckedChange={onToggleOnboarding}
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
                onOpenWizard(0);
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
                    onOpenWizard(stepMeta.id);
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
  );
};
