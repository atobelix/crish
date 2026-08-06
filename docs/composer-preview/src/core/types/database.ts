/**
 * Conex Composer — Database Type Definitions
 *
 * 完整的 Notion 式数据库数据模型。
 * 支持 10 种视图类型、18 种属性类型。
 */

/* ================================================================
 * 视图类型
 * ================================================================ */

export type DatabaseViewType =
  | 'table'
  | 'kanban'
  | 'gallery'
  | 'list'
  | 'calendar'
  | 'timeline'
  | 'chart'
  | 'form'
  | 'map'
  | 'dashboard';

/* ================================================================
 * 属性（列）类型
 * ================================================================ */

export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'person'
  | 'file'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by';

/* ================================================================
 * Notion 10 色系
 * ================================================================ */

export type PropertyColor =
  | 'default'
  | 'gray'
  | 'brown'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red';

/** 颜色到 CSS 变量的映射 */
export const PROPERTY_COLOR_MAP: Record<PropertyColor, { fg: string; bg: string }> = {
  default: { fg: 'var(--color-default)', bg: 'var(--bg-color-default)' },
  gray:    { fg: 'var(--color-gray)',    bg: 'var(--bg-color-gray)' },
  brown:   { fg: 'var(--color-brown)',   bg: 'var(--bg-color-brown)' },
  orange:  { fg: 'var(--color-orange)',  bg: 'var(--bg-color-orange)' },
  yellow:  { fg: 'var(--color-yellow)',  bg: 'var(--bg-color-yellow)' },
  green:   { fg: 'var(--color-green)',   bg: 'var(--bg-color-green)' },
  blue:    { fg: 'var(--color-blue)',    bg: 'var(--bg-color-blue)' },
  purple:  { fg: 'var(--color-purple)',  bg: 'var(--bg-color-purple)' },
  pink:    { fg: 'var(--color-pink)',    bg: 'var(--bg-color-pink)' },
  red:     { fg: 'var(--color-red)',     bg: 'var(--bg-color-red)' },
};

/* ================================================================
 * 选项（用于 select / multi_select / status）
 * ================================================================ */

export interface SelectOption {
  id: string;
  name: string;
  color: PropertyColor;
}

/** 状态属性的预设分组 */
export interface StatusGroup {
  name: string; // '未开始' | '进行中' | '已完成'
  optionIds: string[];
  color: PropertyColor;
}

/* ================================================================
 * 属性（列）定义
 * ================================================================ */

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  width?: number;

  /** select / multi_select / status 的选项列表 */
  options?: SelectOption[];
  /** status 属性的分组配置 */
  statusGroups?: StatusGroup[];
  /** number 的格式 */
  numberFormat?: NumberFormat;
  /** formula 的表达式 */
  formula?: string;
  /** relation 的关联配置 */
  relationConfig?: RelationConfig;
  /** rollup 的汇总配置 */
  rollupConfig?: RollupConfig;
}

export type NumberFormat =
  | 'number'
  | 'number_with_commas'
  | 'percent'
  | 'dollar'
  | 'yuan'
  | 'euro'
  | 'pound';

export interface RelationConfig {
  databaseId: string;
  isTwoWay: boolean;
  twoWayPropertyId?: string;
}

export interface RollupConfig {
  relationPropertyId: string;
  targetPropertyId: string;
  aggregation: RollupAggregation;
}

export type RollupAggregation =
  | 'count'
  | 'count_values'
  | 'unique'
  | 'empty'
  | 'not_empty'
  | 'percent_empty'
  | 'percent_not_empty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'show_original';

/* ================================================================
 * 单元格值
 * ================================================================ */

export interface DateValue {
  start: string;           // ISO date string
  end?: string;            // ISO date string (日期范围的结束)
  includeTime: boolean;
  timezone?: string;
  reminder?: ReminderConfig;
}

export interface ReminderConfig {
  value: number;
  unit: 'minutes' | 'hours' | 'days' | 'weeks';
}

export interface FileValue {
  name: string;
  url: string;
  size: number;
  mimeType: string;
}

export interface PersonValue {
  id: string;
  name: string;
  avatar?: string;
}

/**
 * 单元格值的联合类型。
 * 具体类型由对应列的 PropertyType 决定：
 * - title / text / url / email / phone → string
 * - number → number
 * - checkbox → boolean
 * - select / status → string (option id)
 * - multi_select → string[] (option ids)
 * - date → DateValue
 * - person → PersonValue[]
 * - file → FileValue[]
 * - formula → computed at render time
 * - relation → string[] (related row ids)
 * - rollup → computed at render time
 * - created_time / last_edited_time → number (timestamp)
 * - created_by / last_edited_by → PersonValue
 */
export type CellValue =
  | string
  | number
  | boolean
  | string[]
  | DateValue
  | PersonValue[]
  | FileValue[]
  | PersonValue
  | null
  | undefined;

/* ================================================================
 * 行（记录）
 * ================================================================ */

export interface DatabaseRow {
  id: string;
  properties: Record<string, CellValue>;
  createdAt: number;
  updatedAt: number;
  icon?: string;
  cover?: string;
}

/* ================================================================
 * 排序 & 筛选
 * ================================================================ */

export interface SortRule {
  propertyId: string;
  direction: 'ascending' | 'descending';
}

export type FilterOperator =
  | 'equals'
  | 'does_not_equal'
  | 'contains'
  | 'does_not_contain'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'is_not_empty'
  | 'greater_than'
  | 'less_than'
  | 'greater_than_or_equal'
  | 'less_than_or_equal'
  | 'is_before'
  | 'is_after'
  | 'is_on_or_before'
  | 'is_on_or_after'
  | 'is_relative_to_today';

export interface FilterRule {
  id: string;
  propertyId: string;
  operator: FilterOperator;
  value: CellValue;
}

export interface FilterGroup {
  operator: 'and' | 'or';
  rules: FilterRule[];
}

/* ================================================================
 * 图表配置
 * ================================================================ */

export interface ChartConfig {
  type: 'bar' | 'horizontal_bar' | 'line' | 'donut' | 'pie' | 'scatter' | 'area';
  xAxis: string;           // property id
  yAxis: string;           // property id
  groupBy?: string;        // property id
  colorScheme?: PropertyColor[];
  showLegend?: boolean;
  showGrid?: boolean;
}

/* ================================================================
 * 视图配置
 * ================================================================ */

export interface DatabaseView {
  id: string;
  name: string;
  type: DatabaseViewType;
  icon?: string;

  /** 可见列 ID 列表（有序） */
  visibleProperties: string[];

  /** 排序规则（有序） */
  sorts: SortRule[];

  /** 筛选规则 */
  filter: FilterGroup;

  /* ── 视图特有配置 ── */

  /** Kanban 分组列 */
  groupBy?: string;
  /** Kanban 子分组列 */
  subGroupBy?: string;
  /** Kanban/Gallery 卡片上显示的属性 */
  cardPreviewProperties?: string[];
  /** Kanban 隐藏的分组 */
  hiddenGroups?: string[];

  /** Calendar 日期列 */
  calendarBy?: string;

  /** Timeline 开始/结束列 */
  timelineBy?: { startProperty: string; endProperty: string };

  /** Gallery 封面配置 */
  galleryCover?: {
    propertyId: string;
    size: 'small' | 'medium' | 'large';
    fit: 'cover' | 'contain';
  };

  /** Chart 图表配置 */
  chartConfig?: ChartConfig;

  /** Form 表单配置 */
  formConfig?: {
    title: string;
    description: string;
    submitButtonText: string;
    visibleProperties: string[];
    requiredProperties: string[];
  };
}

/* ================================================================
 * 数据库顶层结构
 * ================================================================ */

export interface DatabaseSchema {
  id: string;
  title: string;
  icon?: string;
  cover?: string;
  description?: string;

  /** 列（属性）定义列表 */
  properties: Property[];

  /** 行（记录）列表 */
  rows: DatabaseRow[];

  /** 视图列表 */
  views: DatabaseView[];

  /** 当前激活的视图 ID */
  activeViewId: string;

  /** 是否为内联数据库（嵌入页面中）vs 整页数据库 */
  isInline: boolean;

  /** 如果是链接视图，指向源数据库的 ID */
  linkedSourceId?: string;
}

/* ================================================================
 * 工具函数
 * ================================================================ */

let _idCounter = 0;

/** 生成唯一 ID */
export function generateId(prefix: string = 'id'): string {
  return `${prefix}_${Date.now()}_${++_idCounter}`;
}

/** 创建一个空的数据库 Schema */
export function createEmptyDatabaseSchema(title: string = '无标题数据库'): DatabaseSchema {
  const titlePropId = generateId('prop');
  const viewId = generateId('view');

  return {
    id: generateId('db'),
    title,
    properties: [
      {
        id: titlePropId,
        name: '名称',
        type: 'title',
        width: 280,
      },
    ],
    rows: [],
    views: [
      {
        id: viewId,
        name: '表格视图',
        type: 'table',
        visibleProperties: [titlePropId],
        sorts: [],
        filter: { operator: 'and', rules: [] },
      },
    ],
    activeViewId: viewId,
    isInline: true,
  };
}

/** 创建一个新行 */
export function createEmptyRow(
  properties: Property[],
  initialValues?: Record<string, CellValue>,
): DatabaseRow {
  const row: DatabaseRow = {
    id: generateId('row'),
    properties: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // 为每个属性初始化默认值
  for (const prop of properties) {
    if (initialValues && initialValues[prop.id] !== undefined) {
      row.properties[prop.id] = initialValues[prop.id];
    } else {
      row.properties[prop.id] = getDefaultCellValue(prop.type);
    }
  }

  return row;
}

/** 获取属性类型的默认单元格值 */
export function getDefaultCellValue(type: PropertyType): CellValue {
  switch (type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return '';
    case 'number':
      return null;
    case 'checkbox':
      return false;
    case 'select':
    case 'status':
      return null;
    case 'multi_select':
      return [];
    case 'date':
      return null;
    case 'person':
      return [];
    case 'file':
      return [];
    case 'formula':
    case 'rollup':
    case 'relation':
    case 'created_time':
    case 'last_edited_time':
    case 'created_by':
    case 'last_edited_by':
      return null;
    default:
      return null;
  }
}
