import React from 'react';
import styles from './McpSettingsTab.module.css';
import { Button, Tooltip } from '@/components/ui';
import { EMPTY_FILTER_HINT } from './types';
import { useI18n } from '../../i18n';

/** MCP 服务器列表筛选空态渲染（加载中 / 无匹配 / 清除筛选按钮）。 */
export function McpServerFilterEmpty({
  loading,
  hasAny,
  filterActive,
  onClearFilter,
}: {
  loading: boolean;
  hasAny: boolean;
  filterActive: boolean;
  onClearFilter: () => void;
}) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div
        className={`${styles.mcpEmptyLine} mcp-empty-line`}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span>{t('settings.mcp.loading', '加载中…')}</span>
      </div>
    );
  }
  if (!hasAny) return null;
  if (!filterActive) return null;
  return (
    <div
      className={`${styles.mcpEmptyLine} mcp-empty-line`}
      role="status"
      aria-live="polite"
    >
      <Tooltip content={t('settings.mcp.filterHint', EMPTY_FILTER_HINT)}>
        <span>{t('settings.mcp.noMatch', '无匹配')}</span>
      </Tooltip>
      <Tooltip content={t('settings.mcp.filterHint', EMPTY_FILTER_HINT)}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClearFilter}
          aria-label={t('settings.mcp.clearFilter', '清除筛选')}
        >
          {t('settings.mcp.clearFilter', '清除筛选')}
        </Button>
      </Tooltip>
    </div>
  );
}
