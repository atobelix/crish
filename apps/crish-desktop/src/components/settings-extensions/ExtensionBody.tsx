import React from 'react';
import styles from './SettingsExtensionsTab.module.css';
import {
  type CatalogEntry,
  type InstalledExtension,
} from '../../api/extensionCatalog';
import type { ExpandMode } from './types';
import { Button, Tooltip } from '../ui';
import { isPluginCardItem } from './ExtensionCardIdentity';

/** skill/plugin 展开体公共回调子集（与 ExtensionCardActionsProps 子集）。 */
export interface ExtensionBodyActionsProps {
  onSetManage?: (kind: 'skill' | 'mcp' | null) => void;
}

export interface ExtensionBodyProps {
  item: InstalledExtension | CatalogEntry;
  mode: ExpandMode;
  kind: 'skill' | 'plugin';
  actions: ExtensionBodyActionsProps;
}

/**
 * skill / plugin 卡片展开体。从 ExtensionCard 抽出以收敛行数；
 * MCP 分支见 McpToolsSection。
 */
export const ExtensionBody: React.FC<ExtensionBodyProps> = ({
  item,
  mode,
  kind,
  actions,
}) => {
  const { onSetManage } = actions;

  if (kind === 'skill') {
    const isInstalled = 'skillPath' in item || 'skillRaw' in item;
    const installedItem = isInstalled ? (item as InstalledExtension) : null;
    const entry = !isInstalled ? (item as CatalogEntry) : null;
    if (mode === 'detail') {
      return (
        <div className="ext-inline-panel">
          {installedItem?.skillPath ? (
            <Tooltip content={installedItem.skillPath}>
              <div className="ext-detail-meta">
                {installedItem.skillPath}
              </div>
            </Tooltip>
          ) : null}
          <pre className="ext-detail-md" tabIndex={0}>
            {(installedItem &&
              (installedItem.skillRaw ||
                installedItem.skillContent ||
                '# 暂无 SKILL.md 内容')) ||
              (entry
                ? `# ${entry.name}\n\n${entry.description}\n\n安装后可在本机技能目录中查看完整 SKILL.md。`
                : '# 暂无内容')}
          </pre>
        </div>
      );
    }
    return (
      <div className="ext-inline-panel">
        <p className="ext-detail-desc">
          {installedItem?.fromSystem
            ? '可在高级管理中编辑路径、同步与更多选项。'
            : '安装后的技能可在本机技能目录维护；高级入口提供完整管理。'}
        </p>
        <div className="ext-detail-actions">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="settings-btn-rect"
            onClick={() => onSetManage?.('skill')}
          >
            高级管理
          </Button>
        </div>
      </div>
    );
  }

  // kind === 'plugin'
  const name = item.name;
  const desc = item.description;
  const ref =
    'installRef' in item && item.installRef ? item.installRef : undefined;
  const pluginCard = isPluginCardItem(item) ? item : null;
  return (
    <div className="ext-inline-panel">
      <div className={`ext-detail-md ${styles.detailMdSans}`}>
        {desc}
        {'\n\n'}
        {mode === 'config'
          ? '此插件已安装，可在任务与对话流程中使用。'
          : '安装后会写入本机扩展包列表，供工作台加载。'}
        {ref ? `\n\n引用：${ref}` : ''}
        {`\n名称：${name}`}
        {pluginCard?.pluginVersion ? `\n版本：${pluginCard.pluginVersion}` : ''}
        {pluginCard?.pluginTrustLevel
          ? `\n信任级别：${pluginCard.pluginTrustLevel}`
          : ''}
        {pluginCard?.pluginHooks && pluginCard.pluginHooks.length > 0
          ? `\n钩子：${pluginCard.pluginHooks.join('、')}`
          : ''}
        {pluginCard?.pluginTools && pluginCard.pluginTools.length > 0
          ? `\n工具：${pluginCard.pluginTools.join('、')}`
          : ''}
      </div>
    </div>
  );
};
