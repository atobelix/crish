/**
 * modelsNormalize.ts —— 协议 / 思考方言归一化唯一入口（SSOT）
 *
 * 运行协议只接受规范名；思考档位只在读边界归一，错误必须显式返回。
 * 协议字面量与显示名只在本文件定义（PROTOCOLS / PROTOCOL_LABELS / DEFAULT_PROTOCOL），
 * 其余文件一律从此派生。依赖方向恒为 types → normalize：本文件不得反向引用类型模块
 * （否则成环），故思考方言类型（ThinkingWireFormat）定义在此，由类型模块反向 re-export。
 */

/** 协议唯一枚举源。所有下拉、模板、默认值、归一化都从此派生。 */
export const PROTOCOLS = [
  'openai/chat',
  'openai/responses',
  'anthropic/messages',
  'google/generate-content',
] as const;

export type ModelProtocol = (typeof PROTOCOLS)[number];

/** 协议显示名。禁止各组件自行写显示文案。 */
export const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  'openai/chat': 'OpenAI Chat (/v1/chat/completions)',
  'openai/responses': 'OpenAI Responses (/responses)',
  'anthropic/messages': 'Anthropic Messages (/v1/messages)',
  'google/generate-content': 'Google GenerateContent (/v1beta/models)',
};

/** 未指定时的默认协议 */
export const DEFAULT_PROTOCOL: ModelProtocol = 'openai/chat';

/**
 * 思考推理协议 Wire 方言枚举。
 * 内核序列化名：gemini / qwen（以及 openai / deepseek / anthropic / zai）。
 * 运行时只接受内核声明的六种格式。
 */
export type ThinkingWireFormat =
  | 'openai' // reasoning_effort: "low" | "medium" | "high"
  | 'qwen' // enable_thinking: true | false
  | 'deepseek' // thinking: { type: "enabled" | "disabled" }
  | 'anthropic' // thinking: { type: "enabled", budget_tokens: number }
  | 'gemini' // thinkingConfig: { thinkingLevel: "HIGH" | ... }
  | 'zai'; // thinking: { type: "enable" }

/** 运行时与写出允许的规范协议集合（不含只读边界旧名 google/interactions） */
export const CANONICAL_PROTOCOLS: ReadonlySet<string> = new Set(PROTOCOLS);

/** 运行时与写出允许的思考方言集合（不含 google / qwen_enable_thinking 旧名） */
export const CANONICAL_THINKING_FORMATS: ReadonlySet<string> = new Set([
  'openai',
  'qwen',
  'deepseek',
  'anthropic',
  'gemini',
  'zai',
]);

/** 协议由显式升级边界转换；运行时只接受规范协议。 */
export function normalizeProtocol(raw: unknown): ModelProtocol | undefined {
  return typeof raw === 'string' && CANONICAL_PROTOCOLS.has(raw)
    ? (raw as ModelProtocol)
    : undefined;
}

/** 只识别内核规范思考格式，未知值必须由调用方报告。 */
export function normalizeThinkingFormat(
  raw: unknown
): ThinkingWireFormat | undefined {
  if (typeof raw === 'string' && CANONICAL_THINKING_FORMATS.has(raw)) {
    return raw as ThinkingWireFormat;
  }
  return undefined;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 思考档位词表镜像（前端唯一一处）
 *
 * 真源 = 内核 `ReasoningEffort`（crates/agent-provider/src/request/vendor/dialect.rs），
 * 由 scripts/check-thinking-vocabulary-ssot.mjs 守护，禁止手改顺序。
 * 顺序即强度序：Off < Minimal < Low < Medium < High < XHigh < Max。
 * 词表本体封闭（plans/09 §2.2）：新增档位须同时改内核枚举 / from_title_case /
 * to_title_case / 强度刻度 / 本镜像，五处一致；不允许只改 yaml 或只改前端。
 * 用户可配置的只有每模型 `thinking` map（支持哪些档 + 每档 wire 值），非词表本体。
 * ───────────────────────────────────────────────────────────────────────── */

/** 规范拼写（按强度序）。镜像内核 `ReasoningEffort`，禁止手改顺序。 */
export const THINKING_VOCABULARY = [
  'Off',
  'Minimal',
  'Low',
  'Medium',
  'High',
  'XHigh',
  'Max',
] as const;

export type ThinkingVocabularyLevel = (typeof THINKING_VOCABULARY)[number];

/** 档位中文标签（关闭/极低/低/中/高/极高/最大）。 */
export const THINKING_VOCABULARY_LABELS: Record<
  ThinkingVocabularyLevel,
  string
> = {
  Off: '关闭',
  Minimal: '极低',
  Low: '低',
  Medium: '中',
  High: '高',
  XHigh: '极高',
  Max: '最大',
};

/**
 * 档位键别名接受集 —— 等价于内核 `from_title_case`，由门禁守护。
 * 键 = 读边界接受拼写（含大小写变体 / None / Disabled / X-High），值 = 规范档位。
 * 归一只在此处发生，禁止散落到调用方。
 */
const THINKING_KEY_ALIASES: Readonly<Record<string, ThinkingVocabularyLevel>> =
  {
    Off: 'Off',
    off: 'Off',
    None: 'Off',
    none: 'Off',
    Disabled: 'Off',
    disabled: 'Off',
    Minimal: 'Minimal',
    minimal: 'Minimal',
    Low: 'Low',
    low: 'Low',
    Medium: 'Medium',
    medium: 'Medium',
    High: 'High',
    high: 'High',
    XHigh: 'XHigh',
    xhigh: 'XHigh',
    'X-High': 'XHigh',
    'x-high': 'XHigh',
    Max: 'Max',
    max: 'Max',
  };

/**
 * 档位键 → 规范档位（首尾 trim + 别名归一）。
 * 等价于内核 `from_title_case`，由 scripts/check-thinking-vocabulary-ssot.mjs 守护。
 * 词表外 → undefined（不静默透传）。
 */
export function normalizeThinkingKey(
  raw: unknown
): ThinkingVocabularyLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim();
  return Object.hasOwn(THINKING_KEY_ALIASES, key)
    ? THINKING_KEY_ALIASES[key]
    : undefined;
}

/** 档位键的中文标签；词表外键原样返回其键名（不伪造成词表档位）。 */
export function thinkingKeyLabel(raw: string): string {
  const canonical = normalizeThinkingKey(raw);
  return canonical ? THINKING_VOCABULARY_LABELS[canonical] : raw;
}

/** 词表外键（经别名归一后仍不属词表）列表；保持 map 插入序，不得静默丢弃。 */
export function findUnsupportedThinkingKeys(
  map: Record<string, string> | null | undefined
): string[] {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.keys(map).filter(
    (key) => normalizeThinkingKey(key) === undefined
  );
}

/**
 * 词表外键显式诊断（配置界面第一防线，plans/09 §4.1）。
 * 无词表外键 → null；否则返回可直接展示的提示文案。
 * 例：`档位键 "Xhigh" 不受支持，可用集合：Off / Minimal / Low / Medium / High / XHigh / Max`
 */
export function thinkingVocabularyDiagnostic(
  map: Record<string, string> | null | undefined
): string | null {
  try {
    normalizeThinkingMap(map);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 读边界归一档位；重复、未知档或空 wire 显式拒绝，合法 wire 原文不改写。 */
export function normalizeThinkingMap(
  raw: unknown
): Partial<Record<ThinkingVocabularyLevel, string>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('思考配置必须是档位到参数值的对象');
  }
  const result: Partial<Record<ThinkingVocabularyLevel, string>> = {};
  for (const [key, wire] of Object.entries(raw)) {
    const canonical = normalizeThinkingKey(key);
    if (!canonical) {
      throw new Error(
        `档位键 "${key}" 不受支持，可用集合：${THINKING_VOCABULARY.join(' / ')}`
      );
    }
    if (Object.hasOwn(result, canonical)) {
      throw new Error(`思考档位重复：${canonical}`);
    }
    if (typeof wire !== 'string' || !wire.trim()) {
      throw new Error(`思考档位 ${canonical} 的参数值不能为空`);
    }
    result[canonical] = wire;
  }
  return result;
}

/** 凭据仅接受显式环境变量或独立的不透明系统凭据槽。 */
export function isCredentialReference(raw: string): boolean {
  return /^(?:env:[A-Za-z_][A-Za-z0-9_]*|dpapi:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(
    raw
  );
}
