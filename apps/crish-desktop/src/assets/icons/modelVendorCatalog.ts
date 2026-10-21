/**
 * modelVendorCatalog.ts — AI 模型厂商元数据与方形原彩图标字典
 *
 * 设计原则（严格遵循 ANTI_OVERENGINEERING_GUARDRAILS.md 与 AGENTS.md）：
 * 1. 结构纯粹：静态强类型映射，零复杂工厂，零动态异步反射；
 * 2. 容错解析：支持 vendorId、组织前缀、完整 modelId（如 deepseek-ai/DeepSeek-V3）与别名；
 * 3. 性能轻量：纯数据与纯函数，O(1) 精确命中 + 极简 O(N) 启发式回退，执行时间 < 0.05ms；
 * 4. 零冗余：仅收录最常用、叫得上号的高频厂商，总数严控在数十家，体积轻盈。
 */

import type { ModelVendorMeta } from './modelVendorTypes';
import { FOUNDATION_MODEL_VENDORS } from './modelVendors.foundation';
import { DOMESTIC_MODEL_VENDORS } from './modelVendors.domestic';
import { MULTIMODAL_MODEL_VENDORS } from './modelVendors.multimodal';
import { INFRA_MODEL_VENDORS } from './modelVendors.infra';
import { PLATFORM_MODEL_VENDORS } from './modelVendors.platform';

export type { ModelVendorMeta } from './modelVendorTypes';

/**
 * 常用叫得上名号的重点厂商数据字典（候选底模库）
 *
 * 数据按类别分文件维护；合并顺序即 Object.values 迭代顺序，决定启发式回退的命中优先级：
 * 1. 国际顶流基础大模型 → 2. 国内主流核心大模型 → 3. 多模态与生图、音频专精
 * → 4. 搜索与 Embedding 顶流 → 5. 核心聚合与推理部署平台。
 */
export const MODEL_VENDOR_CATALOG: Record<string, ModelVendorMeta> = {
  ...FOUNDATION_MODEL_VENDORS,
  ...DOMESTIC_MODEL_VENDORS,
  ...MULTIMODAL_MODEL_VENDORS,
  ...INFRA_MODEL_VENDORS,
  ...PLATFORM_MODEL_VENDORS,
};

/**
 * 快速查找索引表（构建时生成一次，O(1) 命中）
 */
const MATCHER_INDEX = new Map<string, ModelVendorMeta>();

// 初始化精确索引
for (const vendor of Object.values(MODEL_VENDOR_CATALOG)) {
  MATCHER_INDEX.set(vendor.id.toLowerCase(), vendor);
  for (const m of vendor.matchers) {
    MATCHER_INDEX.set(m.toLowerCase(), vendor);
  }
}

/**
 * 纯逻辑智能模型厂商解析器（零过度设计，毫秒级解析）
 *
 * @param input 输入可能是 vendorId（如 'deepseek'）、完整模型标识（如 'deepseek-ai/DeepSeek-V3'）、
 *              或带聚合前缀的路径（如 'openrouter/anthropic/claude-3-5-sonnet'）
 * @returns 匹配到的厂商元数据，若无法识别则返回 null（由调用方触发兜底组件）
 */
export function resolveModelVendor(
  input?: string | null
): ModelVendorMeta | null {
  if (!input) return null;

  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  // 1. 尝试直接精确命中（最高优先级，O(1)）
  const directHit = MATCHER_INDEX.get(raw);
  if (directHit) return directHit;

  // 2. 剥离可能存在的聚合平台/组织层级前缀（如 openrouter/anthropic/claude -> 拆分探测）
  const segments = raw.split(/[\\/]+/).filter(Boolean);

  // 倒序检查每一段（例如 deepseek-ai/DeepSeek-V3 中优先检查 DeepSeek-V3，再检查 deepseek-ai）
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg) {
      const hit = MATCHER_INDEX.get(seg);
      if (hit) return hit;
    }
  }

  // 3. 启发式前缀/包含探测（例如以 'gpt-4o', 'claude-3', 'abab6.5', 'qwen2.5' 等模式判定）
  const normalizedKey = segments[segments.length - 1] || raw;

  for (const vendor of Object.values(MODEL_VENDOR_CATALOG)) {
    for (const matcher of vendor.matchers) {
      if (matcher.length >= 3) {
        // 匹配规则：以 matcher 开头或以分隔符包围，且后接数字、分隔符或字符串结尾
        // 例如：abab6.5, gpt-4, claude-3.5, qwen2.5, llama-3
        const escaped = matcher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|[-_./])${escaped}([-_./\\d]|$)`, 'i');
        if (regex.test(normalizedKey)) {
          return vendor;
        }
      }
    }
  }

  return null;
}
