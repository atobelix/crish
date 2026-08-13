/**
 * MCP 服务列表·共享工具栏：刷新 / 排序 / 搜索 / 添加（demo 态）。
 * G-03d 拆分自 McpServerList 的 renderSharedToolbar（行为等价搬移）。
 */

import React from 'react';
import * as Lucide from 'lucide-react';
import styles from './McpSettingsTab.module.css';
import { Button, Tooltip } from '../ui';
import type { SortMode } from './types';

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
}) => (
  <div
    className={`${styles.mcpToolbar} mcp-toolbar`}
    role="toolbar"
    aria-label="扩展服务工具栏"
  >
    <Tooltip content={loading ? '刷新中…' : '刷新列表'}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRefresh}
        disabled={loading}
        aria-label={loading ? '刷新中' : '刷新列表'}
        aria-busy={loading || undefined}
        icon={
          <Lucide.RefreshCw
            size={14}
            className={loading ? 'spin' : undefined}
            aria-hidden
          />
        }
      />
    </Tooltip>
    <div
      className="ui-segment ui-segment--inline settings-segment-pill"
      role="group"
      aria-label="排序方式"
    >
      <Tooltip content="按名称排序">
        <button
          type="button"
          className={`ui-segment-item ${sortMode === 'name' ? 'active' : ''}`}
          onClick={() => onSetSort('name')}
          aria-pressed={sortMode === 'name'}
        >
          名称
        </button>
      </Tooltip>
      <Tooltip content={demo ? '按启用状态排序' : '按运行状态排序'}>
        <button
          type="button"
          className={`ui-segment-item ${sortMode === 'state' ? 'active' : ''}`}
          onClick={() => onSetSort('state')}
          aria-pressed={sortMode === 'state'}
        >
          状态
        </button>
      </Tooltip>
    </div>
    <Tooltip content="搜索名称、标识或工具；Esc 清除">
      <input
        className={`settings-field-input settings-field-input--sm ${styles.mcpSearch} mcp-search`}
        placeholder="搜索名称、标识…"
        value={filter}
        onChange={(e) => onSetFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && filter) {
            e.preventDefault();
            onClearFilter();
          }
        }}
        aria-label="搜索扩展服务"
      />
    </Tooltip>
    {demo ? (
      <Tooltip content={showAdd ? '收起添加表单' : '添加演示服务'}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onSetShowAdd((v) => !v)}
          aria-label={showAdd ? '收起添加表单' : '添加演示服务'}
          aria-expanded={showAdd}
          icon={<Lucide.Plus size={14} aria-hidden />}
        >
          {showAdd ? '收起' : '添加'}
        </Button>
      </Tooltip>
    ) : null}
  </div>
);
