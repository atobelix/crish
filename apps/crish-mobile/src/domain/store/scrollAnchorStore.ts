// 阅读锚点持久化（批 B ⑱，2026-11-03）：按会话保存「读到哪条消息 +
// 块内偏移」，重开会话后恢复阅读位置，避免长会话重开一律被拽回底部。
// 锚点是可重建的 UI 态、不是用户数据：写入失败静默（与 settingsStore
// 的本机偏好写入同口径），解析失败一律视为无锚点，绝不抛进交互路径。
// 持久面与 settings 同源：kv settings 表经 configure 注入（装配点
// persistBootstrap，SqlSettingsDao 结构满足本接口）；未注入 / DB 降级
// 时退化为进程内 Map——会话内恢复仍成立、跨启动不保留（诚实降级，
// 与 localChat 配置面的降级口径一致）。

/** 阅读锚点：锚点块 id + 块顶之上已滚过的像素 */
export interface ScrollAnchor {
  /** 锚点块 id（DisplayBlock 的 id；工具组 = 组首工具 id，随组稳定） */
  blockId: string;
  /** 块内偏移 px（scrollY − 块顶 y，≥ 0） */
  offsetPx: number;
}

/** 锚点持久接口（SqlSettingsDao 的 get/set/delete 与之同形） */
export interface ScrollAnchorPersist {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

const KEY_PREFIX = 'chat.scroll_anchor.';

/** 锚点 kv 键（anchorKey 由宿主以 `${engine.kind}:${engine.id}` 构成） */
export function scrollAnchorKey(anchorKey: string): string {
  return `${KEY_PREFIX}${anchorKey}`;
}

/** 序列化（savedAtMs 仅供诊断，不参与恢复判定） */
export function serializeScrollAnchor(
  anchor: ScrollAnchor,
  savedAtMs: number
): string {
  return JSON.stringify({
    blockId: anchor.blockId,
    offsetPx: anchor.offsetPx,
    savedAtMs,
  });
}

/** 解析落盘值：形状不对 / 数值非法 → null（无锚点），绝不抛 */
export function parseScrollAnchor(raw: string | null): ScrollAnchor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { blockId, offsetPx } = parsed as Record<string, unknown>;
    if (typeof blockId !== 'string' || blockId.length === 0) return null;
    if (
      typeof offsetPx !== 'number' ||
      !Number.isFinite(offsetPx) ||
      offsetPx < 0
    ) {
      return null;
    }
    return { blockId, offsetPx };
  } catch {
    return null;
  }
}

/** 默认持久化实现（接线层启动时注入一次，同 settingsStore 模式） */
let defaultPersist: ScrollAnchorPersist | null = null;

/** 无持久面时的进程内兜底（DB 降级形态） */
const memoryFallback = new Map<string, ScrollAnchor>();

/** 接线层注入默认持久化（persistBootstrap 装配；传 null 复位为内存形态） */
export function configureScrollAnchorPersistence(
  persist: ScrollAnchorPersist | null
): void {
  defaultPersist = persist;
}

/**
 * 读锚点：有持久面时以持久面为准；无持久面读内存兜底。
 * 读失败 = 无锚点（恢复链整体降级为宿主默认跟随，不报错）。
 */
export async function loadScrollAnchor(
  anchorKey: string
): Promise<ScrollAnchor | null> {
  const persist = defaultPersist;
  if (!persist) return memoryFallback.get(anchorKey) ?? null;
  try {
    return parseScrollAnchor(await persist.get(scrollAnchorKey(anchorKey)));
  } catch {
    return null;
  }
}

/** 写锚点（尽力持久化：失败静默；内存副本同步更新） */
export function saveScrollAnchor(
  anchorKey: string,
  anchor: ScrollAnchor
): void {
  memoryFallback.set(anchorKey, anchor);
  const persist = defaultPersist;
  if (!persist) return;
  void persist
    .set(scrollAnchorKey(anchorKey), serializeScrollAnchor(anchor, Date.now()))
    .catch(() => {
      // 锚点是可重建 UI 态：写入失败不阻断交互（同 settings 偏好口径）
    });
}

/** 清锚点（回到跟随态时调用：底部即当前位置，旧锚点作废） */
export function clearScrollAnchor(anchorKey: string): void {
  memoryFallback.delete(anchorKey);
  const persist = defaultPersist;
  if (!persist) return;
  const key = scrollAnchorKey(anchorKey);
  if (persist.delete) {
    void persist.delete(key).catch(() => undefined);
  } else {
    void persist.set(key, '').catch(() => undefined);
  }
}
