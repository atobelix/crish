/**
 * CONN-B2 · 产品 slash 打开路径
 *
 * ## 角色
 * - 显式 `openProductSlash(menu, blockId, offset?)` → `SlashMenuModel.open`
 * - 键盘 **`/`**（合适 focus 上下文）→ 同路径打开
 * - **composing 期间拒开**（事件 `isComposing` + model `isComposing` 双闸）
 *
 * ## 与 B1 串联
 * 本模块 **只负责打开**；打开后 catalog 的 readonly/writable 由
 * `createProductStrictSlashBinding` + Overlay `writeMode` 决定（CONN-B1）。
 * 打开成功 ≠ 可写；无 applyOps 仍为只读 catalog。
 *
 * ## 诚实边界
 * - **≠ EL-01**；**≠ A-BLK-02 产品 e2e / IME WebView 满关**
 * - **≠** 完整叶子 caret offset 追踪（offset 可由调用方传入；缺省 0）
 * - DomHost `projectSlashCatalog=false` 仍由挂载面钉死（防双浮层）
 */

import type { SlashMenuModel, SlashOpenResult } from '@crish/block-paper';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 显式打开参数 */
export type OpenProductSlashArgs = {
  menu: SlashMenuModel;
  /** 锚定块 id（必填；空串由 model 拒 invalid_anchor） */
  blockId: string;
  /** 块内 offset；缺省 0 */
  offset?: number;
  /** 初始过滤串；缺省空 */
  initialQuery?: string;
};

/**
 * 产品打开结果：透传 model `SlashOpenResult`，
 * 或 key 路径忽略（非 `/` / 焦点外 / 表单域）。
 */
export type ProductSlashOpenResult =
  SlashOpenResult | { ok: false; code: 'ignored'; reason: string };

/** 解析默认锚点输入 */
export type ResolveProductSlashAnchorInput = {
  /** chrome / 宿主当前焦点块 */
  focusedBlockId?: string | null;
  /** 文档块列表（取首块回落） */
  blocks?: readonly { id: string }[];
  /** 无块时占位：`slash-anchor-${docId}` */
  docId?: string;
  /** 最终硬回落 */
  fallbackBlockId?: string;
};

/** key 事件最小形状（DOM KeyboardEvent / 测用 plain object） */
export type ProductSlashKeyLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  /** keyCode 229 / IME Process */
  keyCode?: number;
  which?: number;
  target?: EventTarget | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
};

export type HandleProductSlashKeydownArgs = {
  menu: SlashMenuModel;
  /** 解析好的锚点 blockId */
  blockId: string;
  offset?: number;
  initialQuery?: string;
  /**
   * 表面根节点：事件 target 须在其内（或 surface 自身为 activeElement）。
   * 未传则不校验 DOM 焦点范围（纯测 / 显式调用）。
   */
  surfaceRoot?: Element | null;
  /**
   * 为 true 时：INPUT/TEXTAREA/SELECT（非 contenteditable 产品叶）忽略 `/`。
   * 默认 true，避免抢走搜索框等。
   */
  ignoreNativeFormFields?: boolean;
  /** 打开成功时是否 preventDefault（默认 true） */
  preventDefaultOnOpen?: boolean;
};

// ---------------------------------------------------------------------------
// 锚点
// ---------------------------------------------------------------------------

/**
 * 解析产品 slash 锚点块 id。
 * 优先级：focused → 首块 → `slash-anchor-${docId}` → fallback → `slash-anchor`。
 */
export function resolveProductSlashAnchor(
  input: ResolveProductSlashAnchorInput = {}
): string {
  const focused = input.focusedBlockId?.trim();
  if (focused) return focused;
  const first = input.blocks?.[0]?.id?.trim();
  if (first) return first;
  if (input.docId != null && String(input.docId).length > 0) {
    return `slash-anchor-${input.docId}`;
  }
  if (input.fallbackBlockId != null && input.fallbackBlockId.length > 0) {
    return input.fallbackBlockId;
  }
  return 'slash-anchor';
}

// ---------------------------------------------------------------------------
// 显式打开
// ---------------------------------------------------------------------------

/**
 * 产品显式打开 slash：`openSlash(blockId, offset?)` 可测入口。
 *
 * - 委托 `menu.open`（composing / already_open / invalid_anchor 由其拒绝）
 * - **不**注入 mock 写路径；打开后 writeMode 仍由 B1 binding 决定
 */
export function openProductSlash(args: OpenProductSlashArgs): SlashOpenResult {
  const offset =
    args.offset !== undefined &&
    Number.isFinite(args.offset) &&
    args.offset >= 0
      ? Math.floor(args.offset)
      : 0;
  const initialQuery = args.initialQuery ?? '';
  return args.menu.open(args.blockId, offset, initialQuery);
}

// ---------------------------------------------------------------------------
// 键盘 `/`
// ---------------------------------------------------------------------------

/**
 * 是否为产品 slash 打开键：裸 `/`、无 ctrl/meta/alt、非 IME composing/Process。
 * （shift 允许——部分布局 `/` 在 shift 层，但标准 US 不需要；保留 shift 不挡）
 */
export function isProductSlashOpenKey(ev: ProductSlashKeyLike): boolean {
  if (ev.isComposing === true) return false;
  if (ev.key === 'Process') return false;
  const code = ev.keyCode ?? ev.which;
  if (code === 229) return false;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  return ev.key === '/';
}

/**
 * 目标是否为应忽略的原生表单控件（搜索框等），避免全局/表面 `/` 误开。
 * contentEditable 产品叶 **不**忽略（未来叶子内 `/` 可走同一键路径）。
 */
export function isNativeFormFieldTarget(
  target: EventTarget | null | undefined
): boolean {
  if (target == null || !(target instanceof Element)) return false;
  const el = target as HTMLElement;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  // 嵌套在 label 内的原生控件已由 target 覆盖；contentEditable 放行
  return false;
}

/**
 * 事件是否落在产品表面焦点上下文内。
 * - 无 surfaceRoot：视为上下文 OK（调用方已过滤）
 * - 有 surfaceRoot：target 在根内，或 activeElement 在根内 / 等于根
 */
export function isWithinProductSlashFocusContext(
  surfaceRoot: Element | null | undefined,
  target: EventTarget | null | undefined
): boolean {
  if (surfaceRoot == null) return true;
  if (target instanceof Node && surfaceRoot.contains(target)) return true;
  if (typeof document !== 'undefined') {
    const active = document.activeElement;
    if (
      active != null &&
      (active === surfaceRoot || surfaceRoot.contains(active))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 处理产品 `/` keydown：合格则 `openProductSlash`，否则 ignored / model 拒绝。
 *
 * composing 双闸：
 * 1. `isProductSlashOpenKey` 看 `ev.isComposing` / Process / 229
 * 2. `menu.open` 再查注入的 `isComposing()`（A-IME-02）
 */
export function handleProductSlashKeydown(
  ev: ProductSlashKeyLike,
  args: HandleProductSlashKeydownArgs
): ProductSlashOpenResult {
  if (!isProductSlashOpenKey(ev)) {
    return {
      ok: false,
      code: 'ignored',
      reason: '非产品 slash 打开键（须裸 `/` 且非 composing）',
    };
  }

  const ignoreForms = args.ignoreNativeFormFields !== false;
  if (ignoreForms && isNativeFormFieldTarget(ev.target ?? null)) {
    return {
      ok: false,
      code: 'ignored',
      reason: '焦点在原生表单控件内，不打开产品 slash',
    };
  }

  if (!isWithinProductSlashFocusContext(args.surfaceRoot, ev.target ?? null)) {
    return {
      ok: false,
      code: 'ignored',
      reason: '焦点不在 note-paper 产品表面内',
    };
  }

  const opened = openProductSlash({
    menu: args.menu,
    blockId: args.blockId,
    offset: args.offset,
    initialQuery: args.initialQuery,
  });

  if (opened.ok && args.preventDefaultOnOpen !== false) {
    ev.preventDefault?.();
  }

  return opened;
}

/**
 * 从 key 事件尝试打开（便捷封装：自带锚点解析）。
 * 等价于 resolve anchor + handleProductSlashKeydown。
 */
export function tryOpenProductSlashFromKey(
  ev: ProductSlashKeyLike,
  args: Omit<HandleProductSlashKeydownArgs, 'blockId'> & {
    anchor?: ResolveProductSlashAnchorInput;
    blockId?: string;
  }
): ProductSlashOpenResult {
  const blockId = args.blockId ?? resolveProductSlashAnchor(args.anchor ?? {});
  return handleProductSlashKeydown(ev, {
    menu: args.menu,
    blockId,
    offset: args.offset,
    initialQuery: args.initialQuery,
    surfaceRoot: args.surfaceRoot,
    ignoreNativeFormFields: args.ignoreNativeFormFields,
    preventDefaultOnOpen: args.preventDefaultOnOpen,
  });
}
