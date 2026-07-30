import { Buffer } from 'node:buffer';
import type {
  AgentMessage,
  AgentMessageBlock,
  AgentTool,
  JsonObject,
  JsonValue,
  ToolMode,
  ToolOutput,
} from '@crish/shared-types';

// AgentRole is derived from AgentMessage["role"] which is already in shared-types
type AgentRole = AgentMessage['role'];

// ─── ToolPresetRegistry（从 agent-runtime/src/tools/tool-preset-registry.ts 内联） ───
//
// agent-context 是 Layer 2 leaf，ToolPresetRegistry 是纯数据 + 无状态过滤逻辑，
// 内联于此避免跨层引用 agent-runtime。agent-runtime 的同名文件可 re-export 此实现。

interface ToolPreset {
  toolIds: string[];
  autoApproved: string[];
  categoryFilter?: import('@crish/shared-types').ToolCategory[];
}

const DEFAULT_PRESETS: Record<ToolMode, ToolPreset> = {
  plan: {
    toolIds: ['read_files', 'search_codebase', 'glob', 'grep', 'list_files'],
    autoApproved: [
      'read_files',
      'search_codebase',
      'glob',
      'grep',
      'list_files',
    ],
    categoryFilter: ['filesystem'],
  },
  ask: {
    toolIds: [],
    autoApproved: [
      'read_files',
      'search_codebase',
      'glob',
      'grep',
      'list_files',
    ],
  },
  auto: {
    toolIds: [],
    autoApproved: ['*'],
  },
  'full-access': {
    toolIds: [],
    autoApproved: ['*'],
  },
  unattended: {
    toolIds: [],
    autoApproved: ['*'],
  },
};

class ToolPresetRegistry {
  private static presets: Record<string, ToolPreset> = { ...DEFAULT_PRESETS };

  static getPreset(mode: ToolMode): ToolPreset {
    return this.presets[mode] ?? this.presets['full-access']!;
  }

  static registerPreset(name: string, preset: ToolPreset): void {
    this.presets[name] = preset;
  }

  static filterTools(tools: AgentTool[], mode: ToolMode): AgentTool[] {
    const preset = ToolPresetRegistry.getPreset(mode);
    if (preset.toolIds.length > 0) {
      return tools.filter((t) => preset.toolIds.includes(t.name));
    }
    if (preset.categoryFilter) {
      return tools.filter((t) => preset.categoryFilter!.includes(t.category));
    }
    return tools;
  }

  static resetToDefaults(): void {
    this.presets = { ...DEFAULT_PRESETS };
  }
}

export const PROMPT_ASSEMBLY_VERSION = 1;

export type PromptAssemblyBlockStability = 'stable' | 'volatile';

export type PromptAssemblyBlockKind =
  | 'system-prompt'
  | 'tool-schemas'
  | 'project-profile'
  | 'runtime-profile'
  | 'skills-hook'
  | 'memory-hook'
  | 'plan-hook'
  | 'custom-stable'
  | 'message-history'
  | 'current-user-turn'
  | 'recent-tool-output'
  | 'runtime-steering'
  | 'transient-diagnostics'
  | 'custom-volatile';

export type PromptProviderFamily =
  'openai' | 'anthropic' | 'gemini' | 'openai-compatible' | 'unknown';

export type PromptModelFamily =
  | 'gpt-5.x'
  | 'claude-4.6-plus'
  | 'gemini'
  | 'deepseek-v4-plus'
  | 'kimi-2.5-plus'
  | 'glm-5-plus'
  | 'unknown';

export type PromptCacheStrategy =
  | 'automatic-stable-prefix'
  | 'explicit-cache-breakpoint'
  | 'context-cache'
  | 'conservative-stable-prefix';

export type PromptUsageNormalization =
  'openai-compatible' | 'anthropic' | 'gemini' | 'generic';

export interface PromptAssemblyPayload {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export interface PromptAssemblyContextBlock {
  id: string;
  kind: Extract<
    PromptAssemblyBlockKind,
    | 'project-profile'
    | 'runtime-profile'
    | 'skills-hook'
    | 'memory-hook'
    | 'plan-hook'
    | 'custom-stable'
    | 'custom-volatile'
  >;
  label?: string;
  content: JsonValue;
}

export interface PromptAssemblyInput extends PromptAssemblyPayload {
  providerFamily?: PromptProviderFamily;
  model?: string;
  modelFamily?: PromptModelFamily;
  mode?: ToolMode;
  stableContext?: PromptAssemblyContextBlock[];
  volatileContext?: PromptAssemblyContextBlock[];
}

export interface PromptCacheBlock {
  id: string;
  order: number;
  kind: PromptAssemblyBlockKind;
  stability: PromptAssemblyBlockStability;
  hash: string;
  byteLength: number;
  role?: AgentRole | 'tool';
  label?: string;
}

export interface PromptCacheCandidate {
  id: string;
  strategy: PromptCacheStrategy;
  blockIds: string[];
  stablePrefixHash: string;
  cacheKey: string;
  priority: number;
  anchorBlockId?: string;
}

export interface PromptCacheStrategySelection {
  providerFamily: PromptProviderFamily;
  modelFamily: PromptModelFamily;
  cacheStrategy: PromptCacheStrategy;
  usageNormalization: PromptUsageNormalization;
}

export interface PromptAssemblyMetadata {
  version: typeof PROMPT_ASSEMBLY_VERSION;
  layout: 'stable-prefix-v1';
  providerFamily: PromptProviderFamily;
  modelFamily: PromptModelFamily;
  cacheStrategy: PromptCacheStrategy;
  usageNormalization: PromptUsageNormalization;
  stablePrefixHash: string;
  toolSchemaHash: string;
  cacheKey: string;
  cacheBlocks: PromptCacheBlock[];
  cacheCandidates: PromptCacheCandidate[];
  boundary: {
    layout: 'stable-prefix-v1';
    stableBlockIds: string[];
    volatileBlockIds: string[];
    stableBlockKinds: PromptAssemblyBlockKind[];
    volatileBlockKinds: PromptAssemblyBlockKind[];
    stablePrefixHash: string;
    cacheKey: string;
  };
}

export interface PromptAssemblyResult {
  payload: PromptAssemblyPayload;
  metadata: PromptAssemblyMetadata;
}

const EMPTY_HASH = hashJson({ version: PROMPT_ASSEMBLY_VERSION, empty: true });
const CONTEXT_MESSAGE_ID = 'prompt-context:volatile';
const DEFAULT_TOOL_SCHEMA: JsonObject = {
  type: 'object',
  properties: {},
  additionalProperties: true,
};

export function assemblePromptForProvider(
  input: PromptAssemblyInput
): PromptAssemblyResult {
  const stableContext = (input.stableContext ?? []).filter(
    (block) => block.kind !== 'custom-volatile'
  );
  const volatileContext = input.volatileContext ?? [];
  const stableContextPrompt = renderPromptContextBlocks(
    stableContext,
    'stable'
  );
  const volatileContextPrompt = renderPromptContextBlocks(
    volatileContext,
    'volatile'
  );
  const { currentUserMessageId, currentUserMessageIndex } =
    analyzePromptMessages(input.messages);
  const materializedMessages = materializePromptMessages(
    input.messages,
    volatileContextPrompt,
    currentUserMessageIndex
  );
  const mode = input.mode ?? 'full-access';
  const filtered = ToolPresetRegistry.filterTools(input.tools, mode);
  const tools = stableToolOrder(filtered);
  const systemPrompt = joinPromptParts([
    input.systemPrompt,
    stableContextPrompt,
  ]);
  const payload: PromptAssemblyPayload = {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages: materializedMessages,
    tools,
  };
  const strategy = selectPromptCacheStrategy(input);
  const toolSchemas = tools.map(toolSchemaFingerprint);
  const toolSchemaHash = hashJson({
    version: PROMPT_ASSEMBLY_VERSION,
    tools: toolSchemas,
  });
  const blocks: PromptCacheBlock[] = [];
  const stableBlockIds: string[] = [];
  const stableBlockKinds: PromptAssemblyBlockKind[] = [];
  const stableBlockFingerprints: Array<{
    id: string;
    kind: PromptAssemblyBlockKind;
    hash: string;
  }> = [];
  const volatileBlockIds: string[] = [];
  const volatileBlockKinds: PromptAssemblyBlockKind[] = [];
  let order = 0;

  const addBlock = (
    kind: PromptAssemblyBlockKind,
    stability: PromptAssemblyBlockStability,
    content: JsonValue,
    options: {
      id?: string;
      role?: PromptCacheBlock['role'];
      label?: string;
    } = {}
  ): PromptCacheBlock => {
    const { hash, byteLength } = fingerprintBlock(kind, content);
    const block: PromptCacheBlock = compactObject({
      id: options.id ?? kind,
      order: order++,
      kind,
      stability,
      hash,
      byteLength,
      role: options.role,
      label: options.label,
    }) as unknown as PromptCacheBlock;
    blocks.push(block);
    if (stability === 'stable') {
      stableBlockIds.push(block.id);
      stableBlockKinds.push(kind);
      stableBlockFingerprints.push({ id: block.id, kind, hash });
    } else {
      volatileBlockIds.push(block.id);
      volatileBlockKinds.push(kind);
    }
    return block;
  };

  const addMessageBlock = (message: AgentMessage): void => {
    addBlock(
      classifyMessageBlock(message, currentUserMessageId),
      'volatile',
      messageFingerprint(message) as unknown as JsonValue,
      {
        id: `message:${message.id}`,
        role: message.role,
        label: message.id,
      }
    );
  };

  if (input.systemPrompt?.trim()) {
    addBlock('system-prompt', 'stable', input.systemPrompt, { role: 'system' });
  }

  if (toolSchemas.length > 0) {
    addBlock('tool-schemas', 'stable', toolSchemas as unknown as JsonValue, {
      role: 'tool',
    });
  }

  for (const block of stableContext) {
    addBlock(block.kind, 'stable', block.content, {
      id: block.id,
      ...(block.label !== undefined ? { label: block.label } : {}),
    });
  }

  // 单次遍历：当前用户消息之前的消息（按索引区间迭代，避免 findIndex/slice）
  for (let index = 0; index < currentUserMessageIndex; index++) {
    addMessageBlock(input.messages[index]!);
  }

  for (const block of volatileContext) {
    addBlock(
      block.kind === 'custom-stable' ? 'custom-volatile' : block.kind,
      'volatile',
      block.content,
      {
        id: block.id,
        ...(block.label !== undefined ? { label: block.label } : {}),
      }
    );
  }

  // 单次遍历：当前用户消息及其后的消息（按索引区间迭代，避免 findIndex/slice）
  const fromStartIndex =
    currentUserMessageIndex < 0
      ? input.messages.length
      : currentUserMessageIndex;
  for (let index = fromStartIndex; index < input.messages.length; index++) {
    addMessageBlock(input.messages[index]!);
  }

  const stablePrefixHash =
    stableBlockIds.length > 0
      ? hashJson({
          version: PROMPT_ASSEMBLY_VERSION,
          layout: 'stable-prefix-v1',
          blocks: stableBlockFingerprints,
        })
      : EMPTY_HASH;
  const cacheKey = `prompt:v${PROMPT_ASSEMBLY_VERSION}:${stablePrefixHash}`;
  const metadata: PromptAssemblyMetadata = {
    version: PROMPT_ASSEMBLY_VERSION,
    layout: 'stable-prefix-v1',
    providerFamily: strategy.providerFamily,
    modelFamily: strategy.modelFamily,
    cacheStrategy: strategy.cacheStrategy,
    usageNormalization: strategy.usageNormalization,
    stablePrefixHash,
    toolSchemaHash,
    cacheKey,
    cacheBlocks: blocks,
    cacheCandidates: cacheCandidatesForStrategy(
      strategy.cacheStrategy,
      stableBlockIds,
      stablePrefixHash,
      cacheKey
    ),
    boundary: {
      layout: 'stable-prefix-v1',
      stableBlockIds,
      volatileBlockIds,
      stableBlockKinds,
      volatileBlockKinds,
      stablePrefixHash,
      cacheKey,
    },
  };

  return { payload, metadata };
}

function stableToolOrder(tools: AgentTool[]): AgentTool[] {
  return [...tools].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.label.localeCompare(right.label)
  );
}

export function renderPromptContextBlocks(
  blocks: PromptAssemblyContextBlock[],
  stability: PromptAssemblyBlockStability
): string | undefined {
  if (blocks.length === 0) return undefined;
  const rendered = blocks
    .map((block) => {
      const label = block.label ? ` label=${JSON.stringify(block.label)}` : '';
      return `<context_block id=${JSON.stringify(block.id)} kind=${JSON.stringify(block.kind)}${label}>\n${canonicalJson(block.content)}\n</context_block>`;
    })
    .join('\n');
  return `<prompt_context stability="${stability}" version="${PROMPT_ASSEMBLY_VERSION}">\n${rendered}\n</prompt_context>`;
}

export function selectPromptCacheStrategy(options: {
  providerFamily?: PromptProviderFamily;
  model?: string;
  modelFamily?: PromptModelFamily;
}): PromptCacheStrategySelection {
  const modelFamily =
    options.modelFamily ?? inferPromptModelFamily(options.model);
  const providerFamily =
    options.providerFamily ??
    inferPromptProviderFamily(options.model, modelFamily);

  if (providerFamily === 'openai') {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: 'automatic-stable-prefix',
      usageNormalization: 'openai-compatible',
    };
  }

  if (providerFamily === 'anthropic') {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: 'explicit-cache-breakpoint',
      usageNormalization: 'anthropic',
    };
  }

  if (providerFamily === 'gemini') {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: 'context-cache',
      usageNormalization: 'gemini',
    };
  }

  if (providerFamily === 'openai-compatible') {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: 'conservative-stable-prefix',
      usageNormalization: 'openai-compatible',
    };
  }

  return {
    providerFamily: 'unknown',
    modelFamily,
    cacheStrategy: 'conservative-stable-prefix',
    usageNormalization: 'generic',
  };
}

export function inferPromptModelFamily(
  model: string | undefined
): PromptModelFamily {
  const normalized = normalizeModelName(model);
  if (!normalized) return 'unknown';
  if (
    /\bgpt[-_\s]?5(?:[._-\s]\d+)?\b/.test(normalized) ||
    /^5[._-]4\b/.test(normalized)
  )
    return 'gpt-5.x';
  if (/\bclaude\b/.test(normalized) && versionAtLeast(normalized, 4, 6))
    return 'claude-4.6-plus';
  if (/\bgemini\b/.test(normalized)) return 'gemini';
  if (/\bdeepseek\b/.test(normalized) && versionAtLeast(normalized, 4, 0))
    return 'deepseek-v4-plus';
  if (/\bkimi\b/.test(normalized) && versionAtLeast(normalized, 2, 5))
    return 'kimi-2.5-plus';
  if (/\bglm\b/.test(normalized) && versionAtLeast(normalized, 5, 0))
    return 'glm-5-plus';
  return 'unknown';
}

export function inferPromptProviderFamily(
  model: string | undefined,
  modelFamily = inferPromptModelFamily(model)
): PromptProviderFamily {
  if (modelFamily === 'gpt-5.x') return 'openai';
  if (modelFamily === 'claude-4.6-plus') return 'anthropic';
  if (modelFamily === 'gemini') return 'gemini';
  if (
    modelFamily === 'deepseek-v4-plus' ||
    modelFamily === 'kimi-2.5-plus' ||
    modelFamily === 'glm-5-plus'
  )
    return 'openai-compatible';

  const normalized = normalizeModelName(model);
  if (/\b(openai|gpt)\b/.test(normalized)) return 'openai';
  if (/\banthropic\b|\bclaude\b/.test(normalized)) return 'anthropic';
  if (/\bgoogle\b|\bgemini\b/.test(normalized)) return 'gemini';
  if (/\bdeepseek\b|\bkimi\b|\bglm\b/.test(normalized))
    return 'openai-compatible';
  return 'unknown';
}

function cacheCandidatesForStrategy(
  strategy: PromptCacheStrategy,
  stableBlockIds: string[],
  stablePrefixHash: string,
  cacheKey: string
): PromptCacheCandidate[] {
  if (stableBlockIds.length === 0) return [];
  return [
    compactObject({
      id: `${strategy}:${stablePrefixHash.slice(0, 16)}`,
      strategy,
      blockIds: stableBlockIds,
      stablePrefixHash,
      cacheKey,
      priority: 100,
      anchorBlockId: stableBlockIds.at(-1),
    }) as unknown as PromptCacheCandidate,
  ];
}

function classifyMessageBlock(
  message: AgentMessage,
  currentUserMessageId: string | undefined
): PromptAssemblyBlockKind {
  if (isRuntimeSteeringMessage(message)) return 'runtime-steering';
  if (isTransientDiagnosticMessage(message)) return 'transient-diagnostics';
  if (
    message.role === 'tool' ||
    message.blocks.some((block) => block.type === 'tool-result')
  )
    return 'recent-tool-output';
  if (message.role === 'user' && message.id === currentUserMessageId)
    return 'current-user-turn';
  return 'message-history';
}

function isRuntimeSteeringMessage(message: AgentMessage): boolean {
  return (
    message.metadata?.kind === 'runtime-steering' ||
    message.blocks.some(
      (block) =>
        block.type === 'text' && block.text.startsWith('Runtime steering:')
    )
  );
}

function isTransientDiagnosticMessage(message: AgentMessage): boolean {
  return (
    message.metadata?.kind === 'transient-diagnostic' ||
    message.metadata?.kind === 'transient-diagnostics'
  );
}

function analyzePromptMessages(messages: AgentMessage[]): {
  currentUserMessageId: string | undefined;
  currentUserMessageIndex: number;
} {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') {
      return {
        currentUserMessageId: message.id,
        currentUserMessageIndex: index,
      };
    }
  }
  return { currentUserMessageId: undefined, currentUserMessageIndex: -1 };
}

function materializePromptMessages(
  messages: AgentMessage[],
  volatileContextPrompt: string | undefined,
  currentUserMessageIndex: number
): AgentMessage[] {
  if (!volatileContextPrompt?.trim()) return messages;
  const contextMessage: AgentMessage = {
    id: CONTEXT_MESSAGE_ID,
    role: 'system',
    createdAt: '1970-01-01T00:00:00.000Z',
    blocks: [{ type: 'text', text: volatileContextPrompt }],
    metadata: { kind: 'prompt-context', stability: 'volatile' },
  };
  if (currentUserMessageIndex < 0) return [...messages, contextMessage];
  return [
    ...messages.slice(0, currentUserMessageIndex),
    contextMessage,
    ...messages.slice(currentUserMessageIndex),
  ];
}

function toolSchemaFingerprint(tool: AgentTool): JsonObject {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? DEFAULT_TOOL_SCHEMA,
  };
}

function messageFingerprint(message: AgentMessage): JsonObject {
  return {
    role: message.role,
    blocks: message.blocks.map(blockFingerprint),
  };
}

function blockFingerprint(block: AgentMessageBlock): JsonObject {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'thought')
    return compactObject({
      type: 'thought',
      text: block.text,
      redacted: block.redacted,
    }) as JsonObject;
  if (block.type === 'tool-call')
    return { type: 'tool-call', toolName: block.toolName, input: block.input };
  return {
    type: 'tool-result',
    toolCallId: block.toolCallId,
    toolName: block.toolName,
    output: toolOutputFingerprint(block.output),
    isError: block.isError,
  };
}

function toolOutputFingerprint(output: ToolOutput): JsonObject {
  return compactObject({
    text: output.text,
    json: output.json,
    artifacts: output.artifacts?.map((artifact) =>
      compactObject({
        kind: artifact.kind,
        title: artifact.title,
        uri: artifact.uri,
        text: artifact.text,
        metadata: artifact.metadata,
      })
    ),
  }) as JsonObject;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function joinPromptParts(parts: Array<string | undefined>): string | undefined {
  const normalized = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return normalized.length > 0 ? normalized.join('\n\n') : undefined;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
}

function hashJson(value: unknown): string {
  return fnv1a(canonicalJson(value));
}

/**
 * Single-pass block fingerprint: canonicalize `content` once and derive both the
 * wrapper hash and the byte length from that one serialization.
 *
 * Invariant: `wrapperCanon` must match `canonicalJson({ version, kind, content })`
 * byte-for-byte. `canonicalValue` sorts object keys alphabetically, so the wrapper
 * object serializes as `{"content":<contentCanon>,"kind":<kind>,"version":<version>}`.
 * Building it from the pre-computed `contentCanon` avoids canonicalizing `content`
 * a second time (previously done once inside `hashJson` and once for `byteLength`).
 */
function fingerprintBlock(
  kind: PromptAssemblyBlockKind,
  content: JsonValue
): { hash: string; byteLength: number } {
  const contentCanon = canonicalJson(content);
  const wrapperCanon = `{"content":${contentCanon},"kind":${JSON.stringify(kind)},"version":${PROMPT_ASSEMBLY_VERSION}}`;
  return {
    hash: fnv1a(wrapperCanon),
    byteLength: Buffer.byteLength(contentCanon, 'utf8'),
  };
}

/**
 * FNV-1a 32-bit non-cryptographic hash. Used for cache keys, deduplication, and
 * change detection where cryptographic strength is not required. Roughly 10-50x
 * faster than SHA-256 on small strings.
 *
 * Output: up to 8 lowercase hex characters (unsigned 32-bit). Collision risk is
 * negligible for cache-affinity use; a collision at worst causes a cache miss,
 * never data corruption.
 */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function compactObject(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  ) as JsonObject;
}

function normalizeModelName(model: string | undefined): string {
  return (model ?? '').trim().toLowerCase();
}

function versionAtLeast(value: string, major: number, minor: number): boolean {
  const escapedMajor = String(major).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = value.match(
    new RegExp(
      `(?:^|[^0-9])v?${escapedMajor}(?:[._\\s-](\\d{1,2}))?(?:\\b|[^0-9])`
    )
  );
  if (!match) return false;
  const foundMinor = match[1] === undefined ? 0 : Number(match[1]);
  return Number.isFinite(foundMinor) && foundMinor >= minor;
}
