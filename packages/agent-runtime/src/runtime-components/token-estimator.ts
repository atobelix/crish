import type { AgentMessage } from "@crish/shared-types";

export interface TokenEstimator {
  estimate(messages: AgentMessage[], model?: string): number;
}

const MODEL_RATIOS: Record<string, number> = {
  "gpt-4": 4.0, "gpt-4o": 4.0, "gpt-4o-mini": 4.0,
  "claude-3": 3.5, "claude-3.5": 3.5, "claude-3.5-sonnet": 3.5, "claude-3.5-haiku": 3.5,
  "deepseek": 1.5, "deepseek-chat": 1.5, "deepseek-v2": 1.5,
  "gemini": 3.0, "gemini-1.5": 3.0,
  "mimo": 2.0, "mimo-v2.5": 2.0,
};

function detectModelFamily(model?: string): string {
  if (!model) return "default";
  const key = model.toLowerCase();
  if (key.includes("gpt")) return "gpt-4";
  if (key.includes("claude")) return "claude-3";
  if (key.includes("deepseek")) return "deepseek";
  if (key.includes("gemini")) return "gemini";
  if (key.includes("mimo")) return "mimo";
  return "default";
}

function charsPerToken(model?: string): number {
  const family = detectModelFamily(model);
  return MODEL_RATIOS[family] ?? 3.0;
}

export class UsageBasedTokenEstimator implements TokenEstimator {
  estimate(messages: AgentMessage[], model?: string): number {
    if (messages.length === 0) return 0;

    const ratio = charsPerToken(model);
    let totalChars = 0;

    for (const msg of messages) {
      for (const block of msg.blocks) {
        if (block.type === "text" || block.type === "thought") {
          totalChars += block.text.length;
        } else if (block.type === "tool-call") {
          totalChars += block.toolName.length + JSON.stringify(block.input).length;
        } else if (block.type === "tool-result") {
          totalChars += (block.output.text?.length ?? 0) + JSON.stringify(block.output.json ?? "").length;
        }
      }
      totalChars += msg.role.length + 10;
    }

    return Math.ceil(totalChars / ratio);
  }
}
