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
  // 缓存每个 block 对象的字符数估算，避免在 agent 循环中反复 JSON.stringify 同一 block。
  // block 对象通常是不可变的（创建后不再修改），缓存按引用失效（GC 回收后自动清理）。
  private readonly blockCharCache = new WeakMap<object, number>();

  estimate(messages: AgentMessage[], model?: string): number {
    if (messages.length === 0) return 0;

    const ratio = charsPerToken(model);
    let totalChars = 0;

    for (const msg of messages) {
      for (const block of msg.blocks) {
        totalChars += this.blockChars(block);
      }
      totalChars += msg.role.length + 10;
    }

    return Math.ceil(totalChars / ratio);
  }

  private blockChars(block: AgentMessage["blocks"][number]): number {
    const cached = this.blockCharCache.get(block);
    if (cached !== undefined) return cached;
    let chars = 0;
    if (block.type === "text" || block.type === "thought") {
      chars = block.text.length;
    } else if (block.type === "tool-call") {
      chars = block.toolName.length + JSON.stringify(block.input).length;
    } else if (block.type === "tool-result") {
      chars = (block.output.text?.length ?? 0) + JSON.stringify(block.output.json ?? "").length;
    }
    this.blockCharCache.set(block, chars);
    return chars;
  }
}
