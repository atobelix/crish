import { describe, expect, it } from "vitest";
import {
  allocateModelRoles,
  reallocateRoles,
  type MultiModelAssignment,
} from "./model-routing-roles";
import type { ModelProfile } from "./model-routing";

function profile(id: string, overrides: Partial<ModelProfile> & Record<string, any> = {}): ModelProfile {
  return { id, availability: "available", health: "healthy", ...overrides };
}

describe("selectBestFit (via allocateModelRoles)", () => {
  it("returns the best matching profile for primary when candidates exist", () => {
    const profiles = [
      profile("fast-a", { capabilities: { code: 1 } }),
      profile("code-b", {
        capabilities: { code: 1, "tool-use": 1 },
        capabilityFlags: { supportsFunctionCalling: true },
        contextWindowTokens: 128_000,
      }),
    ];
    const result = allocateModelRoles("code", profiles);
    expect(result.primary.id).toBe("code-b");
  });

  it("returns undefined for fast when no profile meets required constraints", () => {
    const profiles = [
      profile("no-code", {
        capabilities: { "tool-use": 1 },
        capabilityFlags: { supportsFunctionCalling: true },
      }),
    ];
    const result = allocateModelRoles("code", profiles);
    expect(result.primary).toBeDefined();
    expect(result.fast).toBeUndefined();
  });

  it("returns undefined for fast when task requires json but profile lacks it", () => {
    const profiles = [
      profile("no-json", {
        capabilities: { code: 1, "tool-use": 1 },
        capabilityFlags: { supportsFunctionCalling: true },
      }),
    ];
    const result = allocateModelRoles("planning", profiles);
    expect(result.primary).toBeDefined();
    expect(result.fast).toBeUndefined();
  });

  it("always assigns primary even if no profile matches (falls back to profiles[0])", () => {
    const profiles = [
      profile("fallback-a", {}),
    ];
    const result = allocateModelRoles("code", profiles);
    expect(result.primary.id).toBe("fallback-a");
  });

  it("assigns all roles when all constraints are satisfied", () => {
    const profiles = [
      profile("all-rounder", {
        capabilities: { code: 1, "tool-use": 1, json: 1, "low-cost": 1, "low-latency": 1 },
        capabilityFlags: { supportsFunctionCalling: true },
        contextWindowTokens: 128_000,
      }),
    ];
    const result = allocateModelRoles("code", profiles);
    expect(result.primary).toBeDefined();
    expect(result.fast).toBeDefined();
    expect(result.editor).toBeUndefined();
  });
});

describe("allocateModelRoles", () => {
  it("handles empty profiles gracefully", () => {
    const result = allocateModelRoles("chat", []);
    expect(result.primary.id).toBe("unknown");
  });
});

describe("reallocateRoles", () => {
  it("re-resolves specified roles with merged constraints", () => {
    const profiles = [
      profile("code-b", {
        capabilities: { code: 1, "tool-use": 1, json: 1 },
        capabilityFlags: { supportsFunctionCalling: true },
      }),
    ];
    const existing: MultiModelAssignment = { primary: profiles[0]! };
    const newProfiles = [
      profile("new-fast", {
        capabilities: { code: 1, json: 1 },
      }),
    ];
    const result = reallocateRoles(existing, ["fast"], newProfiles);
    expect(result.fast?.id).toBe("new-fast");
    expect(result.primary.id).toBe("code-b");
  });
});
