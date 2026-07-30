/**
 * Map product responseStyle settings → system prompt guidance.
 * Consumed by desktop → run-task systemPrompt / metadata.systemPrompt.
 */

export type ResponseStyleLevel = 'minimal' | 'low' | 'medium' | 'high';

const STYLE_GUIDANCE: Record<ResponseStyleLevel, string> = {
  minimal:
    'Response style: minimal. Prefer the shortest correct answer. Avoid preambles, lists, and restating the question.',
  low: 'Response style: concise. Keep answers short; use bullets only when they improve clarity. Skip lengthy explanations unless asked.',
  medium:
    'Response style: balanced. Be clear and complete without padding. Explain non-obvious steps briefly.',
  high: 'Response style: thorough. Provide structured reasoning, edge cases, and verification steps when useful. Still stay on-topic.',
};

export function normalizeResponseStyleLevel(
  value: unknown
): ResponseStyleLevel {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  if (s === 'minimal' || s === 'low' || s === 'medium' || s === 'high')
    return s;
  // Chinese labels from settings
  if (s === '极简' || s === '最简') return 'minimal';
  if (s === '简洁' || s === '简短') return 'low';
  if (s === '适中' || s === '标准') return 'medium';
  if (s === '深入' || s === '详细') return 'high';
  return 'medium';
}

/** Build a stable system-prompt fragment for the given style. */
export function responseStyleSystemGuidance(style: unknown): string {
  const level = normalizeResponseStyleLevel(style);
  return STYLE_GUIDANCE[level];
}

/** Merge optional base system prompt with response-style guidance. */
export function mergeSystemPromptWithResponseStyle(
  base: string | undefined,
  style: unknown
): string {
  const guidance = responseStyleSystemGuidance(style);
  const trimmed = (base ?? '').trim();
  if (!trimmed) return guidance;
  if (trimmed.includes('Response style:')) return trimmed;
  return `${trimmed}\n\n${guidance}`;
}
