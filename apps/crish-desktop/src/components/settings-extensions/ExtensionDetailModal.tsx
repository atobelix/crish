import React from 'react';
import {
  type CatalogEntry,
  type InstalledExtension,
  kindLabel,
} from '../../api/extensionCatalog';
import { Badge, Button, Dialog, Tooltip } from '../ui';
import { AppIcon, type IconName } from '../ui/icons/index';
import { isPluginCardItem } from './ExtensionCardIdentity';
import {
  McpToolsSection,
  type McpToolsSectionStateProps,
} from './McpToolsSection';
import type { ManageKind } from './types';
import styles from './ExtensionDetailModal.module.css';

export interface ExtensionDetailModalProps {
  open: boolean;
  onClose: () => void;
  scope: 'installed' | 'catalog';
  item: InstalledExtension | CatalogEntry | null;
  canUninstall?: boolean;
  busyId?: string | null;
  mcpState: McpToolsSectionStateProps;
  onInstallCatalog?: (entry: CatalogEntry) => void;
  onRemovePackage?: (item: InstalledExtension) => void;
  onTogglePlugin?: (pluginId: string, enabled: boolean) => void;
  onToggleMcpServer?: (serverId: string, start: boolean) => void;
  onToggleMcpTool?: (serverId: string, tool: string, enabled: boolean) => void;
  onToggleExpandMcpTools?: (id: string) => void;
  onSetManage?: (kind: ManageKind) => void;
  onOpenExternalSync?: () => void;
}

export function getExtensionIcon(
  item: InstalledExtension | CatalogEntry
): IconName {
  if (item.kind === 'mcp') return 'cable';
  if (item.kind === 'skill') return 'sparkles';
  const idOrName = (item.id + ' ' + item.name).toLowerCase();
  if (idOrName.includes('claude') || idOrName.includes('codex')) {
    return 'puzzle';
  }
  if (idOrName.includes('audit') || idOrName.includes('审计')) {
    return 'shield-check';
  }
  if (idOrName.includes('doc') || idOrName.includes('文档')) {
    return 'file-text';
  }
  if (idOrName.includes('theme') || idOrName.includes('主题')) {
    return 'orbit';
  }
  return 'blocks';
}

function sourceLabel(source: string): string {
  if (source === 'official') return '官方';
  if (source === 'community') return '三方';
  return '本机';
}

export const ExtensionDetailModal: React.FC<ExtensionDetailModalProps> = ({
  open,
  onClose,
  scope,
  item,
  canUninstall,
  busyId,
  mcpState,
  onInstallCatalog,
  onRemovePackage,
  onTogglePlugin,
  onToggleMcpServer,
  onToggleMcpTool,
  onToggleExpandMcpTools,
  onSetManage,
  onOpenExternalSync,
}) => {
  if (!item) return null;

  const pluginCard = isPluginCardItem(item) ? item : null;
  const isImportPlugin =
    item.id === '@crish/plugin-import-claude-codex' ||
    item.id === '@crish/import-claude-codex' ||
    item.id.includes('import-claude-codex') ||
    (pluginCard != null &&
      (pluginCard.pluginId === '@crish/import-claude-codex' ||
        pluginCard.pluginId === '@crish/plugin-import-claude-codex'));

  const installedItem =
    scope === 'installed' ? (item as InstalledExtension) : null;
  const catalogEntry = scope === 'catalog' ? (item as CatalogEntry) : null;

  const dialogSize = item.kind === 'mcp' || item.kind === 'skill' ? 'xl' : 'lg';

  return (
    <Dialog
      size={dialogSize}
      open={open}
      onClose={onClose}
      ariaLabel={`${item.name} 详情`}
      role="dialog"
      showCloseButton={false}
    >
      <div className={styles.modalOverlay}>
        <div className={styles.header}>
          <div className={styles.iconBox}>
            <AppIcon name={getExtensionIcon(item)} size={18} />
          </div>
          <div className={styles.headerMeta}>
            <div className={styles.titleLine}>
              <h3 className={styles.title}>{item.name}</h3>
              <Badge size="xs" tone="neutral">
                {kindLabel(item.kind)}
              </Badge>
              <Badge
                size="xs"
                tone={item.source === 'official' ? 'brand' : 'neutral'}
              >
                {sourceLabel(item.source)}
              </Badge>
              <div className={styles.headerActions}>
                {scope === 'installed' && pluginCard ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    active={pluginCard.pluginEnabled}
                    aria-pressed={pluginCard.pluginEnabled}
                    onClick={() =>
                      onTogglePlugin?.(
                        pluginCard.pluginId!,
                        !pluginCard.pluginEnabled
                      )
                    }
                  >
                    {pluginCard.pluginEnabled ? '已启用' : '已停用'}
                  </Button>
                ) : null}

                {scope === 'catalog' && catalogEntry ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={busyId === catalogEntry.id}
                    onClick={() => void onInstallCatalog?.(catalogEntry)}
                  >
                    {busyId === catalogEntry.id ? '安装中…' : '安装'}
                  </Button>
                ) : null}

                {canUninstall && installedItem ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      void onRemovePackage?.(installedItem);
                      onClose();
                    }}
                  >
                    卸载
                  </Button>
                ) : null}
              </div>
            </div>
            <div className={styles.subMeta}>
              <span>ID: {item.id}</span>
              {pluginCard?.pluginVersion ? (
                <span>· v{pluginCard.pluginVersion}</span>
              ) : null}
            </div>
            <p className={styles.description}>
              {item.description || '暂无描述信息'}
            </p>
          </div>
          <Tooltip content="关闭">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="关闭弹窗"
            >
              <AppIcon name="x" size={14} />
            </Button>
          </Tooltip>
        </div>

        <div className={`${styles.bodyCoverContent} coverContent`}>
          {isImportPlugin ? (
            <div className={styles.featureCard}>
              <div className={styles.featureCardHeader}>
                <div className={styles.featureCardTitle}>
                  <AppIcon name="refresh" size={16} />
                  <span>外部对话无损导入与同步</span>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onClose();
                    onOpenExternalSync?.();
                  }}
                >
                  进入导入与管理
                </Button>
              </div>
              <div className={styles.featureCardDesc}>
                自动检测 Claude Code 与 OpenAI Codex
                的本地对话记录，一键无损同步至 Crish，无需繁琐导出或格式迁移。
              </div>
            </div>
          ) : null}

          {item.kind === 'mcp' ? (
            <div className={styles.descriptionSection}>
              <span className={styles.sectionTitle}>MCP 服务与工具</span>
              <McpToolsSection
                item={item}
                mode="config"
                state={mcpState}
                actions={{
                  onToggleMcpServer,
                  onToggleMcpTool,
                  onToggleExpandMcpTools,
                  onSetManage,
                }}
              />
            </div>
          ) : null}

          {item.kind === 'skill' ? (
            <div className={styles.descriptionSection}>
              <div className={styles.featureCardHeader}>
                <span className={styles.sectionTitle}>技能指令 (SKILL.md)</span>
                {onSetManage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      onClose();
                      onSetManage('skill');
                    }}
                  >
                    在技能中心编辑
                  </Button>
                ) : null}
              </div>
              {'skillPath' in item && item.skillPath ? (
                <Tooltip content={item.skillPath}>
                  <div className={styles.infoLabel}>路径: {item.skillPath}</div>
                </Tooltip>
              ) : null}
              <pre className={`${styles.detailMdCoverContent} coverContent`}>
                {'skillRaw' in item && item.skillRaw
                  ? item.skillRaw
                  : 'skillContent' in item && item.skillContent
                    ? item.skillContent
                    : catalogEntry
                      ? `# ${catalogEntry.name}\n\n${catalogEntry.description}\n\n安装后可在本地技能目录中查看完整 SKILL.md。`
                      : '暂无指令内容'}
              </pre>
            </div>
          ) : null}

          {pluginCard ? (
            <div className={styles.descriptionSection}>
              <span className={styles.sectionTitle}>插件元数据清单</span>
              <div className={styles.infoGrid}>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>声明工具数</span>
                  <span className={styles.infoValue}>
                    {pluginCard.pluginTools?.length ?? 0} 个
                  </span>
                </div>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>监听生命周期</span>
                  <span className={styles.infoValue}>
                    {pluginCard.pluginHooks?.join(', ') || '无'}
                  </span>
                </div>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>信任级别</span>
                  <span className={styles.infoValue}>
                    {pluginCard.pluginTrustLevel || 'normal'}
                  </span>
                </div>
                <div className={styles.infoItem}>
                  <span className={styles.infoLabel}>安装类型</span>
                  <span className={styles.infoValue}>内置官方分发</span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
};
