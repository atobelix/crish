import React, { useMemo } from 'react';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';

import type { CustomPluginItem } from './customPluginStorage';
import { ExtensionDetailModal } from '../settings-extensions/ExtensionDetailModal';
import { SkillCreateModal } from './SkillCreateModal';
import { McpConnectModal } from './McpConnectModal';
import { PluginCreateModal } from './PluginCreateModal';
import { PluginShareModal } from './PluginShareModal';
import { SkillDetailModal, type SkillDetailTarget } from './SkillDetailModal';
import type { DesktopSkill } from '../../api/skillsApi';

export interface ExtensionsModalsProps {
  selectedDetailItem: InstalledExtension | CatalogEntry | null;
  onCloseDetail: () => void;
  catalogInstalled: Set<string>;
  busyId: string | null;
  skills?: DesktopSkill[];
  onToggleSkill?: (skill: DesktopSkill) => Promise<void> | void;
  onBackToChat?: () => void;
  mcpState: {
    expandedMcpTools: Set<string>;
    toolTick: number;
    mcpServerBusy: boolean;
    mcpToolBusy: boolean;
  };
  onInstallCatalog: (entry: CatalogEntry) => void;
  onRemovePackage: (item: InstalledExtension) => void;
  togglePlugin: (pluginId: string, enabled: boolean) => void;
  onToggleMcpServer: (serverId: string, start: boolean) => void;
  onToggleMcpTool: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools: (id: string) => void;
  showSkillCreateModal: boolean;
  onCloseSkillCreate: () => void;
  showMcpConnectModal: boolean;
  onCloseMcpConnect: () => void;
  showPluginCreateModal: boolean;
  pluginCreateTab?: 'create' | 'manual';
  onClosePluginCreate: () => void;
  showPluginShareModal: boolean;
  onClosePluginShare: () => void;
  sharePluginTarget:
    | CustomPluginItem
    | { id: string; name: string; description: string; version?: string }
    | null;
  onRefresh: () => void;
  onPluginCreated: () => void;
}

export const ExtensionsModals: React.FC<ExtensionsModalsProps> = ({
  selectedDetailItem,
  onCloseDetail,
  catalogInstalled,
  busyId,
  skills,
  onToggleSkill,
  onBackToChat,
  mcpState,
  onInstallCatalog,
  onRemovePackage,
  togglePlugin,
  onToggleMcpServer,
  onToggleMcpTool,
  onToggleExpandMcpTools,
  showSkillCreateModal,
  onCloseSkillCreate,
  showMcpConnectModal,
  onCloseMcpConnect,
  showPluginCreateModal,
  pluginCreateTab = 'create',
  onClosePluginCreate,
  showPluginShareModal,
  onClosePluginShare,
  sharePluginTarget,
  onRefresh,
  onPluginCreated,
}) => {
  const isSkill = selectedDetailItem?.kind === 'skill';

  const skillTarget: SkillDetailTarget | null = useMemo(() => {
    if (!selectedDetailItem || selectedDetailItem.kind !== 'skill') return null;
    const isInstalled =
      'installRef' in selectedDetailItem
        ? catalogInstalled.has(selectedDetailItem.id)
        : true;
    const inst = selectedDetailItem as InstalledExtension;
    const cat = selectedDetailItem as CatalogEntry;
    const matchingSkill = skills?.find(
      (s) =>
        s.id === selectedDetailItem.id ||
        s.name.toLowerCase() === selectedDetailItem.name.toLowerCase()
    );
    const isEnabled = matchingSkill
      ? matchingSkill.activation === 'enabled' ||
        matchingSkill.activation === 'recommended'
      : true;

    return {
      id: selectedDetailItem.id,
      name: selectedDetailItem.name,
      description: selectedDetailItem.description,
      source: selectedDetailItem.source,
      filePath: inst.skillPath || matchingSkill?.filePath,
      content: inst.skillContent || matchingSkill?.content,
      raw: inst.skillRaw || matchingSkill?.raw,
      isInstalled,
      isEnabled,
      isOfficial:
        selectedDetailItem.source === 'official' ||
        Boolean(matchingSkill?.system),
      rawSkill: matchingSkill,
      installedItem: 'fromSystem' in selectedDetailItem ? inst : undefined,
      catalogEntry: 'installRef' in selectedDetailItem ? cat : undefined,
    };
  }, [selectedDetailItem, catalogInstalled, skills]);

  return (
    <>
      {isSkill ? (
        <SkillDetailModal
          open={Boolean(selectedDetailItem)}
          onClose={onCloseDetail}
          skill={skillTarget}
          onImport={async (target) => {
            if (target.catalogEntry) {
              await onInstallCatalog(target.catalogEntry);
            }
          }}
          onToggleEnabled={async (target) => {
            if (onToggleSkill && target.rawSkill) {
              await onToggleSkill(target.rawSkill);
            }
          }}
          onBackToChat={onBackToChat}
        />
      ) : (
        <ExtensionDetailModal
          open={Boolean(selectedDetailItem)}
          onClose={onCloseDetail}
          scope={
            selectedDetailItem &&
            'installRef' in selectedDetailItem &&
            !catalogInstalled.has(selectedDetailItem.id)
              ? 'catalog'
              : 'installed'
          }
          item={selectedDetailItem}
          canUninstall={false}
          busyId={busyId}
          mcpState={mcpState}
          onInstallCatalog={onInstallCatalog}
          onRemovePackage={onRemovePackage}
          onTogglePlugin={togglePlugin}
          onToggleMcpServer={onToggleMcpServer}
          onToggleMcpTool={onToggleMcpTool}
          onToggleExpandMcpTools={onToggleExpandMcpTools}
        />
      )}

      <SkillCreateModal
        open={showSkillCreateModal}
        onClose={onCloseSkillCreate}
        onSuccess={() => void onRefresh()}
      />
      <McpConnectModal
        open={showMcpConnectModal}
        onClose={onCloseMcpConnect}
        onSuccess={() => void onRefresh()}
      />
      <PluginCreateModal
        open={showPluginCreateModal}
        initialTab={pluginCreateTab}
        onClose={onClosePluginCreate}
        onSuccess={onPluginCreated}
      />
      <PluginShareModal
        open={showPluginShareModal}
        onClose={onClosePluginShare}
        plugin={sharePluginTarget}
      />
    </>
  );
};
