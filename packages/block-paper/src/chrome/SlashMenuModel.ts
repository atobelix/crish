/**
 * Slash 菜单状态模型（纯 TS，可测）。
 *
 * - 打开 / 过滤 / 关闭
 * - **composing 时不可开**（A-IME-02 / editor-kit structureKeyGuard 思想）
 * - **composing 时不可确认提交**（W3-F 加固）
 * - 选中 catalog 项 → 产出 `slash_insert` StructureIntent
 *   （经 `submitIntent` → **生产** `createCollabApplySink`；形状测可用 mock）
 * - 可注入 `isComposing` 回调（对接 ImeMachine.isComposing 或宿主）
 *
 * 写路径：StructureIntent → `submitIntent` → **`createCollabApplySink`** → wire → RS `DocSession::apply`；
 * 形状测可用 `createMockIntentSink`；禁止 DOM 旁路写盘。
 *
 * ## 轨
 * - **W3-F Strict 子集**：`selectItem` → `slash_insert` → collab sink（见 `chrome.apply.test.ts`）
 * - mock 形状见 `chrome.shape.test.ts`；**不得** mock.calls 关 Strict
 * - **W3-F DOM 余量**：`BlockChromeDomHost` 可挂 slash 宿主容器显隐（`w3f_dom_slash_host`）
 * - **≠ EL-01**；slash **完整浮层 catalog UI / A-BLK-02 产品 e2e 仍开**
 *
 * ## SD-55
 * - 类型：`SlashMenuModel.types`
 * - 默认目录 / 过滤：`slashCatalog`
 * - 本文件：状态机 + 既有 `./SlashMenuModel` 公开符号 barrel
 * - **≠** 占 SD-13 Overlay / SD-48 DomHost；**≠** 默开 catalog；**≠ EL-01**
 */

import type {
  BlockId,
  IntentId,
  SlashContribution,
} from '@crish/block-paper-contract';
// SD-05：中性 intentId；禁止 chrome→TextLeafModel 仅为 id
import { nextIntentId } from '../intentId';
import { buildSlashInsertIntent } from './structureIntents';
import { DEFAULT_SLASH_CATALOG, filterSlashCatalog } from './slashCatalog';
import type {
  IsComposingFn,
  SlashMenuItemView,
  SlashMenuModelOptions,
  SlashMenuSnapshot,
  SlashOpenResult,
  SlashSelectResult,
} from './SlashMenuModel.types';

export type {
  IsComposingFn,
  SlashOpenResult,
  SlashSelectResult,
  SlashMenuItemView,
  SlashMenuSnapshot,
  SlashMenuModelOptions,
} from './SlashMenuModel.types';

export { DEFAULT_SLASH_CATALOG, filterSlashCatalog } from './slashCatalog';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Slash 菜单状态机。
 *
 * 不变量：
 * 1. `isComposing() === true` 时 `open()` / `select*` 拒绝（A-IME-02）
 * 2. 关闭后 snapshot.open === false；焦点/选区由宿主 SelectionStore 保持（A-SIL-02）
 * 3. 选中项产出 `slash_insert`，**不**直接改文档；须 `submitIntent` → sink
 */
export class SlashMenuModel {
  private readonly isComposing: IsComposingFn;
  private readonly createIntentId: () => IntentId;
  private readonly resolveFlavour: (catalogItemId: string) => string;
  private catalog: SlashContribution[];
  private openState = false;
  private blockId: BlockId | null = null;
  private offset = 0;
  private query = '';
  private items: SlashMenuItemView[] = [];
  private activeIndex = 0;
  /** React / DomHost 订阅：open·filter·select·close 后通知重绘 */
  private readonly listeners = new Set<() => void>();

  constructor(options: SlashMenuModelOptions = {}) {
    this.isComposing = options.isComposing ?? (() => false);
    this.createIntentId =
      options.createIntentId ?? (() => nextIntentId('slash'));
    this.resolveFlavour = options.resolveFlavour ?? ((id) => id);
    this.catalog = [...(options.catalog ?? DEFAULT_SLASH_CATALOG)];
  }

  /**
   * 订阅快照变更（useSyncExternalStore / 父级 forceUpdate）。
   * @returns 取消订阅
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // 监听方异常不打断 model
      }
    }
  }

  /** 替换目录（假数据 / 后续 flavour 贡献合并后注入） */
  setCatalog(catalog: readonly SlashContribution[]): void {
    this.catalog = [...catalog];
    if (this.openState) {
      this.refilter();
    }
    this.emit();
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
    this.emit();
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
    this.emit();
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
    this.emit();
    return this.getSnapshot();
  }

  /**
   * 确认当前高亮项 → `slash_insert` Intent，并关闭菜单。
   *
   * - composing → 拒绝（加固；不关闭菜单，宿主可再试）
   * - 未打开 / 无可见项 → 拒绝
   */
  selectActive(): SlashSelectResult {
    if (this.isComposing()) {
      return {
        ok: false,
        code: 'composing',
        reason: 'IME composing：禁止提交 slash 插入（A-IME-02）',
      };
    }
    if (!this.openState) {
      return {
        ok: false,
        code: 'not_open',
        reason: 'SlashMenuModel.selectActive：菜单未打开',
      };
    }
    if (this.items.length === 0) {
      return {
        ok: false,
        code: 'no_active_item',
        reason: 'SlashMenuModel.selectActive：无可见 catalog 项',
      };
    }
    const item = this.items[this.activeIndex] ?? this.items[0];
    if (!item) {
      return {
        ok: false,
        code: 'no_active_item',
        reason: 'SlashMenuModel.selectActive：activeIndex 越界',
      };
    }
    return this.commitItem(item.id);
  }

  /**
   * 按 catalog 项 id 确认 → `slash_insert` Intent，并关闭菜单。
   * id 须在**当前过滤可见** items 中（或完整 catalog；此处查完整 catalog，便于点击非高亮项）。
   */
  selectItem(catalogItemId: string): SlashSelectResult {
    if (this.isComposing()) {
      return {
        ok: false,
        code: 'composing',
        reason: 'IME composing：禁止提交 slash 插入（A-IME-02）',
      };
    }
    if (!this.openState) {
      return {
        ok: false,
        code: 'not_open',
        reason: 'SlashMenuModel.selectItem：菜单未打开',
      };
    }
    if (!catalogItemId) {
      return {
        ok: false,
        code: 'item_not_found',
        reason: 'SlashMenuModel.selectItem：catalogItemId 不可为空',
      };
    }
    const inCatalog = this.catalog.some((c) => c.id === catalogItemId);
    if (!inCatalog) {
      return {
        ok: false,
        code: 'item_not_found',
        reason: `SlashMenuModel.selectItem：目录中无 id=${catalogItemId}`,
      };
    }
    return this.commitItem(catalogItemId);
  }

  /** 关闭菜单；清空锚点与 query。 */
  close(): SlashMenuSnapshot {
    this.openState = false;
    this.blockId = null;
    this.offset = 0;
    this.query = '';
    this.items = [];
    this.activeIndex = 0;
    this.emit();
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

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private commitItem(catalogItemId: string): SlashSelectResult {
    const blockId = this.blockId;
    if (!blockId) {
      return {
        ok: false,
        code: 'invalid_anchor',
        reason: 'SlashMenuModel：锚点 blockId 丢失',
      };
    }
    const offset = this.offset;
    const flavour = this.resolveFlavour(catalogItemId);
    const intent = buildSlashInsertIntent({
      blockId,
      offset,
      flavour,
      catalogItemId,
      origin: 'slash',
      createIntentId: this.createIntentId,
    });
    // 成功产出 Intent 后关闭（A-SIL-02：面板噪声消失；选区由宿主保持）
    // close() 内已 emit
    const snapshot = this.close();
    return { ok: true, intent, snapshot };
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
