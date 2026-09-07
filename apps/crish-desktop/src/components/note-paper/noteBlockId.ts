/**
 * 笔记块 ID 生成（audit-repair-202609 · T7）。
 *
 * 引擎约束：collab wire 的 `id` 经 Rust `BlockId::parse`（serde Uuid）反序列化，
 * **必须是合法 UUID 字符串**——历史空笔记初始化行使用 `"init-first-block"`
 * 幽灵 ID 会在 `ops_from_json_str` 处直接失败。本模块保证产出合法 UUID v4。
 */

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 是否为合法 UUID v4 字符串（导出供测试与调用方自检） */
export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/**
 * 生成块 ID（合法 UUID v4 字符串）。
 * 优先 `crypto.randomUUID`；不可用时以 `crypto.getRandomValues` 组装 v4
 * （jsdom / 旧 WebView 兜底）；二者皆无才退化为 Math.random（此时随机性
 * 弱化但格式仍合法——仅影响碰撞概率，不影响引擎反序列化）。
 */
export function newNoteBlockId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  try {
    if (c && typeof c.randomUUID === 'function') {
      return c.randomUUID();
    }
  } catch {
    /* fallthrough */
  }
  const bytes = new Uint8Array(16);
  try {
    if (c && typeof c.getRandomValues === 'function') {
      c.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
