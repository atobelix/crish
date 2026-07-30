import type {
  PromptAssemblyMetadata,
  PromptAssemblyResult,
  PromptCacheBlock,
  PromptCacheStrategy,
  PromptProviderFamily,
  PromptUsageNormalization,
} from '@crish/agent-context';

export const PROVIDER_CACHE_HINT_PLAN_VERSION = 1;
export const DEFAULT_GEMINI_CONTEXT_CACHE_MIN_BYTES = 32 * 1024;

export type ProviderCacheHintIntent =
  | 'metadata-affinity'
  | 'explicit-breakpoints'
  | 'context-cache-candidate'
  | 'conservative-no-op';

export type ProviderCacheHintDecision = 'hint' | 'no-op';
export type ProviderCacheHintPlanSource = 'prompt-assembly-metadata-v1';
export type ProviderCacheStableBlockPurpose =
  'stable-prefix' | 'tool-schema' | 'anchor';

export interface ProviderCacheHintPlanOptions {
  providerFamily?: PromptProviderFamily;
  geminiContextCacheMinBytes?: number;
}

export interface ProviderCacheStableBlockHint {
  id: string;
  order: number;
  kind: PromptCacheBlock['kind'];
  hash: string;
  byteLength: number;
  role?: PromptCacheBlock['role'];
  label?: string;
}

export interface ProviderCacheMetricsDimensions {
  providerFamily: PromptProviderFamily;
  modelFamily: PromptAssemblyMetadata['modelFamily'];
  cacheStrategy: PromptCacheStrategy;
  stablePrefixHash: string;
  toolSchemaHash: string;
  cacheKey: string;
}

export interface OpenAICompatibleCacheHints {
  kind: 'openai-compatible';
  stablePromptCacheAffinityKey: string;
  requestMetadata: {
    cacheKey: string;
    stablePrefixHash: string;
    toolSchemaHash: string;
    cacheStrategy: PromptCacheStrategy;
  };
  usageNormalization: 'openai-compatible';
  serverCacheControl: 'metadata-hint-only';
}

export interface AnthropicCacheBreakpointHint {
  id: string;
  purpose: ProviderCacheStableBlockPurpose;
  afterBlockId: string;
  blockIds: string[];
  stablePrefixHash: string;
  cacheKey: string;
  priority: number;
}

export interface AnthropicStyleCacheHints {
  kind: 'anthropic-style';
  explicitBreakpoints: AnthropicCacheBreakpointHint[];
  usageNormalization: 'anthropic';
}

export interface GeminiContextCacheCandidateHint {
  id: string;
  blockIds: string[];
  stablePrefixHash: string;
  cacheKey: string;
  byteLength: number;
  minByteLength: number;
}

export interface GeminiStyleCacheHints {
  kind: 'gemini-style';
  contextCacheCandidate?: GeminiContextCacheCandidateHint;
  minByteLength: number;
  usageNormalization: 'gemini';
  reason?: 'below-min-byte-length';
}

export interface UnknownProviderCacheHints {
  kind: 'unknown';
  reason: 'unsupported-provider' | 'no-stable-blocks' | 'below-min-byte-length';
}

export type ProviderCacheFamilyHints =
  | OpenAICompatibleCacheHints
  | AnthropicStyleCacheHints
  | GeminiStyleCacheHints
  | UnknownProviderCacheHints;

export interface ProviderCacheHintPlan {
  version: typeof PROVIDER_CACHE_HINT_PLAN_VERSION;
  source: ProviderCacheHintPlanSource;
  decision: ProviderCacheHintDecision;
  intent: ProviderCacheHintIntent;
  providerFamily: PromptProviderFamily;
  modelFamily: PromptAssemblyMetadata['modelFamily'];
  cacheStrategy: PromptCacheStrategy;
  usageNormalization: PromptUsageNormalization;
  stablePrefixHash: string;
  toolSchemaHash: string;
  cacheKey: string;
  stableByteLength: number;
  stableBlocks: ProviderCacheStableBlockHint[];
  providerHints: ProviderCacheFamilyHints;
  metricsDimensions: ProviderCacheMetricsDimensions;
}

export function createProviderCacheHintPlan(
  input: PromptAssemblyMetadata | PromptAssemblyResult,
  options: ProviderCacheHintPlanOptions = {}
): ProviderCacheHintPlan {
  const metadata = isPromptAssemblyResult(input) ? input.metadata : input;
  const providerFamily = options.providerFamily ?? metadata.providerFamily;
  const stableBlocks = metadata.cacheBlocks
    .filter((block) => block.stability === 'stable')
    .sort((left, right) => left.order - right.order)
    .map(stableBlockHint);
  const stableByteLength = stableBlocks.reduce(
    (total, block) => total + block.byteLength,
    0
  );
  const metricsDimensions: ProviderCacheMetricsDimensions = {
    providerFamily,
    modelFamily: metadata.modelFamily,
    cacheStrategy: metadata.cacheStrategy,
    stablePrefixHash: metadata.stablePrefixHash,
    toolSchemaHash: metadata.toolSchemaHash,
    cacheKey: metadata.cacheKey,
  };
  const base: Omit<
    ProviderCacheHintPlan,
    'decision' | 'intent' | 'providerHints'
  > = {
    version: PROVIDER_CACHE_HINT_PLAN_VERSION,
    source: 'prompt-assembly-metadata-v1' as const,
    providerFamily,
    modelFamily: metadata.modelFamily,
    cacheStrategy: metadata.cacheStrategy,
    usageNormalization: metadata.usageNormalization,
    stablePrefixHash: metadata.stablePrefixHash,
    toolSchemaHash: metadata.toolSchemaHash,
    cacheKey: metadata.cacheKey,
    stableByteLength,
    stableBlocks,
    metricsDimensions,
  };

  if (stableBlocks.length === 0) {
    return {
      ...base,
      decision: 'no-op',
      intent: 'conservative-no-op',
      providerHints: { kind: 'unknown', reason: 'no-stable-blocks' },
    };
  }

  if (providerFamily === 'openai' || providerFamily === 'openai-compatible') {
    return {
      ...base,
      decision: 'hint',
      intent: 'metadata-affinity',
      providerHints: openAICompatibleHints(metadata),
    };
  }

  if (providerFamily === 'anthropic') {
    return {
      ...base,
      decision: 'hint',
      intent: 'explicit-breakpoints',
      providerHints: anthropicStyleHints(metadata, stableBlocks),
    };
  }

  if (providerFamily === 'gemini') {
    return geminiStylePlan(
      metadata,
      stableBlocks,
      stableByteLength,
      base,
      options.geminiContextCacheMinBytes
    );
  }

  return {
    ...base,
    decision: 'no-op',
    intent: 'conservative-no-op',
    providerHints: { kind: 'unknown', reason: 'unsupported-provider' },
  };
}

function openAICompatibleHints(
  metadata: PromptAssemblyMetadata
): OpenAICompatibleCacheHints {
  return {
    kind: 'openai-compatible',
    stablePromptCacheAffinityKey: metadata.stablePrefixHash,
    requestMetadata: {
      cacheKey: metadata.cacheKey,
      stablePrefixHash: metadata.stablePrefixHash,
      toolSchemaHash: metadata.toolSchemaHash,
      cacheStrategy: metadata.cacheStrategy,
    },
    usageNormalization: 'openai-compatible',
    serverCacheControl: 'metadata-hint-only',
  };
}

function anthropicStyleHints(
  metadata: PromptAssemblyMetadata,
  stableBlocks: ProviderCacheStableBlockHint[]
): AnthropicStyleCacheHints {
  return {
    kind: 'anthropic-style',
    explicitBreakpoints: [
      ...stablePrefixBreakpoints(metadata, stableBlocks),
      ...toolSchemaBreakpoints(metadata, stableBlocks),
      ...anchorBreakpoints(metadata, stableBlocks),
    ],
    usageNormalization: 'anthropic',
  };
}

function stablePrefixBreakpoints(
  metadata: PromptAssemblyMetadata,
  stableBlocks: ProviderCacheStableBlockHint[]
): AnthropicCacheBreakpointHint[] {
  const lastStableBlock = stableBlocks.at(-1);
  if (!lastStableBlock) return [];
  return [
    {
      id: `stable-prefix:${metadata.stablePrefixHash.slice(0, 16)}`,
      purpose: 'stable-prefix',
      afterBlockId: lastStableBlock.id,
      blockIds: stableBlocks.map((block) => block.id),
      stablePrefixHash: metadata.stablePrefixHash,
      cacheKey: metadata.cacheKey,
      priority: 100,
    },
  ];
}

function toolSchemaBreakpoints(
  metadata: PromptAssemblyMetadata,
  stableBlocks: ProviderCacheStableBlockHint[]
): AnthropicCacheBreakpointHint[] {
  const toolSchemaBlock = stableBlocks.find(
    (block) => block.kind === 'tool-schemas'
  );
  if (!toolSchemaBlock) return [];
  return [
    {
      id: `tool-schema:${metadata.toolSchemaHash.slice(0, 16)}`,
      purpose: 'tool-schema',
      afterBlockId: toolSchemaBlock.id,
      blockIds: stableBlocks
        .filter((block) => block.order <= toolSchemaBlock.order)
        .map((block) => block.id),
      stablePrefixHash: metadata.stablePrefixHash,
      cacheKey: metadata.cacheKey,
      priority: 90,
    },
  ];
}

function anchorBreakpoints(
  metadata: PromptAssemblyMetadata,
  stableBlocks: ProviderCacheStableBlockHint[]
): AnthropicCacheBreakpointHint[] {
  const stableBlockIds = new Set(stableBlocks.map((block) => block.id));
  return metadata.cacheCandidates
    .filter(
      (candidate) =>
        candidate.anchorBlockId && stableBlockIds.has(candidate.anchorBlockId)
    )
    .sort(
      (left, right) =>
        right.priority - left.priority || left.id.localeCompare(right.id)
    )
    .slice(0, 1)
    .map((candidate) => ({
      id: `anchor:${candidate.id}`,
      purpose: 'anchor',
      afterBlockId: candidate.anchorBlockId!,
      blockIds: candidate.blockIds.filter((id) => stableBlockIds.has(id)),
      stablePrefixHash: candidate.stablePrefixHash,
      cacheKey: candidate.cacheKey,
      priority: candidate.priority,
    }));
}

function geminiStylePlan(
  metadata: PromptAssemblyMetadata,
  stableBlocks: ProviderCacheStableBlockHint[],
  stableByteLength: number,
  base: Omit<ProviderCacheHintPlan, 'decision' | 'intent' | 'providerHints'>,
  minByteLengthInput: number | undefined
): ProviderCacheHintPlan {
  const minByteLength = normalizeMinByteLength(minByteLengthInput);
  if (stableByteLength < minByteLength) {
    return {
      ...base,
      decision: 'no-op',
      intent: 'conservative-no-op',
      providerHints: {
        kind: 'gemini-style',
        minByteLength,
        usageNormalization: 'gemini',
        reason: 'below-min-byte-length',
      },
    };
  }

  return {
    ...base,
    decision: 'hint',
    intent: 'context-cache-candidate',
    providerHints: {
      kind: 'gemini-style',
      contextCacheCandidate: {
        id: `context-cache:${metadata.stablePrefixHash.slice(0, 16)}`,
        blockIds: stableBlocks.map((block) => block.id),
        stablePrefixHash: metadata.stablePrefixHash,
        cacheKey: metadata.cacheKey,
        byteLength: stableByteLength,
        minByteLength,
      },
      minByteLength,
      usageNormalization: 'gemini',
    },
  };
}

function stableBlockHint(
  block: PromptCacheBlock
): ProviderCacheStableBlockHint {
  return compactObject({
    id: block.id,
    order: block.order,
    kind: block.kind,
    hash: block.hash,
    byteLength: block.byteLength,
    role: block.role,
    label: block.label,
  }) as unknown as ProviderCacheStableBlockHint;
}

function normalizeMinByteLength(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_GEMINI_CONTEXT_CACHE_MIN_BYTES;
}

function isPromptAssemblyResult(
  input: PromptAssemblyMetadata | PromptAssemblyResult
): input is PromptAssemblyResult {
  return 'metadata' in input && Boolean(input.metadata);
}

function compactObject(
  input: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}
