/**
 * MCP 服务列表·共享工具栏：刷新 / 排序 / 搜索 / 添加（demo 态）。
 * G-03d 拆分自 McpServerList 的 renderSharedToolbar（行为等价搬移）。
 */

import React from 'react';
import styles from './McpSettingsTab.module.css';
import { Button, Input, SegmentedControl, Tooltip } from '@/components/ui';
import type { SortMode } from './types';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

export type McpServerToolbarProps = {
  demo: boolean;
  loading: boolean;
  filter: string;
  sortMode: SortMode;
  showAdd: boolean;
  onRefresh: () => void;
  onSetSort: (mode: SortMode) => void;
  onSetFilter: (filter: string) => void;
  onClearFilter: () => void;
  onSetShowAdd: React.Dispatch<React.SetStateAction<boolean>>;
};

export const McpServerToolbar: React.FC<McpServerToolbarProps> = ({
  demo,
  loading,
  filter,
  sortMode,
  showAdd,
  onRefresh,
  onSetSort,
  onSetFilter,
  onClearFilter,
  onSetShowAdd,
}) => {
  const { t } = useI18n();
  return (
    <div
      className={`${styles.mcpToolbar} mcp-toolbar`}
      role="toolbar"
      aria-label={t('settings.mcp.toolbarAria', '扩展服务工具栏')}
    >
      <Tooltip
        content={
          loading
            ? t('settings.mcp.refreshing', '刷新中…')
            : t('settings.mcp.refreshList', '刷新列表')
        }
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={loading}
          aria-label={
            loading
              ? t('settings.mcp.refreshingShort', '刷新中')
              : t('settings.mcp.refreshList', '刷新列表')
          }
          aria-busy={loading || undefined}
          icon={
            <AppIcon
              name="refresh"
              size={14}
              className={loading ? 'spin' : undefined}
              aria-hidden
            />
          }
        />
      </Tooltip>
      <SegmentedControl
        aria-label={t('settings.mcp.sortAria', '排序方式')}
        size="sm"
        className={styles.segment}
        value={sortMode}
        options={[
          { value: 'name', label: t('settings.mcp.sortName', '名称') },
          { value: 'state', label: t('settings.mcp.sortState', '状态') },
        ]}
        onChange={(v) => onSetSort(v as SortMode)}
      />
      <Tooltip
        content={t(
          'settings.mcp.searchTooltip',
          '搜索名称、标识或工具；Esc 清除'
        )}
      >
        <div className={styles.mcpSearch}>
          <Input
            variant="search"
            size="sm"
            placeholder={t('settings.mcp.searchPlaceholder', '搜索名称、标识…')}
            value={filter}
            onChange={(e) => onSetFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault();
                onClearFilter();
              }
            }}
            clearable
            onClear={onClearFilter}
            aria-label={t('settings.mcp.searchAria', '搜索扩展服务')}
          />
        </div>
      </Tooltip>
      {demo ? (
        <Tooltip
          content={
            showAdd
              ? t('settings.mcp.collapseAddForm', '收起添加表单')
              : t('settings.mcp.addDemo', '添加演示服务')
          }
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onSetShowAdd((v) => !v)}
            aria-label={
              showAdd
                ? t('settings.mcp.collapseAddForm', '收起添加表单')
                : t('settings.mcp.addDemo', '添加演示服务')
            }
            aria-expanded={showAdd}
            icon={<AppIcon name="plus" size={14} aria-hidden />}
          >
            {showAdd
              ? t('settings.mcp.collapse', '收起')
              : t('settings.mcp.add', '添加')}
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
};
