/**
 * conex-doc-collab `Op` 的可序列化 wire 契约（snake_case JSON）。
 *
 * 对齐 Rust：
 * - `crates/conex-doc-collab/src/op.rs`：`#[serde(tag = "op", rename_all = "snake_case")]`
 * - `crates/conex-doc-collab/src/ir.rs`：`BlockKind` / `BlockProps`
 *
 * **写路径纪律（强制）**：
 * - UI StructureIntent / TextEditIntent **不得**直接写盘或旁路 mutate 树
 * - 必须：Intent →（本包 wire）→ sink / IPC → RS `DocSession::apply`
 * - 呈现层只产出 Intent；权威变更仅经 apply
 *
 * 本文件仅类型 + 纯函数校验/解析，不接线 DocSession / 业务。
 */

import type { BlockId } from './block-id';
import type { UnicodeScalarOffset } from './coordinates';

// ---------------------------------------------------------------------------
// BlockKind / BlockProps wire（对齐 ir.rs serde）
// ---------------------------------------------------------------------------

/**
 * 块种类 wire。
 * - 单元变体：字符串字面量（paragraph / bullet_item / … / table / math …）
 * - 带字段：外部标签对象 `{ heading: { level } }` / `{ task_item: { ordered } }` /
 *   `{ callout: { kind } }` / `{ unknown: { flavour } }`
 */
export type CollabBlockKindWire =
  | 'paragraph'
  | 'bullet_item'
  | 'ordered_item'
  | 'code'
  | 'quote'
  | 'divider'
  | 'table'
  | 'math'
  | 'footnote_definition'
  | { heading: { level: number } }
  | { task_item: { ordered: boolean } }
  | { callout: { kind: string } }
  | { unknown: { flavour: string } };

/** 块属性：`attrs` 为任意 JSON 值表（含 collapsed 等） */
export type CollabBlockPropsWire = {
  attrs: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Op wire 联合（对齐 op.rs）
// ---------------------------------------------------------------------------

export type CollabInsertOpWire = {
  op: 'insert';
  id: BlockId;
  parent: BlockId | null;
  /** fractional index 字符串排序键 */
  order: string;
  kind: CollabBlockKindWire;
  props: CollabBlockPropsWire;
};

export type CollabUpdatePropsOpWire = {
  /** 全量替换 props，不是 attrs 局部更新。 */
  op: 'update_props';
  id: BlockId;
  props: CollabBlockPropsWire;
};

export type CollabPatchAttrsOpWire = {
  op: 'patch_attrs';
  id: BlockId;
  /** 写入或覆盖的 attrs；可与 remove 重叠，重叠时 set 生效。 */
  set: Record<string, unknown>;
  /** 明确删除的 attrs 键。 */
  remove: string[];
};

export type CollabMoveOpWire = {
  op: 'move';
  id: BlockId;
  new_parent: BlockId | null;
  order: string;
};

export type CollabDeleteOpWire = {
  op: 'delete';
  id: BlockId;
};

export type CollabTextEditOpWire = {
  op: 'text_edit';
  id: BlockId;
  /** Unicode 标量（char）偏移量（对齐 Rust chars().count()） */
  start: UnicodeScalarOffset | number;
  end: UnicodeScalarOffset | number;
  insert: string;
};

/**
 * collab `Op` 可序列化 wire（snake_case、tag=`op`）。
 * 与 Rust `Vec<Op>` 的 `serde_json` 互解。
 */
export type CollabOpWire =
  | CollabInsertOpWire
  | CollabUpdatePropsOpWire
  | CollabPatchAttrsOpWire
  | CollabMoveOpWire
  | CollabDeleteOpWire
  | CollabTextEditOpWire;

export type CollabOpTag = CollabOpWire['op'];

const OP_TAGS: ReadonlySet<string> = new Set([
  'insert',
  'update_props',
  'patch_attrs',
  'move',
  'delete',
  'text_edit',
]);

// ---------------------------------------------------------------------------
// flavour → kind
// ---------------------------------------------------------------------------

/**
 * 将纸面 flavour / slash catalog id 映射为 collab `BlockKind` wire。
 * 未识别 flavour → `{ unknown: { flavour } }`（对齐 Rust `BlockKind::Unknown`）。
 */
export function flavourToCollabKind(flavour: string): CollabBlockKindWire {
  const f = (flavour || '').trim().toLowerCase();
  if (!f || f === 'paragraph' || f === 'text' || f === 'p') {
    return 'paragraph';
  }
  const heading = f.match(/^heading(?:[-_]?(\d+))?$/);
  if (heading) {
    const level = heading[1] ? Number(heading[1]) : 1;
    const lv =
      Number.isFinite(level) && level >= 1 && level <= 6
        ? Math.floor(level)
        : 1;
    return { heading: { level: lv } };
  }
  if (f === 'h1') return { heading: { level: 1 } };
  if (f === 'h2') return { heading: { level: 2 } };
  if (f === 'h3') return { heading: { level: 3 } };
  if (f === 'h4') return { heading: { level: 4 } };
  if (f === 'h5') return { heading: { level: 5 } };
  if (f === 'h6') return { heading: { level: 6 } };

  if (
    f === 'bullet' ||
    f === 'bullet_item' ||
    f === 'bullet-item' ||
    f === 'list' ||
    f === 'ul'
  ) {
    return 'bullet_item';
  }
  if (
    f === 'ordered' ||
    f === 'ordered_item' ||
    f === 'ordered-item' ||
    f === 'numbered' ||
    f === 'ol'
  ) {
    return 'ordered_item';
  }
  if (f === 'code' || f === 'code_block' || f === 'code-block') {
    return 'code';
  }
  if (f === 'quote' || f === 'blockquote') {
    return 'quote';
  }
  if (f === 'divider' || f === 'hr' || f === 'horizontal_rule') {
    return 'divider';
  }
  if (
    f === 'task' ||
    f === 'task_item' ||
    f === 'task-item' ||
    f === 'todo' ||
    f === 'checkbox'
  ) {
    return { task_item: { ordered: false } };
  }
  return { unknown: { flavour: flavour || f } };
}

/** 空 props wire */
export function emptyCollabProps(): CollabBlockPropsWire {
  return { attrs: {} };
}

/** 带 attrs 的 props wire */
export function collabPropsWithAttrs(
  attrs: Record<string, unknown>
): CollabBlockPropsWire {
  return { attrs: { ...attrs } };
}

/**
 * 由兄弟索引生成 provisional fractional order（字典序可排）。
 * 真正 fractional 分配由 RS 侧权威；此处仅 bridge 占位。
 */
export function orderFromIndex(index: number): string {
  const i = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  return `i${String(i).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// 类型守卫 / 校验
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

function isBlockIdLike(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isKindWire(v: unknown): v is CollabBlockKindWire {
  if (typeof v === 'string') {
    return (
      v === 'paragraph' ||
      v === 'bullet_item' ||
      v === 'ordered_item' ||
      v === 'code' ||
      v === 'quote' ||
      v === 'divider' ||
      v === 'table' ||
      v === 'math' ||
      v === 'footnote_definition'
    );
  }
  if (!isPlainObject(v)) return false;
  if ('heading' in v) {
    const h = (v as { heading?: unknown }).heading;
    return (
      isPlainObject(h) &&
      typeof (h as { level?: unknown }).level === 'number' &&
      Number.isFinite((h as { level: number }).level)
    );
  }
  if ('task_item' in v) {
    const t = (v as { task_item?: unknown }).task_item;
    return (
      isPlainObject(t) &&
      typeof (t as { ordered?: unknown }).ordered === 'boolean'
    );
  }
  if ('callout' in v) {
    const c = (v as { callout?: unknown }).callout;
    return (
      isPlainObject(c) && typeof (c as { kind?: unknown }).kind === 'string'
    );
  }
  if ('unknown' in v) {
    const u = (v as { unknown?: unknown }).unknown;
    return (
      isPlainObject(u) &&
      typeof (u as { flavour?: unknown }).flavour === 'string'
    );
  }
  return false;
}

function isPropsWire(v: unknown): v is CollabBlockPropsWire {
  if (!isPlainObject(v)) return false;
  const attrs = (v as { attrs?: unknown }).attrs;
  return isPlainObject(attrs);
}

/** 是否为合法 collab Op wire 条目 */
export function isCollabOpWire(value: unknown): value is CollabOpWire {
  if (!isPlainObject(value)) return false;
  const op = value.op;
  if (typeof op !== 'string' || !OP_TAGS.has(op)) return false;

  switch (op) {
    case 'insert':
      return (
        isBlockIdLike(value.id) &&
        (value.parent === null || isBlockIdLike(value.parent)) &&
        typeof value.order === 'string' &&
        isKindWire(value.kind) &&
        isPropsWire(value.props)
      );
    case 'update_props':
      return isBlockIdLike(value.id) && isPropsWire(value.props);
    case 'patch_attrs':
      return (
        isBlockIdLike(value.id) &&
        isPlainObject(value.set) &&
        isStringArray(value.remove)
      );
    case 'move':
      return (
        isBlockIdLike(value.id) &&
        (value.new_parent === null || isBlockIdLike(value.new_parent)) &&
        typeof value.order === 'string'
      );
    case 'delete':
      return isBlockIdLike(value.id);
    case 'text_edit':
      return (
        isBlockIdLike(value.id) &&
        typeof value.start === 'number' &&
        typeof value.end === 'number' &&
        typeof value.insert === 'string' &&
        Number.isFinite(value.start) &&
        Number.isFinite(value.end) &&
        value.start >= 0 &&
        value.end >= value.start
      );
    default:
      return false;
  }
}

/**
 * 校验 ops 数组：每条字段齐全且为 collab wire。
 * @returns 合法 ops；非法抛错（含索引与原因）
 */
export function assertCollabOpsWire(ops: unknown): CollabOpWire[] {
  if (!Array.isArray(ops)) {
    throw new Error('assertCollabOpsWire：期望 JSON 数组');
  }
  const out: CollabOpWire[] = [];
  for (let i = 0; i < ops.length; i++) {
    const item = ops[i];
    if (!isCollabOpWire(item)) {
      throw new Error(
        `assertCollabOpsWire：ops[${i}] 非 collab Op wire（需 tag=op snake_case 且字段齐全）`
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * 从 JSON 字符串解析 collab ops wire（双向测 / 宿主 IPC 入口）。
 * 对应 Rust `ops_from_json` / `serde_json::from_str::<Vec<Op>>`。
 */
export function collabOpsFromJson(json: string): CollabOpWire[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (e) {
    throw new Error(
      `collabOpsFromJson：JSON 解析失败：${e instanceof Error ? e.message : String(e)}`
    );
  }
  return assertCollabOpsWire(parsed);
}

/** 序列化为 JSON 字符串（稳定键序不保证；形状与 Rust 互解） */
export function collabOpsToJson(ops: readonly CollabOpWire[]): string {
  return JSON.stringify(ops);
}

/**
 * 列出单条 op 的必填 wire 字段名（验收「字段齐全」）。
 * 不含可选扩展字段。
 */
export function requiredWireFields(op: CollabOpWire): readonly string[] {
  switch (op.op) {
    case 'insert':
      return ['op', 'id', 'parent', 'order', 'kind', 'props'];
    case 'update_props':
      return ['op', 'id', 'props'];
    case 'patch_attrs':
      return ['op', 'id', 'set', 'remove'];
    case 'move':
      return ['op', 'id', 'new_parent', 'order'];
    case 'delete':
      return ['op', 'id'];
    case 'text_edit':
      return ['op', 'id', 'start', 'end', 'insert'];
  }
}

/** 断言 op 对象自有可枚举键覆盖 requiredWireFields */
export function assertWireFieldsPresent(op: CollabOpWire): void {
  const need = requiredWireFields(op);
  for (const k of need) {
    if (!(k in op)) {
      throw new Error(`assertWireFieldsPresent：缺少字段 ${k}（op=${op.op}）`);
    }
  }
  if (op.op === 'insert' || op.op === 'update_props') {
    if (!isPlainObject(op.props) || !isPlainObject(op.props.attrs)) {
      throw new Error(
        `assertWireFieldsPresent：props.attrs 必须为对象（op=${op.op}）`
      );
    }
  }
  if (
    op.op === 'patch_attrs' &&
    (!isPlainObject(op.set) || !isStringArray(op.remove))
  ) {
    throw new Error(
      'assertWireFieldsPresent：patch_attrs 的 set 必须为对象且 remove 必须为字符串数组'
    );
  }
}
