/**
 * 设置 · 浏览器：偏好配置、数据清理与凭据管理。
 *
 * 遵循设计规范：
 * 避免不必要的次要标签和描述，让布局结构与交互原子自身清晰说明语义。
 */
import React, { useState } from 'react';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { BrowserImportSection } from '../workspace/browser-panel/BrowserImportSection';
import { useBrowserSession } from '../workspace/useBrowserSession';
import { useI18n } from '../../i18n';
import { Select, Input, Button, Switch } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { toast } from '../../services/toast/ToastContext';
import {
  getSearchEngine,
  setSearchEngine,
  getHomepage,
  setHomepage,
  getBrowserStorageMode,
  setBrowserStorageMode,
  getBrowserDefaultMuted,
  setBrowserDefaultMuted,
  clearAllHistory,
  clearAllBookmarks,
  type SearchEngineId,
  type BrowserStorageMode,
  SEARCH_ENGINE_SELECT_OPTIONS,
} from './settingsBrowserLib';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
  saveExport?: (filename: string, content: string) => void;
};

export const SettingsBrowserTab: React.FC<Props> = ({ saveExport }) => {
  const { state } = useBrowserSession();
  const { t } = useI18n();
  const browserRunning = state === 'running';

  const [searchEngine, setSearchEngineState] = useState<SearchEngineId>(() =>
    getSearchEngine()
  );
  const [homepage, setHomepageState] = useState<string>(() => getHomepage());
  const [storageMode, setStorageModeState] = useState<BrowserStorageMode>(() =>
    getBrowserStorageMode()
  );
  const [defaultMuted, setDefaultMutedState] = useState<boolean>(() =>
    getBrowserDefaultMuted()
  );

  const handleSearchEngineChange = (val: string) => {
    const id = val as SearchEngineId;
    setSearchEngineState(id);
    setSearchEngine(id);
  };

  const handleHomepageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setHomepageState(val);
    setHomepage(val);
  };

  const handleStorageModeChange = (checked: boolean) => {
    const mode: BrowserStorageMode = checked ? 'ephemeral' : 'persistent';
    setStorageModeState(mode);
    setBrowserStorageMode(mode);
  };

  const handleDefaultMutedChange = (checked: boolean) => {
    setDefaultMutedState(checked);
    setBrowserDefaultMuted(checked);
  };

  const handleClearHistory = () => {
    clearAllHistory();
    toast.show(t('settings.browser.historyCleared', '历史记录已清除'));
  };

  const handleClearBookmarks = () => {
    clearAllBookmarks();
    toast.show(t('settings.browser.bookmarksCleared', '书签已清空'));
  };

  return (
    <SettingsPage title={t('settings.tabs.browser')}>
      <SettingsSection title={t('settings.browser.preferences', '偏好设置')}>
        <SettingsCard>
          <SettingsRow
            icon={<AppIcon name="search" size={16} />}
            title={t('settings.browser.defaultSearchEngine', '默认搜索引擎')}
            control={
              <Select
                size="sm"
                value={searchEngine}
                options={SEARCH_ENGINE_SELECT_OPTIONS}
                onChange={handleSearchEngineChange}
              />
            }
          />
          <SettingsRow
            icon={<AppIcon name="home" size={16} />}
            title={t('settings.browser.homepage', '主页')}
            control={
              <Input
                size="xs"
                value={homepage}
                placeholder="about:blank"
                onChange={handleHomepageChange}
              />
            }
          />
          <SettingsRow
            icon={<AppIcon name="shield" size={16} />}
            title={t('settings.browser.ephemeralMode', '无痕沙箱模式')}
            control={
              <Switch
                size="sm"
                aria-label={t('settings.browser.ephemeralMode', '无痕沙箱模式')}
                checked={storageMode === 'ephemeral'}
                onCheckedChange={handleStorageModeChange}
              />
            }
          />
          <SettingsRow
            icon={<AppIcon name="sliders" size={16} />}
            title={t('settings.browser.defaultMuted', '默认静音')}
            control={
              <Switch
                size="sm"
                aria-label={t('settings.browser.defaultMuted', '默认静音')}
                checked={defaultMuted}
                onCheckedChange={handleDefaultMutedChange}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('settings.browser.dataCleanup', '数据清理')}>
        <SettingsCard>
          <SettingsRow
            icon={<AppIcon name="history" size={16} />}
            title={t('settings.browser.browsingHistory', '浏览历史')}
            control={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleClearHistory}
              >
                {t('settings.browser.clearHistory', '清除')}
              </Button>
            }
          />
          <SettingsRow
            icon={<AppIcon name="bookmark" size={16} />}
            title={t('settings.browser.bookmarks', '书签')}
            control={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleClearBookmarks}
              >
                {t('settings.browser.emptyBookmarks', '清空')}
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <BrowserImportSection
        browserRunning={browserRunning}
        saveExport={saveExport}
      />
    </SettingsPage>
  );
};
