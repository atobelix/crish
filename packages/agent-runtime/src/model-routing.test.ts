import { describe, expect, it } from "vitest";
import {
  modelProfileFromMetadata,
  modelRouteDecisionToMetadata,
  capabilityRequestFromTask,
  mergeModelRoutePolicies,
  profileFromProviderRouteOffer,
  routeModelForTask,
  routeModelByCapability,
  type ModelProfile
} from "./model-routing";

describe("model capability routing", () => {
  it("filters models missing required capabilities", () => {
    const decision = routeModelByCapability(
      [
        profile("text-a", { capabilities: { code: 0.8 } }),
        profile("vision-b", { capabilities: { vision: 1, code: 0.5 } })
      ],
      { required: ["vision"] }
    );

    expect(decision.selected?.id).toBe("vision-b");
    expect(decision.candidates.map((candidate) => candidate.profile.id)).toEqual(["vision-b"]);
    expect(decision.rejections).toMatchObject([{ profile: { id: "text-a" }, reasons: ["missing_required:vision"] }]);
    expect(decision.trace).toEqual(expect.arrayContaining(["required:vision", "reject:text-a:missing_required:vision", "selected:vision-b"]));
  });

  it("scores preferred capabilities without requiring them", () => {
    const decision = routeModelByCapability(
      [
        profile("search-a", { capabilities: { search: 1, reasoning: 1 }, latencyMs: 1_000 }),
        profile("reasoning-b", { capabilities: { reasoning: 1 }, latencyMs: 900 })
      ],
      { required: ["reasoning"], preferred: ["search"] }
    );

    expect(decision.selected?.id).toBe("search-a");
    expect(decision.candidates.map((candidate) => [candidate.profile.id, candidate.matchedPreferred])).toEqual([
      ["search-a", ["search"]],
      ["reasoning-b", []]
    ]);
    expect(decision.candidates[1]?.reasons).toEqual(expect.arrayContaining(["missing_preferred:search:-3"]));
  });

  it("uses health, cost, and latency as deterministic tie breakers", () => {
    const decision = routeModelByCapability(
      [
        profile("tie-high-cost", { capabilities: { json: 1 }, health: "healthy", costTier: "high", latencyMs: 300 }),
        profile("tie-low-cost-slow", { capabilities: { json: 1 }, health: "healthy", costTier: "low", latencyMs: 3_000 }),
        profile("tie-degraded", { capabilities: { json: 1 }, health: "degraded", costTier: "low", latencyMs: 200 })
      ],
      { required: ["json"] }
    );

    expect(decision.candidates.map((candidate) => candidate.profile.id)).toEqual(["tie-low-cost-slow", "tie-high-cost", "tie-degraded"]);
    expect(decision.selected?.id).toBe("tie-low-cost-slow");
  });

  it("applies plugin and user policy overrides", () => {
    const profiles = [
      profile("code-a", { providerId: "tenant-a", capabilities: { code: 1, "tool-use": 1 }, costTier: "medium" }),
      profile("code-b", { providerId: "tenant-b", capabilities: { code: 1, "tool-use": 0.8 }, costTier: "low" }),
      profile("code-c", { providerId: "tenant-c", capabilities: { code: 1, "tool-use": 0.8 }, costTier: "free" })
    ];

    const decision = routeModelByCapability(
      profiles,
      { required: ["code"], preferred: ["tool-use"] },
      {
        denyProviders: ["tenant-b"],
        maxCostTier: "medium",
        preferModelIds: ["code-a"],
        weights: { preferredModel: 100 }
      }
    );

    expect(decision.selected?.id).toBe("code-a");
    expect(decision.rejections.map((rejection) => [rejection.profile.id, rejection.reasons])).toEqual([["code-b", ["provider:denied"]]]);
  });

  it("treats unknown profiles conservatively", () => {
    const decision = routeModelByCapability(
      [
        profile("unknown-a"),
        profile("known-b", { capabilities: { reasoning: 1 }, contextWindowTokens: 32_000 })
      ],
      { required: ["reasoning"], minimumContextTokens: 8_000 }
    );

    expect(decision.selected?.id).toBe("known-b");
    expect(decision.rejections.map((rejection) => [rejection.profile.id, rejection.reasons])).toEqual([
      ["unknown-a", ["context:unknown", "missing_required:reasoning"]]
    ]);
  });

  it("orders equivalent candidates by stable profile id", () => {
    const profiles = [
      profile("z-model", { capabilities: { json: 1 }, providerId: "z" }),
      profile("a-model", { capabilities: { json: 1 }, providerId: "a" }),
      profile("m-model", { capabilities: { json: 1 }, providerId: "m" })
    ];

    const first = routeModelByCapability(profiles, { required: ["json"] });
    const second = routeModelByCapability([...profiles].reverse(), { required: ["json"] });

    expect(first.candidates.map((candidate) => candidate.profile.id)).toEqual(["a-model", "m-model", "z-model"]);
    expect(second.candidates.map((candidate) => candidate.profile.id)).toEqual(["a-model", "m-model", "z-model"]);
    expect(first.trace.at(-1)).toBe("selected:a-model");
    expect(second.trace.at(-1)).toBe("selected:a-model");
  });

  it("adapts provider route offer metadata into a model profile", () => {
    const profile = profileFromProviderRouteOffer({
      id: "route-search-a",
      model: "search-a",
      providerId: "provider-a",
      upstreamModel: "search-a-upstream",
      endpointSupport: "responses",
      streamingSupport: "streaming",
      credentialSource: { type: "account", accountId: "acct_1" },
      priority: 60,
      health: { status: "healthy", lastLatencyMs: 500, lastSuccessAt: 1_000 },
      metadata: {
        modelProfile: {
          id: "profile-search-a",
          capabilities: { search: true, json: 0.9 },
          costTier: "low",
          contextWindowTokens: 64_000
        }
      }
    });

    expect(profile).toMatchObject({
      id: "profile-search-a",
      providerId: "provider-a",
      routeId: "route-search-a",
      model: "search-a",
      upstreamModel: "search-a-upstream",
      endpointSupport: "responses",
      streamingSupport: "streaming",
      credentialSource: { type: "account", accountId: "acct_1" },
      health: "healthy",
      lastSuccess: { at: 1_000, latencyMs: 500 },
      capabilities: { search: 1, json: 0.9 },
      costTier: "low",
      latencyMs: 500,
      contextWindowTokens: 64_000
    });
  });

  it("keeps same-name models distinct by provider route metadata and capability", () => {
    const profiles = [
      profile("provider-a/shared-chat", {
        providerId: "provider-a",
        routeId: "route-a",
        model: "shared-chat",
        endpointSupport: "responses",
        streamingSupport: "streaming",
        capabilities: { json: 1, search: 1 }
      }),
      profile("provider-b/shared-chat", {
        providerId: "provider-b",
        routeId: "route-b",
        model: "shared-chat",
        endpointSupport: "chat-completions",
        streamingSupport: "non-streaming",
        capabilities: { json: 1, code: 1 }
      })
    ];

    const searchDecision = routeModelByCapability(profiles, { required: ["search"] });
    const codeDecision = routeModelByCapability(profiles, { required: ["code"] });

    expect(searchDecision.selected).toMatchObject({
      model: "shared-chat",
      providerId: "provider-a",
      routeId: "route-a",
      endpointSupport: "responses"
    });
    expect(codeDecision.selected).toMatchObject({
      model: "shared-chat",
      providerId: "provider-b",
      routeId: "route-b",
      endpointSupport: "chat-completions"
    });
  });

  it("keeps same-name routes distinct by health, endpoint, streaming, credentials, and capabilities", () => {
    const profiles = [
      profile("account/shared-chat/responses-stream", {
        providerId: "account-center",
        routeId: "acct-responses-stream",
        model: "shared-chat",
        endpointSupport: "responses",
        streamingSupport: "streaming",
        credentialSource: { type: "account", accountId: "acct_1" },
        health: "degraded",
        capabilities: { code: 1, json: 1 }
      }),
      profile("direct/shared-chat/chat-nonstream", {
        providerId: "direct-provider",
        routeId: "direct-chat-nonstream",
        model: "shared-chat",
        endpointSupport: "chat-completions",
        streamingSupport: "non-streaming",
        credentialSource: { type: "api-key", credentialId: "direct_1" },
        health: "healthy",
        capabilities: { code: 1, search: 1, json: 1 }
      }),
      profile("account/shared-chat/responses-no-code", {
        providerId: "account-center",
        routeId: "acct-responses-nonstream",
        model: "shared-chat",
        endpointSupport: "responses",
        streamingSupport: "non-streaming",
        credentialSource: { type: "account", accountId: "acct_2" },
        health: "healthy",
        capabilities: { search: 1, json: 1 }
      })
    ];

    const streamingCode = routeModelByCapability(profiles, {
      required: ["code"],
      requiredEndpointSupport: ["responses"],
      requiredStreamingSupport: ["streaming"]
    });
    const chatSearch = routeModelByCapability(profiles, {
      required: ["search"],
      requiredEndpointSupport: ["chat-completions"],
      requiredStreamingSupport: ["non-streaming"]
    });

    expect(streamingCode.selected).toMatchObject({
      providerId: "account-center",
      routeId: "acct-responses-stream",
      model: "shared-chat",
      endpointSupport: "responses",
      streamingSupport: "streaming",
      credentialSource: { type: "account", accountId: "acct_1" }
    });
    expect(streamingCode.rejections.map((rejection) => [rejection.profile.id, rejection.reasons])).toEqual([
      ["account/shared-chat/responses-no-code", ["streaming:unsupported:streaming", "missing_required:code"]],
      ["direct/shared-chat/chat-nonstream", ["endpoint:unsupported:responses", "streaming:unsupported:streaming"]]
    ]);
    expect(chatSearch.selected).toMatchObject({
      providerId: "direct-provider",
      routeId: "direct-chat-nonstream",
      model: "shared-chat",
      endpointSupport: "chat-completions",
      streamingSupport: "non-streaming"
    });
  });

  it("serializes decisions to diagnostic metadata", () => {
    const decision = routeModelByCapability([profile("json-a", { capabilities: { json: 1 } })], { required: ["json"] });
    const metadata = modelRouteDecisionToMetadata(decision);

    expect(metadata).toMatchObject({
      selectedModelProfileId: "json-a",
      candidates: [{ id: "json-a", rank: 1 }],
      rejections: [],
      trace: expect.arrayContaining(["selected:json-a"])
    });
  });

  it("parses model profiles from untrusted metadata", () => {
    expect(modelProfileFromMetadata({ id: "meta-a", capabilities: { vision: 2, code: false }, aliases: [" alias-a ", ""] })).toMatchObject({
      id: "meta-a",
      aliases: ["alias-a"],
      capabilities: { vision: 1, code: 0 }
    });
    expect(modelProfileFromMetadata({ capabilities: { vision: 1 } })).toBeUndefined();
  });

  it("normalizes task hints into provider-neutral capability requests", () => {
    expect(
      capabilityRequestFromTask({
        kind: "code",
        priority: "quality",
        needsToolUse: true,
        needsJson: true,
        minimumContextTokens: 64_000
      })
    ).toMatchObject({
      required: ["code"],
      preferred: expect.arrayContaining(["tool-use", "json", "reasoning", "cache-friendly", "long-context"]),
      minimumContextTokens: 64_000
    });

    expect(
      capabilityRequestFromTask({
        kind: "vision",
        needsSearch: true,
        preferred: ["low-latency"]
      })
    ).toMatchObject({
      required: ["search", "vision"],
      preferred: expect.arrayContaining(["reasoning", "json", "low-latency"])
    });

    for (const kind of ["code", "search", "vision", "chinese-writing", "planning", "workflow", "background"] as const) {
      const request = capabilityRequestFromTask({ kind });
      expect(request).not.toHaveProperty("allowProviders");
      expect(request).not.toHaveProperty("denyProviders");
      expect(request).not.toHaveProperty("preferModelIds");
      expect(request).not.toHaveProperty("model");
      expect(request).not.toHaveProperty("providerId");
      expect(request).not.toHaveProperty("routeId");
    }
  });

  it("keeps cache-friendly as a soft capability preference instead of a model-name binding", () => {
    const profiles = [
      profile("arbitrary-display-name-b", { model: "same-display", capabilities: { code: 1, json: 1, "tool-use": 1 } }),
      profile("arbitrary-display-name-a", { model: "same-display", capabilities: { code: 1, json: 1, "tool-use": 1, "cache-friendly": 1 } })
    ];

    const decision = routeModelForTask(profiles, { kind: "code" });

    expect(decision.request).toMatchObject({
      required: ["code"],
      preferred: expect.arrayContaining(["cache-friendly"])
    });
    expect(decision.selected?.id).toBe("arbitrary-display-name-a");
    expect(decision.trace.join("|")).not.toContain("same-display:cache");
  });

  it("reports distinct rejection causes in routing trace and diagnostic metadata", () => {
    const decision = routeModelByCapability(
      [
        profile("provider-denied", { providerId: "blocked", capabilities: { code: 1 } }),
        profile("context-too-small", { providerId: "allowed", capabilities: { code: 1 }, contextWindowTokens: 4_000 }),
        profile("missing-capability", { providerId: "allowed", capabilities: { json: 1 }, contextWindowTokens: 64_000 }),
        profile("unavailable", { providerId: "allowed", availability: "unavailable", capabilities: { code: 1 }, contextWindowTokens: 64_000 })
      ],
      { required: ["code"], minimumContextTokens: 32_000 },
      { denyProviders: ["blocked"] }
    );
    const metadata = modelRouteDecisionToMetadata(decision);

    expect(decision.selected).toBeUndefined();
    expect(decision.trace).toEqual(
      expect.arrayContaining([
        "reject:provider-denied:provider:denied|context:unknown",
        "reject:context-too-small:context:too_small",
        "reject:missing-capability:missing_required:code",
        "reject:unavailable:availability:unavailable"
      ])
    );
    expect(metadata.rejections).toEqual(
      expect.arrayContaining([
        { id: "provider-denied", providerId: "blocked", routeId: null, reasons: ["provider:denied", "context:unknown"] },
        { id: "context-too-small", providerId: "allowed", routeId: null, reasons: ["context:too_small"] },
        { id: "missing-capability", providerId: "allowed", routeId: null, reasons: ["missing_required:code"] },
        { id: "unavailable", providerId: "allowed", routeId: null, reasons: ["availability:unavailable"] }
      ])
    );
  });

  it("routes task hints by capabilities instead of provider brand", () => {
    const profiles = [
      profile("code-fast", {
        providerId: "provider-a",
        capabilities: { code: 1, "tool-use": 1, json: 1, reasoning: 0.7, "low-latency": 1 },
        latencyMs: 300,
        costTier: "medium"
      }),
      profile("search-specialist", {
        providerId: "provider-b",
        capabilities: { search: 1, json: 0.9, reasoning: 0.6, "low-latency": 0.7 },
        latencyMs: 800,
        costTier: "low"
      }),
      profile("writer", {
        providerId: "provider-c",
        capabilities: { "chinese-writing": 1, reasoning: 0.7, "low-cost": 1 },
        latencyMs: 1_200,
        costTier: "low"
      })
    ];

    expect(routeModelForTask(profiles, { kind: "search", priority: "latency" }).selected?.id).toBe("search-specialist");
    expect(routeModelForTask(profiles, { kind: "chinese-writing", priority: "cost" }).selected?.id).toBe("writer");
    expect(routeModelForTask(profiles, { kind: "code", needsToolUse: true }).selected?.id).toBe("code-fast");
  });

  it("merges task policy with user/plugin overrides deterministically", () => {
    const merged = mergeModelRoutePolicies(
      { preferred: ["json"], weights: { cost: 20 }, preferModelIds: ["fast-a"], metadata: { source: "task" } },
      { required: ["code"], weights: { latency: 30 }, avoidModelIds: ["slow-b"], metadata: { user: true } }
    );

    expect(merged).toMatchObject({
      required: ["code"],
      preferred: ["json"],
      preferModelIds: ["fast-a"],
      avoidModelIds: ["slow-b"],
      weights: {
        cost: 20,
        latency: 30
      },
      metadata: {
        source: "task",
        user: true
      }
    });
  });
});

function profile(id: string, overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id,
    availability: "available",
    health: "healthy",
    ...overrides
  };
}
