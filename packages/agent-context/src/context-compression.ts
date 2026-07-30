export {
  TOKEN_ESTIMATE_SAFETY_FACTOR,
  IMAGE_TOKEN_COST,
  applyTokenEstimateSafetyFactor,
  estimateContextTokens,
  estimateMediaTokensFromMessages,
  estimateMediaTokensFromMessageParts,
  countMessageImages,
  estimateMessageTokens,
} from './context-compression/token-estimator';
export type {
  ContextTokenEstimate,
  ContextTokenEstimateOptions,
} from './context-compression/token-estimator';

export {
  buildFileOpsXml,
  serializeMessagesForSummary,
  createCompressionSummaryMessage,
} from './context-compression/serializer';
export type { SerializeContextOptions } from './context-compression/serializer';

export {
  ContextCompressor,
  findFirstKeptMessageIndex,
  extractRecentTerminalCommandFacts,
  safeCompactionCutoff,
} from './context-compression/index';
export type {
  CompressionHistoryEntry,
  ContextCompressionResult,
  ContextCompressionDecision,
} from './context-compression/index';
