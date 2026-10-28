import React from 'react';
import styles from './McpSettingsTab.module.css';
import { Button, Tooltip } from '@/components/ui';
import { EMPTY_FILTER_HINT } from './types';

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
  if (loading) {
    return (
      <div
        className={`${styles.mcpEmptyLine} mcp-empty-line`}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span>加载中…</span>
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
      <Tooltip content={EMPTY_FILTER_HINT}>
        <span>无匹配</span>
      </Tooltip>
      <Tooltip content={EMPTY_FILTER_HINT}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClearFilter}
          aria-label="清除筛选"
        >
          清除筛选
        </Button>
      </Tooltip>
    </div>
  );
}
