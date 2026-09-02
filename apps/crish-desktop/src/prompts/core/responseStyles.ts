/**
 * L0 响应风格规范资产（收拢原 streamSession.ts 中 STYLE_DESCS 的定义）。
 *
 * 风格 key 与设置系统 responseStyle 枚举完全同构（wire 值）：
 * minimal / low / medium / high。getResponseStyleDescription 为调用方提供的
 * 便捷单行文案获取；默认中文，兼顾低层纯函数无依赖约束。
 */
import { createPromptTemplate } from '../compiler/interpolate';
import type {
  PromptLocale,
  PromptTemplate,
  ResponseStyleLevel,
} from '../types';

export type ResponseStyleParams = {
  style: ResponseStyleLevel;
  /**
   * 渲染进模板的风格描述文案（与 style 对应，由上层用
   * getResponseStyleDescription 取对应 locale 文案后传入；缺省渲染时回退空串并告警）。
   */
  styleDescription?: string;
};

export const RESPONSE_STYLE_GUIDANCE_MAP: Record<
  PromptLocale,
  Record<ResponseStyleLevel, string>
> = {
  'zh-CN': {
    minimal:
      '回复风格：极简。仅给出最短正确答案，省略问候语、不必要的列表与问题重述。',
    low: '回复风格：简洁。保持回答简明扼要；仅在能提升清晰度时使用要点列表，不主动展开超长背景。',
    medium:
      '回复风格：适中。表达清晰、逻辑完整且无冗余赘述；对非显而易见的步骤做简要说明。',
    high: '回复风格：深入。提供结构化的推演分析、边界条件及完备的验证步骤，内容充实详尽。',
  },
  'en-US': {
    minimal:
      'Response style: minimal. Prefer the shortest correct answer. Avoid preambles, lists, and restating the question.',
    low: 'Response style: concise. Keep answers short; use bullets only when they improve clarity. Skip lengthy explanations unless asked.',
    medium:
      'Response style: balanced. Be clear and complete without padding. Explain non-obvious steps briefly.',
    high: 'Response style: thorough. Provide structured reasoning, edge cases, and verification steps when useful. Still stay on-topic.',
  },
};

export const RESPONSE_STYLE_PROMPT: PromptTemplate<ResponseStyleParams> =
  createPromptTemplate(
    {
      id: 'core-response-style',
      name: '响应风格规范',
      description: '调控模型回复的详略程度与表达密度',
      layer: 'core',
      version: '1.0.0',
      defaultLocale: 'zh-CN',
      tags: ['style', 'formatting'],
      defaultParams: {
        style: 'medium',
      },
    },
    {
      'zh-CN': '[回复风格规范]\n{{styleDescription}}',
      'en-US': '[Response Style Directive]\n{{styleDescription}}',
    }
  );

/**
 * 便捷获取单行风格描述（英文文案需在 styleDescription 插值时选用对应模板层）。
 * 中文风格名由上层 normalizeResponseStyle 归一，本函数只接受 wire 枚举字面量。
 */
export function getResponseStyleDescription(
  style: ResponseStyleLevel,
  locale: PromptLocale = 'zh-CN'
): string {
  return (
    RESPONSE_STYLE_GUIDANCE_MAP[locale]?.[style] ||
    RESPONSE_STYLE_GUIDANCE_MAP['zh-CN'].medium
  );
}

/** 中文风格标签 → wire 档位（迁移自 streamSession.ts STYLE_ZH_MAP，语义原样保留） */
const STYLE_LABEL_TO_LEVEL: Readonly<Record<string, ResponseStyleLevel>> = {
  极简: 'minimal',
  简洁: 'low',
  适中: 'medium',
  深入: 'high',
};

const WIRE_LEVELS: readonly ResponseStyleLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
];

/**
 * 任意设置值 → wire 风格档位（等价原 streamSession 的
 * `STYLE_ZH_MAP[rawStyle] || rawStyle.toLowerCase()` + `?? medium` 兜底）：
 * 中文标签 / wire 枚举 / 小写 wire 枚举均可命中，未知值回退 'medium'。
 */
export function resolveResponseStyle(raw: unknown): ResponseStyleLevel {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const exact = WIRE_LEVELS.find((s) => s === trimmed);
    if (exact) return exact;
    const fromLabel = STYLE_LABEL_TO_LEVEL[trimmed];
    if (fromLabel) return fromLabel;
    const lower = WIRE_LEVELS.find((s) => s === trimmed.toLowerCase());
    if (lower) return lower;
  }
  return 'medium';
}
