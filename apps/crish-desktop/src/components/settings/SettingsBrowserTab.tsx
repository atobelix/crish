/**
 * 设置 · 浏览器：书签导入、历史记录导入与登录态管理。
 * 严格复用 SettingsUI 标准页面骨架与统一设计 Token。
 */
import React from 'react';
import { SettingsPage } from './SettingsUI';
import { BrowserImportSection } from '../workspace/browser-panel/BrowserImportSection';
import { useBrowserSession } from '../workspace/useBrowserSession';
import { useI18n } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
  saveExport?: (filename: string, content: string) => void;
};

export const SettingsBrowserTab: React.FC<Props> = ({ saveExport }) => {
  const { state } = useBrowserSession();
  const { t } = useI18n();
  const browserRunning = state === 'running';

  return (
    <SettingsPage title={t('settings.tabs.browser')}>
      <BrowserImportSection
        browserRunning={browserRunning}
        saveExport={saveExport}
      />
    </SettingsPage>
  );
};
