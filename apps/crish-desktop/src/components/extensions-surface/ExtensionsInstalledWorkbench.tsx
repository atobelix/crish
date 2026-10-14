import React from 'react';
import { Button } from '../ui';
import { AppIcon } from '../ui/icons/index';
import type { DesktopSkill } from '../../api/skillsApi';
import type { McpServerInfo } from '../../api/mcpApi';
import { ExternalSessionsWorkbench } from './ExternalSessionsWorkbench';
import { McpDetailWorkbench } from './McpDetailWorkbench';
import { SkillDetailWorkbench } from './SkillDetailWorkbench';
import {
  ExtensionGeneralWorkbench,
  type GeneralExtensionItem,
} from './ExtensionGeneralWorkbench';
import { isImportClaudeCodexPlugin } from './extensionIdentity';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import type { CustomPluginItem } from './customPluginStorage';
import styles from './ExtensionsMainSurface.module.css';

export interface ExtensionsInstalledWorkbenchProps {
  item: UnifiedExtensionItem;
  onBackToChat?: () => void;
  refresh: () => Promise<void> | void;
  onToggleMcp: (server: McpServerInfo) => void;
  onToggleSkill: (skill: DesktopSkill) => Promise<void> | void;
  onToggleGeneral: (item: GeneralExtensionItem) => void;
  onSharePlugin: (
    target:
      | CustomPluginItem
      | { id: string; name: string; description: string; version?: string }
  ) => void;
}

export const ExtensionsInstalledWorkbench: React.FC<
  ExtensionsInstalledWorkbenchProps
> = ({
  item,
  onBackToChat,
  refresh,
  onToggleMcp,
  onToggleSkill,
  onToggleGeneral,
  onSharePlugin,
}) => {
  if (isImportClaudeCodexPlugin(item)) {
    return (
      <ExternalSessionsWorkbench
        onBackToChat={onBackToChat}
        onRefresh={refresh}
      />
    );
  }

  if (item.kind === 'mcp' && item.rawMcp) {
    return (
      <McpDetailWorkbench server={item.rawMcp} onToggleServer={onToggleMcp} />
    );
  }

  if (item.kind === 'skill' && item.rawSkill) {
    return (
      <SkillDetailWorkbench
        skill={item.rawSkill}
        onToggleActivation={onToggleSkill}
        onBackToChat={onBackToChat}
      />
    );
  }

  return (
    <>
      <div className={styles.workbenchTopBar}>
        <span className={styles.workbenchTopBarTitle}>
          <AppIcon name={item.icon} size={14} />
          <span>{item.name} 专属工作台</span>
        </span>
        <div className={styles.workbenchTopBarActions}>
          <Button
            variant="secondary"
            size="sm"
            className={styles.headerActionBtn}
            onClick={() => {
              onSharePlugin({
                id: item.id.replace('custom-plugin:', ''),
                name: item.name,
                description: item.description,
                version:
                  (item.installedItem as unknown as { version?: string })
                    ?.version || '1.0.0',
              });
            }}
          >
            <AppIcon name="upload" size={13} />
            <span>分享插件</span>
          </Button>
        </div>
      </div>
      <ExtensionGeneralWorkbench
        item={{
          id: item.id,
          kind: item.kind,
          name: item.name,
          description: item.description,
          icon: item.icon,
          isOfficial: item.isOfficial,
          isEnabled: item.isEnabled,
          installRef: item.installRef,
          version:
            (item.installedItem as unknown as { version?: string })?.version ||
            '1.0.0',
        }}
        onToggleEnabled={onToggleGeneral}
      />
    </>
  );
};
