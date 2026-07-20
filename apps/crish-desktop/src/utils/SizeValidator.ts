/**
 * 消息内容尺寸校验与截断工具。
 *
 * 使用 TextEncoder 按 UTF-8 字节长度截断，保证在完整 grapheme cluster 边界切割。
 */

import type { SessionMessage, MessageToolCall } from '../store/types';

/** 各字段字节上限常量 */
export const SIZE_LIMITS = {
  text: 100 * 1024,
  thinking: 50 * 1024,
  toolCallOutput: 200 * 1024,
  toolCallArguments: 50 * 1024,
} as const;

/** 截断后缀 */
const TRUNCATION_SUFFIX = '...[截断]';

/**
 * 将字符串按 UTF-8 字节长度截断，在完整的 grapheme cluster 边界处切割，
 * 并追加截断标记。
 *
 * @param text 原始文本
 * @param maxBytes 允许的最大字节数（含截断后缀）
 * @returns 截断后的字符串
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);

  if (bytes.length <= maxBytes) {
    return text;
  }

  const suffixBytes = encoder.encode(TRUNCATION_SUFFIX).length;
  const availableBytes = maxBytes - suffixBytes;

  if (availableBytes <= 0) {
    return TRUNCATION_SUFFIX;
  }

  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const segments = segmenter.segment(text);

  let accumulatedBytes = 0;
  let result = '';

  for (const { segment } of segments) {
    const segBytes = encoder.encode(segment).length;
    if (accumulatedBytes + segBytes > availableBytes) {
      break;
    }
    accumulatedBytes += segBytes;
    result += segment;
  }

  return result + TRUNCATION_SUFFIX;
}

/**
 * 对消息各文本字段进行尺寸校验与截断。
 *
 * 各字段上限：
 * - text            → 100 KB
 * - thinking        → 50 KB
 * - toolCall.output → 200 KB
 * - toolCall.args   → 50 KB
 *
 * @param msg 原消息（不会被修改）
 * @returns 截断后的新消息对象
 */
export function validateMessageSize(msg: SessionMessage): SessionMessage {
  const result: SessionMessage = { ...msg };

  if (result.text != null) {
    result.text = truncateToBytes(result.text, SIZE_LIMITS.text);
  }
  if (result.thinking != null) {
    result.thinking = truncateToBytes(result.thinking, SIZE_LIMITS.thinking);
  }
  if (result.toolCalls != null) {
    result.toolCalls = result.toolCalls.map(truncateToolCall);
  }

  return result;
}

function truncateToolCall(tc: MessageToolCall): MessageToolCall {
  const result: MessageToolCall = { ...tc };

  if (result.output != null) {
    result.output = truncateToBytes(result.output, SIZE_LIMITS.toolCallOutput);
  }
  if (result.arguments) {
    result.arguments = truncateToBytes(result.arguments, SIZE_LIMITS.toolCallArguments);
  }

  return result;
}
