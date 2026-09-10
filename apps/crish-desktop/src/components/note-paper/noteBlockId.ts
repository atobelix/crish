/**
 * 笔记块 ID 生成（audit-repair-202609 · T7 / SYSTEMATIC-FIX-PLAN §6）。
 *
 * 引擎约束：collab wire 的 `id` 经 Rust `BlockId::parse`（serde Uuid）反序列化，
 * **必须是合法 UUID 字符串**——历史空笔记初始化行使用 `"init-first-block"`
 * 幽灵 ID 会在 `ops_from_json_str` 处直接失败。本模块保证产出合法 UUID v4。
 *
 * 熵约束（§6）：桌面生产构建强制 crypto 熵（randomUUID / getRandomValues）；
 * 弱 Math.random 回落仅允许出现在非生产（DEV/test）路径，不得进入生产构建可达路径。
 */

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 是否为合法 UUID v4 字符串（导出供测试与调用方自检） */
export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/** 仅 DEV/test：弱熵填充。生产构建经 import.meta.env.PROD 死码消除，不得调用。 */
function fillWeakEntropyForDevOnly(bytes: Uint8Array): void {
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
}

function bytesToUuidV4(bytes: Uint8Array): string {
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 生成块 ID（合法 UUID v4 字符串）。
 * 优先 `crypto.randomUUID`；否则 `crypto.getRandomValues` 组装 v4。
 * 生产构建二者皆不可用时硬失败；非生产才允许弱熵回落。
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
  let filled = false;
  try {
    if (c && typeof c.getRandomValues === 'function') {
      c.getRandomValues(bytes);
      filled = true;
    }
  } catch {
    filled = false;
  }

  if (!filled) {
    // 桌面生产构建强制 crypto 熵；弱熵回落不得出现在生产
    if (import.meta.env.PROD) {
      throw new Error(
        '[noteBlockId] crypto entropy required in production; weak-entropy fallback is forbidden'
      );
    }
    // import.meta.env.DEV / test：jsdom 等无 crypto 时的格式合法弱熵兜底
    if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
      fillWeakEntropyForDevOnly(bytes);
    } else {
      // 非 PROD 但也非 DEV/test 的未知模式：仍拒绝弱熵，避免漏网
      throw new Error(
        '[noteBlockId] crypto entropy unavailable; refusing weak-entropy fallback'
      );
    }
  }

  return bytesToUuidV4(bytes);
}
