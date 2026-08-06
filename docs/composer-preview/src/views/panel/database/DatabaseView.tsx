/**
 * DatabaseView — 数据库区块入口壳组件
 *
 * 负责：
 * 1. 解析节点 attrs 中的 DatabaseSchema JSON
 * 2. 渲染数据库标题 + 视图切换器 + 工具栏
 * 3. 根据当前激活的视图类型委托给对应视图组件
 * 4. 所有状态变更通过 updateAttributes 写入 ProseMirror 事务
 */

import React, { useMemo, useCallback, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import {
  Table, Kanban, LayoutGrid, List, CalendarDays,
  GanttChart, BarChart3, FileInput, Map, LayoutDashboard,
  Filter, ArrowUpDown, Sparkles, Search, Settings,
  Plus, ChevronDown,
} from 'lucide-react';
import type {
  DatabaseSchema,
  DatabaseViewType,
  DatabaseView as DatabaseViewConfig,
  Property,
} from '../../../core/types/database';
import { createEmptyDatabaseSchema, createEmptyRow, generateId } from '../../../core/types/database';
import { Tooltip } from '../../../ui/Tooltip';
import { DatabaseTableView } from './TableView';

/* 视图类型 → 图标映射 */
const VIEW_ICONS: Record<DatabaseViewType, React.FC<{ size: number }>> = {
  table: Table,
  kanban: Kanban,
  gallery: LayoutGrid,
  list: List,
  calendar: CalendarDays,
  timeline: GanttChart,
  chart: BarChart3,
  form: FileInput,
  map: Map,
  dashboard: LayoutDashboard,
};

/* 视图类型 → 显示名 */
const VIEW_LABELS: Record<DatabaseViewType, string> = {
  table: '表格',
  kanban: '看板',
  gallery: '画廊',
  list: '列表',
  calendar: '日历',
  timeline: '时间轴',
  chart: '图表',
  form: '表单',
  map: '地图',
  dashboard: '管理面板',
};

export const DatabaseView: React.FC<NodeViewProps> = ({
  node,
  updateAttributes,
  editor,
  getPos,
}) => {
  const [showSettings, setShowSettings] = useState(false);

  // 解析数据库 schema
  const schema = useMemo<DatabaseSchema>(() => {
    try {
      const raw = node.attrs.data as string;
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return createEmptyDatabaseSchema();
  }, [node.attrs.data]);

  // 更新 schema（防抖写入 ProseMirror 事务）
  const updateSchema = useCallback((updater: (prev: DatabaseSchema) => DatabaseSchema) => {
    const newSchema = updater(schema);
    updateAttributes({ data: JSON.stringify(newSchema) });
  }, [schema, updateAttributes]);

  // 获取当前激活的视图
  const activeView = useMemo(() => {
    return schema.views.find((v: DatabaseViewConfig) => v.id === schema.activeViewId) ?? schema.views[0];
  }, [schema]);

  // 切换视图
  const switchView = useCallback((viewId: string) => {
    updateSchema(prev => ({ ...prev, activeViewId: viewId }));
  }, [updateSchema]);

  // 添加新行
  const addRow = useCallback(() => {
    updateSchema(prev => ({
      ...prev,
      rows: [...prev.rows, createEmptyRow(prev.properties)],
    }));
  }, [updateSchema]);

  // 添加新视图
  const addView = useCallback((type: DatabaseViewType) => {
    updateSchema(prev => {
      const newView = {
        id: generateId('view'),
        name: VIEW_LABELS[type],
        type,
        visibleProperties: prev.properties.map((p: Property) => p.id),
        sorts: [],
        filter: { operator: 'and' as const, rules: [] },
      };
      return {
        ...prev,
        views: [...prev.views, newView],
        activeViewId: newView.id,
      };
    });
  }, [updateSchema]);

  // 渲染当前视图
  const renderView = () => {
    if (!activeView) return null;

    switch (activeView.type) {
      case 'table':
        return (
          <DatabaseTableView
            schema={schema}
            view={activeView}
            updateSchema={updateSchema}
          />
        );
      // TODO: 后续添加 kanban, gallery, calendar 等视图
      default:
        return (
          <div className="empty-state">
            <span className="empty-state__icon">🚧</span>
            <span className="empty-state__title">{VIEW_LABELS[activeView.type]}视图即将推出</span>
          </div>
        );
    }
  };

  return (
    <NodeViewWrapper className={`database-block ${schema.isInline ? 'database-block--inline' : ''}`}>
      {/* 数据库标题 */}
      <div
        className="database-block__title"
        contentEditable
        suppressContentEditableWarning
        onBlur={(e) => {
          const newTitle = (e.target as HTMLDivElement).textContent ?? '';
          if (newTitle !== schema.title) {
            updateSchema(prev => ({ ...prev, title: newTitle }));
          }
        }}
      >
        {schema.title}
      </div>

      {/* 工具栏 */}
      <div className="db-toolbar" contentEditable={false}>
        <div className="db-toolbar__left">
          {/* 视图切换 Tab */}
          <div className="db-view-tabs">
            {schema.views.map((view: DatabaseViewConfig) => {
              const Icon = VIEW_ICONS[view.type];
              return (
                <button
                  key={view.id}
                  type="button"
                  className={`db-view-tab ${view.id === activeView?.id ? 'db-view-tab--active' : ''}`}
                  onClick={() => switchView(view.id)}
                >
                  <Icon size={14} />
                  <span>{view.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="db-toolbar__right">
          <Tooltip content="筛选">
            <button type="button" className="db-toolbar__icon-btn">
              <Filter size={15} />
            </button>
          </Tooltip>
          <Tooltip content="排序">
            <button type="button" className="db-toolbar__icon-btn">
              <ArrowUpDown size={15} />
            </button>
          </Tooltip>
          <Tooltip content="AI 自动填充">
            <button type="button" className="db-toolbar__icon-btn">
              <Sparkles size={15} />
            </button>
          </Tooltip>
          <Tooltip content="搜索">
            <button type="button" className="db-toolbar__icon-btn">
              <Search size={15} />
            </button>
          </Tooltip>
          <Tooltip content="设置">
            <button
              type="button"
              className={`db-toolbar__icon-btn ${showSettings ? 'db-toolbar__icon-btn--active' : ''}`}
              onClick={() => setShowSettings(!showSettings)}
            >
              <Settings size={15} />
            </button>
          </Tooltip>

          {/* 新建按钮 */}
          <button type="button" className="db-new-btn" onClick={addRow}>
            新建
            <span className="db-new-btn__arrow">
              <ChevronDown size={12} />
            </span>
          </button>
        </div>
      </div>

      {/* 视图内容 */}
      <div contentEditable={false}>
        {renderView()}
      </div>
    </NodeViewWrapper>
  );
};
