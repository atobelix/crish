/**
 * 设置 · 浏览器：书签导入、历史记录导入与登录态管理。
 * 严格复用 SettingsUI 标准页面骨架与统一设计 Token。
 */
import React from 'react';
import { SettingsPage } from './SettingsUI';
import { BrowserImportSection } from '../workspace/browser-panel/BrowserImportSection';
import { useBrowserSession } from '../workspace/useBrowserSession';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
  saveExport?: (filename: string, content: string) => void;
  onShowToast?: (message: string) => void;
};

export const SettingsBrowserTab: React.FC<Props> = ({
  saveExport,
  onShowToast,
}) => {
  const { state } = useBrowserSession();
  const browserRunning = state === 'running';

  return (
    <SettingsPage title="浏览器">
      <BrowserImportSection
        browserRunning={browserRunning}
        saveExport={saveExport}
        onShowToast={onShowToast}
      />
    </SettingsPage>
  );
};
