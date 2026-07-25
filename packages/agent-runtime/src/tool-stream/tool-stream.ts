export interface PendingToolCall {
  id: string;
  name: string;
  index: number;
  accumulatedJson: string;
}

export class ToolStream {
  private tools: Map<string, PendingToolCall> = new Map();
  private maxToolCalls = 128;
  private maxArgumentsLength = 256 * 1024;

  appendOrStart(index: number, delta: { id?: string; function?: { name?: string; arguments?: string } }): void {
    const key = String(index);
    if (!this.tools.has(key)) {
      if (this.tools.size >= this.maxToolCalls) return;
      this.tools.set(key, {
        id: delta.id ?? `call_${index}`,
        name: delta.function?.name ?? "unknown",
        index,
        accumulatedJson: "",
      });
    }
    const tool = this.tools.get(key)!;
    if (delta.function?.name) tool.name = delta.function.name;
    if (delta.id) tool.id = delta.id;
    if (delta.function?.arguments) {
      if (tool.accumulatedJson.length + delta.function.arguments.length > this.maxArgumentsLength) return;
      tool.accumulatedJson += delta.function.arguments;
    }
  }

  start(key: string, id: string, name: string): void {
    if (this.tools.size >= this.maxToolCalls) return;
    this.tools.set(key, { id, name, index: 0, accumulatedJson: "" });
  }

  append(key: string, text: string): void {
    const tool = this.tools.get(key);
    if (!tool) return;
    if (tool.accumulatedJson.length + text.length > this.maxArgumentsLength) return;
    tool.accumulatedJson += text;
  }

  finish(key: string): ToolCallResult | null {
    const tool = this.tools.get(key);
    if (!tool) return null;
    this.tools.delete(key);
    return this.parseToolCall(tool);
  }

  finishAll(): ToolCallResult[] {
    const results: ToolCallResult[] = [];
    for (const [key] of this.tools) {
      const result = this.finish(key);
      if (result) results.push(result);
    }
    return results;
  }

  private parseToolCall(tool: PendingToolCall): ToolCallResult {
    const sanitized = this.sanitizeJson(tool.accumulatedJson);
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(sanitized);
    } catch {
      input = {};
    }
    return { id: tool.id, name: tool.name, input, raw: tool.accumulatedJson };
  }

  private sanitizeJson(raw: string): string {
    let s = raw.trim();
    if (!s || s === "{}") return "{}";
    s = s.replace(/,(\s*[}\]])/g, "$1");
    if (s.startsWith("{") && !s.endsWith("}")) s += "}";
    if (s.startsWith("[") && !s.endsWith("]")) s += "]";
    return s;
  }

  reset(): void { this.tools.clear(); }
  get size(): number { return this.tools.size; }
}

export interface ToolCallResult {
  id: string;
  name: string;
  input: Record<string, unknown>;
  raw: string;
}
