/**
 * 插件导入页：官方插件可安装/卸载，从文件导入的插件可删除。
 */

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { t } from '../../i18n';
import { AppIcon } from '@/components/ui/icons';
import { ExtensionActionCard } from './ExtensionActionCard';
import { useToast } from '../../services/toast/ToastContext';
import { CANONICAL_IMPORT_PLUGIN_ID } from './extensionIdentity';
import {
  isOfficialPluginUninstalled,
  setOfficialPluginUninstalled,
} from '../../api/extensionCatalog';
import { setPluginEnabled } from '../settings-extensions/pluginRegistryAdapter';
import {
  loadCustomPlugins,
  removeCustomPlugin,
  type CustomPluginItem,
} from './customPluginStorage';
import { notifyExtensionLifecycle } from './skillDismissState';
import styles from './ExternalImportWorkbench.module.css';

export interface PluginImportPanelProps {
  onRequestFileImport?: () => void;
}

export const PluginImportPanel: React.FC<PluginImportPanelProps> = ({
  onRequestFileImport,
}) => {
  const { showToast } = useToast();
  const [customPlugins, setCustomPlugins] = useState<CustomPluginItem[]>(() =>
    loadCustomPlugins()
  );
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const sync = () => setCustomPlugins(loadCustomPlugins());
    window.addEventListener('crish:custom-plugins-changed', sync);
    return () =>
      window.removeEventListener('crish:custom-plugins-changed', sync);
  }, []);

  const officialInstalled =
    revision >= 0 && !isOfficialPluginUninstalled(CANONICAL_IMPORT_PLUGIN_ID);

  const toggleOfficial = () => {
    const nextInstalled = !officialInstalled;
    setOfficialPluginUninstalled(CANONICAL_IMPORT_PLUGIN_ID, !nextInstalled);
    setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, nextInstalled);
    setRevision((value) => value + 1);
    notifyExtensionLifecycle();
    const pluginName = t('extensions.officialPlugin.name');
    showToast(
      nextInstalled
        ? t('extensions.toast.pluginInstalled', { name: pluginName })
        : t('extensions.plugin.uninstalled', { name: pluginName })
    );
  };

  const deleteCustom = (plugin: CustomPluginItem) => {
    removeCustomPlugin(plugin.id);
    notifyExtensionLifecycle();
    showToast(t('extensions.plugin.deleted', { name: plugin.name }));
  };

  return (
    <>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerTitle}>
            <AppIcon name="puzzle" size={18} />
            <span>{t('extensions.panel.title')}</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <Button
            size="sm"
            variant="secondary"
            onClick={onRequestFileImport}
            disabled={!onRequestFileImport}
          >
            <AppIcon name="folder-input" size={13} />
            <span>{t('extensions.panel.fromFileLabel')}</span>
          </Button>
        </div>
      </div>
      <div className={styles.content}>
        <div className={styles.grid}>
          <ExtensionActionCard
            name={t('extensions.officialPlugin.name')}
            description={t('extensions.officialPlugin.description')}
            badge={t('extensions.badge.official')}
            icon="history"
            placement="catalog"
            installed={officialInstalled}
            onAction={toggleOfficial}
          />
          {customPlugins.map((plugin) => (
            <ExtensionActionCard
              key={plugin.id}
              name={plugin.name}
              description={
                plugin.description || t('extensions.plugin.fromFileDescription')
              }
              badge={t('extensions.badge.local')}
              icon="puzzle"
              placement="custom"
              installed
              onAction={() => deleteCustom(plugin)}
            />
          ))}
        </div>
      </div>
    </>
  );
};
