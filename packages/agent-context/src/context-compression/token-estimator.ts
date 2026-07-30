import type {
  AgentMessage,
  AgentMessageBlock,
  ImageContent,
  ProviderUsage,
} from '@crish/shared-types';
import { stringifyToolOutput } from '../tool-output-budget';

export const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.15;
export const IMAGE_TOKEN_COST = 1600;

export function applyTokenEstimateSafetyFactor(
  estimatedTokens: number
): number {
  return Math.ceil(estimatedTokens * TOKEN_ESTIMATE_SAFETY_FACTOR);
}

export interface ContextTokenEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageMessageIndex: number | null;
}

export interface ContextTokenEstimateOptions {
  systemPrompt?: string;
  tools?: unknown[];
  rules?: string[];
}

export function estimateContextTokens(
  messages: AgentMessage[],
  options?: ContextTokenEstimateOptions
): ContextTokenEstimate {
  let staticOverheadTokens = 0;
  if (options?.systemPrompt) {
    staticOverheadTokens += Math.ceil(options.systemPrompt.length / 4);
  }
  if (options?.tools && options.tools.length > 0) {
    try {
      staticOverheadTokens += Math.ceil(
        JSON.stringify(options.tools).length / 4
      );
    } catch {
      staticOverheadTokens += options.tools.length * 150;
    }
  }
  if (options?.rules && options.rules.length > 0) {
    for (const rule of options.rules) {
      staticOverheadTokens += Math.ceil(rule.length / 4);
    }
  }

  const latestCompressionSummary = findLatestCompressionSummary(messages);
  let usageInfo: { usage: ProviderUsage; index: number } | undefined;
  for (
    let index = messages.length - 1;
    index > latestCompressionSummary.index;
    index--
  ) {
    const message = messages[index]!;
    if (
      latestCompressionSummary.createdAtMs !== undefined &&
      messageCreatedAtMs(message) <= latestCompressionSummary.createdAtMs
    ) {
      continue;
    }
    const usage = providerUsageFromMessage(message);
    if (usage?.totalTokens !== undefined) {
      usageInfo = { usage, index };
      break;
    }
  }

  if (!usageInfo) {
    let tokens = staticOverheadTokens;
    for (let i = 0; i < messages.length; i++)
      tokens += estimateMessageTokens(messages[i]!);
    return {
      tokens,
      usageTokens: staticOverheadTokens,
      trailingTokens: tokens - staticOverheadTokens,
      lastUsageMessageIndex: null,
    };
  }

  const usageTokens = (usageInfo.usage.totalTokens ?? 0) + staticOverheadTokens;
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++)
    trailingTokens += estimateMessageTokens(messages[i]!);
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageMessageIndex: usageInfo.index,
  };
}

function findLatestCompressionSummary(messages: AgentMessage[]): {
  index: number;
  createdAtMs?: number;
} {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.metadata?.kind === 'context-compression-summary') {
      return { index, createdAtMs: messageCreatedAtMs(messages[index]!) };
    }
  }
  return { index: -1 };
}

const messageTokenCache = new WeakMap<AgentMessage, number>();
const blockCharCache = new WeakMap<object, number>();

/**
 * 估算图片 token 消耗（参考 OpenAI 官方计费公式）。
 *
 * 内联自 agent-runtime/src/media/media-preprocessor.ts 的 estimateImageTokens 逻辑。
 * agent-context 仅需图片 token 估算，无需完整 MediaPreprocessor 类（该类依赖
 * media-cache 等运行时设施）。低细节模式 85 tokens，高细节模式按 tile 计算。
 */
function estimateImageTokens(image: ImageContent): number {
  if ('detail' in image && image.detail === 'low') return 85;
  const w = image.width ?? 1024;
  const h = image.height ?? 1024;
  const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
  return tiles * 170 + 85;
}

export function estimateMediaTokensFromMessages(
  messages: AgentMessage[]
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMediaTokensFromMessageParts(message);
  }
  return total;
}

export function estimateMediaTokensFromMessageParts(
  message: AgentMessage
): number {
  const meta = message.metadata ?? {};
  const parts = meta.contentParts;
  if (!Array.isArray(parts) || parts.length === 0) return 0;

  let total = 0;

  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const p = part as Record<string, unknown>;

    if (p.type === 'image_url') {
      const url = typeof p.url === 'string' ? p.url : '';
      const detail =
        typeof p.detail === 'string'
          ? (p.detail as 'low' | 'high' | 'auto')
          : undefined;
      const width = typeof p.width === 'number' ? p.width : undefined;
      const height = typeof p.height === 'number' ? p.height : undefined;
      const imageContent: ImageContent = {
        type: 'image',
        mimeType: 'image/jpeg',
        source: url.startsWith('data:') ? 'base64' : 'url',
        data: url,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(detail !== undefined ? { detail } : {}),
        sizeBytes: 0,
      };
      total += estimateImageTokens(imageContent);
    }
  }

  return total;
}

export function countMessageImages(message: AgentMessage): number {
  const meta = message.metadata ?? {};
  const parts = meta.contentParts;
  let n = 0;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const p = part as Record<string, unknown>;
      if (p.type === 'image_url') n += 1;
      else if (typeof p.url === 'string' && p.url.startsWith('data:image'))
        n += 1;
    }
  }
  if (n === 0 && meta.hasImages === true) return 1;
  return n;
}

export function estimateMessageTokens(message: AgentMessage): number {
  if (messageTokenCache.has(message)) {
    return messageTokenCache.get(message)!;
  }
  const chars = message.blocks.reduce(
    (sum, block) => sum + estimateBlockChars(block),
    0
  );
  const textTokens = Math.ceil(chars / 4);
  const mediaTokens = estimateMediaTokensFromMessageParts(message);
  const imageTokens =
    mediaTokens > 0 ? 0 : countMessageImages(message) * IMAGE_TOKEN_COST;
  const tokens = textTokens + mediaTokens + imageTokens;
  messageTokenCache.set(message, tokens);
  return tokens;
}

function estimateBlockChars(block: AgentMessageBlock): number {
  if (blockCharCache.has(block)) {
    return blockCharCache.get(block)!;
  }
  let size = 0;
  if (block.type === 'text' || block.type === 'thought') {
    size = block.text.length;
  } else if (block.type === 'tool-call') {
    size = block.toolName.length + JSON.stringify(block.input).length;
  } else {
    size = block.toolName.length + stringifyToolOutput(block.output).length;
  }
  blockCharCache.set(block, size);
  return size;
}

function messageCreatedAtMs(message: AgentMessage): number {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function providerUsageFromMessage(
  message: AgentMessage
): ProviderUsage | undefined {
  const usage = message.metadata?.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage))
    return undefined;
  const record = usage as Record<string, unknown>;
  const totalTokens = numberField(record.totalTokens);
  if (totalTokens === undefined) return undefined;
  const promptTokens = numberField(record.promptTokens);
  const completionTokens = numberField(record.completionTokens);
  const cacheReadTokens = numberField(record.cacheReadTokens);
  const cacheWriteTokens = numberField(record.cacheWriteTokens);
  const reasoningTokens = numberField(record.reasoningTokens);
  return {
    totalTokens,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
