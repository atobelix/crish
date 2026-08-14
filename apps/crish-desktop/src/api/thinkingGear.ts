/**
 * 思考档位单源（描述接口 efforts 白名单 → 档位面板）。
 *
 * 单源 = Rust `describe_model` 的 `offered_levels()`（R2 C9 / S-B7），经
 * `catalog_get` 下发的 `reasoningEffortTiers` / `thinkingLevelMap`（TierEffortMap）
 * 到达前端。档位 UI **不再自造静态档位表**（前端 `THINKING_LEVEL_IDS` 已移除）。
 *
 * 数据流：
 *   Rust describe_model(offered_levels) ──catalog_get──▶ 本模块 applyCatalogEfforts
 *   ──▶ resolveCatalogEfforts(model) ──▶ thinkingLevelOptionsFor（档位面板唯一数据源）
 *
 * 行为：
 * - 有能力元数据（offered 非空）→ 渲染描述接口白名单档位 + 【提供方默认】；
 * - 无能力元数据（offered 空 / 快照缺失）→ 仅【提供方默认】项（不渲染自造档位）；
 * - 「提供方默认」= value 'default'，不注入显式思考参数（呼应 G8-c 显式/默认档位
 *   区分与 R4 T4.1「省略档位 → 无思考参数」）。
 */

/** catalog_get wire 档位映射（Rust TierEffortMap camelCase：键=规范档位，值=Some(wire)/None=隐藏） */
export type CatalogEffortMapWire = Record<string, string | null>;

/** catalog_get wire 档位面条目（Rust ModelCatalogEntry camelCase 档位字段子集） */
export interface CatalogEffortEntryWire {
  model?: string;
  apiModel?: string;
  /** 档位白名单（wire 拼写 = Some）/ 隐藏档（值 = null）；缺省 = 未收录 */
  reasoningEffortTiers?: CatalogEffortMapWire | null;
  /** pi-ai thinkingLevelMap 语义载体（键=规范档位；值=Some(wire)/None=隐藏） */
  thinkingLevelMap?: CatalogEffortMapWire | null;
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

/** 档位面板可选项（单源 = 描述接口白名单 + 提供方默认项）。 */
export type ThinkingLevelOption = {
  value: string;
  label: string;
  /** true = 「跟随提供方默认」项（不注入显式思考参数） */
  isProviderDefault: boolean;
};

/** 档位段标签（纯，语义稳定） */
export const THINKING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  off: '关闭',
  minimal: '最短',
  low: '标准',
  medium: '详细',
  high: '深入',
  xhigh: '最深',
};

/**
 * 描述接口档位映射 → 提供档位集 + 默认档位（纯转换，可单测）。
 *
 * 单源语义（R2 C9）：跨 `thinkingLevelMap` 与 `reasoningEffortTiers` 并集，
 * 仅收录 **提供（wire 拼写非 null）** 的档位；隐藏档（值 null）不入集。
 * defaultEffort = 提供的档位中第一个（对齐 Rust describe_model 的 default_effort
 * 派生语义——C9 `default_effort 为派生默认（efforts 首个）`）。
 * 无能力元数据（两字段均缺省/空）→ null（档位面板回落「提供方默认」项）。
 */
export function effortsFromEntryWire(
  entry:
    | Pick<CatalogEffortEntryWire, 'reasoningEffortTiers' | 'thinkingLevelMap'>
    | null
    | undefined
): EffortDescription | null {
  if (!entry) return null;
  const offeredSet = new Set<string>();
  for (const map of [entry.thinkingLevelMap, entry.reasoningEffortTiers]) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [level, wire] of Object.entries(map)) {
      // 仅收录提供档位（wire 拼写非 null 且非空）；隐藏档（null）不入集
      if (typeof wire === 'string' && wire.trim() !== '') {
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
 * - 有能力元数据（offered 非空）→ rendered = 描述接口白名单档位 + 【提供方默认】；
 * - 无能力元数据（offered 空 / snapshot 缺失）→ 仅【提供方默认】项（不渲染自造档位）；
 * - 【提供方默认】恒为首项，value = 'default'（不注入显式思考参数，呼应
 *   G8-c「显式档位/默认档位区分」与 T4.1「省略档位 → 无思考参数」）。
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
    { value: 'default', label: '提供方默认', isProviderDefault: true },
    ...explicit,
  ];
}

/**
 * 档位选择结果 → 是否注入显式档位（纯）。
 * value === 'default'（提供方默认）→ false（省略档位，引擎按默认执行）；
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
 * 版本号语义由 pricing 快照统一承载，此处仅按条目幂等合并（重复调用安全）。
 * 非法载荷（entries 缺失/非数组）→ 忽略（档位面板回落「提供方默认」）。
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

/** 测试辅助：清空描述接口档位快照（档位面板回落「提供方默认」） */
export function clearCatalogEfforts(): void {
  catalogEfforts = null;
}

/**
 * 描述接口档位解析（单源）。精确 + 模糊匹配（版本后缀 / 点号异形兼容）；
 * 未收录 → { offered: [] }（档位面板只渲染「提供方默认」项，不渲染自造档位）。
 */
export function resolveCatalogEfforts(model: string): EffortDescription {
  if (!catalogEfforts) return { offered: [] };
  const exact = catalogEfforts[model];
  if (exact) return exact;
  for (const key of Object.keys(catalogEfforts)) {
    if (model.includes(key) || key.includes(model)) {
      const entry = catalogEfforts[key];
      if (entry) return entry;
    }
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
