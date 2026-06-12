import { describe, expect, it } from "vitest";
import {
  assemblePromptForProvider,
  createProviderCacheHintPlan,
  createTextMessage,
  DEFAULT_GEMINI_CONTEXT_CACHE_MIN_BYTES,
  defineTextTool,
} from ".";
import type { JsonObject } from "@crish/shared-types";

function shellTool(inputSchema: JsonObject = commandSchema()): ReturnType<typeof defineTextTool> {
  return defineTextTool({
    name: "shell_command",
    description: "Run a shell command",
    inputSchema,
    execute: () => "ok"
  });
}

function commandSchema(extra: JsonObject = {}): JsonObject {
  return {
    type: "object",
    properties: {
      command: { type: "string" },
      ...extra
    },
    required: ["command"]
  };
}

function assembled(providerFamily: Parameters<typeof assemblePromptForProvider>[0]["providerFamily"]) {
  return assemblePromptForProvider({
    providerFamily,
    modelFamily: providerFamily === "anthropic" ? "claude-4.6-plus" : providerFamily === "gemini" ? "gemini" : "unknown",
    systemPrompt: "Keep the stable prefix reusable.",
    stableContext: [
      {
        id: "project-profile",
        kind: "project-profile",
        content: { cwd: "C:/Software/conex", branch: "main" }
      }
    ],
    messages: [createTextMessage("user", "Inspect the current turn.")],
    tools: [shellTool()]
  });
}

describe("ProviderCacheHintPlan", () => {
  it("maps OpenAI-compatible metadata to affinity and request metadata hints", () => {
    const result = assembled("openai-compatible");
    const plan = createProviderCacheHintPlan(result);

    expect(plan).toMatchObject({
      decision: "hint",
      intent: "metadata-affinity",
      providerFamily: "openai-compatible",
      cacheStrategy: "conservative-stable-prefix",
      usageNormalization: "openai-compatible",
      stablePrefixHash: result.metadata.stablePrefixHash,
      cacheKey: result.metadata.cacheKey,
      metricsDimensions: {
        providerFamily: "openai-compatible",
        stablePrefixHash: result.metadata.stablePrefixHash,
        cacheKey: result.metadata.cacheKey,
        cacheStrategy: "conservative-stable-prefix"
      },
      providerHints: {
        kind: "openai-compatible",
        stablePromptCacheAffinityKey: result.metadata.stablePrefixHash,
        serverCacheControl: "metadata-hint-only",
        requestMetadata: {
          cacheKey: result.metadata.cacheKey,
          stablePrefixHash: result.metadata.stablePrefixHash,
          toolSchemaHash: result.metadata.toolSchemaHash
        }
      }
    });
    expect(plan.stableBlocks.map((block) => block.kind)).not.toContain("current-user-turn");
  });

  it("maps Anthropic-style metadata to explicit stable, tool schema, and anchor breakpoints", () => {
    const result = assembled("anthropic");
    const plan = createProviderCacheHintPlan(result);

    expect(plan).toMatchObject({
      decision: "hint",
      intent: "explicit-breakpoints",
      providerFamily: "anthropic",
      cacheStrategy: "explicit-cache-breakpoint",
      providerHints: {
        kind: "anthropic-style",
        usageNormalization: "anthropic"
      }
    });
    expect(plan.providerHints.kind).toBe("anthropic-style");
    if (plan.providerHints.kind !== "anthropic-style") return;
    expect(plan.providerHints.explicitBreakpoints.map((hint) => hint.purpose)).toEqual(["stable-prefix", "tool-schema", "anchor"]);
    expect(plan.providerHints.explicitBreakpoints[0]).toMatchObject({
      afterBlockId: "project-profile",
      blockIds: ["system-prompt", "tool-schemas", "project-profile"],
      stablePrefixHash: result.metadata.stablePrefixHash,
      cacheKey: result.metadata.cacheKey,
      priority: 100
    });
    expect(plan.providerHints.explicitBreakpoints[1]).toMatchObject({
      afterBlockId: "tool-schemas",
      blockIds: ["system-prompt", "tool-schemas"],
      priority: 90
    });
  });

  it("keeps Gemini context-cache candidates conservative below the byte threshold", () => {
    const result = assembled("gemini");
    const plan = createProviderCacheHintPlan(result, { geminiContextCacheMinBytes: Number.MAX_SAFE_INTEGER });

    expect(plan).toMatchObject({
      decision: "no-op",
      intent: "conservative-no-op",
      providerFamily: "gemini",
      providerHints: {
        kind: "gemini-style",
        minByteLength: Number.MAX_SAFE_INTEGER,
        usageNormalization: "gemini"
      }
    });
    expect(plan.providerHints.kind).toBe("gemini-style");
    if (plan.providerHints.kind !== "gemini-style") return;
    expect(plan.providerHints.contextCacheCandidate).toBeUndefined();
    expect(plan.stableByteLength).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("emits a Gemini context-cache candidate when the stable prefix reaches the threshold", () => {
    const result = assembled("gemini");
    const plan = createProviderCacheHintPlan(result, { geminiContextCacheMinBytes: 1 });

    expect(plan).toMatchObject({
      decision: "hint",
      intent: "context-cache-candidate",
      providerHints: {
        kind: "gemini-style",
        minByteLength: 1,
        contextCacheCandidate: {
          blockIds: ["system-prompt", "tool-schemas", "project-profile"],
          stablePrefixHash: result.metadata.stablePrefixHash,
          cacheKey: result.metadata.cacheKey,
          minByteLength: 1
        }
      }
    });
    expect(DEFAULT_GEMINI_CONTEXT_CACHE_MIN_BYTES).toBe(32768);
  });

  it("returns an unknown-provider no-op while preserving cache aggregation keys", () => {
    const result = assembled("unknown");
    const plan = createProviderCacheHintPlan(result);

    expect(plan).toMatchObject({
      decision: "no-op",
      intent: "conservative-no-op",
      providerFamily: "unknown",
      stablePrefixHash: result.metadata.stablePrefixHash,
      cacheKey: result.metadata.cacheKey,
      providerHints: {
        kind: "unknown",
        reason: "unsupported-provider"
      },
      metricsDimensions: {
        providerFamily: "unknown",
        stablePrefixHash: result.metadata.stablePrefixHash,
        toolSchemaHash: result.metadata.toolSchemaHash,
        cacheKey: result.metadata.cacheKey
      }
    });
  });

  it("orders stable blocks by PromptAssembly order and excludes volatile turns from stable hints", () => {
    const result = assemblePromptForProvider({
      providerFamily: "anthropic",
      systemPrompt: "Stable first.",
      stableContext: [
        { id: "runtime-profile", kind: "runtime-profile", content: { shell: "powershell" } },
        { id: "memory-hook", kind: "memory-hook", content: { summary: "facts" } }
      ],
      messages: [createTextMessage("user", "First current turn.")],
      tools: [shellTool()]
    });
    const second = assemblePromptForProvider({
      providerFamily: "anthropic",
      systemPrompt: "Stable first.",
      stableContext: [
        { id: "runtime-profile", kind: "runtime-profile", content: { shell: "powershell" } },
        { id: "memory-hook", kind: "memory-hook", content: { summary: "facts" } }
      ],
      messages: [createTextMessage("user", "Different current turn.")],
      tools: [shellTool()]
    });
    const plan = createProviderCacheHintPlan(result);

    expect(result.metadata.stablePrefixHash).toBe(second.metadata.stablePrefixHash);
    expect(plan.stableBlocks.map((block) => block.id)).toEqual(["system-prompt", "tool-schemas", "runtime-profile", "memory-hook"]);
    expect(plan.stableBlocks.map((block) => block.kind)).not.toContain("current-user-turn");
    expect(JSON.stringify(plan.providerHints)).not.toContain("First current turn.");
  });

  it("is stable across JSON roundtrip", () => {
    const plan = createProviderCacheHintPlan(assembled("openai-compatible"));
    const roundtripped = JSON.parse(JSON.stringify(plan));

    expect(roundtripped).toEqual(plan);
  });

  it("exposes cache identifiers only as hint and observability dimensions", () => {
    const result = assembled("openai-compatible");
    const plan = createProviderCacheHintPlan(result);
    const serialized = JSON.stringify(plan);

    expect(plan.decision).toBe("hint");
    expect(plan.intent).toBe("metadata-affinity");
    expect(plan.providerHints.kind).toBe("openai-compatible");
    if (plan.providerHints.kind !== "openai-compatible") return;
    expect(plan.providerHints.serverCacheControl).toBe("metadata-hint-only");
    expect(plan.metricsDimensions).toMatchObject({
      providerFamily: "openai-compatible",
      stablePrefixHash: result.metadata.stablePrefixHash,
      cacheKey: result.metadata.cacheKey
    });
    expect(serialized).not.toContain("gpt-");
    expect(serialized).not.toContain("claude-");
    expect(serialized).not.toContain("gemini-");
  });
});
