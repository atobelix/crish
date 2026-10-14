/**
 * ExtensionsMainSurface 头部右侧动作区（分类动作按钮 + 搜索框）。
 * 拆分来源：ExtensionsMainSurface.tsx（行数门禁收口，结构不变）。
 */

import React from 'react';
import { Button, Input } from '../ui';
import { AppIcon } from '../ui/icons/index';
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
}) => (
  <>
    {categoryFilter === 'plugins' && (
      <>
        <Button
          variant="secondary"
          size="sm"
          className={styles.headerActionBtn}
          onClick={onCreatePlugin}
        >
          <AppIcon name="plus" size={13} />
          <span>制作插件</span>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className={styles.headerActionBtn}
          onClick={onOpenPluginImport}
        >
          <AppIcon name="folder-input" size={13} />
          <span>导入插件</span>
        </Button>
      </>
    )}
    {categoryFilter === 'skills' && (
      <Button
        variant="secondary"
        size="sm"
        className={styles.headerActionBtn}
        onClick={onOpenSkillCreate}
      >
        <AppIcon name="plus" size={13} />
        <span>添加技能</span>
      </Button>
    )}
    {categoryFilter === 'mcp' && (
      <Button
        variant="secondary"
        size="sm"
        className={styles.headerActionBtn}
        onClick={onOpenMcpConnect}
      >
        <AppIcon name="plus" size={13} />
        <span>接入 MCP</span>
      </Button>
    )}

    <div className={styles.searchBarWrapper}>
      <AppIcon name="search" size={13} className={styles.searchIcon} />
      <Input
        bare
        value={searchQuery}
        onChange={(e) => onSearchQueryChange(e.target.value)}
        placeholder="搜索扩展、技能与工具…"
        className={styles.searchInput}
        aria-label="搜索扩展"
      />
    </div>
  </>
);
