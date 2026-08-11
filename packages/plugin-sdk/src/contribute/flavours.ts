// packages/plugin-sdk/src/contribute/flavours.ts
// W4-C：block_view 仅装饰「现有」flavour 的默认白名单
//
// 对齐 SlashMenuModel DEFAULT_SLASH_CATALOG 与 block-paper-contract 常见 kind。
// 非永久锁死：registerFlavour(F1+) 落地后宿主通过 setKnownFlavours 扩展本集合。
// 见 plans/specs/register-flavour-roadmap.md（F0→F3）。

/**
 * 内置 / 当前产品已支持的 flavour id。
 * block_view 注册时 flavour 必须命中此集（或宿主注入的 known 集）。
 */
export const DEFAULT_KNOWN_FLAVOURS: readonly string[] = [
  'paragraph',
  'heading',
  'heading-1',
  'heading-2',
  'heading-3',
  'bullet',
  'numbered',
  'list',
  'list_item',
  'code',
  'code_block',
  'quote',
  'divider',
  'table',
  'todo',
  'image',
  'callout',
  'unknown', // 投影 Unknown 占位；允许装饰未知块的通用视图
] as const;

/** 构造可变 Set（注册表内部用）。 */
export function createKnownFlavourSet(extra?: Iterable<string>): Set<string> {
  const set = new Set<string>(DEFAULT_KNOWN_FLAVOURS);
  if (extra) {
    for (const f of extra) {
      if (typeof f === 'string' && f.length > 0) set.add(f);
    }
  }
  return set;
}

export function isKnownFlavour(
  known: ReadonlySet<string>,
  flavour: string
): boolean {
  return known.has(flavour);
}
