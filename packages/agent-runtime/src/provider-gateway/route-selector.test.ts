import { describe, expect, it, vi } from "vitest";
import {
  StaticProviderRouteCatalog,
  routeMatchesRequest,
  routeMatchesModel,
  routeInCooldown,
  compareRouteOffers,
  routeHealthScore,
  statusHealthScore,
  failurePlan,
  toRouteSelection,
} from "./route-selector";
import {
  createProviderGateway,
  ProviderGatewayError,
  type ProviderRouteOffer,
} from "./index";
import { FauxProviderCallGateway } from "../testing/faux-call-gateway";
import type { ProviderGatewayPlan } from "./types";

function route(id: string, overrides: Partial<ProviderRouteOffer> = {}): ProviderRouteOffer {
  return {
    id,
    model: "chat",
    providerId: "p1",
    credentialSource: { type: "api-key", apiKey: "key1" },
    ...overrides,
  };
}

describe("StaticProviderRouteCatalog", () => {
  it("records a successful result and updates health", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")], { now: () => 1000 });
    const health = catalog.recordRouteResult({ routeId: "r1", ok: true, latencyMs: 50 });
    expect(health).toMatchObject({ status: "healthy", successCount: 1, failureCount: 0, consecutiveFailures: 0, lastLatencyMs: 50 });
    expect(health?.cooldownUntil).toBeNull();
  });

  it("records a failure result and increments consecutive failures", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")], { now: () => 1000, failureCooldownThreshold: 3, cooldownMs: 5000 });
    const health = catalog.recordRouteResult({ routeId: "r1", ok: false, errorCode: "rate-limit", latencyMs: 100 });
    expect(health).toMatchObject({ status: "degraded", successCount: 0, failureCount: 1, consecutiveFailures: 1, lastErrorCode: "rate-limit", lastLatencyMs: 100 });
    expect(health?.cooldownUntil).toBeNull();
  });

  it("triggers cooldown after threshold failures", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")], { now: () => 1000, failureCooldownThreshold: 2, cooldownMs: 10_000 });
    catalog.recordRouteResult({ routeId: "r1", ok: false, errorCode: "timeout" });
    const health = catalog.recordRouteResult({ routeId: "r1", ok: false, errorCode: "timeout" });
    expect(health?.status).toBe("unhealthy");
    expect(health?.cooldownUntil).toBe(1000 + 10_000);
    expect(health?.consecutiveFailures).toBe(2);
  });

  it("uses cooldownUntil override from result", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")], { now: () => 1000, failureCooldownThreshold: 1, cooldownMs: 5000 });
    const health = catalog.recordRouteResult({ routeId: "r1", ok: false, cooldownUntil: 9999 });
    expect(health?.cooldownUntil).toBe(9999);
  });

  it("uses dynamic cooldown function", () => {
    const cooldownMs = vi.fn((failures: number) => failures * 1000);
    const catalog = new StaticProviderRouteCatalog([route("r1")], { now: () => 1000, failureCooldownThreshold: 1, cooldownMs });
    catalog.recordRouteResult({ routeId: "r1", ok: false });
    const health = catalog.recordRouteResult({ routeId: "r1", ok: false });
    expect(cooldownMs).toHaveBeenCalledWith(2);
    expect(health?.cooldownUntil).toBe(1000 + 2000);
  });

  it("recovers health after a successful result following failures", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")], { now: () => 1000 });
    catalog.recordRouteResult({ routeId: "r1", ok: false, errorCode: "error" });
    const health = catalog.recordRouteResult({ routeId: "r1", ok: true, latencyMs: 30 });
    expect(health).toMatchObject({ status: "healthy", successCount: 1, failureCount: 1, consecutiveFailures: 0, lastLatencyMs: 30 });
    expect(health?.cooldownUntil).toBeNull();
  });

  it("returns undefined for unknown routeId in recordRouteResult", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")]);
    const result = catalog.recordRouteResult({ routeId: "nonexistent", ok: true });
    expect(result).toBeUndefined();
  });

  it("filters routes by model", () => {
    const catalog = new StaticProviderRouteCatalog([
      route("r1", { model: "gpt-4" }),
      route("r2", { model: "claude" }),
    ]);
    expect(catalog.listRoutes({ model: "gpt-4" })).toHaveLength(1);
    expect(catalog.listRoutes({ model: "nonexistent" })).toHaveLength(0);
  });

  it("filters routes by providerId", () => {
    const catalog = new StaticProviderRouteCatalog([
      route("r1", { providerId: "a" }),
      route("r2", { providerId: "b" }),
    ]);
    expect(catalog.listRoutes({ providerId: "a" })).toHaveLength(1);
  });

  it("hasRoute returns true for existing route", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")]);
    expect(catalog.hasRoute("r1")).toBe(true);
    expect(catalog.hasRoute("nonexistent")).toBe(false);
  });

  it("removeRoute removes a route and returns true", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")]);
    expect(catalog.removeRoute("r1")).toBe(true);
    expect(catalog.hasRoute("r1")).toBe(false);
  });

  it("removeRoute returns false for nonexistent route", () => {
    const catalog = new StaticProviderRouteCatalog([]);
    expect(catalog.removeRoute("nonexistent")).toBe(false);
  });

  it("lists cloned routes so mutations do not affect internal state", () => {
    const catalog = new StaticProviderRouteCatalog([route("r1")]);
    const listed = catalog.listRoutes();
    listed[0]!.priority = 999;
    const again = catalog.listRoutes();
    expect(again[0]?.priority).toBeUndefined();
  });
});

describe("route matching", () => {
  it("routeMatchesRequest matches by routeId", () => {
    const r = route("my-route");
    expect(routeMatchesRequest(r, { model: "chat", routeId: "my-route" }, "chat")).toBe(true);
    expect(routeMatchesRequest(r, { model: "chat", routeId: "other" }, "chat")).toBe(false);
  });

  it("routeMatchesRequest matches by providerId", () => {
    const r = route("r1", { providerId: "provider-a" });
    expect(routeMatchesRequest(r, { model: "chat", providerId: "provider-a" }, "chat")).toBe(true);
    expect(routeMatchesRequest(r, { model: "chat", providerId: "provider-b" }, "chat")).toBe(false);
  });

  it("routeMatchesModel matches model by alias", () => {
    const r = route("r1", { model: "gpt-4", aliases: ["gpt-4-turbo", "gpt-4-32k"] });
    expect(routeMatchesModel(r, "gpt-4")).toBe(true);
    expect(routeMatchesModel(r, "gpt-4-turbo")).toBe(true);
    expect(routeMatchesModel(r, "gpt-4-32k")).toBe(true);
    expect(routeMatchesModel(r, "gpt-5")).toBe(false);
  });
});

describe("routeInCooldown", () => {
  it("returns false when no health data", () => {
    expect(routeInCooldown(route("r1"), 1000)).toBe(false);
  });

  it("returns true when cooldownUntil is in the future", () => {
    const r = route("r1", { health: { cooldownUntil: 2000 } });
    expect(routeInCooldown(r, 1000)).toBe(true);
  });

  it("returns false when cooldownUntil has passed", () => {
    const r = route("r1", { health: { cooldownUntil: 500 } });
    expect(routeInCooldown(r, 1000)).toBe(false);
  });

  it("returns false when cooldownUntil is null", () => {
    const r = route("r1", { health: { cooldownUntil: null } });
    expect(routeInCooldown(r, 1000)).toBe(false);
  });
});

describe("compareRouteOffers", () => {
  it("prefers higher priority", () => {
    const high = route("a", { priority: 200 });
    const low = route("b", { priority: 100 });
    expect(compareRouteOffers(high, low, 1000)).toBeLessThan(0);
    expect(compareRouteOffers(low, high, 1000)).toBeGreaterThan(0);
  });

  it("prefers higher health score when priority equal", () => {
    const healthy = route("a", { priority: 100, health: { status: "healthy", successCount: 10 } });
    const degraded = route("b", { priority: 100, health: { status: "degraded" } });
    expect(compareRouteOffers(healthy, degraded, 1000)).toBeLessThan(0);
  });

  it("uses routingWeight as second tiebreaker", () => {
    const heavy = route("a", { priority: 100, routingWeight: 200 });
    const light = route("b", { priority: 100, routingWeight: 50 });
    expect(compareRouteOffers(heavy, light, 1000)).toBeLessThan(0);
  });

  it("uses id as final tiebreaker", () => {
    const a = route("a", { priority: 100 });
    const b = route("b", { priority: 100 });
    expect(compareRouteOffers(a, b, 1000)).toBeLessThan(0);
  });
});

describe("routeHealthScore", () => {
  it("returns 80 when no health data", () => {
    expect(routeHealthScore(route("r1"), 1000)).toBe(80);
  });

  it("returns 0 when route is in cooldown", () => {
    const r = route("r1", { health: { cooldownUntil: 2000 } });
    expect(routeHealthScore(r, 1000)).toBe(0);
  });

  it("returns 100 for healthy route with no failures", () => {
    const r = route("r1", { health: { status: "healthy", successCount: 10, failureCount: 0 } });
    expect(routeHealthScore(r, 1000)).toBeGreaterThanOrEqual(90);
  });

  it("penalizes consecutive failures", () => {
    const r = route("r1", { health: { status: "degraded", consecutiveFailures: 4, successCount: 5, failureCount: 4 } });
    const score = routeHealthScore(r, 1000);
    expect(score).toBeLessThan(80);
  });

  it("penalizes high latency", () => {
    const r = route("r1", { health: { status: "degraded", lastLatencyMs: 12000, successCount: 5, failureCount: 5 } });
    const score = routeHealthScore(r, 1000);
    expect(score).toBe(48);
  });
});

describe("statusHealthScore", () => {
  it("returns 100 for healthy", () => expect(statusHealthScore("healthy")).toBe(100));
  it("returns 60 for degraded", () => expect(statusHealthScore("degraded")).toBe(60));
  it("returns 20 for unhealthy", () => expect(statusHealthScore("unhealthy")).toBe(20));
  it("returns 80 for unknown", () => expect(statusHealthScore(undefined)).toBe(80));
});

describe("failurePlan", () => {
  it("creates a non-ok plan with given code and defaults", () => {
    const plan = failurePlan({ code: "route_not_found", requestedModel: "chat", routeDecision: [], candidateCount: 0, availableCandidateCount: 0, cooldownCandidateCount: 0, fallbackUsed: false });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("route_not_found");
    expect(plan.credentialConfigured).toBe(false);
  });
});

describe("toRouteSelection", () => {
  it("preserves route fields and redacts credential source", () => {
    const r = route("sel-1", {
      model: "gpt-4",
      upstreamModel: "gpt-4-2024",
      priority: 50,
      routingWeight: 100,
      fallback: true,
      credentialSource: { type: "api-key", apiKey: "sk-secret" },
    });
    const sel = toRouteSelection(r, "gpt-4", 1000);
    expect(sel.routeId).toBe("sel-1");
    expect(sel.model).toBe("gpt-4");
    expect(sel.upstreamModel).toBe("gpt-4-2024");
    expect(sel.priority).toBe(50);
    expect(sel.routingWeight).toBe(100);
    expect(sel.fallback).toBe(true);
    expect(sel.credentialSourceType).toBe("api-key");
    expect(JSON.stringify(sel)).not.toContain("sk-secret");
  });
});

describe("DefaultProviderGateway resolves credentials via direct resolver", () => {
  it("returns plan with provider_credential_missing when resolver returns null and source is account", async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: "acct-route",
          model: "chat",
          providerId: "acct",
          credentialSource: { type: "account", accountId: "acct_1" },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: "chat", accountId: "acct_1" });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("provider_credential_missing");
  });

  it("throws ProviderGatewayError when resolveProvider called with missing credential", async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: "no-cred",
          model: "chat",
          providerId: "p",
          credentialSource: { type: "account", accountId: "acct_1" },
        },
      ],
    });
    await expect(gateway.resolveProvider({ model: "chat", accountId: "acct_1" })).rejects.toThrow(ProviderGatewayError);
  });
});

describe("DefaultProviderGateway — fallback scenarios", () => {
  it("returns route_not_found when allowFallback is false and only fallback routes exist", async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: "fallback-only",
          model: "chat",
          providerId: "fb",
          fallback: true,
          credentialSource: { type: "api-key", apiKey: "fb-key" },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: "chat", allowFallback: false });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("route_not_found");
  });

  it("returns route_in_cooldown when all active routes are in cooldown", async () => {
    const now = 1000;
    const gateway = createProviderGateway({
      now: () => now,
      routes: [
        {
          id: "cooling1",
          model: "chat",
          providerId: "p1",
          credentialSource: { type: "api-key", apiKey: "k1" },
          health: { cooldownUntil: now + 60_000 },
        },
        {
          id: "cooling2",
          model: "chat",
          providerId: "p2",
          credentialSource: { type: "api-key", apiKey: "k2" },
          health: { cooldownUntil: now + 30_000 },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: "chat" });
    expect(plan.ok).toBe(false);
    expect(plan.code).toBe("route_in_cooldown");
    expect(plan.cooldownCandidateCount).toBe(2);
  });
});

describe("DefaultProviderGateway — capability routing with hasMedia", () => {
  it("auto-adds vision capability when request has media", async () => {
    const gateway = createProviderGateway({
      routes: [
        {
          id: "vision-route",
          model: "vision-model",
          providerId: "p",
          credentialSource: { type: "api-key", apiKey: "sk-vision-test-key-12345" },
        },
      ],
    });
    const plan = await gateway.planRoute({ model: "vision-model", hasMedia: true });
    expect(plan.ok).toBe(true);
    expect(plan.routeDecision).toContain("request_has_media:vision_auto_required");
  });
});

describe("FauxProviderCallGateway — routing decisions", () => {
  it("records planRoute decisions", async () => {
    const faux = new FauxProviderCallGateway();
    const plan: ProviderGatewayPlan = {
      ok: true,
      requestedModel: "gpt-4",
      credentialConfigured: true,
      candidateCount: 1,
      availableCandidateCount: 1,
      cooldownCandidateCount: 0,
      fallbackUsed: false,
      routeDecision: ["selected_provider:openai"],
    };
    faux.setPlan("gpt-4", plan);

    const result = await faux.planRoute({ model: "gpt-4" });
    expect(result.ok).toBe(true);
    expect(faux.getDecisions()).toHaveLength(1);
    expect(faux.getDecisions()[0]!.method).toBe("planRoute");
  });

  it("records resolveProvider decisions", async () => {
    const faux = new FauxProviderCallGateway();
    const mockProvider = { id: "mock", stream: async function* () {} };
    faux.setProvider("gpt-4", mockProvider);

    const result = await faux.resolveProvider({ model: "gpt-4" });
    expect(result).toBe(mockProvider);
    expect(faux.getDecisions()).toHaveLength(1);
    expect(faux.getDecisions()[0]!.method).toBe("resolveProvider");
  });

  it("records recordRouteResult decisions", async () => {
    const faux = new FauxProviderCallGateway();
    faux.setPlan("chat", {
      ok: true,
      requestedModel: "chat",
      credentialConfigured: true,
      candidateCount: 1,
      availableCandidateCount: 1,
      cooldownCandidateCount: 0,
      fallbackUsed: false,
      routeDecision: [],
    });

    await faux.planRoute({ model: "chat" });
    faux.recordRouteResult({ routeId: "r1", ok: true });
    expect(faux.getDecisions()).toHaveLength(2);
  });

  it("clearDecisions resets recorded decisions", async () => {
    const faux = new FauxProviderCallGateway();
    faux.setPlan("chat", {
      ok: true, requestedModel: "chat", credentialConfigured: true,
      candidateCount: 0, availableCandidateCount: 0, cooldownCandidateCount: 0, fallbackUsed: false, routeDecision: [],
    });
    await faux.planRoute({ model: "chat" });
    expect(faux.getDecisions().length).toBeGreaterThan(0);
    faux.clearDecisions();
    expect(faux.getDecisions()).toHaveLength(0);
  });

  it("reset clears all state", async () => {
    const faux = new FauxProviderCallGateway();
    faux.setPlan("chat", {
      ok: true, requestedModel: "chat", credentialConfigured: true,
      candidateCount: 0, availableCandidateCount: 0, cooldownCandidateCount: 0, fallbackUsed: false, routeDecision: [],
    });
    faux.setDefaultProvider({ id: "mock", stream: async function* () {} });
    faux.reset();
    await expect(faux.planRoute({ model: "chat" })).rejects.toThrow("No plan found");
    await expect(faux.resolveProvider({ model: "chat" })).rejects.toThrow("No provider found");
  });

  it("uses defaultPlan when no model-specific plan is set", async () => {
    const faux = new FauxProviderCallGateway();
    const defaultPlan: ProviderGatewayPlan = {
      ok: false,
      requestedModel: "unknown",
      credentialConfigured: false,
      candidateCount: 0,
      availableCandidateCount: 0,
      cooldownCandidateCount: 0,
      fallbackUsed: false,
      code: "route_not_found",
      routeDecision: [],
    };
    faux.setDefaultPlan(defaultPlan);
    const result = await faux.planRoute({ model: "unknown" });
    expect(result.code).toBe("route_not_found");
  });

  it("uses defaultProvider via factory when set as function", async () => {
    const faux = new FauxProviderCallGateway();
    faux.setDefaultProvider(() => ({ id: "factory-provider", stream: async function* () {} }));
    const result = await faux.resolveProvider({ model: "any" });
    expect(result).toMatchObject({ id: "factory-provider" });
  });
});
