export type ThinkingConfig =
  | { mode: "disabled" }
  | { mode: "enabled"; budgetTokens: number }
  | { mode: "adaptive"; effort?: ThinkingEffort };

export type ThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ThinkingVendorParams {
  params: Record<string, unknown>;
  headers?: Record<string, string>;
}

export function resolveThinkingConfig(config: ThinkingConfig, vendor: string): ThinkingVendorParams {
  switch (vendor) {
    case "openai":
      if (config.mode === "disabled") return { params: {} };
      return {
        params: {
          reasoning: { effort: config.mode === "adaptive" ? (config.effort ?? "medium") : "medium" }
        }
      };
    case "anthropic":
      if (config.mode === "disabled") return { params: {} };
      if (config.mode === "adaptive") {
        return {
          params: { thinking: { type: "adaptive" } },
          headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" }
        };
      }
      return {
        params: { thinking: { type: "enabled", budget_tokens: config.budgetTokens } },
        headers: { "anthropic-beta": "interleaved-thinking-2025-05-14" }
      };
    case "deepseek":
      if (config.mode === "disabled") return { params: {} };
      return {
        params: {
          extra_body: { thinking: { type: "enabled" } },
          reasoning_effort: config.mode === "adaptive" ? (config.effort ?? "high") : "high"
        }
      };
    case "gemini":
      if (config.mode === "disabled") return { params: {} };
      const levelMap: Record<string, string> = { none: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
      return { params: { generation_config: { thinking_level: levelMap[config.mode === "adaptive" ? (config.effort ?? "high") : "high"] ?? "high" } } };
    default:
      return { params: {} };
  }
}

export function effortToBudgetTokens(effort: ThinkingEffort): number {
  const map: Record<ThinkingEffort, number> = {
    none: 0, minimal: 128, low: 1024, medium: 2048,
    high: 4096, xhigh: 8192, max: 16384
  };
  return map[effort] ?? 2048;
}

export function extractThinkingFromDelta(vendor: string, delta: Record<string, unknown>): string | null {
  switch (vendor) {
    case "openai":
      return (delta.reasoning_content as string) ?? null;
    case "anthropic":
      return (delta.thinking as string) ?? (delta.thinking_delta as string) ?? null;
    case "deepseek":
      return (delta.reasoning_content as string) ?? null;
    case "gemini":
      const thought = (delta as any).thought;
      return thought === true ? (delta.text as string) : null;
    default:
      return null;
  }
}
