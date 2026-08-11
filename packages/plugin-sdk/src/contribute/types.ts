// packages/plugin-sdk/src/contribute/types.ts
// W4-C · contribute points View 轨骨架
// 对齐：plans/06-扩展与Agent工具面.md；round-D 06 §5.2–5.4；EL-07 投影-only

/**
 * Contribute point 种类（View 轨）。
 *
 * - slash_item：斜杠菜单项
 * - block_view：块视图装饰（仅装饰已知 flavour，见 registry）
 * - widget：边栏/gutter 等 chrome 挂件
 * - keymap：快捷键 → 意图 commandId（不直接写文档）
 */
export type ContributeKind = 'slash_item' | 'block_view' | 'widget' | 'keymap';

/** 全部合法 kind（枚举校验 / list 过滤）。 */
export const CONTRIBUTE_KINDS: readonly ContributeKind[] = [
  'slash_item',
  'block_view',
  'widget',
  'keymap',
] as const;

/**
 * View 轨注册时允许/要求的权限声明字段。
 * - `ui:contribute`：注册任意 contribute point 的**必填**权限
 * - `note:read` / `note:write`：可选声明（读投影 / 未来 command 轨写工具）；
 *   即便声明 note:write，View 轨 API **仍不**返回 write store
 */
export type ContributePermission = 'ui:contribute' | 'note:read' | 'note:write';

export const CONTRIBUTE_PERMISSIONS: readonly ContributePermission[] = [
  'ui:contribute',
  'note:read',
  'note:write',
] as const;

/** 注册 contribute 的硬性权限（无声明 → 拒绝）。 */
export const REQUIRED_CONTRIBUTE_PERMISSION: ContributePermission =
  'ui:contribute';

// ─── 注册载荷（插件侧传入）────────────────────────────────────

/** 公共字段：id 在 (pluginId, kind) 维度唯一；permissions 为声明面。 */
export interface ContributeBase {
  /** 贡献项 id（插件内唯一；全局键 = pluginId + kind + id） */
  readonly id: string;
  /** 所属插件 id（与 manifest.id 对齐） */
  readonly pluginId: string;
  readonly kind: ContributeKind;
  /**
   * 权限声明。必须含 `ui:contribute`；
   * 可附带 `note:read` / `note:write`（声明不影响 View 描述符形状）。
   */
  readonly permissions: readonly ContributePermission[];
}

export interface SlashItemContribution extends ContributeBase {
  readonly kind: 'slash_item';
  readonly title: string;
  readonly description?: string;
  readonly group?: string;
  /**
   * 动作描述（纯数据意图）。禁止函数 / store 句柄；
   * 最终须落为 Intent / Op，不得旁路写盘。
   */
  readonly action?: Readonly<Record<string, unknown>>;
}

export interface BlockViewContribution extends ContributeBase {
  readonly kind: 'block_view';
  /**
   * 目标 flavour。W4-C：只能装饰**已知** flavour（内置或宿主 setKnownFlavours）；
   * 未知 → 拒绝（默认）或 warn 降级（unknownFlavourPolicy）。
   * F1 registerFlavour 落地后宿主可把第三方 flavour 加入 known 集。
   */
  readonly flavour: string;
  /** 组件注册键（tag / 动态 import key）；不绑 React/Lit 具体类型 */
  readonly component: string;
  readonly virtualizable?: boolean;
}

export interface WidgetContribution extends ContributeBase {
  readonly kind: 'widget';
  /** 挂载锚点（如 block-gutter / doc-header） */
  readonly anchor: string;
  readonly component: string;
}

export interface KeymapContribution extends ContributeBase {
  readonly kind: 'keymap';
  /** 键序列描述（如 'Mod-b'）；宿主 keymap 解析 */
  readonly keys: string;
  /**
   * 白名单 command id 意图。run 只发意图，不持文档权威。
   */
  readonly commandId: string;
}

export type Contribution =
  | SlashItemContribution
  | BlockViewContribution
  | WidgetContribution
  | KeymapContribution;

// ─── 视图描述符（list / 查询唯一对外形状）────────────────────

/**
 * 投影-only 视图描述符。
 *
 * 不变量（EL-07 / 恶意扩展零持久化）：
 * - 仅含可序列化 UI 元数据
 * - **永不**包含 store / applyOp / write / transaction 等写句柄
 * - 宿主据此渲染；写权威仍走 RS 工具面
 */
export type ViewDescriptor =
  | SlashItemViewDescriptor
  | BlockViewViewDescriptor
  | WidgetViewDescriptor
  | KeymapViewDescriptor;

export interface ViewDescriptorBase {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: ContributeKind;
  /** 注册时声明的权限快照（只读；不含提升） */
  readonly permissions: readonly ContributePermission[];
}

export interface SlashItemViewDescriptor extends ViewDescriptorBase {
  readonly kind: 'slash_item';
  readonly title: string;
  readonly description?: string;
  readonly group?: string;
  readonly action?: Readonly<Record<string, unknown>>;
}

export interface BlockViewViewDescriptor extends ViewDescriptorBase {
  readonly kind: 'block_view';
  readonly flavour: string;
  readonly component: string;
  readonly virtualizable: boolean;
}

export interface WidgetViewDescriptor extends ViewDescriptorBase {
  readonly kind: 'widget';
  readonly anchor: string;
  readonly component: string;
}

export interface KeymapViewDescriptor extends ViewDescriptorBase {
  readonly kind: 'keymap';
  readonly keys: string;
  readonly commandId: string;
}

// ─── 注册结果 ────────────────────────────────────────────────

export type RegisterErrorCode =
  | 'missing_permission'
  | 'unknown_flavour'
  | 'duplicate_id'
  | 'invalid_payload'
  | 'forbidden_write_handle';

export type RegisterResult =
  | { readonly ok: true; readonly registrationKey: string }
  | {
      readonly ok: false;
      readonly code: RegisterErrorCode;
      readonly message: string;
    };

/** 未知 flavour 策略：默认 reject；warn 仍注册并回调 onWarning */
export type UnknownFlavourPolicy = 'reject' | 'warn';

export interface ContributePointRegistryOptions {
  /**
   * 初始已知 flavour 集合。省略则用 DEFAULT_KNOWN_FLAVOURS。
   * 宿主可在 registerFlavour(F1) 后调用 setKnownFlavours 扩展。
   */
  readonly knownFlavours?: ReadonlySet<string> | readonly string[];
  /** 默认 'reject' */
  readonly unknownFlavourPolicy?: UnknownFlavourPolicy;
  /** warn 策略或校验降级时的诊断回调 */
  readonly onWarning?: (message: string) => void;
}
