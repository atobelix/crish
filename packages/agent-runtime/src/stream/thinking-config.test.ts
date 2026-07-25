import { describe, expect, it } from "vitest";
import {
  resolveThinkingConfig,
  effortToBudgetTokens,
  extractThinkingFromDelta,
} from "./thinking-config";

describe("resolveThinkingConfig", () => {
  describe("disabled mode", () => {
    it("returns empty params for all vendors", () => {
      const config = { mode: "disabled" as const };
      expect(resolveThinkingConfig(config, "openai")).toEqual({ params: {} });
      expect(resolveThinkingConfig(config, "anthropic")).toEqual({ params: {} });
      expect(resolveThinkingConfig(config, "deepseek")).toEqual({ params: {} });
      expect(resolveThinkingConfig(config, "gemini")).toEqual({ params: {} });
      expect(resolveThinkingConfig(config, "unknown")).toEqual({ params: {} });
    });
  });

  describe("adaptive mode", () => {
    it("openai maps effort to reasoning.effort", () => {
      const result = resolveThinkingConfig({ mode: "adaptive", effort: "high" }, "openai");
      expect(result.params).toEqual({ reasoning: { effort: "high" } });
    });

    it("openai defaults effort to medium", () => {
      const result = resolveThinkingConfig({ mode: "adaptive" }, "openai");
      expect(result.params).toEqual({ reasoning: { effort: "medium" } });
    });

    it("anthropic adaptive mode returns thinking type adaptive with beta header", () => {
      const result = resolveThinkingConfig({ mode: "adaptive", effort: "high" }, "anthropic");
      expect(result.params).toEqual({ thinking: { type: "adaptive" } });
      expect(result.headers).toEqual({ "anthropic-beta": "interleaved-thinking-2025-05-14" });
    });

    it("deepseek maps effort to reasoning_effort", () => {
      const result = resolveThinkingConfig({ mode: "adaptive", effort: "low" }, "deepseek");
      expect(result.params).toEqual({
        extra_body: { thinking: { type: "enabled" } },
        reasoning_effort: "low",
      });
    });

    it("deepseek defaults effort to high", () => {
      const result = resolveThinkingConfig({ mode: "adaptive" }, "deepseek");
      expect(result.params).toEqual({
        extra_body: { thinking: { type: "enabled" } },
        reasoning_effort: "high",
      });
    });

    it("gemini maps effort to thinking_level", () => {
      const result = resolveThinkingConfig({ mode: "adaptive", effort: "medium" }, "gemini");
      expect(result.params).toEqual({ generation_config: { thinking_level: "medium" } });
    });
  });

  describe("enabled mode", () => {
    it("openai enabled mode returns reasoning.effort medium", () => {
      const result = resolveThinkingConfig({ mode: "enabled", budgetTokens: 4096 }, "openai");
      expect(result.params).toEqual({ reasoning: { effort: "medium" } });
    });

    it("anthropic enabled mode returns thinking type enabled with budget_tokens", () => {
      const result = resolveThinkingConfig({ mode: "enabled", budgetTokens: 8192 }, "anthropic");
      expect(result.params).toEqual({ thinking: { type: "enabled", budget_tokens: 8192 } });
      expect(result.headers).toEqual({ "anthropic-beta": "interleaved-thinking-2025-05-14" });
    });

    it("deepseek enabled mode returns reasoning_effort high", () => {
      const result = resolveThinkingConfig({ mode: "enabled", budgetTokens: 4096 }, "deepseek");
      expect(result.params).toEqual({
        extra_body: { thinking: { type: "enabled" } },
        reasoning_effort: "high",
      });
    });

    it("gemini enabled mode returns thinking_level high", () => {
      const result = resolveThinkingConfig({ mode: "enabled", budgetTokens: 4096 }, "gemini");
      expect(result.params).toEqual({ generation_config: { thinking_level: "high" } });
    });
  });
});

describe("effortToBudgetTokens", () => {
  it("maps all 7 effort levels to correct budget token counts", () => {
    expect(effortToBudgetTokens("none")).toBe(0);
    expect(effortToBudgetTokens("minimal")).toBe(128);
    expect(effortToBudgetTokens("low")).toBe(1024);
    expect(effortToBudgetTokens("medium")).toBe(2048);
    expect(effortToBudgetTokens("high")).toBe(4096);
    expect(effortToBudgetTokens("xhigh")).toBe(8192);
    expect(effortToBudgetTokens("max")).toBe(16384);
  });
});

describe("extractThinkingFromDelta", () => {
  it("extracts reasoning_content from openai delta", () => {
    expect(extractThinkingFromDelta("openai", { reasoning_content: "thinking..." })).toBe("thinking...");
    expect(extractThinkingFromDelta("openai", {})).toBeNull();
  });

  it("extracts thinking or thinking_delta from anthropic delta", () => {
    expect(extractThinkingFromDelta("anthropic", { thinking: "deep thought" })).toBe("deep thought");
    expect(extractThinkingFromDelta("anthropic", { thinking_delta: "delta thought" })).toBe("delta thought");
    expect(extractThinkingFromDelta("anthropic", {})).toBeNull();
  });

  it("extracts reasoning_content from deepseek delta", () => {
    expect(extractThinkingFromDelta("deepseek", { reasoning_content: "reasoning..." })).toBe("reasoning...");
    expect(extractThinkingFromDelta("deepseek", {})).toBeNull();
  });

  it("extracts text from gemini delta when thought flag is true", () => {
    expect(extractThinkingFromDelta("gemini", { thought: true, text: "gemini thought" })).toBe("gemini thought");
    expect(extractThinkingFromDelta("gemini", { thought: false, text: "not thought" })).toBeNull();
    expect(extractThinkingFromDelta("gemini", { text: "no flag" })).toBeNull();
    expect(extractThinkingFromDelta("gemini", {})).toBeNull();
  });

  it("returns null for unknown vendor", () => {
    expect(extractThinkingFromDelta("unknown", { reasoning_content: "test" })).toBeNull();
  });
});
