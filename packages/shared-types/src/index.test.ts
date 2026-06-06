import { describe, expect, it } from "vitest";
import {
  formatProviderDisplayName,
  normalizeProviderName,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_NAMES
} from "./index";

describe("provider display names", () => {
  it("exposes the full provider registry", () => {
    expect(PROVIDER_NAMES).toEqual([
      "chatgpt",
      "gemini",
      "claude",
      "aistudio",
      "kimi",
      "deepseek",
      "minimax-agent",
      "codex"
    ]);
  });

  it("includes all supported providers", () => {
    expect(PROVIDER_DISPLAY_NAMES).toMatchObject({
      chatgpt: "ChatGPT",
      gemini: "Gemini",
      claude: "Claude",
      aistudio: "AI Studio",
      kimi: "Kimi",
      deepseek: "DeepSeek",
      "minimax-agent": "MiniMax Agent",
      codex: "Codex"
    });
  });

  it("formats AI Studio, Kimi, DeepSeek and MiniMax Agent consistently", () => {
    expect(formatProviderDisplayName("aistudio")).toBe("AI Studio");
    expect(formatProviderDisplayName("kimi")).toBe("Kimi");
    expect(formatProviderDisplayName("deepseek")).toBe("DeepSeek");
    expect(formatProviderDisplayName("minimax-agent")).toBe("MiniMax Agent");
    expect(formatProviderDisplayName("codex")).toBe("Codex");
  });

  it("normalizes provider names consistently", () => {
    expect(normalizeProviderName("AIStudio")).toBe("aistudio");
    expect(normalizeProviderName("  Kimi ")).toBe("kimi");
    expect(normalizeProviderName("DeepSeek")).toBe("deepseek");
    expect(normalizeProviderName("MiniMax-Agent")).toBe("minimax-agent");
    expect(normalizeProviderName("Codex")).toBe("codex");
    expect(normalizeProviderName("unknown")).toBeNull();
  });

  it("falls back to the original value for unknown providers", () => {
    expect(formatProviderDisplayName("custom-provider")).toBe("custom-provider");
  });
});
