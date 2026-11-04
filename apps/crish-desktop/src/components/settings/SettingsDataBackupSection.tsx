/**
 * apps/crish-desktop/src/components/settings/SettingsDataBackupSection.tsx
 *
 * 设置 · 个性化页的「数据与备份」分区（自 SettingsPersonalizeTab 抽出以
 * 满足行数门禁）：全部设置导出 / 导入的按钮组与隐藏文件输入；导出导入的
 * 状态与处理函数由宿主持有，本组件只负责呈现。
 */
import React, { type RefObject } from 'react';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsUI';
import { Button, Input, Tooltip } from '@/components/ui';
import { useI18n } from '../../i18n';

export interface SettingsDataBackupSectionProps {
  exporting: boolean;
  importing: boolean;
  onExport: () => void;
  onImport: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const SettingsDataBackupSection: React.FC<
  SettingsDataBackupSectionProps
> = ({
  exporting,
  importing,
  onExport,
  onImport,
  fileInputRef,
  onFileChange,
}) => {
  const { t } = useI18n();
  return (
    <SettingsSection title={t('settings.personalize.dataBackupSection')}>
      <SettingsCard>
        <SettingsRow
          title={t('settings.personalize.exportImportAllSettings')}
          desc={t('settings.personalize.exportImportDesc')}
          control={
            <>
              <Tooltip
                content={
                  exporting
                    ? t('settings.personalize.exporting')
                    : t('settings.personalize.exportBackup')
                }
                delayShow={300}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={exporting}
                  onClick={() => void onExport()}
                >
                  {exporting
                    ? t('settings.personalize.exportingShort')
                    : t('settings.personalize.exportBtn')}
                </Button>
              </Tooltip>
              <Tooltip
                content={
                  importing
                    ? t('settings.personalize.importing')
                    : t('settings.personalize.importBackup')
                }
                delayShow={300}
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={importing}
                  onClick={onImport}
                >
                  {importing
                    ? t('settings.personalize.importingShort')
                    : t('settings.personalize.importBtn')}
                </Button>
              </Tooltip>
              <Input
                bare
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={onFileChange}
              />
            </>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
};
