/**
 * Slash 菜单状态模型（纯 TS，可测）。
 *
 * - 打开 / 过滤 / 关闭
 * - **composing 时不可开**（A-IME-02 / editor-kit structureKeyGuard 思想）
 * - 可注入 `isComposing` 回调（对接 ImeMachine.isComposing 或宿主）
 *
 * 本模型 **不** 下发 Intent；选中项后由宿主构造 `op` / `request_slash` 经守卫下发。
 * 写路径必须 Intent → RS apply；禁止 DOM 旁路写盘。
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { SlashContribution } from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 是否处于 IME composition 的查询回调 */
export type IsComposingFn = () => boolean;

/** 打开结果 */
export type SlashOpenResult =
  | { ok: true; snapshot: SlashMenuSnapshot }
  | {
      ok: false;
      code: 'composing' | 'already_open' | 'invalid_anchor';
      reason: string;
    };

/** 过滤后的菜单项视图 */
export type SlashMenuItemView = {
  id: string;
  title: string;
  description?: string;
  group?: string;
};

/** 只读快照 */
export type SlashMenuSnapshot = {
  open: boolean;
  /** 锚定块 */
  blockId: BlockId | null;
  /** 块内 offset（触发 `/` 的位置） */
  offset: number;
  /** 过滤查询串（`/` 后输入） */
  query: string;
  /** 当前过滤后的可见项 */
  items: SlashMenuItemView[];
  /** 高亮索引（键盘导航） */
  activeIndex: number;
};

/** 构造选项 */
export type SlashMenuModelOptions = {
  /** 注入 IME 查询；默认恒 false */
  isComposing?: IsComposingFn;
  /** 初始菜单项目录；缺省用内置静默样例 */
  catalog?: readonly SlashContribution[];
};

// ---------------------------------------------------------------------------
// 默认目录（假数据；不接线真实 flavour 注册表）
// ---------------------------------------------------------------------------

export const DEFAULT_SLASH_CATALOG: readonly SlashContribution[] = [
  { id: 'paragraph', title: '正文', description: '普通段落', group: '基础' },
  { id: 'heading-1', title: '标题 1', description: '一级标题', group: '基础' },
  { id: 'heading-2', title: '标题 2', description: '二级标题', group: '基础' },
  { id: 'bullet', title: '无序列表', description: '项目符号', group: '列表' },
  { id: 'numbered', title: '有序列表', description: '编号列表', group: '列表' },
  { id: 'code', title: '代码块', description: '等宽代码', group: '高级' },
  { id: 'quote', title: '引用', description: '引用块', group: '高级' },
  { id: 'divider', title: '分割线', description: '水平线', group: '高级' },
];

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

function toView(item: SlashContribution): SlashMenuItemView {
  const view: SlashMenuItemView = {
    id: item.id,
    title: item.title,
  };
  if (item.description !== undefined) {
    view.description = item.description;
  }
  if (item.group !== undefined) {
    view.group = item.group;
  }
  return view;
}

/**
 * 按 query 过滤目录（标题 / id / description 子串，大小写不敏感）。
 * 空 query → 全部。
 */
export function filterSlashCatalog(
  catalog: readonly SlashContribution[],
  query: string
): SlashMenuItemView[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return catalog.map(toView);
  }
  return catalog
    .filter((item) => {
      const hay = [
        item.id,
        item.title,
        item.description ?? '',
        item.group ?? '',
      ]
        .join('\n')
        .toLowerCase();
      return hay.includes(q);
    })
    .map(toView);
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Slash 菜单状态机。
 *
 * 不变量：
 * 1. `isComposing() === true` 时 `open()` 拒绝（A-IME-02）
 * 2. 关闭后 snapshot.open === false；焦点/选区由宿主 SelectionStore 保持（A-SIL-02）
 */
export class SlashMenuModel {
  private readonly isComposing: IsComposingFn;
  private catalog: SlashContribution[];
  private openState = false;
  private blockId: BlockId | null = null;
  private offset = 0;
  private query = '';
  private items: SlashMenuItemView[] = [];
  private activeIndex = 0;

  constructor(options: SlashMenuModelOptions = {}) {
    this.isComposing = options.isComposing ?? (() => false);
    this.catalog = [...(options.catalog ?? DEFAULT_SLASH_CATALOG)];
  }

  /** 替换目录（假数据 / 后续 flavour 贡献合并后注入） */
  setCatalog(catalog: readonly SlashContribution[]): void {
    this.catalog = [...catalog];
    if (this.openState) {
      this.refilter();
    }
  }

  /**
   * 尝试打开 slash 菜单。
   *
   * - composing → `{ ok: false, code: 'composing' }`（不可开）
   * - 已打开 → `{ ok: false, code: 'already_open' }`
   * - 空 blockId → `{ ok: false, code: 'invalid_anchor' }`
   */
  open(blockId: BlockId, offset = 0, initialQuery = ''): SlashOpenResult {
    if (this.isComposing()) {
      return {
        ok: false,
        code: 'composing',
        reason: 'IME composing：禁止打开 slash 面板（A-IME-02）',
      };
    }
    if (!blockId) {
      return {
        ok: false,
        code: 'invalid_anchor',
        reason: 'SlashMenuModel.open：blockId 不可为空',
      };
    }
    if (this.openState) {
      return {
        ok: false,
        code: 'already_open',
        reason: 'SlashMenuModel：菜单已打开，请先 close 或复用 setQuery',
      };
    }

    this.openState = true;
    this.blockId = blockId;
    this.offset =
      Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0;
    this.query = initialQuery;
    this.refilter();
    return { ok: true, snapshot: this.getSnapshot() };
  }

  /**
   * 更新过滤串并刷新 items。
   * 未打开时 no-op（返回当前快照）。
   */
  setQuery(query: string): SlashMenuSnapshot {
    if (!this.openState) {
      return this.getSnapshot();
    }
    this.query = query;
    this.refilter();
    return this.getSnapshot();
  }

  /**
   * 键盘高亮移动（夹在 [0, items.length)）。
   * 无项时 activeIndex 置 0。
   */
  moveActive(delta: number): SlashMenuSnapshot {
    if (!this.openState || this.items.length === 0) {
      this.activeIndex = 0;
      return this.getSnapshot();
    }
    const len = this.items.length;
    const next = (((this.activeIndex + delta) % len) + len) % len;
    this.activeIndex = next;
    return this.getSnapshot();
  }

  /** 关闭菜单；清空锚点与 query。 */
  close(): SlashMenuSnapshot {
    this.openState = false;
    this.blockId = null;
    this.offset = 0;
    this.query = '';
    this.items = [];
    this.activeIndex = 0;
    return this.getSnapshot();
  }

  /** 是否打开 */
  isOpen(): boolean {
    return this.openState;
  }

  getSnapshot(): SlashMenuSnapshot {
    return {
      open: this.openState,
      blockId: this.blockId,
      offset: this.offset,
      query: this.query,
      items: this.items.map((it) => ({ ...it })),
      activeIndex: this.activeIndex,
    };
  }

  private refilter(): void {
    this.items = filterSlashCatalog(this.catalog, this.query);
    if (this.items.length === 0) {
      this.activeIndex = 0;
    } else if (this.activeIndex >= this.items.length) {
      this.activeIndex = this.items.length - 1;
    }
  }
}
