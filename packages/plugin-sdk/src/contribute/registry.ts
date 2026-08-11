// packages/plugin-sdk/src/contribute/registry.ts
// W4-C · ContributePoint 注册表（View 轨）+ M4 registerFlavour
//
// 不变量：
// 1. 无 ui:contribute 声明 → 拒绝 contribute 注册
// 2. block_view 只能装饰 known flavour（未知 → reject 或 warn）
// 3. list() 仅返回 ViewDescriptor；永不暴露 write store / applyOp
// 4. registerFlavour 写入 known 集；权限需 ui:contribute | note:extend；幂等
// 5. 不实现完整插件沙箱 VM；投影-only 守卫靠类型 + 运行时剥离
// 6. 扩展绕过写路径禁止：载荷禁止 store/applyOp 等写句柄

import { createKnownFlavourSet, isKnownFlavour } from './flavours';
import type {
  BlockViewContribution,
  BlockViewViewDescriptor,
  ContributeKind,
  ContributePermission,
  ContributePointRegistryOptions,
  Contribution,
  FlavourDefinition,
  FlavourDescriptor,
  KeymapContribution,
  KeymapViewDescriptor,
  RegisterFlavourResult,
  RegisterResult,
  SlashItemContribution,
  SlashItemViewDescriptor,
  UnknownFlavourPolicy,
  ViewDescriptor,
  WidgetContribution,
  WidgetViewDescriptor,
} from './types';
import {
  CONTRIBUTE_KINDS,
  FLAVOUR_REGISTER_PERMISSIONS,
  REQUIRED_CONTRIBUTE_PERMISSION,
} from './types';

/**
 * 禁止出现在注册载荷 / 描述符上的写路径键名。
 * 恶意扩展若夹带这些字段 → 拒绝注册（forbidden_write_handle）。
 */
const FORBIDDEN_WRITE_KEYS: readonly string[] = [
  'store',
  'writeStore',
  'getWriteStore',
  'applyOp',
  'apply',
  'transaction',
  'mutate',
  'db',
  'sqlite',
  'write',
  'documentWrite',
  'fsWrite',
  'getRootElement',
  'innerHTML',
] as const;

/** 全局注册键：pluginId\0kind\0id（避免 id 碰撞跨插件）。 */
export function makeRegistrationKey(
  pluginId: string,
  kind: ContributeKind,
  id: string
): string {
  return `${pluginId}\0${kind}\0${id}`;
}

/**
 * ContributePoint 注册表。
 *
 * 宿主单例持有；插件 activate 时 register / registerFlavour，deactivate 时 unregisterByPlugin。
 * 与 PluginRegistry / ToolRegistry **分轨**：本表只服务 View 投影 + known flavour 元数据。
 */
export class ContributePointRegistry {
  private readonly entries = new Map<string, ViewDescriptor>();
  /** registerFlavour 登记的 flavour 元数据（id → 描述符） */
  private readonly flavourDefs = new Map<string, FlavourDescriptor>();
  private knownFlavours: Set<string>;
  private readonly unknownFlavourPolicy: UnknownFlavourPolicy;
  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(options: ContributePointRegistryOptions = {}) {
    this.knownFlavours = createKnownFlavourSet(options.knownFlavours);
    this.unknownFlavourPolicy = options.unknownFlavourPolicy ?? 'reject';
    this.onWarning = options.onWarning;
  }

  /**
   * 注册一条 View 轨贡献。
   * @returns `{ ok: true, registrationKey }` 或错误码（不抛错，便于批注册）。
   */
  register(contrib: Contribution): RegisterResult {
    const baseCheck = this.validateBase(contrib);
    if (!baseCheck.ok) return baseCheck;

    const permCheck = this.validatePermissions(contrib);
    if (!permCheck.ok) return permCheck;

    const writeCheck = this.rejectWriteHandles(contrib);
    if (!writeCheck.ok) return writeCheck;

    if (contrib.kind === 'block_view') {
      const flavourCheck = this.validateBlockViewFlavour(contrib);
      if (!flavourCheck.ok) return flavourCheck;
    }

    const payloadCheck = this.validateKindPayload(contrib);
    if (!payloadCheck.ok) return payloadCheck;

    const key = makeRegistrationKey(contrib.pluginId, contrib.kind, contrib.id);
    if (this.entries.has(key)) {
      return {
        ok: false,
        code: 'duplicate_id',
        message: `contribute already registered: plugin=${contrib.pluginId} kind=${contrib.kind} id=${contrib.id}`,
      };
    }

    const descriptor = toViewDescriptor(contrib);
    // 冻结：防止注册后被外部 mutate 塞入写句柄
    this.entries.set(key, Object.freeze(descriptor) as ViewDescriptor);
    return { ok: true, registrationKey: key };
  }

  /**
   * 列出视图描述符。
   * @param kind 可选过滤；省略则返回全部 kind
   */
  list(kind?: ContributeKind): readonly ViewDescriptor[] {
    if (kind !== undefined && !CONTRIBUTE_KINDS.includes(kind)) {
      return [];
    }
    const out: ViewDescriptor[] = [];
    for (const desc of this.entries.values()) {
      if (kind === undefined || desc.kind === kind) {
        out.push(desc);
      }
    }
    // 稳定序：pluginId → id
    out.sort((a, b) => {
      const p = a.pluginId.localeCompare(b.pluginId);
      return p !== 0 ? p : a.id.localeCompare(b.id);
    });
    return out;
  }

  /**
   * 按全局键或 (pluginId, kind, id) 注销。
   * @returns 是否删除到了条目
   */
  unregister(
    idOrKey: string,
    pluginId?: string,
    kind?: ContributeKind
  ): boolean {
    // 完整 key 直删
    if (this.entries.has(idOrKey)) {
      return this.entries.delete(idOrKey);
    }
    if (pluginId !== undefined && kind !== undefined) {
      const key = makeRegistrationKey(pluginId, kind, idOrKey);
      return this.entries.delete(key);
    }
    // 仅 id：删除所有匹配 id 的条目（跨插件慎用）
    let removed = false;
    for (const [key, desc] of this.entries) {
      if (desc.id === idOrKey) {
        if (pluginId !== undefined && desc.pluginId !== pluginId) continue;
        if (kind !== undefined && desc.kind !== kind) continue;
        this.entries.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  /**
   * 停用插件时清理其全部 contribute 贡献。
   * 注意：不自动清理 registerFlavour；请同步调用 unregisterFlavoursByPlugin，
   * 或由宿主 deactivate 钩子两者都调。
   */
  unregisterByPlugin(pluginId: string): number {
    let n = 0;
    for (const [key, desc] of this.entries) {
      if (desc.pluginId === pluginId) {
        this.entries.delete(key);
        n += 1;
      }
    }
    return n;
  }

  /** 当前已知 flavour 快照（只读副本）。 */
  getKnownFlavours(): ReadonlySet<string> {
    return new Set(this.knownFlavours);
  }

  /**
   * 扩展/替换已知 flavour 集（宿主批量接线；插件优先走 registerFlavour）。
   * @param mode 'replace' 全量替换；'merge'（默认）并入
   */
  setKnownFlavours(
    flavours: Iterable<string>,
    mode: 'replace' | 'merge' = 'merge'
  ): void {
    if (mode === 'replace') {
      this.knownFlavours = createKnownFlavourSet(flavours);
      // replace 不自动清 flavourDefs；仅 id 集变更。宿主需自行对齐。
    } else {
      for (const f of flavours) {
        if (typeof f === 'string' && f.length > 0) {
          this.knownFlavours.add(f);
        }
      }
    }
  }

  /**
   * M4 · 正式 API：注册/扩展 known flavour。
   *
   * - 写入 known flavours，使第三方 block_view 可装饰该 flavour
   * - 幂等：同 id 重复注册 → ok + idempotent:true（覆盖元数据快照）
   * - 权限：permissions 须含 `ui:contribute` **或** `note:extend`
   * - 投影-only：拒绝 store / applyOp 等写句柄；不返回写路径
   */
  registerFlavour(def: FlavourDefinition): RegisterFlavourResult {
    const base = this.validateFlavourDefBase(def);
    if (!base.ok) return base;

    const perm = this.validateFlavourPermissions(def);
    if (!perm.ok) return perm;

    const write = this.rejectWriteHandlesOnBag(
      def as unknown as Record<string, unknown>
    );
    if (!write.ok) return write;

    const allowed = normalizeAllowedContribute(def.allowedContribute);
    if (!allowed.ok) return allowed;

    const existing = this.flavourDefs.has(def.id);
    const descriptor = toFlavourDescriptor(def, allowed.kinds);
    this.flavourDefs.set(
      def.id,
      Object.freeze(descriptor) as FlavourDescriptor
    );
    this.knownFlavours.add(def.id);

    return {
      ok: true,
      registrationKey: def.id,
      idempotent: existing,
    };
  }

  /** 已 registerFlavour 的 flavour 描述符列表（稳定按 id 排序）。 */
  listFlavours(): readonly FlavourDescriptor[] {
    const out = [...this.flavourDefs.values()];
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /** 按 id 取 flavour 描述符；未 registerFlavour 则 undefined（内置 DEFAULT 不在此表）。 */
  getFlavour(id: string): FlavourDescriptor | undefined {
    return this.flavourDefs.get(id);
  }

  /**
   * 注销 registerFlavour 登记项；可选是否从 known 集移除。
   * @param removeFromKnown 默认 true；false 时仅删元数据，id 仍可被 block_view 装饰
   */
  unregisterFlavour(id: string, removeFromKnown = true): boolean {
    const had = this.flavourDefs.delete(id);
    if (had && removeFromKnown) {
      this.knownFlavours.delete(id);
    }
    return had;
  }

  /** 停用插件时清理其 registerFlavour 登记（并从 known 移除对应 id）。 */
  unregisterFlavoursByPlugin(pluginId: string): number {
    let n = 0;
    for (const [id, desc] of this.flavourDefs) {
      if (desc.pluginId === pluginId) {
        this.flavourDefs.delete(id);
        this.knownFlavours.delete(id);
        n += 1;
      }
    }
    return n;
  }

  /** contribute 条目数（测试 / 诊断）。 */
  get size(): number {
    return this.entries.size;
  }

  /** registerFlavour 条目数。 */
  get flavourCount(): number {
    return this.flavourDefs.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** 清空 contribute + flavour 登记（known 回到 DEFAULT + 构造注入）。 */
  clearAll(options?: ContributePointRegistryOptions): void {
    this.entries.clear();
    this.flavourDefs.clear();
    this.knownFlavours = createKnownFlavourSet(options?.knownFlavours);
  }

  // ─── 校验 ──────────────────────────────────────────────────

  private validateBase(contrib: Contribution): RegisterResult {
    if (!contrib || typeof contrib !== 'object') {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'contribution must be a non-null object',
      };
    }
    if (!isNonEmptyString(contrib.id)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'contribution.id is required (non-empty string)',
      };
    }
    if (!isNonEmptyString(contrib.pluginId)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'contribution.pluginId is required (non-empty string)',
      };
    }
    if (!CONTRIBUTE_KINDS.includes(contrib.kind)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: `contribution.kind must be one of: ${CONTRIBUTE_KINDS.join(', ')}`,
      };
    }
    return { ok: true, registrationKey: '' };
  }

  private validatePermissions(contrib: Contribution): RegisterResult {
    const perms = contrib.permissions;
    if (!Array.isArray(perms) || perms.length === 0) {
      return {
        ok: false,
        code: 'missing_permission',
        message:
          'contribution.permissions is required; must declare ui:contribute (and optionally note:read|note:write|note:extend)',
      };
    }
    if (!perms.includes(REQUIRED_CONTRIBUTE_PERMISSION)) {
      return {
        ok: false,
        code: 'missing_permission',
        message: `contribution.permissions must include '${REQUIRED_CONTRIBUTE_PERMISSION}' (declared: [${perms.join(', ')}])`,
      };
    }
    for (const p of perms) {
      if (
        p !== 'ui:contribute' &&
        p !== 'note:read' &&
        p !== 'note:write' &&
        p !== 'note:extend'
      ) {
        return {
          ok: false,
          code: 'missing_permission',
          message: `unknown contribute permission '${String(p)}'; allowed: ui:contribute | note:read | note:write | note:extend`,
        };
      }
    }
    return { ok: true, registrationKey: '' };
  }

  private rejectWriteHandles(contrib: Contribution): RegisterResult {
    const bag = contrib as unknown as Record<string, unknown>;
    for (const key of FORBIDDEN_WRITE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(bag, key) && bag[key] != null) {
        return {
          ok: false,
          code: 'forbidden_write_handle',
          message: `contribution must not carry write handle '${key}' (View 轨投影-only；写权威仅经 RS 工具面)`,
        };
      }
    }
    // action 内亦不得夹带函数或写键
    if (contrib.kind === 'slash_item' && contrib.action) {
      for (const [k, v] of Object.entries(contrib.action)) {
        if (typeof v === 'function') {
          return {
            ok: false,
            code: 'forbidden_write_handle',
            message: `slash_item.action.${k} must not be a function (intent data only)`,
          };
        }
        if (
          FORBIDDEN_WRITE_KEYS.includes(k) ||
          (typeof v === 'object' &&
            v !== null &&
            hasForbiddenNested(v as Record<string, unknown>))
        ) {
          return {
            ok: false,
            code: 'forbidden_write_handle',
            message: `slash_item.action carries forbidden write-related key '${k}'`,
          };
        }
      }
    }
    return { ok: true, registrationKey: '' };
  }

  private validateBlockViewFlavour(
    contrib: BlockViewContribution
  ): RegisterResult {
    if (!isNonEmptyString(contrib.flavour)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'block_view.flavour is required (non-empty string)',
      };
    }
    if (isKnownFlavour(this.knownFlavours, contrib.flavour)) {
      // 若经 registerFlavour 登记，校验 allowedContribute 含 block_view
      const def = this.flavourDefs.get(contrib.flavour);
      if (def && !def.allowedContribute.includes('block_view')) {
        return {
          ok: false,
          code: 'contribute_not_allowed',
          message: `block_view not allowed on flavour '${contrib.flavour}' (allowedContribute: [${def.allowedContribute.join(', ')}])`,
        };
      }
      return { ok: true, registrationKey: '' };
    }
    const msg = `block_view flavour '${contrib.flavour}' is not in known flavours (W4-C/M4: decorate known flavour only; use registerFlavour or setKnownFlavours)`;
    if (this.unknownFlavourPolicy === 'warn') {
      this.onWarning?.(msg);
      return { ok: true, registrationKey: '' };
    }
    return { ok: false, code: 'unknown_flavour', message: msg };
  }

  // ─── registerFlavour 校验 ──────────────────────────────────

  private validateFlavourDefBase(
    def: FlavourDefinition
  ): RegisterFlavourResult {
    if (!def || typeof def !== 'object') {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'flavour definition must be a non-null object',
      };
    }
    if (!isNonEmptyString(def.id)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'flavour.id is required (non-empty string)',
      };
    }
    if (!isNonEmptyString(def.displayName)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'flavour.displayName is required (non-empty string)',
      };
    }
    if (!isNonEmptyString(def.category)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'flavour.category is required (non-empty string)',
      };
    }
    if (!isNonEmptyString(def.pluginId)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: 'flavour.pluginId is required (non-empty string)',
      };
    }
    return { ok: true, registrationKey: '', idempotent: false };
  }

  private validateFlavourPermissions(
    def: FlavourDefinition
  ): RegisterFlavourResult {
    const perms = def.permissions;
    if (!Array.isArray(perms) || perms.length === 0) {
      return {
        ok: false,
        code: 'missing_permission',
        message:
          'flavour.permissions is required; must declare ui:contribute or note:extend (registerFlavour 门槛)',
      };
    }
    const hasGate = FLAVOUR_REGISTER_PERMISSIONS.some((p) => perms.includes(p));
    if (!hasGate) {
      return {
        ok: false,
        code: 'missing_permission',
        message: `flavour.permissions must include 'ui:contribute' or 'note:extend' (declared: [${perms.join(', ')}])`,
      };
    }
    for (const p of perms) {
      if (
        p !== 'ui:contribute' &&
        p !== 'note:read' &&
        p !== 'note:write' &&
        p !== 'note:extend'
      ) {
        return {
          ok: false,
          code: 'missing_permission',
          message: `unknown flavour permission '${String(p)}'; allowed: ui:contribute | note:extend | note:read | note:write`,
        };
      }
    }
    return { ok: true, registrationKey: '', idempotent: false };
  }

  private rejectWriteHandlesOnBag(
    bag: Record<string, unknown>
  ): RegisterFlavourResult {
    for (const key of FORBIDDEN_WRITE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(bag, key) && bag[key] != null) {
        return {
          ok: false,
          code: 'forbidden_write_handle',
          message: `flavour definition must not carry write handle '${key}' (EL-07 投影-only；registerFlavour 不授予写路径)`,
        };
      }
    }
    // schema 内亦不得夹带写键
    const schema = bag.schema;
    if (schema && typeof schema === 'object' && schema !== null) {
      if (hasForbiddenNested(schema as Record<string, unknown>)) {
        return {
          ok: false,
          code: 'forbidden_write_handle',
          message:
            'flavour.schema carries forbidden write-related key (store/applyOp/…)',
        };
      }
    }
    return { ok: true, registrationKey: '', idempotent: false };
  }

  private validateKindPayload(contrib: Contribution): RegisterResult {
    switch (contrib.kind) {
      case 'slash_item':
        return validateSlash(contrib);
      case 'block_view':
        return validateBlockView(contrib);
      case 'widget':
        return validateWidget(contrib);
      case 'keymap':
        return validateKeymap(contrib);
      default: {
        const _exhaustive: never = contrib;
        return {
          ok: false,
          code: 'invalid_payload',
          message: `unsupported kind: ${String((_exhaustive as Contribution).kind)}`,
        };
      }
    }
  }
}

// ─── kind 载荷校验 ───────────────────────────────────────────

function validateSlash(c: SlashItemContribution): RegisterResult {
  if (!isNonEmptyString(c.title)) {
    return {
      ok: false,
      code: 'invalid_payload',
      message: 'slash_item.title is required',
    };
  }
  return { ok: true, registrationKey: '' };
}

function validateBlockView(c: BlockViewContribution): RegisterResult {
  if (!isNonEmptyString(c.component)) {
    return {
      ok: false,
      code: 'invalid_payload',
      message: 'block_view.component is required',
    };
  }
  return { ok: true, registrationKey: '' };
}

function validateWidget(c: WidgetContribution): RegisterResult {
  if (!isNonEmptyString(c.anchor)) {
    return {
      ok: false,
      code: 'invalid_payload',
      message: 'widget.anchor is required',
    };
  }
  if (!isNonEmptyString(c.component)) {
    return {
      ok: false,
      code: 'invalid_payload',
      message: 'widget.component is required',
    };
  }
  return { ok: true, registrationKey: '' };
}

function validateKeymap(c: KeymapContribution): RegisterResult {
  if (!isNonEmptyString(c.keys)) {
    return {
      ok: false,
      code: 'invalid_payload',
      message: 'keymap.keys is required',
    };
  }
  if (!isNonEmptyString(c.commandId)) {
    return {
      ok: false,
      code: 'invalid_payload',
      message: 'keymap.commandId is required',
    };
  }
  return { ok: true, registrationKey: '' };
}

// ─── flavour 描述符投影 ──────────────────────────────────────

function normalizeAllowedContribute(
  kinds: readonly ContributeKind[] | undefined
):
  | { ok: true; kinds: readonly ContributeKind[] }
  | { ok: false; code: 'invalid_payload'; message: string } {
  if (kinds === undefined) {
    return { ok: true, kinds: ['block_view'] };
  }
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return {
      ok: false,
      code: 'invalid_payload',
      message:
        'flavour.allowedContribute must be a non-empty array of ContributeKind (or omit for default [block_view])',
    };
  }
  const out: ContributeKind[] = [];
  for (const k of kinds) {
    if (!CONTRIBUTE_KINDS.includes(k)) {
      return {
        ok: false,
        code: 'invalid_payload',
        message: `flavour.allowedContribute contains invalid kind '${String(k)}'; allowed: ${CONTRIBUTE_KINDS.join(', ')}`,
      };
    }
    if (!out.includes(k)) out.push(k);
  }
  return { ok: true, kinds: out };
}

function toFlavourDescriptor(
  def: FlavourDefinition,
  allowedContribute: readonly ContributeKind[]
): FlavourDescriptor {
  const d: FlavourDescriptor = {
    id: def.id,
    displayName: def.displayName,
    category: def.category,
    allowedContribute: Object.freeze([
      ...allowedContribute,
    ]) as readonly ContributeKind[],
    permissions: freezePerms(def.permissions),
    pluginId: def.pluginId,
  };
  if (def.schema !== undefined) {
    (d as { schema?: Readonly<Record<string, unknown>> }).schema =
      Object.freeze({
        ...def.schema,
      });
  }
  return d;
}

// ─── 描述符投影（剥离一切非 View 字段）──────────────────────

function toViewDescriptor(contrib: Contribution): ViewDescriptor {
  const permissions = freezePerms(contrib.permissions);
  switch (contrib.kind) {
    case 'slash_item': {
      const d: SlashItemViewDescriptor = {
        id: contrib.id,
        pluginId: contrib.pluginId,
        kind: 'slash_item',
        permissions,
        title: contrib.title,
      };
      if (contrib.description !== undefined) {
        (d as { description?: string }).description = contrib.description;
      }
      if (contrib.group !== undefined) {
        (d as { group?: string }).group = contrib.group;
      }
      if (contrib.action !== undefined) {
        (d as { action?: Readonly<Record<string, unknown>> }).action =
          Object.freeze({ ...contrib.action });
      }
      return d;
    }
    case 'block_view': {
      const d: BlockViewViewDescriptor = {
        id: contrib.id,
        pluginId: contrib.pluginId,
        kind: 'block_view',
        permissions,
        flavour: contrib.flavour,
        component: contrib.component,
        virtualizable: contrib.virtualizable !== false,
      };
      return d;
    }
    case 'widget': {
      const d: WidgetViewDescriptor = {
        id: contrib.id,
        pluginId: contrib.pluginId,
        kind: 'widget',
        permissions,
        anchor: contrib.anchor,
        component: contrib.component,
      };
      return d;
    }
    case 'keymap': {
      const d: KeymapViewDescriptor = {
        id: contrib.id,
        pluginId: contrib.pluginId,
        kind: 'keymap',
        permissions,
        keys: contrib.keys,
        commandId: contrib.commandId,
      };
      return d;
    }
    default: {
      const _exhaustive: never = contrib;
      throw new Error(
        `unreachable kind: ${String((_exhaustive as Contribution).kind)}`
      );
    }
  }
}

function freezePerms(
  perms: readonly ContributePermission[]
): readonly ContributePermission[] {
  return Object.freeze([...perms]) as readonly ContributePermission[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function hasForbiddenNested(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_WRITE_KEYS.includes(key)) return true;
  }
  return false;
}

/**
 * 工厂：创建注册表实例（便于测试与宿主 DI）。
 */
export function createContributePointRegistry(
  options?: ContributePointRegistryOptions
): ContributePointRegistry {
  return new ContributePointRegistry(options);
}
