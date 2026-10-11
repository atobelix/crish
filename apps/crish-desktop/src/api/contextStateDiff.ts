/**
 * 上下文状态的结构化快照与字段差分（运行时，不持久化）。
 *
 * 注入时与 SessionRuntimeRegistry 里上一份快照比较：只把变化的字段写入
 * metadata，并附 `changed`。没有上一份快照时（会话首次注入）视为全部字段变化。
 */

export const CONTEXT_STATE_FIELD_ORDER = [
  'model',
  'profile',
  'permission',
  'thinking',
] as const;

export type ContextStateFieldKey = (typeof CONTEXT_STATE_FIELD_ORDER)[number];

/** 模型 / 服务商 / 权限 / 思考档位。空串视为缺省，不入快照。 */
export interface ContextStateFieldSnapshot {
  model?: string;
  profile?: string;
  permission?: string;
  thinking?: string;
}

export function snapshotFromFields(
  fields: ContextStateFieldSnapshot
): ContextStateFieldSnapshot {
  const out: ContextStateFieldSnapshot = {};
  for (const key of CONTEXT_STATE_FIELD_ORDER) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim();
    }
  }
  return out;
}

/**
 * 与上一份结构化快照比较。
 * - `previous == null`：首次注入，全部非空字段都算变化。
 * - 否则只返回新值非空且与上次不同的字段。
 * - 无变化时 `changed` 为空（调用方不注入）。
 */
export function diffContextStateSnapshot(
  previous: ContextStateFieldSnapshot | null | undefined,
  next: ContextStateFieldSnapshot
): { changed: ContextStateFieldKey[]; fields: ContextStateFieldSnapshot } {
  const normalized = snapshotFromFields(next);
  const isFirst = previous == null;
  const prev = isFirst ? null : snapshotFromFields(previous);
  const changed: ContextStateFieldKey[] = [];
  const fields: ContextStateFieldSnapshot = {};
  for (const key of CONTEXT_STATE_FIELD_ORDER) {
    const value = normalized[key];
    if (!value) continue;
    if (isFirst || prev?.[key] !== value) {
      changed.push(key);
      fields[key] = value;
    }
  }
  return { changed, fields };
}
