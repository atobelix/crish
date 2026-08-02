/**
 * 正式版权限模式（桌面 UI ↔ 引擎 permissionMode）
 *
 * 契约：ENGINE-RUN + LS（localStorage crish_permission_mode）
 * TrustZone 矩阵（与 runtime / daemon 一致）：
 * - ask   需确认：T0/T2 自动；T1/T3 确认；T4 拒绝
 * - deep  深入分析：偏沟通与分析（引擎侧等同 ask）
 * - full  完全访问：T0–T3 自动；T4（极危）仍确认
 * - plan  计划：仅 T0；写与风险 soft-deny，不弹窗
 *
 * 与 packages/agent-daemon daemon-permission-policy.normalizeEnginePermissionMode
 * 别名表对齐（桌面侧映射到 UI 四模式，不暴露 unattended/auto）：
 * - deep / project / confirm / default / interactive → ask（deep 桌面可保留 deep，引擎仍 ask）
 * - full / full_access / full-access / yolo / danger → full
 * - plan / readonly / read-only / analysis / safe / cautious → plan
 * - unattended / headless / batch / ci → ask（安全默认，不暴露批处理）
 * - auto / autopilot → ask
 * 桌面不暴露 unattended；收到 unattended 时 hydrate 为 ask。
 *
 * 路径语义（桌面）：
 * - default / auto 族 → ask（安全默认，不静默 full）
 * - ask 族（ask|deep）→ 引擎 ask，审批 UI 可见
 * - allow 族（full）→ 引擎 full-access，T0–T3 自动
 * - plan 族 → 只读规划
 */

export type PermissionMode = 'ask' | 'deep' | 'full' | 'plan';

/** 引擎协议 permissionMode（含 unattended 批处理；桌面 UI 暂不暴露） */
export type EnginePermissionMode = 'ask' | 'auto' | 'full-access' | 'plan' | 'unattended';

export type PermissionModeMeta = {
  id: PermissionMode;
  label: string;
  shortLabel: string;
  description: string;
  accent: string;
  /** 引擎侧实际生效的 permissionMode */
  engineMode: EnginePermissionMode;
  /** 一句话矩阵摘要（设置页 / 菜单副文案） */
  matrixHint: string;
};

export const PERMISSION_MODE_STORAGE_KEY = 'crish_permission_mode';

/**
 * 桌面安全默认模式（未知 / 空 / 损坏存储均回落至此）。
 * 与 daemon normalize 未知值 → ask 一致，永不静默 full-access。
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

/** 桌面正式四模式 id 列表（设置 Select / 菜单 / 测试共用；顺序即 cycle 顺序） */
export const DESKTOP_PERMISSION_MODE_IDS: readonly PermissionMode[] = [
  'ask',
  'deep',
  'plan',
  'full',
] as const;

const DESKTOP_MODE_SET: ReadonlySet<string> = new Set(DESKTOP_PERMISSION_MODE_IDS);

/** 桌面正式模式 → run-task 必须下发的引擎 mode（单一真相表） */
export const DESKTOP_TO_ENGINE: Readonly<Record<PermissionMode, EnginePermissionMode>> = {
  ask: 'ask',
  deep: 'ask',
  full: 'full-access',
  plan: 'plan',
};

/**
 * 菜单/设置文案：短、可扫读，避免 TrustZone 术语与长句。
 * matrixHint 仅作简短对比一行（可选展示）；主决策看 label + description。
 */
export const PERMISSION_MODES: PermissionModeMeta[] = [
  {
    id: 'ask',
    label: '需确认',
    shortLabel: '需确认',
    description: '改文件、推送前先问你',
    accent: 'var(--text-tertiary)',
    engineMode: DESKTOP_TO_ENGINE.ask,
    matrixHint: '常用默认',
  },
  {
    id: 'deep',
    label: '深入分析',
    shortLabel: '深入分析',
    description: '多读多聊，改文件仍会问你',
    accent: 'var(--text-secondary)',
    engineMode: DESKTOP_TO_ENGINE.deep,
    matrixHint: '同需确认',
  },
  {
    id: 'plan',
    label: '计划',
    shortLabel: '计划',
    description: '只出方案，不改项目',
    accent: 'var(--text-secondary)',
    engineMode: DESKTOP_TO_ENGINE.plan,
    matrixHint: '只读',
  },
  {
    id: 'full',
    label: '完全访问',
    shortLabel: '完全访问',
    description: '读写推送自动做，极危才问',
    accent: 'var(--text-primary)',
    engineMode: DESKTOP_TO_ENGINE.full,
    matrixHint: '少打扰',
  },
];

/** id → meta 索引（O(1)；与 PERMISSION_MODES 同步） */
const META_BY_ID: ReadonlyMap<PermissionMode, PermissionModeMeta> = new Map(
  PERMISSION_MODES.map((m) => [m.id, m]),
);

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && DESKTOP_MODE_SET.has(v);
}

/**
 * 未知 / 自由文本 → 合法桌面四模式。
 * 已是合法 id 原样返回；否则走 normalize（含别名与中文标签）。
 */
export function coercePermissionMode(v: unknown): PermissionMode {
  if (isPermissionMode(v)) return v;
  return normalizePermissionMode(v);
}

/** 折叠大小写 / 下划线 / 空白，与 daemon normalize 入参习惯对齐 */
function foldPermissionKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // 下划线与空白统一为连字符，便于 "full access" / "full_access" / "FULL-ACCESS"
  const key = v
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');
  return key || null;
}

/**
 * 引擎/配置/历史字符串 → 桌面 UI 四模式。
 * 与 daemon normalize 别名表镜像；unattended 族收成 ask。
 * 亦接受中文 UX 标签（需确认 / 深入分析 / 完全访问 / 计划 …）。
 */
export function normalizePermissionMode(v: unknown): PermissionMode {
  const key = foldPermissionKey(v);
  if (!key) {
    if (isPermissionMode(v)) return v;
    return DEFAULT_PERMISSION_MODE;
  }
  // deep 在桌面保留独立 UI（引擎侧仍 ask）
  if (key === 'deep' || key === '深入分析') return 'deep';
  if (key === 'ask' || key === '需确认' || key === '确认') return 'ask';

  // → ask（含 unattended 安全默认、auto 族 hydrate）
  if (
    key === 'auto' ||
    key === 'autopilot' ||
    key === 'project' ||
    key === 'confirm' ||
    key === 'default' ||
    key === 'interactive' ||
    key === 'unattended' ||
    key === 'headless' ||
    key === 'batch' ||
    key === 'ci' ||
    key === '自动' ||
    key === '无人值守'
  ) {
    return 'ask';
  }

  // → full（allow 路径）
  if (
    key === 'full-access' ||
    key === 'fullaccess' ||
    key === 'full' ||
    key === 'yolo' ||
    key === 'danger' ||
    key === 'allow' ||
    key === '完全访问' ||
    key === '全部允许'
  ) {
    return 'full';
  }

  // → plan
  if (
    key === 'plan' ||
    key === 'readonly' ||
    key === 'read-only' ||
    key === 'analysis' ||
    key === 'safe' ||
    key === 'cautious' ||
    key === '仅分析' ||
    key === '计划' ||
    key === '只读'
  ) {
    return 'plan';
  }

  if (isPermissionMode(v)) return v;
  return DEFAULT_PERMISSION_MODE;
}

/**
 * 取模式元数据；未知 id 经 coerce 回落 DEFAULT，永不抛错。
 */
export function permissionModeMeta(id: PermissionMode | unknown): PermissionModeMeta {
  const mode = coercePermissionMode(id);
  return META_BY_ID.get(mode) ?? META_BY_ID.get(DEFAULT_PERMISSION_MODE)!;
}

/** 中文完整标签（设置 / Overview 等；未知 → 需确认） */
export function permissionModeLabel(mode: PermissionMode | unknown): string {
  return permissionModeMeta(mode).label;
}

/** 中文短标签（Composer pill；未知 → 需确认） */
export function permissionModeShortLabel(mode: PermissionMode | unknown): string {
  return permissionModeMeta(mode).shortLabel;
}

/** 桌面 → 引擎：deep 映射为 ask；full → full-access（唯一真相：DESKTOP_TO_ENGINE） */
export function toEnginePermissionMode(mode: PermissionMode | unknown): EnginePermissionMode {
  const m = coercePermissionMode(mode);
  return DESKTOP_TO_ENGINE[m] ?? DESKTOP_TO_ENGINE[DEFAULT_PERMISSION_MODE];
}

/**
 * 引擎/配置回写桌面（设置 hydrate）。
 * full-access → full；auto/unattended → ask；plan → plan。
 * deep 仅当引擎原样回传 deep 时保留（run-task 下发的是 ask，引擎不会回 deep）。
 */
export function fromEnginePermissionMode(mode: unknown): PermissionMode {
  const key = foldPermissionKey(mode);
  if (!key) return normalizePermissionMode(mode);
  // deep 原样回传时保留 UI 态（normalize 同样处理；显式分支便于契约阅读）
  if (key === 'deep' || key === '深入分析') return 'deep';
  // 其余与 normalize 同一别名表（单一路径，避免 hydrate 与 normalize 漂移）
  return normalizePermissionMode(mode);
}

/**
 * 设置页 / Composer 选择后的「应下发引擎」mode。
 * 保证 meta.engineMode 与 toDaemon 永远一致；不一致时以 DESKTOP_TO_ENGINE 为准。
 */
export function resolveEnginePermissionMode(mode: PermissionMode | unknown): EnginePermissionMode {
  const desktop = coercePermissionMode(mode);
  const engine = toEnginePermissionMode(desktop);
  const metaEngine = permissionModeMeta(desktop).engineMode;
  // 防御：若 meta 表被误改，仍下发真相表
  return metaEngine === engine ? engine : DESKTOP_TO_ENGINE[desktop] ?? DESKTOP_TO_ENGINE[DEFAULT_PERMISSION_MODE];
}

/**
 * 桌面 mode 经 daemon 再回写是否稳定（deep 会塌缩为 ask，属预期）。
 * 用于测试与调试，不改变 store。
 */
export function desktopEngineRoundTrip(mode: PermissionMode | unknown): {
  engine: EnginePermissionMode;
  back: PermissionMode;
  stable: boolean;
  deepCollapses: boolean;
} {
  const desktop = coercePermissionMode(mode);
  const engine = toEnginePermissionMode(desktop);
  const back = fromEnginePermissionMode(engine);
  const deepCollapses = desktop === 'deep' && back === 'ask';
  const stable = back === desktop || deepCollapses;
  return { engine, back, stable, deepCollapses };
}

// ── 路径语义（default / auto / ask / allow / plan）──────────────────────────

/** 是否为桌面安全默认（ask） */
export function isDefaultPermissionMode(mode: PermissionMode | unknown): boolean {
  return coercePermissionMode(mode) === DEFAULT_PERMISSION_MODE;
}

/**
 * ask 族：需确认 + 深入分析（引擎均为 ask，T1/T3 走确认）。
 */
export function isAskFamilyMode(mode: PermissionMode | unknown): boolean {
  const m = coercePermissionMode(mode);
  return m === 'ask' || m === 'deep';
}

/**
 * allow 路径：完全访问（T0–T3 自动；T4 仍确认）。
 * 产品别名 allow / yolo / full-access 均 coerce 到 full。
 */
export function isAllowPathMode(mode: PermissionMode | unknown): boolean {
  return coercePermissionMode(mode) === 'full';
}

/** plan 路径：只读规划，无审批弹窗 */
export function isPlanPathMode(mode: PermissionMode | unknown): boolean {
  return coercePermissionMode(mode) === 'plan';
}

/**
 * auto 族别名（引擎 auto / autopilot）在桌面是否 hydrate 为 ask。
 * 用于契约测试与设置 hydrate 诊断。
 */
export function isAutoAliasToAsk(alias: unknown): boolean {
  const key = foldPermissionKey(alias);
  if (!key) return false;
  if (key === 'auto' || key === 'autopilot' || key === '自动') return true;
  // 已规范化结果为 ask，且原串不是 ask/deep 本身时，不算 auto 别名
  return false;
}

export function modeShowsApprovalUi(mode: PermissionMode | unknown): boolean {
  const m = coercePermissionMode(mode);
  return m === 'ask' || m === 'deep' || m === 'full';
}

/** 与 planModeEnabled 布尔双向对齐：plan 模式时 ribbon 与引擎一致 */
export function planModeEnabledFor(mode: PermissionMode | unknown): boolean {
  return isPlanPathMode(mode);
}

/**
 * planMode 开关 → permissionMode 配对（单一规则，store 两侧共用）。
 * on → plan；off 且当前为 plan → ask；off 且非 plan → 保持。
 * 未知 currently 先 coerce。
 */
export function permissionModeAfterPlanToggle(
  currently: PermissionMode | unknown,
  planEnabled: boolean,
): PermissionMode {
  const cur = coercePermissionMode(currently);
  if (planEnabled) return 'plan';
  if (cur === 'plan') return DEFAULT_PERMISSION_MODE;
  return cur;
}

/**
 * 菜单 / 快捷键：按 DESKTOP_PERMISSION_MODE_IDS 顺序循环切换。
 * 未知 current → 从 DEFAULT 起算下一档。
 */
export function nextPermissionMode(current: PermissionMode | unknown): PermissionMode {
  const ids = DESKTOP_PERMISSION_MODE_IDS;
  const cur = coercePermissionMode(current);
  const i = ids.indexOf(cur);
  const from = i < 0 ? 0 : i;
  return ids[(from + 1) % ids.length]!;
}

/** 反向循环（与 next 对称） */
export function previousPermissionMode(current: PermissionMode | unknown): PermissionMode {
  const ids = DESKTOP_PERMISSION_MODE_IDS;
  const cur = coercePermissionMode(current);
  const i = ids.indexOf(cur);
  const from = i < 0 ? 0 : i;
  return ids[(from - 1 + ids.length) % ids.length]!;
}

/**
 * UI 选择后的过渡：将 next 收成合法桌面模式。
 * 不隐式改写 plan 配对（那是 permissionModeAfterPlanToggle 的职责）。
 */
export function transitionPermissionMode(
  _currently: PermissionMode | unknown,
  next: unknown,
): PermissionMode {
  return coercePermissionMode(next);
}

export function loadStoredPermissionMode(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): PermissionMode {
  try {
    const v = storage?.getItem(PERMISSION_MODE_STORAGE_KEY);
    return normalizePermissionMode(v);
  } catch {
    return DEFAULT_PERMISSION_MODE;
  }
}

export function persistPermissionMode(
  mode: PermissionMode | unknown,
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof localStorage !== 'undefined'
    ? localStorage
    : null,
): void {
  try {
    const id = coercePermissionMode(mode);
    storage?.setItem(PERMISSION_MODE_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
