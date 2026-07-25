import type { JsonObject, ToolCategory, ToolConcurrency, ToolExecutionContext, ToolOutput } from "@crish/shared-types";
import type { AgentTool } from "../types";

export interface MockToolOptions {
  name: string;
  label?: string;
  description?: string;
  category?: ToolCategory;
  inputSchema?: JsonObject;
  concurrency?: ToolConcurrency;
  allowParallel?: boolean;
  fatalOnError?: boolean;
  output?: ToolOutput;
  error?: Error;
  readOnly?: boolean;
  executeHook?: (input: JsonObject, context: ToolExecutionContext) => void;
}

export function createMockTool(options: MockToolOptions): AgentTool {
  const {
    name,
    label = name,
    description = `Mock tool: ${name}`,
    category = "internal" as ToolCategory,
    inputSchema,
    concurrency = "sequential" as ToolConcurrency,
    allowParallel = false,
    fatalOnError = false,
    output = { text: `Mock output from ${name}` },
    error,
    readOnly = true,
    executeHook,
  } = options;

  return {
    name,
    label,
    description,
    category,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    concurrency,
    allowParallel,
    fatalOnError,
    isReadOnly(_input: JsonObject): boolean {
      return readOnly;
    },
    summarize(input: JsonObject): string {
      return `${name}(${JSON.stringify(input)})`;
    },
    async execute(
      input: JsonObject,
      context: ToolExecutionContext
    ): Promise<ToolOutput> {
      executeHook?.(input, context);
      if (error) throw error;
      return output;
    },
  };
}
