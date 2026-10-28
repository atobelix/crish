import React from 'react';
import { Button } from '@/components/ui';
import { t } from '../../i18n';
import { ExternalImportWorkbench } from './ExternalImportWorkbench';
import { ExtensionsHeaderActions } from './ExtensionsHeaderActions';
import { ExtensionsInstalledWorkbench } from './ExtensionsInstalledWorkbench';
import { ExtensionsModals } from './ExtensionsModals';
import { ExtensionsSidebar } from './ExtensionsSidebar';
import { ExtensionsCatalogGrid } from './ExtensionsCatalogGrid';
import {
  useExtensionsMainController,
  type CategoryFilter,
} from './useExtensionsMainController';
export type { UnifiedExtensionItem } from './buildUnifiedItems';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsMainSurfaceProps {
  onBackToChat?: () => void;
}

const CATEGORY_TABS: { id: CategoryFilter; labelKey: string }[] = [
  { id: 'plugins', labelKey: 'extensions.tab.plugins' },
  { id: 'skills', labelKey: 'extensions.tab.skills' },
  { id: 'mcp', labelKey: 'extensions.tab.mcp' },
];

export const ExtensionsMainSurface: React.FC<ExtensionsMainSurfaceProps> = ({
  onBackToChat,
}) => {
  const ctrl = useExtensionsMainController(onBackToChat);

  return (
    <div className={styles.surfaceRoot} data-testid="extensions-main-surface">
      {/* 顶部第一行：三大扩展形态分类 + 右侧快捷图标与搜索 */}
      <div className={styles.surfaceHeader}>
        <div className={styles.topNavTabs} role="tablist">
          {CATEGORY_TABS.map((tab) => (
            <Button
              key={tab.id}
              bare
              type="button"
              className={`${styles.topNavTab} ${ctrl.categoryFilter === tab.id ? styles.activeTopNavTab : ''}`}
              onClick={() => ctrl.handleCategoryChange(tab.id)}
            >
              {t(tab.labelKey)}
            </Button>
          ))}
        </div>

        <div className={styles.headerRight}>
          <ExtensionsHeaderActions
            categoryFilter={ctrl.categoryFilter}
            searchQuery={ctrl.searchQuery}
            onSearchQueryChange={ctrl.setSearchQuery}
            onCreatePlugin={ctrl.handleCreatePlugin}
            onOpenPluginImport={() => ctrl.setShowPluginCreateModal(true)}
            onOpenSkillCreate={() => ctrl.setShowSkillCreateModal(true)}
            onOpenMcpConnect={() => ctrl.setShowMcpConnectModal(true)}
          />
        </div>
      </div>

      {/* 第二行功能导航行 + 下方全宽主工作区 */}
      <div className={styles.mainLayout}>
        <ExtensionsSidebar
          sidebarNav={ctrl.sidebarNav}
          onSelectNav={ctrl.handleSelectNav}
          installedItems={ctrl.installedItems}
          selectedInstalledId={ctrl.selectedInstalledId}
        />

        <div className={styles.rightWorkspace}>
          {ctrl.sidebarNav === 'import' ? (
            <div className={styles.workbenchContainer}>
              <ExternalImportWorkbench
                categoryFilter={ctrl.currentKind}
                onBackToChat={onBackToChat}
                onRefresh={ctrl.refresh}
                onImportSuccess={ctrl.refresh}
                onRequestPluginImport={() =>
                  ctrl.setShowPluginCreateModal(true)
                }
              />
            </div>
          ) : ctrl.selectedInstalledItem ? (
            <div className={styles.workbenchContainer}>
              <ExtensionsInstalledWorkbench
                item={ctrl.selectedInstalledItem}
                onBackToChat={onBackToChat}
                refresh={ctrl.refresh}
                onToggleMcp={ctrl.handleToggleMcp}
                onToggleSkill={ctrl.handleToggleSkill}
                onToggleGeneral={ctrl.handleToggleGeneral}
                onSharePlugin={ctrl.handleSharePlugin}
              />
            </div>
          ) : (
            <ExtensionsCatalogGrid
              catalogItems={ctrl.catalogItems}
              sidebarNav={
                ctrl.sidebarNav === 'featured'
                  ? 'featured'
                  : ctrl.sidebarNav === 'installed'
                    ? 'installed'
                    : 'explore'
              }
              categoryFilter={ctrl.categoryFilter}
              searchQuery={ctrl.searchQuery}
              busyId={ctrl.busyId}
              onSelectDetail={ctrl.setSelectedDetailItem}
              onSelectInstalled={ctrl.handleSelectInstalled}
              onInstall={ctrl.handleInstallCatalogItem}
              onUninstall={ctrl.handleUninstallItem}
            />
          )}
        </div>
      </div>

      {/* 弹窗管理器 */}
      <ExtensionsModals
        selectedDetailItem={ctrl.selectedDetailItem}
        onCloseDetail={() => ctrl.setSelectedDetailItem(null)}
        catalogInstalled={ctrl.catalogInstalled}
        busyId={ctrl.busyId}
        skills={ctrl.skills}
        onToggleSkill={ctrl.handleToggleSkill}
        onBackToChat={onBackToChat}
        mcpState={ctrl.mcpState}
        onInstallCatalog={ctrl.handleInstallCatalog}
        onRemovePackage={ctrl.handleRemoveFromDetail}
        togglePlugin={ctrl.togglePlugin}
        onToggleMcpServer={ctrl.handleToggleMcpServerId}
        onToggleMcpTool={ctrl.toggleMcpTool}
        onToggleExpandMcpTools={ctrl.toggleExpandMcpTools}
        showSkillCreateModal={ctrl.showSkillCreateModal}
        onCloseSkillCreate={() => ctrl.setShowSkillCreateModal(false)}
        showMcpConnectModal={ctrl.showMcpConnectModal}
        onCloseMcpConnect={() => ctrl.setShowMcpConnectModal(false)}
        showPluginCreateModal={ctrl.showPluginCreateModal}
        pluginCreateTab={ctrl.pluginCreateTab}
        onClosePluginCreate={() => ctrl.setShowPluginCreateModal(false)}
        showPluginShareModal={ctrl.showPluginShareModal}
        onClosePluginShare={() => ctrl.setShowPluginShareModal(false)}
        sharePluginTarget={ctrl.sharePluginTarget}
        onRefresh={() => void ctrl.refresh()}
        onPluginCreated={ctrl.handlePluginCreated}
      />
    </div>
  );
};
