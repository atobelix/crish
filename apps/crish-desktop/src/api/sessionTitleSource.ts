/**
 * 自动标题原料：平凡首句跳过，再落到有信息量的用户消息或助手首句。
 * 不写存储、不编号。真正截断与清洗仍走 sessionTitle.deriveSessionTitle。
 */
import { hasVisibleContent } from './sessionTitle-invisible';

/** 整句等于这些词才算平凡（大小写不敏感）。更长的句子不算。 */
const TRIVIAL_TITLE_KEYS = new Set([
  '你好',
  '你好啊',
  'hi',
  'hello',
  '在吗',
  'test',
]);

export type AutoTitleOrigin = 'auto' | 'auto-trivial';

/** 落盘标题来源。缺字段的旧会话按 auto 读，不在迁移时回写。 */
export type SessionTitleSource = AutoTitleOrigin | 'user';

export function parseSessionTitleSource(
  raw: unknown
): SessionTitleSource | undefined {
  if (raw === 'auto' || raw === 'auto-trivial' || raw === 'user') return raw;
  return undefined;
}

/** 旧索引没有 titleSource 时视为 auto。 */
export function effectiveTitleSource(
  raw: SessionTitleSource | null | undefined
): SessionTitleSource {
  return raw === 'user' || raw === 'auto-trivial' || raw === 'auto' ? raw : 'auto';
}

type TitleSourceMessage = {
  sender?: string | undefined;
  text?: string | undefined;
};

/** 第一句：以句号 / 叹号 / 问号 / 换行切开，不含分隔符本身。 */
export function firstTitleSentence(text: string | null | undefined): string {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/^[^。！？!?\n\r]+/u);
  const head = (match?.[0] ?? trimmed).trim();
  return head || trimmed;
}

function trivialKey(sentence: string): string {
  return sentence
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '')
    .replace(/[。！？.!?…‥]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 只在「整句就是平凡问候」时成立。
 * 「你好，帮我看登录」或「hello world」不是平凡源。
 * 同一条消息在平凡首句之后还有正文时，整条不算平凡。
 */
export function isTrivialTitleSource(text: string | null | undefined): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const sentence = firstTitleSentence(raw);
  const key = trivialKey(sentence);
  if (!key || !TRIVIAL_TITLE_KEYS.has(key)) return false;
  const rest = raw
    .slice(sentence.length)
    .replace(/^[。！？!?\n\r.\s]+/u, '');
  return trivialKey(rest) === '';
}

function isSlashOnly(text: string): boolean {
  return /^(?:\/\S+[ \t]*)+$/.test(text.trim());
}

function visibleText(text: string | undefined): string {
  const t = (text || '').trim();
  if (!t || !hasVisibleContent(t)) return '';
  return t;
}

/**
 * 自动标题用的原文。
 * 跳过平凡用户句，用下一条有信息量的用户消息；
 * 都没有则用助手首句；再没有就保留那句平凡原文。
 */
export function pickAutoTitle(
  messages: readonly TitleSourceMessage[] | null | undefined
): { text: string; origin: AutoTitleOrigin } | null {
  if (!messages?.length) return null;
  let trivial = '';
  for (const m of messages) {
    if (!m || m.sender !== 'user') continue;
    const text = visibleText(m.text);
    if (!text || isSlashOnly(text)) continue;
    if (isTrivialTitleSource(text)) {
      if (!trivial) trivial = text;
      continue;
    }
    return { text, origin: 'auto' };
  }
  for (const m of messages) {
    if (!m || m.sender !== 'assistant') continue;
    const text = visibleText(m.text);
    if (!text) continue;
    const sentence = firstTitleSentence(text);
    if (!sentence || !hasVisibleContent(sentence)) continue;
    return {
      text: sentence,
      origin: isTrivialTitleSource(sentence) ? 'auto-trivial' : 'auto',
    };
  }
  if (!trivial) return null;
  return { text: trivial, origin: 'auto-trivial' };
}

export function pickAutoTitleText(
  messages: readonly TitleSourceMessage[] | null | undefined
): string {
  return pickAutoTitle(messages)?.text ?? '';
}
