import { describe, expect, it } from "vitest";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "./types";
import { routeModelByCapability } from "./model-routing";
import {
  createProviderGateway,
  DefaultProviderGateway,
  ProviderGatewayError,
  StaticProviderRouteCatalog,
  type ProviderCredentialResolver,
  type ProviderFactoryPlan,
  type ProviderRouteOffer
} from "./provider-gateway";

class PlannedProvider implements AgentProvider {
  readonly id: string;

  constructor(readonly plan: ProviderFactoryPlan) {
    this.id = `${plan.route.providerId}:${plan.route.upstreamModel}`;
  }

  async *stream(_request: AgentProviderRequest): AsyncIterable<ProviderStreamEvent> {
    yield { type: "stop", reason: "stop" };
  }
}

describe("ProviderGateway", () => {
  it("plans an account-backed route with resolved account credentials", async () => {
    const resolver: ProviderCredentialResolver = {
      resolveCredential({ request, credentialSource }) {
        expect(credentialSource.type).toBe("account");
        return {
          id: "acct-runtime-key",
          source: "account",
          providerId: credentialSource.providerId ?? "account-center",
          accountId: credentialSource.type === "account" ? credentialSource.accountId ?? request.accountId : request.accountId,
          apiKey: "runtime-key",
          baseUrl: "https://gateway.example/v1",
          metadata: { quota: "account" }
        };
      }
    };
    const gateway = createProviderGateway({
      credentialResolver: resolver,
      routes: [
        {
          id: "account-mimo",
          model: "mimo-large",
          providerId: "account-center",
          upstreamModel: "mimo-v2.5",
          priority: 100,
          credentialSource: {
            type: "account",
            keyClass: "internal"
          },
          providerOptions: {
            endpoint: "chat-completions"
          }
        }
      ]
    });

    const plan = await gateway.planRoute({ accountId: "acct_1", model: "mimo-large" });

    expect(plan).toMatchObject({
      ok: true,
      requestedModel: "mimo-large",
      credentialConfigured: true,
      selectedRoute: {
        routeId: "account-mimo",
        providerId: "account-center",
        upstreamModel: "mimo-v2.5",
        credentialSourceType: "account"
      },
      providerPlan: {
        kind: "provider-factory-plan",
        credential: {
          id: "acct-runtime-key",
          accountId: "acct_1",
          apiKey: "runtime-key"
        }
      }
    });
    expect(plan.routeDecision).toEqual(
      expect.arrayContaining(["candidate_routes:1", "available_routes:1", "selected_provider:account-center", "selected_route:account-mimo"])
    );

    const providerPlan = await gateway.resolveProvider({ accountId: "acct_1", model: "mimo-large", materializeProvider: false });
    expect(providerPlan).toMatchObject({
      kind: "provider-factory-plan",
      route: {
        routeId: "account-mimo",
        upstreamModel: "mimo-v2.5"
      }
    });
  });

  it("materializes an AgentProvider from a direct api-key route factory", async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: "direct-openai",
          model: "gpt-4o",
          providerId: "openai",
          upstreamModel: "gpt-4o-2024-11-20",
          credentialSource: {
            type: "api-key",
            apiKey: "sk-test",
            baseUrl: "https://api.openai.example/v1",
            headers: { "x-tenant": "local" }
          },
          providerFactory: (plan) => new PlannedProvider(plan)
        }
      ]
    });

    const provider = await gateway.resolveProvider({ model: "gpt-4o" });
    const plannedProvider = provider as PlannedProvider;

    expect(provider).toBeInstanceOf(PlannedProvider);
    expect(plannedProvider.id).toBe("openai:gpt-4o-2024-11-20");
    expect(plannedProvider.plan.credential).toMatchObject({
      source: "api-key",
      providerId: "openai",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.example/v1",
      headers: { "x-tenant": "local" }
    });
  });

  it("selects by priority and health while skipping cooldown routes before fallback", async () => {
    const now = 1_000;
    const routes: ProviderRouteOffer[] = [
      {
        id: "primary-hot",
        model: "chat",
        providerId: "fast",
        priority: 200,
        credentialSource: { type: "api-key", apiKey: "hot" },
        health: {
          status: "healthy",
          cooldownUntil: now + 60_000
        }
      },
      {
        id: "primary-healthy",
        model: "chat",
        providerId: "steady",
        priority: 100,
        credentialSource: { type: "api-key", apiKey: "steady" },
        health: {
          status: "healthy",
          successCount: 20
        }
      },
      {
        id: "fallback-expensive",
        model: "chat",
        providerId: "backup",
        priority: 300,
        fallback: true,
        credentialSource: { type: "api-key", apiKey: "backup" },
        health: {
          status: "healthy"
        }
      }
    ];
    const gateway = new DefaultProviderGateway({ routes, now: () => now });

    const plan = await gateway.planRoute({ model: "chat" });

    expect(plan.ok).toBe(true);
    expect(plan.selectedRoute?.routeId).toBe("primary-healthy");
    expect(plan.fallbackUsed).toBe(false);
    expect(plan.cooldownCandidateCount).toBe(1);
    expect(plan.routeDecision).toEqual(expect.arrayContaining(["cooldown_routes:1", "selected_provider:steady"]));
  });

  it("uses fallback only after primary routes are unavailable", async () => {
    const now = 1_000;
    const gateway = createProviderGateway({
      now: () => now,
      routes: [
        {
          id: "primary-cooling",
          model: "chat",
          providerId: "primary",
          priority: 100,
          credentialSource: { type: "api-key", apiKey: "primary" },
          health: {
            cooldownUntil: now + 60_000
          }
        },
        {
          id: "fallback-ready",
          model: "chat",
          providerId: "fallback",
          priority: 1,
          fallback: true,
          credentialSource: { type: "api-key", apiKey: "fallback" }
        }
      ]
    });

    const plan = await gateway.planRoute({ model: "chat" });

    expect(plan.ok).toBe(true);
    expect(plan.selectedRoute?.routeId).toBe("fallback-ready");
    expect(plan.fallbackUsed).toBe(true);
    expect(plan.routeDecision).toContain("fallback_route_used");
  });

  it("records route results and cools down repeated failures", async () => {
    let now = 10_000;
    const catalog = new StaticProviderRouteCatalog(
      [
        {
          id: "a",
          model: "chat",
          providerId: "a",
          priority: 100,
          credentialSource: { type: "api-key", apiKey: "a" }
        },
        {
          id: "b",
          model: "chat",
          providerId: "b",
          priority: 90,
          credentialSource: { type: "api-key", apiKey: "b" }
        }
      ],
      {
        now: () => now,
        failureCooldownThreshold: 2,
        cooldownMs: 1_000
      }
    );
    const gateway = new DefaultProviderGateway({ catalog, now: () => now });

    expect((await gateway.planRoute({ model: "chat" })).selectedRoute?.routeId).toBe("a");

    await gateway.recordRouteResult({ routeId: "a", ok: false, errorCode: "rate-limit", latencyMs: 120 });
    await gateway.recordRouteResult({ routeId: "a", ok: false, errorCode: "rate-limit", latencyMs: 90 });

    const cooledPlan = await gateway.planRoute({ model: "chat" });
    expect(cooledPlan.selectedRoute?.routeId).toBe("b");
    expect(cooledPlan.cooldownCandidateCount).toBe(1);

    await gateway.recordRouteResult({ routeId: "a", ok: true, latencyMs: 80 });

    const recoveredPlan = await gateway.planRoute({ model: "chat" });
    expect(recoveredPlan.selectedRoute?.routeId).toBe("a");

    now += 2_000;
    expect((await gateway.planRoute({ model: "chat" })).selectedRoute?.routeId).toBe("a");
  });

  it("reports missing account credentials without trying a network provider", async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: "account-only",
          model: "chat",
          providerId: "account-center",
          credentialSource: {
            type: "account",
            accountId: "acct_1"
          }
        }
      ]
    });

    const plan = await gateway.planRoute({ model: "chat", accountId: "acct_1" });
    expect(plan).toMatchObject({
      ok: false,
      code: "provider_credential_missing",
      credentialConfigured: false,
      selectedRoute: {
        routeId: "account-only"
      }
    });

    await expect(gateway.resolveProvider({ model: "chat", accountId: "acct_1" })).rejects.toBeInstanceOf(ProviderGatewayError);
  });

  it("carries capability routing metadata through provider plans", async () => {
    const capabilityRequest = { required: ["json"], preferred: ["low-latency"] };
    const modelProfile = {
      id: "json-a-profile",
      providerId: "provider-a",
      capabilities: { json: 1, "low-latency": 0.7 },
      costTier: "low" as const
    };
    const modelRouteDecision = routeModelByCapability([modelProfile], capabilityRequest);
    const gateway = createProviderGateway({
      routes: [
        {
          id: "json-a-route",
          model: "json-a",
          providerId: "provider-a",
          modelProfile,
          credentialSource: { type: "api-key", apiKey: "key" }
        }
      ]
    });

    const plan = await gateway.planRoute({ model: "json-a", capabilityRequest, modelRouteDecision });

    expect(plan.ok).toBe(true);
    expect(plan.capabilityRequest).toBe(capabilityRequest);
    expect(plan.modelRouteDecision?.selected?.id).toBe("json-a-profile");
    expect(plan.providerPlan?.modelProfile?.id).toBe("json-a-profile");
    expect(plan.providerPlan?.metadata).toMatchObject({
      capabilityRequest: { required: ["json"], preferred: ["low-latency"] },
      modelRouting: {
        selectedProfileId: "json-a-profile",
        candidateCount: 1,
        rejectionCount: 0,
        trace: expect.arrayContaining(["selected:json-a-profile"])
      }
    });
  });

  it("selects same-name models by provider and route identity from capability routing", async () => {
    const sharedModel = "shared-chat";
    const capabilityRequest = { required: ["code"] };
    const profiles = [
      {
        id: "provider-a/shared-chat",
        providerId: "provider-a",
        routeId: "route-a",
        model: sharedModel,
        capabilities: { search: 1 },
        endpointSupport: "responses" as const
      },
      {
        id: "provider-b/shared-chat",
        providerId: "provider-b",
        routeId: "route-b",
        model: sharedModel,
        capabilities: { code: 1 },
        endpointSupport: "chat-completions" as const
      }
    ];
    const modelRouteDecision = routeModelByCapability(profiles, capabilityRequest);
    const gateway = createProviderGateway({
      routes: [
        {
          id: "route-a",
          model: sharedModel,
          providerId: "provider-a",
          endpointSupport: "responses",
          streamingSupport: "streaming",
          credentialSource: { type: "api-key", apiKey: "a" }
        },
        {
          id: "route-b",
          model: sharedModel,
          providerId: "provider-b",
          endpointSupport: "chat-completions",
          streamingSupport: "non-streaming",
          credentialSource: { type: "account", accountId: "acct_b" }
        }
      ],
      credentialResolver: {
        resolveCredential({ route, credentialSource }) {
          return {
            id: `${route.id}:credential`,
            source: credentialSource.type,
            providerId: route.providerId,
            accountId: credentialSource.type === "account" ? credentialSource.accountId : undefined,
            apiKey: `${route.providerId}-key`
          };
        }
      }
    });

    const plan = await gateway.planRoute({ model: sharedModel, capabilityRequest, modelRouteDecision });

    expect(modelRouteDecision.selected).toMatchObject({
      providerId: "provider-b",
      routeId: "route-b",
      model: sharedModel
    });
    expect(plan).toMatchObject({
      ok: true,
      selectedRoute: {
        routeId: "route-b",
        providerId: "provider-b",
        model: sharedModel,
        endpointSupport: "chat-completions",
        streamingSupport: "non-streaming",
        credentialSourceType: "account",
        credentialSource: {
          type: "account",
          accountId: "acct_b"
        }
      },
      candidateCount: 1
    });
  });

  it("keeps selected route credential status redacted for direct api-key routes", async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: "direct-sensitive",
          model: "chat",
          providerId: "direct-provider",
          credentialSource: {
            type: "api-key",
            apiKey: "sk-live-secret",
            credentialId: "cred_1",
            baseUrl: "https://provider.example/v1",
            headers: {
              authorization: "Bearer header-secret",
              "x-safe-header": "visible-name-only"
            },
            metadata: {
              apiKey: "metadata-secret",
              nested: {
                bearerToken: "nested-secret"
              },
              label: "local-dev"
            }
          }
        }
      ]
    });

    const plan = await gateway.planRoute({ model: "chat" });
    const serialized = JSON.stringify(plan.selectedRoute);

    expect(plan.ok).toBe(true);
    expect(plan.selectedRoute?.credentialSource).toEqual({
      type: "api-key",
      providerId: undefined,
      credentialId: "cred_1",
      baseUrl: "https://provider.example/v1",
      headerNames: ["authorization", "x-safe-header"],
      metadata: {
        apiKey: "[redacted]",
        nested: {
          bearerToken: "[redacted]"
        },
        label: "local-dev"
      }
    });
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("metadata-secret");
    expect(serialized).not.toContain("nested-secret");
  });

  it("surfaces model-routing rejection causes alongside gateway cooldown and credential failures", async () => {
    const now = 10_000;
    const modelRouteDecision = routeModelByCapability(
      [
        {
          id: "provider-denied",
          providerId: "blocked",
          model: "chat",
          capabilities: { code: 1 },
          availability: "available",
          health: "healthy"
        },
        {
          id: "context-too-small",
          providerId: "allowed",
          model: "chat",
          capabilities: { code: 1 },
          contextWindowTokens: 4_000,
          availability: "available",
          health: "healthy"
        },
        {
          id: "missing-capability",
          providerId: "allowed",
          model: "chat",
          capabilities: { json: 1 },
          contextWindowTokens: 64_000,
          availability: "available",
          health: "healthy"
        }
      ],
      { required: ["code"], minimumContextTokens: 32_000 },
      { denyProviders: ["blocked"] }
    );
    const gateway = createProviderGateway({
      now: () => now,
      routes: [
        {
          id: "cooling",
          model: "chat",
          providerId: "allowed",
          credentialSource: { type: "api-key", apiKey: "cooling" },
          health: { cooldownUntil: now + 60_000 }
        }
      ]
    });

    const plan = await gateway.planRoute({
      model: "chat",
      capabilityRequest: { required: ["code"], minimumContextTokens: 32_000 },
      modelRouteDecision
    });

    expect(plan).toMatchObject({
      ok: false,
      code: "route_in_cooldown",
      cooldownCandidateCount: 1
    });
    expect(plan.routeDecision).toEqual(
      expect.arrayContaining([
        "model_route_selected:none",
        "capability_required:code",
        "capability_minimum_context:32000",
        "model_route_rejection:context:too_small:1",
        "model_route_rejection:context:unknown:1",
        "model_route_rejection:missing_required:code:1",
        "model_route_rejection:provider:denied:1",
        "model_route_no_selected_candidate",
        "cooldown_routes:1",
        "route_in_cooldown"
      ])
    );
  });

  it("preserves credential-missing diagnostics after capability routing selects a route", async () => {
    const capabilityRequest = {
      required: ["code"],
      requiredEndpointSupport: ["responses" as const],
      requiredStreamingSupport: ["streaming" as const]
    };
    const modelRouteDecision = routeModelByCapability(
      [
        {
          id: "account-route-profile",
          providerId: "account-center",
          routeId: "account-code",
          model: "shared-chat",
          endpointSupport: "responses",
          streamingSupport: "streaming",
          capabilities: { code: 1 },
          availability: "available",
          health: "healthy"
        }
      ],
      capabilityRequest
    );
    const gateway = createProviderGateway({
      routes: [
        {
          id: "account-code",
          model: "shared-chat",
          providerId: "account-center",
          endpointSupport: "responses",
          streamingSupport: "streaming",
          credentialSource: { type: "account", accountId: "acct_missing", metadata: { apiKey: "must-not-leak" } }
        }
      ]
    });

    const plan = await gateway.planRoute({
      model: "shared-chat",
      accountId: "acct_missing",
      capabilityRequest,
      modelRouteDecision
    });
    const serializedRoute = JSON.stringify(plan.selectedRoute);

    expect(plan).toMatchObject({
      ok: false,
      code: "provider_credential_missing",
      selectedRoute: {
        routeId: "account-code",
        providerId: "account-center",
        endpointSupport: "responses",
        streamingSupport: "streaming",
        credentialSource: {
          type: "account",
          accountId: "acct_missing",
          metadata: { apiKey: "[redacted]" }
        }
      }
    });
    expect(plan.routeDecision).toEqual(
      expect.arrayContaining(["model_route_selected:account-route-profile", "capability_required:code", "selected_route:account-code", "credential_missing"])
    );
    expect(plan.providerPlan).toBeUndefined();
    expect(serializedRoute).not.toContain("must-not-leak");
  });

  it("exposes route health events on selected route metadata", async () => {
    let now = 50_000;
    const catalog = new StaticProviderRouteCatalog(
      [
        {
          id: "health-route",
          model: "chat",
          providerId: "provider-a",
          credentialSource: { type: "api-key", apiKey: "key" }
        }
      ],
      { now: () => now }
    );
    const gateway = new DefaultProviderGateway({ catalog, now: () => now });

    await gateway.recordRouteResult({ routeId: "health-route", ok: false, errorCode: "rate-limit", latencyMs: 250 });
    now += 1_000;
    let plan = await gateway.planRoute({ model: "chat" });
    expect(plan.selectedRoute?.lastFailure).toMatchObject({
      at: 50_000,
      latencyMs: 250,
      errorCode: "rate-limit"
    });

    await gateway.recordRouteResult({ routeId: "health-route", ok: true, latencyMs: 100 });
    plan = await gateway.planRoute({ model: "chat" });
    expect(plan.selectedRoute?.lastSuccess).toMatchObject({
      at: 51_000,
      latencyMs: 100,
      errorCode: null
    });
  });
});
