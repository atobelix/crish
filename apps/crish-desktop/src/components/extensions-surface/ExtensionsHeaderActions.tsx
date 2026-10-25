/**
 * ExtensionsMainSurface 头部右侧动作区（分类动作按钮 + 搜索框）。
 * 拆分来源：ExtensionsMainSurface.tsx（行数门禁收口，结构不变）。
 */

import React from 'react';
import { Button, Input, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';
import styles from './ExtensionsMainSurface.module.css';

export type ExtensionsCategoryFilter = 'plugins' | 'skills' | 'mcp';

export interface ExtensionsHeaderActionsProps {
  categoryFilter: ExtensionsCategoryFilter;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onCreatePlugin: () => void;
  onOpenPluginImport: () => void;
  onOpenSkillCreate: () => void;
  onOpenMcpConnect: () => void;
}

export const ExtensionsHeaderActions: React.FC<
  ExtensionsHeaderActionsProps
> = ({
  categoryFilter,
  searchQuery,
  onSearchQueryChange,
  onCreatePlugin,
  onOpenPluginImport,
  onOpenSkillCreate,
  onOpenMcpConnect,
}) => {
  const { t } = useI18n();
  const createPluginLabel = t('extensions.header.createPlugin', '制作插件');
  const importPluginLabel = t('extensions.header.importPlugin', '导入插件');
  const addSkillLabel = t('extensions.header.addSkill', '添加技能');
  const connectMcpLabel = t('extensions.header.connectMcp', '接入 MCP');

  return (
    <>
      {categoryFilter === 'plugins' && (
        <>
          <Tooltip content={createPluginLabel}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.headerIconBtn}
              onClick={onCreatePlugin}
              aria-label={createPluginLabel}
            >
              <AppIcon name="sparkles" size={16} />
            </Button>
          </Tooltip>
          <Tooltip content={importPluginLabel}>
            <Button
              variant="ghost"
              size="sm"
              className={styles.headerIconBtn}
              onClick={onOpenPluginImport}
              aria-label={importPluginLabel}
            >
              <AppIcon name="folder-input" size={16} />
            </Button>
          </Tooltip>
        </>
      )}
      {categoryFilter === 'skills' && (
        <Tooltip content={addSkillLabel}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.headerIconBtn}
            onClick={onOpenSkillCreate}
            aria-label={addSkillLabel}
          >
            <AppIcon name="plus" size={16} />
          </Button>
        </Tooltip>
      )}
      {categoryFilter === 'mcp' && (
        <Tooltip content={connectMcpLabel}>
          <Button
            variant="ghost"
            size="sm"
            className={styles.headerIconBtn}
            onClick={onOpenMcpConnect}
            aria-label={connectMcpLabel}
          >
            <AppIcon name="plus" size={16} />
          </Button>
        </Tooltip>
      )}

      <div className={styles.searchBarWrapper}>
        <AppIcon name="search" size={14} className={styles.searchIcon} />
        <Input
          bare
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder={t(
            'extensions.header.searchPlaceholder',
            '搜索扩展、技能与工具…'
          )}
          className={styles.searchInput}
          aria-label={t('extensions.header.searchLabel', '搜索扩展')}
        />
      </div>
    </>
  );
};
