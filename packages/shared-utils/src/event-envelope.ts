/**
 * 事件信封宽容解析原语（T4 投影原语下沉 · 单源）。
 *
 * 两端（crish-desktop / crish-mobile）共用的事件体宽容读取助手：
 * 事件体为宽容 JSON（缺失/类型错 → undefined/false，M6 §10.5），
 * 逐事件访问一律走 read* 助手，不复制契约字段（M5 §1.3 组合纪律）。
 * transport 无关：仅处理扁平 JSON 信封，不依赖任何接线层。
 */

/** 契约：events.push.body.event 的 AgentEventEnvelope 扁平 JSON（events.rs:1092-1179 / M6 §10.5） */
export interface EventEnvelopeFrame {
  /** 事件 wire type（AgentEvent 变体名；未知 type 宽容跳过，MessageKind::Unknown 语义） */
  type: string;
  /** 事件归属 run id（emit 层注入；数据面事件缺失，events.rs:1116） */
  runId?: string;
  /** 会话内连续序列（resume 游标唯一依据，M6 §8.3；预览帧未落库时仍带值） */
  sequence?: number;
  /** 信封 wire schema 版本（缺省视为 1，events.rs:1100-1103） */
  schemaVersion?: number;
  sessionId: string;
  // 事件体字段平铺在信封顶层（additionalProperties: true，M6 §10.5）——
  // 逐事件访问走宽容读取（read* 助手），不在此复制契约字段（M5 §1.3 组合纪律）
  [key: string]: unknown;
}

/** 宽容记录读取：非对象/数组 → undefined */
export function readRecord(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

/** 宽容字符串读取：缺失/类型错 → undefined */
export function readString(v: unknown, key: string): string | undefined {
  const obj = readRecord(v);
  const value = obj?.[key];
  return typeof value === 'string' ? value : undefined;
}

/** 宽容数字读取：缺失/非有限数 → undefined */
export function readNumber(v: unknown, key: string): number | undefined {
  const obj = readRecord(v);
  const value = obj?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** 宽容布尔读取：沿 keys 路径逐层下钻，任一层缺失/非对象 → false */
export function readBool(v: unknown, ...keys: string[]): boolean {
  let current: unknown = v;
  for (const key of keys) {
    const obj = readRecord(current);
    if (!obj) return false;
    current = obj[key];
  }
  return current === true;
}
