/**
 * 工具系统 - 定义与执行分离（Layer 3）
 *
 * 三层工具体系：
 * 1. ToolDefinition — 第三方只需实现这个（最小接口）
 * 2. ToolRegistrationOptions — 可选的高级特性
 * 3. RegisteredTool — 运行时工具，系统根据 definition + options 自动填充所有字段
 *
 * RegisteredTool 实现了 AgentTool 接口，因此与现有代码完全兼容。
 */

import type { ToolDefinition as SchemaToolDefinition, JsonObject, ToolCategory, ToolConcurrency, ToolExecutionContext, ToolOutput } from "@crish/shared-types";

// ─── 第 1 层：工具定义（第三方最小接口） ──────────────────────

export type ToolDefinition = SchemaToolDefinition;

// ─── 第 2 层：注册选项（可选高级特性） ────────────────────────

export interface ToolRegistrationOptions {
  label?: string;
  category?: ToolCategory;
  concurrency?: ToolConcurrency;
  allowParallel?: boolean;
  fatalOnError?: boolean;
  isReadOnly?: (input: JsonObject) => boolean;
  summarize?: (input: JsonObject) => string;
  inputAliases?: Record<string, string[]>;
}

// ─── 第 3 层：运行时工具（系统内部自动构建） ──────────────────

export class RegisteredTool {
  readonly definition: SchemaToolDefinition;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly inputSchema?: JsonObject;
  readonly inputAliases?: Record<string, string[]>;
  readonly concurrency: ToolConcurrency;
  readonly allowParallel: boolean;
  readonly fatalOnError: boolean;
  readonly isReadOnly: (input: JsonObject) => boolean;
  readonly summarize: (input: JsonObject) => string;
  readonly execute: (input: JsonObject, context: ToolExecutionContext) => Promise<ToolOutput>;

  constructor(definition: SchemaToolDefinition, options?: ToolRegistrationOptions) {
    const raw = definition as Partial<RegisteredTool>;
    this.definition = definition;
    this.name = definition.name;
    this.label = options?.label ?? raw.label ?? definition.name;
    this.description = definition.description;
    this.category = options?.category ?? raw.category ?? inferCategory(definition.name, definition.description);
    if (definition.inputSchema !== undefined) this.inputSchema = definition.inputSchema;
    if (options?.inputAliases !== undefined || raw.inputAliases !== undefined) this.inputAliases = options?.inputAliases ?? raw.inputAliases;
    this.concurrency = options?.concurrency ?? raw.concurrency ?? "parallel";
    this.allowParallel = options?.allowParallel ?? raw.allowParallel ?? true;
    this.fatalOnError = options?.fatalOnError ?? raw.fatalOnError ?? false;
    this.isReadOnly = options?.isReadOnly ?? raw.isReadOnly ?? (() => false);
    this.summarize = options?.summarize ?? raw.summarize ?? defaultSummarize;
    this.execute = (input, context) => definition.execute(input, context);
  }
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema?: JsonObject;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly rawAgentTools = new Map<string, import("../types").AgentTool>();

  register(def: SchemaToolDefinition, options?: ToolRegistrationOptions): RegisteredTool {
    if (this.tools.has(def.name) || this.rawAgentTools.has(def.name)) {
      throw new Error(`Duplicate tool registered: ${def.name}`);
    }
    const registered = new RegisteredTool(def, options);
    this.tools.set(def.name, registered);
    return registered;
  }

  registerGroup(groupName: string, defs: SchemaToolDefinition[], options?: ToolRegistrationOptions): void {
    for (const def of defs) {
      this.register(def, options);
    }
  }

  registerAgentTool(tool: import("../types").AgentTool): void {
    if (this.tools.has(tool.name) || this.rawAgentTools.has(tool.name)) {
      throw new Error(`Duplicate tool registered: ${tool.name}`);
    }
    this.rawAgentTools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name) || this.rawAgentTools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  getAgentTool(name: string): import("../types").AgentTool | undefined {
    const registered = this.tools.get(name);
    if (registered) return registered;
    return this.rawAgentTools.get(name);
  }

  list(): import("../types").AgentTool[] {
    const registered = [...this.tools.values()];
    const raw = [...this.rawAgentTools.values()];
    return [...registered, ...raw];
  }

  listRegistered(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  resolveForLLM(): LlmToolDefinition[] {
    const definitions: LlmToolDefinition[] = [];
    for (const registered of this.tools.values()) {
      definitions.push({
        name: registered.name,
        description: registered.description,
        ...(registered.inputSchema !== undefined ? { inputSchema: registered.inputSchema } : {}),
      });
    }
    for (const raw of this.rawAgentTools.values()) {
      definitions.push({
        name: raw.name,
        description: raw.description,
        ...(raw.inputSchema !== undefined ? { inputSchema: raw.inputSchema } : {}),
      });
    }
    return definitions;
  }

  has(name: string): boolean {
    return this.tools.has(name) || this.rawAgentTools.has(name);
  }

  get size(): number {
    return this.tools.size + this.rawAgentTools.size;
  }
}

const DEFAULT_SUMMARIZE_MAX_LENGTH = 200;

function defaultSummarize(input: JsonObject): string {
  try {
    const text = JSON.stringify(input);
    return text.length > DEFAULT_SUMMARIZE_MAX_LENGTH
      ? text.slice(0, DEFAULT_SUMMARIZE_MAX_LENGTH) + "..."
      : text;
  } catch {
    // silent: JSON.stringify 异常时返回无效输入标记
    return "(invalid input)";
  }
}

function inferCategory(name: string, description: string): ToolCategory {
  const combined = `${name} ${description}`.toLowerCase();
  const tokens = combined.replace(/[_.\-]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  if (/mcp/.test(tokens)) return "mcp";
  if (/skill/.test(tokens)) return "skill";
  if (/agent|subagent/.test(tokens)) return "agent";
  if (/read|view|get|list|cat|head|ls|find|search/.test(tokens)) return "filesystem";
  if (/bash|shell|exec|command|cmd|terminal/.test(tokens)) return "terminal";
  if (/fetch|download|http|url|request|curl|wget/.test(tokens)) return "network";
  return "internal";
}
