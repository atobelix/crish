/**
 * 思考档位单源（描述接口 efforts 白名单 → 档位面板）。
 *
 * 单源 = Rust `describe_model` 的 `offered_levels()`（R2 C9 / S-B7），经
 * `catalog_get` 下发的 `thinkingTiers`（TierEffortMap 单一载体）到达前端。
 * 档位 UI **不再自造静态档位表**（前端 `THINKING_LEVEL_IDS` 已移除）。
 *
 * 数据流：
 *   Rust describe_model(offered_levels) ──catalog_get──▶ 本模块 applyCatalogEfforts
 *   ──▶ resolveCatalogEfforts(model) ──▶ thinkingLevelOptionsFor（档位面板唯一数据源）
 *
 * 行为：
 * - 有能力元数据（offered 非空）→ 渲染描述接口白名单档位 + 【默认】；
 * - 无能力元数据（offered 空 / 快照缺失）→ 仅【默认】项（不渲染自造档位）；
 * - 「默认」= value 'default'，不注入显式思考参数（呼应 G8-c 显式/默认档位
 *   区分与 R4 T4.1「省略档位 → 无思考参数」）。
 */

/** catalog_get wire 档位映射（Rust TierEffortMap camelCase：键=规范档位，值=Some(wire)/None=隐藏） */
export type CatalogEffortMapWire = Record<string, string | null>;

/** catalog_get wire 档位面条目（Rust ModelCatalogEntry camelCase 档位字段子集） */
export interface CatalogEffortEntryWire {
  model?: string;
  apiModel?: string;
  /** 模型级思考档位白名单 + wire 拼写映射（TierEffortMap 单一载体） */
  thinkingTiers?: CatalogEffortMapWire | null;
}

/** catalog_get wire 档位面快照（Rust CatalogSnapshot camelCase 档位字段子集） */
export interface CatalogEffortWire {
  entries?: CatalogEffortEntryWire[];
}

/** 描述接口档位解析结果（供档位面板；单源 = 描述接口 offered） */
export type EffortDescription = {
  /** 提供档位白名单（跨两映射并集，字典序） */
  offered: string[];
  /** 派生默认档位（efforts 首个，对齐 Rust describe_model default_effort） */
  defaultEffort?: string;
};

/** 档位面板可选项（单源 = 描述接口白名单 + 默认项）。 */
export type ThinkingLevelOption = {
  value: string;
  label: string;
  /** true = 「跟随默认」项（不注入显式思考参数） */
  isProviderDefault: boolean;
};

/** 档位段标签（纯，语义稳定） */
export const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  default: '默认',
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

/**
 * 描述接口档位映射 → 提供档位集 + 默认档位（纯转换，可单测）。
 *
 * 单源语义：仅读取 `thinkingTiers` 单一载体（Rust 侧旧双字段已废止）。
 */
export function effortsFromEntryWire(
  entry: Pick<CatalogEffortEntryWire, 'thinkingTiers'> | null | undefined
): EffortDescription | null {
  if (!entry) return null;
  const offeredSet = new Set<string>();
  const map = entry.thinkingTiers;
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [level, wire] of Object.entries(map)) {
      if (level === 'default') continue;
      // 仅收录提供档位（wire 非 null 且非空；null = 隐藏档）
      if (wire !== null && String(wire).trim() !== '') {
        offeredSet.add(level);
      }
    }
  }
  if (offeredSet.size === 0) return null;
  const offered = Array.from(offeredSet).sort();
  return { offered, defaultEffort: offered[0] };
}

/**
 * 档位面板渲染选项（纯函数，单源 = 描述接口 offered）。
 *
 * - 有能力元数据（offered 非空）→ rendered = 描述接口白名单档位 + 【默认】；
 * - 无能力元数据（offered 空 / snapshot 缺失）→ 仅【默认】项（不渲染自造档位）；
 * - 【默认】恒为首项，value = 'default'（不注入显式思考参数）。
 */
export function thinkingLevelOptionsFor(
  efforts: EffortDescription | null | undefined
): ThinkingLevelOption[] {
  const explicit = (efforts?.offered || []).map((level) => ({
    value: level,
    label: THINKING_LEVEL_LABELS[level] ?? level,
    isProviderDefault: false,
  }));
  return [
    { value: 'default', label: '默认', isProviderDefault: true },
    ...explicit,
  ];
}

/**
 * 档位选择结果 → 是否注入显式档位（纯）。
 * value === 'default'（默认）→ false（省略档位，引擎按默认执行）；
 * 否则 → true（显式档位，命中描述接口白名单才有效）。
 */
export function isExplicitThinkingLevel(value: string): boolean {
  return value !== '' && value !== 'default';
}

// ─── catalog_get 快照档位存储（前端只读快照缓存，单源）────────────────────

/** model 键（含 apiModel 别名）→ 描述接口档位 */
let catalogEfforts: Record<string, EffortDescription> | null = null;

/**
 * 注入描述接口档位快照（单源 = Rust catalog_get 档位字段；纯读取缓存）。
 */
export function applyCatalogEfforts(
  wire: CatalogEffortWire | null | undefined
): void {
  if (!wire || !Array.isArray(wire.entries)) return;
  const next: Record<string, EffortDescription> = {};
  for (const entry of wire.entries) {
    const model = normalizeEffortModel(entry?.model);
    if (!model) continue;
    const effort = effortsFromEntryWire(entry);
    if (!effort) continue;
    next[model] = effort;
    const apiModel = normalizeEffortModel(entry.apiModel);
    if (apiModel && apiModel !== model && !next[apiModel]) {
      next[apiModel] = effort;
    }
  }
  catalogEfforts = Object.keys(next).length > 0 ? next : null;
}

/** 测试辅助：清空描述接口档位快照（档位面板回落「默认」） */
export function clearCatalogEfforts(): void {
  catalogEfforts = null;
}

/**
 * 描述接口档位解析（单源）。精确 + 模糊匹配 + 常见推理模型保底
 */
export function resolveCatalogEfforts(model: string): EffortDescription {
  const norm = (model || '').toLowerCase().trim();
  if (catalogEfforts) {
    const exact = catalogEfforts[model] || catalogEfforts[norm];
    if (exact && exact.offered.length > 0) return exact;
    for (const key of Object.keys(catalogEfforts)) {
      const k = key.toLowerCase();
      if (norm.includes(k) || k.includes(norm)) {
        const entry = catalogEfforts[key];
        if (entry && entry.offered.length > 0) return entry;
      }
    }
  }
  // 智能保底：如果是推理模型（r1, o1, o3, spark, reasoner, thinking, claude-3-7 等）
  if (
    norm &&
    /r1|o1|o3|o4|spark|reasoner|reasoning|thinking|claude-3-7/i.test(norm)
  ) {
    return {
      offered: ['off', 'low', 'medium', 'high'],
      defaultEffort: 'medium',
    };
  }
  return { offered: [] };
}

/** model id 规范化（trim；中文/全角空格；空 → ''） */
function normalizeEffortModel(raw: unknown): string {
  if (raw == null) return '';
  if (
    typeof raw !== 'string' &&
    typeof raw !== 'number' &&
    typeof raw !== 'boolean'
  ) {
    return '';
  }
  let s = String(raw);
  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore environments without String.normalize */
  }
  return s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

/**
 * 拉取描述接口档位快照（catalog_get → applyCatalogEfforts）。
 * 与定价快照 `modelCatalog.fetchCatalogSnapshot` 共用同一条 IPC（catalog_get；
 * 版本号语义由 pricing 快照统一承载），此面仅消费档位字段、幂等。
 * 命令缺失 / 失败 / 载荷非法 → false（档位面板回落「提供方默认」，恒不抛）。
 */
export async function fetchDescribeEffortsSnapshot(): Promise<boolean> {
  // 动态引入以避免 tauriInvoke 在非 Tauri 环境（纯单测）形成顶层循环依赖
  const { invokeResult } = await import('./tauriInvoke');
  try {
    const res = await invokeResult<CatalogEffortWire>('catalog_get', {});
    if (res.status !== 'ok') return false;
    applyCatalogEfforts(res.data);
    return true;
  } catch {
    return false;
  }
}
