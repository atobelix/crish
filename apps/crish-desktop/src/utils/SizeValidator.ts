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

const utf8Encoder = new TextEncoder();
const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const TRUNCATION_SUFFIX_BYTES = utf8Encoder.encode(TRUNCATION_SUFFIX).length;

/**
 * 将字符串按 UTF-8 字节长度截断，在完整的 grapheme cluster 边界处切割，
 * 并追加截断标记。
 *
 * @param text 原始文本
 * @param maxBytes 允许的最大字节数（含截断后缀）
 * @returns 截断后的字符串
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const bytes = utf8Encoder.encode(text);

  if (bytes.length <= maxBytes) {
    return text;
  }

  const availableBytes = maxBytes - TRUNCATION_SUFFIX_BYTES;

  if (availableBytes <= 0) {
    return TRUNCATION_SUFFIX;
  }

  // NaN 上限：任何比较均为 false，历史语义是「不截断 + 追加后缀」（见
  // SizeValidator.adversarial SV1），这里显式保留，不让 NaN 流入 Uint8Array。
  if (Number.isNaN(availableBytes)) {
    return text + TRUNCATION_SUFFIX;
  }

  // 1) encodeInto 一次求出「UTF-8 字节数 ≤ availableBytes 的最长码点前缀」，
  //    不会切开代理对（read = 已消费的 UTF-16 码元数）。
  // 2) Segmenter.containing 只在切点处回退到所在 grapheme cluster 的起点，
  //    保证不切开 ZWJ 序列 / 国旗 / 组合字符。
  // 结果与「逐 grapheme 累加字节直到超限」完全一致；但旧实现逐段迭代
  // Intl.Segmenter 并逐段 encode，在 Node 20 的 ICU 上对 100KB 级文本呈超线性
  // （实测 200KB 同步阻塞 50–200s），会卡死 vitest worker 并触发 birpc
  // 「Timeout calling onTaskUpdate」。现在是一次编码 + 单点定位。
  const { read } = utf8Encoder.encodeInto(
    text,
    new Uint8Array(Math.floor(availableBytes))
  );
  const cluster = graphemeSegmenter.segment(text).containing(read);
  const cut = cluster && cluster.index < read ? cluster.index : read;

  return text.slice(0, cut) + TRUNCATION_SUFFIX;
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
    result.arguments = truncateToBytes(
      result.arguments,
      SIZE_LIMITS.toolCallArguments
    );
  }

  return result;
}
