import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AgentMessage, AgentMessageBlock, JsonObject, JsonValue, ToolOutput } from "@crish/shared-types";
import type { AgentRole, AgentTool } from "./types";

export const PROMPT_ASSEMBLY_VERSION = 1;

export type PromptAssemblyBlockStability = "stable" | "volatile";

export type PromptAssemblyBlockKind =
  | "system-prompt"
  | "tool-schemas"
  | "project-profile"
  | "runtime-profile"
  | "skills-hook"
  | "memory-hook"
  | "plan-hook"
  | "custom-stable"
  | "message-history"
  | "current-user-turn"
  | "recent-tool-output"
  | "runtime-steering"
  | "transient-diagnostics"
  | "custom-volatile";

export type PromptProviderFamily = "openai" | "anthropic" | "gemini" | "openai-compatible" | "unknown";

export type PromptModelFamily =
  | "gpt-5.x"
  | "claude-4.6-plus"
  | "gemini"
  | "deepseek-v4-plus"
  | "kimi-2.5-plus"
  | "glm-5-plus"
  | "unknown";

export type PromptCacheStrategy =
  | "automatic-stable-prefix"
  | "explicit-cache-breakpoint"
  | "context-cache"
  | "conservative-stable-prefix";

export type PromptUsageNormalization = "openai-compatible" | "anthropic" | "gemini" | "generic";

export interface PromptAssemblyPayload {
  systemPrompt?: string;
  messages: AgentMessage[];
  tools: AgentTool[];
}

export interface PromptAssemblyContextBlock {
  id: string;
  kind: Extract<
    PromptAssemblyBlockKind,
    "project-profile" | "runtime-profile" | "skills-hook" | "memory-hook" | "plan-hook" | "custom-stable" | "custom-volatile"
  >;
  label?: string;
  content: JsonValue;
}

export interface PromptAssemblyInput extends PromptAssemblyPayload {
  providerFamily?: PromptProviderFamily;
  model?: string;
  modelFamily?: PromptModelFamily;
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
  role?: AgentRole | "tool";
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
  layout: "stable-prefix-v1";
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
    layout: "stable-prefix-v1";
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
const CONTEXT_MESSAGE_ID = "prompt-context:volatile";
const DEFAULT_TOOL_SCHEMA: JsonObject = {
  type: "object",
  properties: {},
  additionalProperties: true
};

export function assemblePromptForProvider(input: PromptAssemblyInput): PromptAssemblyResult {
  const stableContext = (input.stableContext ?? []).filter((block) => block.kind !== "custom-volatile");
  const volatileContext = input.volatileContext ?? [];
  const stableContextPrompt = renderPromptContextBlocks(stableContext, "stable");
  const volatileContextPrompt = renderPromptContextBlocks(volatileContext, "volatile");
  const materializedMessages = materializePromptMessages(input.messages, volatileContextPrompt);
  const tools = stableToolOrder(input.tools);
  const payload: PromptAssemblyPayload = {
    systemPrompt: joinPromptParts([input.systemPrompt, stableContextPrompt]),
    messages: materializedMessages,
    tools
  };
  const strategy = selectPromptCacheStrategy(input);
  const toolSchemas = tools.map(toolSchemaFingerprint);
  const toolSchemaHash = hashJson({ version: PROMPT_ASSEMBLY_VERSION, tools: toolSchemas });
  const blocks: PromptCacheBlock[] = [];
  const stableBlockIds: string[] = [];
  let order = 0;

  const addBlock = (
    kind: PromptAssemblyBlockKind,
    stability: PromptAssemblyBlockStability,
    content: JsonValue,
    options: { id?: string; role?: PromptCacheBlock["role"]; label?: string } = {}
  ): PromptCacheBlock => {
    const hash = hashJson({ version: PROMPT_ASSEMBLY_VERSION, kind, content });
    const block: PromptCacheBlock = compactObject({
      id: options.id ?? kind,
      order: order++,
      kind,
      stability,
      hash,
      byteLength: Buffer.byteLength(canonicalJson(content), "utf8"),
      role: options.role,
      label: options.label
    }) as unknown as PromptCacheBlock;
    blocks.push(block);
    if (stability === "stable") stableBlockIds.push(block.id);
    return block;
  };

  if (input.systemPrompt?.trim()) {
    addBlock("system-prompt", "stable", input.systemPrompt, { role: "system" });
  }

  if (toolSchemas.length > 0) {
    addBlock("tool-schemas", "stable", toolSchemas as unknown as JsonValue, { role: "tool" });
  }

  for (const block of stableContext) {
    addBlock(block.kind, "stable", block.content, { id: block.id, label: block.label });
  }

  const currentUserMessageId = latestUserMessageId(input.messages);
  for (const message of messagesBeforeCurrentUser(input.messages, currentUserMessageId)) {
    const kind = classifyMessageBlock(message, currentUserMessageId);
    addBlock(kind, "volatile", messageFingerprint(message) as unknown as JsonValue, {
      id: `message:${message.id}`,
      role: message.role,
      label: message.id
    });
  }

  for (const block of volatileContext) {
    addBlock(block.kind === "custom-stable" ? "custom-volatile" : block.kind, "volatile", block.content, { id: block.id, label: block.label });
  }

  for (const message of messagesFromCurrentUser(input.messages, currentUserMessageId)) {
    const kind = classifyMessageBlock(message, currentUserMessageId);
    addBlock(kind, "volatile", messageFingerprint(message) as unknown as JsonValue, {
      id: `message:${message.id}`,
      role: message.role,
      label: message.id
    });
  }

  const stablePrefixHash =
    stableBlockIds.length > 0
      ? hashJson({
          version: PROMPT_ASSEMBLY_VERSION,
          layout: "stable-prefix-v1",
          blocks: blocks
            .filter((block) => block.stability === "stable")
            .map((block) => ({ id: block.id, kind: block.kind, hash: block.hash }))
        })
      : EMPTY_HASH;
  const cacheKey = `prompt:v${PROMPT_ASSEMBLY_VERSION}:${stablePrefixHash}`;
  const metadata: PromptAssemblyMetadata = {
    version: PROMPT_ASSEMBLY_VERSION,
    layout: "stable-prefix-v1",
    providerFamily: strategy.providerFamily,
    modelFamily: strategy.modelFamily,
    cacheStrategy: strategy.cacheStrategy,
    usageNormalization: strategy.usageNormalization,
    stablePrefixHash,
    toolSchemaHash,
    cacheKey,
    cacheBlocks: blocks,
    cacheCandidates: cacheCandidatesForStrategy(strategy.cacheStrategy, stableBlockIds, stablePrefixHash, cacheKey),
    boundary: promptBoundaryMetadata(blocks, stablePrefixHash, cacheKey)
  };

  return { payload, metadata };
}

function stableToolOrder(tools: AgentTool[]): AgentTool[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name) || left.label.localeCompare(right.label));
}

function promptBoundaryMetadata(blocks: PromptCacheBlock[], stablePrefixHash: string, cacheKey: string): PromptAssemblyMetadata["boundary"] {
  const stableBlocks = blocks.filter((block) => block.stability === "stable");
  const volatileBlocks = blocks.filter((block) => block.stability === "volatile");
  return {
    layout: "stable-prefix-v1",
    stableBlockIds: stableBlocks.map((block) => block.id),
    volatileBlockIds: volatileBlocks.map((block) => block.id),
    stableBlockKinds: stableBlocks.map((block) => block.kind),
    volatileBlockKinds: volatileBlocks.map((block) => block.kind),
    stablePrefixHash,
    cacheKey
  };
}

export function renderPromptContextBlocks(
  blocks: PromptAssemblyContextBlock[],
  stability: PromptAssemblyBlockStability
): string | undefined {
  if (blocks.length === 0) return undefined;
  const rendered = blocks
    .map((block) => {
      const label = block.label ? ` label=${JSON.stringify(block.label)}` : "";
      return `<context_block id=${JSON.stringify(block.id)} kind=${JSON.stringify(block.kind)}${label}>\n${canonicalJson(block.content)}\n</context_block>`;
    })
    .join("\n");
  return `<prompt_context stability="${stability}" version="${PROMPT_ASSEMBLY_VERSION}">\n${rendered}\n</prompt_context>`;
}

export function selectPromptCacheStrategy(options: {
  providerFamily?: PromptProviderFamily;
  model?: string;
  modelFamily?: PromptModelFamily;
}): PromptCacheStrategySelection {
  const modelFamily = options.modelFamily ?? inferPromptModelFamily(options.model);
  const providerFamily = options.providerFamily ?? inferPromptProviderFamily(options.model, modelFamily);

  if (providerFamily === "openai") {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: "automatic-stable-prefix",
      usageNormalization: "openai-compatible"
    };
  }

  if (providerFamily === "anthropic") {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: "explicit-cache-breakpoint",
      usageNormalization: "anthropic"
    };
  }

  if (providerFamily === "gemini") {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: "context-cache",
      usageNormalization: "gemini"
    };
  }

  if (providerFamily === "openai-compatible") {
    return {
      providerFamily,
      modelFamily,
      cacheStrategy: "conservative-stable-prefix",
      usageNormalization: "openai-compatible"
    };
  }

  return {
    providerFamily: "unknown",
    modelFamily,
    cacheStrategy: "conservative-stable-prefix",
    usageNormalization: "generic"
  };
}

export function inferPromptModelFamily(model: string | undefined): PromptModelFamily {
  const normalized = normalizeModelName(model);
  if (!normalized) return "unknown";
  if (/\bgpt[-_\s]?5(?:[._-\s]\d+)?\b/.test(normalized) || /^5[._-]4\b/.test(normalized)) return "gpt-5.x";
  if (/\bclaude\b/.test(normalized) && versionAtLeast(normalized, 4, 6)) return "claude-4.6-plus";
  if (/\bgemini\b/.test(normalized)) return "gemini";
  if (/\bdeepseek\b/.test(normalized) && versionAtLeast(normalized, 4, 0)) return "deepseek-v4-plus";
  if (/\bkimi\b/.test(normalized) && versionAtLeast(normalized, 2, 5)) return "kimi-2.5-plus";
  if (/\bglm\b/.test(normalized) && versionAtLeast(normalized, 5, 0)) return "glm-5-plus";
  return "unknown";
}

export function inferPromptProviderFamily(model: string | undefined, modelFamily = inferPromptModelFamily(model)): PromptProviderFamily {
  if (modelFamily === "gpt-5.x") return "openai";
  if (modelFamily === "claude-4.6-plus") return "anthropic";
  if (modelFamily === "gemini") return "gemini";
  if (modelFamily === "deepseek-v4-plus" || modelFamily === "kimi-2.5-plus" || modelFamily === "glm-5-plus") return "openai-compatible";

  const normalized = normalizeModelName(model);
  if (/\b(openai|gpt)\b/.test(normalized)) return "openai";
  if (/\banthropic\b|\bclaude\b/.test(normalized)) return "anthropic";
  if (/\bgoogle\b|\bgemini\b/.test(normalized)) return "gemini";
  if (/\bdeepseek\b|\bkimi\b|\bglm\b/.test(normalized)) return "openai-compatible";
  return "unknown";
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
      anchorBlockId: stableBlockIds.at(-1)
    }) as unknown as PromptCacheCandidate
  ];
}

function classifyMessageBlock(message: AgentMessage, currentUserMessageId: string | undefined): PromptAssemblyBlockKind {
  if (isRuntimeSteeringMessage(message)) return "runtime-steering";
  if (isTransientDiagnosticMessage(message)) return "transient-diagnostics";
  if (message.role === "tool" || message.blocks.some((block) => block.type === "tool-result")) return "recent-tool-output";
  if (message.role === "user" && message.id === currentUserMessageId) return "current-user-turn";
  return "message-history";
}

function isRuntimeSteeringMessage(message: AgentMessage): boolean {
  return message.metadata?.kind === "runtime-steering" || message.blocks.some((block) => block.type === "text" && block.text.startsWith("Runtime steering:"));
}

function isTransientDiagnosticMessage(message: AgentMessage): boolean {
  return message.metadata?.kind === "transient-diagnostic" || message.metadata?.kind === "transient-diagnostics";
}

function latestUserMessageId(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user") return message.id;
  }
  return undefined;
}

function materializePromptMessages(messages: AgentMessage[], volatileContextPrompt: string | undefined): AgentMessage[] {
  if (!volatileContextPrompt?.trim()) return messages;
  const contextMessage: AgentMessage = {
    id: CONTEXT_MESSAGE_ID,
    role: "system",
    createdAt: "1970-01-01T00:00:00.000Z",
    blocks: [{ type: "text", text: volatileContextPrompt }],
    metadata: { kind: "prompt-context", stability: "volatile" }
  };
  const currentUserMessageId = latestUserMessageId(messages);
  if (!currentUserMessageId) return [...messages, contextMessage];
  const index = messages.findIndex((message) => message.id === currentUserMessageId);
  if (index < 0) return [...messages, contextMessage];
  return [...messages.slice(0, index), contextMessage, ...messages.slice(index)];
}

function messagesBeforeCurrentUser(messages: AgentMessage[], currentUserMessageId: string | undefined): AgentMessage[] {
  if (!currentUserMessageId) return messages;
  const index = messages.findIndex((message) => message.id === currentUserMessageId);
  return index < 0 ? messages : messages.slice(0, index);
}

function messagesFromCurrentUser(messages: AgentMessage[], currentUserMessageId: string | undefined): AgentMessage[] {
  if (!currentUserMessageId) return [];
  const index = messages.findIndex((message) => message.id === currentUserMessageId);
  return index < 0 ? [] : messages.slice(index);
}

function toolSchemaFingerprint(tool: AgentTool): JsonObject {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? DEFAULT_TOOL_SCHEMA
  };
}

function messageFingerprint(message: AgentMessage): JsonObject {
  return {
    role: message.role,
    blocks: message.blocks.map(blockFingerprint)
  };
}

function blockFingerprint(block: AgentMessageBlock): JsonObject {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thought") return compactObject({ type: "thought", text: block.text, redacted: block.redacted }) as JsonObject;
  if (block.type === "tool-call") return { type: "tool-call", toolName: block.toolName, input: block.input };
  return {
    type: "tool-result",
    toolCallId: block.toolCallId,
    toolName: block.toolName,
    output: toolOutputFingerprint(block.output),
    isError: block.isError
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
        metadata: artifact.metadata
      })
    )
  }) as JsonObject;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function joinPromptParts(parts: Array<string | undefined>): string | undefined {
  const normalized = parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part));
  return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)])
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compactObject(input: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}

function normalizeModelName(model: string | undefined): string {
  return (model ?? "").trim().toLowerCase();
}

function versionAtLeast(value: string, major: number, minor: number): boolean {
  const escapedMajor = String(major).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`(?:^|[^0-9])v?${escapedMajor}(?:[._\\s-](\\d{1,2}))?(?:\\b|[^0-9])`));
  if (!match) return false;
  const foundMinor = match[1] === undefined ? 0 : Number(match[1]);
  return Number.isFinite(foundMinor) && foundMinor >= minor;
}
