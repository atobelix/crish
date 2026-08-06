/**
 * DatabaseTableView — 数据库表格视图
 *
 * 参考 Notion 截图中的表格设计：
 * - 列头带属性类型图标
 * - 列宽可拖拽调整
 * - 行悬浮高亮
 * - 最后一列为 "+" 添加列按钮
 * - 最后一行为 "+ 新页面" 添加行按钮
 * - 单元格根据属性类型渲染不同的 UI（标签、日期、复选框等）
 */

import React, { useCallback } from 'react';
import {
  Type, Hash, Calendar, CheckSquare, Link2,
  AtSign, Paperclip, ListFilter, Clock, User,
  Mail, Phone, Tag, Sigma,
} from 'lucide-react';
import type { DatabaseSchema, DatabaseView, Property, CellValue, PropertyType } from '../../../core/types/database';
import { generateId, getDefaultCellValue } from '../../../core/types/database';

/* 属性类型图标映射 */
const PROPERTY_ICONS: Partial<Record<PropertyType, React.FC<{ size: number }>>> = {
  title: Type,
  text: Type,
  number: Hash,
  select: Tag,
  multi_select: ListFilter,
  status: ListFilter,
  date: Calendar,
  person: User,
  file: Paperclip,
  checkbox: CheckSquare,
  url: Link2,
  email: Mail,
  phone: Phone,
  formula: Sigma,
  created_time: Clock,
  last_edited_time: Clock,
  created_by: AtSign,
  last_edited_by: AtSign,
};

interface TableViewProps {
  schema: DatabaseSchema;
  view: DatabaseView;
  updateSchema: (updater: (prev: DatabaseSchema) => DatabaseSchema) => void;
}

export const DatabaseTableView: React.FC<TableViewProps> = ({
  schema,
  view,
  updateSchema,
}) => {
  // 可见列（按视图配置顺序）
  const visibleProps = view.visibleProperties
    .map(id => schema.properties.find(p => p.id === id))
    .filter((p): p is Property => p != null);

  // 添加新行
  const addRow = useCallback(() => {
    updateSchema(prev => ({
      ...prev,
      rows: [...prev.rows, {
        id: generateId('row'),
        properties: Object.fromEntries(
          prev.properties.map(p => [p.id, getDefaultCellValue(p.type)])
        ),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    }));
  }, [updateSchema]);

  // 添加新列
  const addColumn = useCallback(() => {
    const newProp: Property = {
      id: generateId('prop'),
      name: '新属性',
      type: 'text',
      width: 180,
    };
    updateSchema(prev => ({
      ...prev,
      properties: [...prev.properties, newProp],
      views: prev.views.map(v => ({
        ...v,
        visibleProperties: [...v.visibleProperties, newProp.id],
      })),
    }));
  }, [updateSchema]);

  // 更新单元格
  const updateCell = useCallback((rowId: string, propId: string, value: CellValue) => {
    updateSchema(prev => ({
      ...prev,
      rows: prev.rows.map(r =>
        r.id === rowId
          ? { ...r, properties: { ...r.properties, [propId]: value }, updatedAt: Date.now() }
          : r
      ),
    }));
  }, [updateSchema]);

  return (
    <div className="db-table-container">
      <table className="db-table">
        {/* 表头 */}
        <thead>
          <tr className="db-table__header-row">
            {visibleProps.map(prop => {
              const Icon = PROPERTY_ICONS[prop.type] ?? Type;
              return (
                <th
                  key={prop.id}
                  className="db-table__header-cell"
                  style={{ width: prop.width ?? 180 }}
                >
                  <div className="db-table__header-cell-inner">
                    <span className="db-table__header-icon">
                      <Icon size={14} />
                    </span>
                    <span className="db-table__header-name">{prop.name}</span>
                  </div>
                  <div className="db-table__resize-handle" />
                </th>
              );
            })}
            <th className="db-table__add-col" onClick={addColumn}>
              +
            </th>
          </tr>
        </thead>

        {/* 数据行 */}
        <tbody>
          {schema.rows.map(row => (
            <tr key={row.id} className="db-table__row">
              {visibleProps.map(prop => (
                <td
                  key={prop.id}
                  className={`db-table__cell ${prop.type === 'title' ? 'db-table__cell--title' : ''}`}
                >
                  <CellRenderer
                    property={prop}
                    value={row.properties[prop.id]}
                    onChange={(val) => updateCell(row.id, prop.id, val)}
                  />
                </td>
              ))}
              <td className="db-table__cell" />
            </tr>
          ))}
        </tbody>
      </table>

      {/* 添加行 */}
      <div className="db-table__add-row" onClick={addRow}>
        <span>+</span>
        <span>新页面</span>
      </div>
    </div>
  );
};

/* ────────────────────────────────────────────
 * 单元格渲染器
 * ──────────────────────────────────────────── */
interface CellRendererProps {
  property: Property;
  value: CellValue;
  onChange: (value: CellValue) => void;
}

const CellRenderer: React.FC<CellRendererProps> = ({ property, value, onChange }) => {
  switch (property.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return (
        <input
          className="db-table__cell-input"
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={property.type === 'title' ? '无标题' : ''}
        />
      );

    case 'number':
      return (
        <input
          className="db-table__cell-input cell-number"
          type="number"
          value={(value as number) ?? ''}
          onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
        />
      );

    case 'checkbox':
      return (
        <div className="cell-checkbox">
          <input
            className="cell-checkbox__input"
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
          />
        </div>
      );

    case 'select':
    case 'status': {
      const selectedOption = property.options?.find(o => o.id === value);
      if (!selectedOption) {
        return <span className="cell-tag cell-tag--gray">选择...</span>;
      }
      return (
        <span className={`cell-tag cell-tag--${selectedOption.color}`}>
          {property.type === 'status' && (
            <span
              className="cell-status__dot"
              style={{ backgroundColor: `var(--color-${selectedOption.color})` }}
            />
          )}
          {selectedOption.name}
        </span>
      );
    }

    case 'multi_select': {
      const selectedIds = (value as string[]) ?? [];
      const selectedOptions = selectedIds
        .map(id => property.options?.find(o => o.id === id))
        .filter(Boolean);
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px' }}>
          {selectedOptions.map(opt => opt && (
            <span key={opt.id} className={`cell-tag cell-tag--${opt.color}`}>
              {opt.name}
            </span>
          ))}
        </div>
      );
    }

    case 'date': {
      const dateStr = value && typeof value === 'object' && 'start' in value
        ? (value as { start: string }).start
        : (typeof value === 'string' ? value : '');
      return <span className="cell-date">{dateStr || ''}</span>;
    }

    case 'created_time':
    case 'last_edited_time': {
      const ts = value as number;
      if (!ts) return <span className="cell-date">—</span>;
      const d = new Date(ts);
      return <span className="cell-date">{d.toLocaleDateString('zh-CN')}</span>;
    }

    default:
      return <span>{String(value ?? '')}</span>;
  }
};

/* 单元格输入样式（内联，因为极简） */
const cellInputStyle = `
.db-table__cell-input {
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  color: inherit;
  padding: 0;
}

.db-table__cell-input::placeholder {
  color: var(--text-placeholder);
}
`;

// 注入样式
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = cellInputStyle;
  document.head.appendChild(style);
}
