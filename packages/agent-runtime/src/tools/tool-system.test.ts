import { describe, expect, it } from "vitest";
import {
  type ToolDefinition,
  type ToolRegistrationOptions,
  RegisteredTool,
  ToolRegistry,
} from "./tool-definition";
import type { AgentTool } from "../types";
import type {
  JsonObject,
  ToolExecutionContext,
  ToolOutput,
} from "@crish/shared-types";

// ─── 辅助函数 ────────────────────────────────────────────

function createTestToolDefinition(name: string, description?: string): ToolDefinition {
  return {
    name,
    description: description ?? `Test tool: ${name}`,
    execute: async (input: JsonObject, ctx: ToolExecutionContext): Promise<ToolOutput> => {
      return { text: `Executed ${name} with ${JSON.stringify(input)}` };
    },
  };
}

function createTestToolDefinitionWithSchema(name: string): ToolDefinition {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    execute: async (input: JsonObject): Promise<ToolOutput> => {
      return { text: `Ran ${input.command ?? "unknown"}` };
    },
  };
}

// ─── RegisteredTool 测试 ──────────────────────────────────

describe("RegisteredTool", () => {
  it("implements AgentTool with default values", () => {
    const def = createTestToolDefinition("echo");
    const registered = new RegisteredTool(def);

    // Must implement AgentTool interface
    expect(registered.name).toBe("echo");
    expect(registered.label).toBe("echo"); // default: name
    expect(registered.description).toBe("Test tool: echo");
    expect(registered.concurrency).toBe("parallel"); // default
    expect(registered.allowParallel).toBe(true); // default
    expect(registered.fatalOnError).toBe(false); // default
    expect(registered.isReadOnly({})).toBe(false); // default: () => false
    expect(registered.inputAliases).toBeUndefined(); // default
    expect(registered.definition).toBe(def); // stores original definition
  });

  it("fills category from name inference", () => {
    const readTool = new RegisteredTool(createTestToolDefinition("read_file"));
    expect(readTool.category).toBe("filesystem");

    const bashTool = new RegisteredTool(createTestToolDefinition("bash_command"));
    expect(bashTool.category).toBe("terminal");

    const fetchTool = new RegisteredTool(createTestToolDefinition("fetch_url"));
    expect(fetchTool.category).toBe("network");

    const mcpTool = new RegisteredTool(createTestToolDefinition("mcp_tool"));
    expect(mcpTool.category).toBe("mcp");

    const skillTool = new RegisteredTool(createTestToolDefinition("skill_invoke"));
    expect(skillTool.category).toBe("skill");

    const agentTool = new RegisteredTool(createTestToolDefinition("subagent_run"));
    expect(agentTool.category).toBe("agent");

    const miscTool = new RegisteredTool(createTestToolDefinition("calculate"));
    expect(miscTool.category).toBe("internal");
  });

  it("uses explicit options over defaults", () => {
    const def = createTestToolDefinition("echo");
    const options: ToolRegistrationOptions = {
      label: "Echo Tool",
      category: "terminal",
      concurrency: "exclusive",
      allowParallel: false,
      fatalOnError: true,
      isReadOnly: () => true,
      summarize: (input) => `Custom: ${input.command ?? "n/a"}`,
      inputAliases: { command: ["cmd", "shell"] },
    };
    const registered = new RegisteredTool(def, options);

    expect(registered.label).toBe("Echo Tool");
    expect(registered.category).toBe("terminal");
    expect(registered.concurrency).toBe("exclusive");
    expect(registered.allowParallel).toBe(false);
    expect(registered.fatalOnError).toBe(true);
    expect(registered.isReadOnly({})).toBe(true);
    expect(registered.summarize({ command: "ls" })).toBe("Custom: ls");
    expect(registered.inputAliases).toEqual({ command: ["cmd", "shell"] });
  });

  it("default summarize truncates large JSON input", () => {
    const def = createTestToolDefinition("echo");
    const registered = new RegisteredTool(def);

    const largeInput = { data: "x".repeat(500) };
    const summary = registered.summarize(largeInput);
    expect(summary.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(summary.endsWith("...")).toBe(true);
  });

  it("execute delegates to definition", async () => {
    const def = createTestToolDefinition("echo");
    const registered = new RegisteredTool(def);

    const ctx: ToolExecutionContext = {
      toolCallId: "test-call",
      sessionId: "test-session",
      cwd: "/tmp",
      signal: new AbortController().signal,
      emit: () => {},
    };

    const output = await registered.execute({ text: "hello" }, ctx);
    expect(output.text).toContain("echo");
    expect(output.text).toContain("hello");
  });

  it("is compatible with AgentTool type", () => {
    const def = createTestToolDefinition("echo");
    const registered = new RegisteredTool(def);

    // TypeScript structural compatibility: RegisteredTool implements AgentTool
    const asAgentTool: AgentTool = registered;
    expect(asAgentTool.name).toBe("echo");
    expect(asAgentTool.label).toBe("echo");
    // "echo" contains no category keywords, so default is "internal"
    expect(asAgentTool.category).toBe("internal");
  });

  it("preserves inputSchema from definition", () => {
    const def = createTestToolDefinitionWithSchema("shell");
    const registered = new RegisteredTool(def);
    expect(registered.inputSchema).toEqual(def.inputSchema);
  });
});

// ─── AdvancedToolRegistry 测试 ────────────────────────────

describe("ToolRegistry (Layer 3)", () => {
  it("registers ToolDefinition and returns RegisteredTool", () => {
    const registry = new ToolRegistry();
    const registered = registry.register(createTestToolDefinition("echo"));
    expect(registered).toBeInstanceOf(RegisteredTool);
    expect(registered.name).toBe("echo");
  });

  it("registers with explicit options", () => {
    const registry = new ToolRegistry();
    const registered = registry.register(createTestToolDefinition("echo"), {
      category: "terminal",
      concurrency: "exclusive",
    });
    expect(registered.category).toBe("terminal");
    expect(registered.concurrency).toBe("exclusive");
  });

  it("rejects duplicate tool names", () => {
    const registry = new ToolRegistry();
    registry.register(createTestToolDefinition("echo"));
    expect(() => registry.register(createTestToolDefinition("echo"))).toThrow(/Duplicate tool/);
  });

  it("registerGroup registers multiple tools", () => {
    const registry = new ToolRegistry();
    registry.registerGroup("utils", [
      createTestToolDefinition("read_file"),
      createTestToolDefinition("write_file"),
    ], { category: "filesystem" });

    expect(registry.size).toBe(2);
    expect(registry.get("read_file")).toBeInstanceOf(RegisteredTool);
    expect(registry.get("write_file")?.category).toBe("filesystem");
  });

  it("registerAgentTool adds raw AgentTool for backward compatibility", () => {
    const registry = new ToolRegistry();
    // Create a raw AgentTool (not from ToolDefinition)
    const rawTool: AgentTool = {
      name: "legacy_tool",
      label: "Legacy",
      description: "A legacy tool",
      category: "internal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "legacy",
      execute: async () => ({ text: "legacy output" }),
    };

    registry.registerAgentTool(rawTool);
    expect(registry.size).toBe(1);

    // get() only returns RegisteredTool, not raw AgentTools
    expect(registry.get("legacy_tool")).toBeUndefined();

    // getAgentTool() returns either RegisteredTool or raw AgentTool
    expect(registry.getAgentTool("legacy_tool")).toBe(rawTool);

    // list() returns all tools as AgentTool[]
    const allTools = registry.list();
    expect(allTools).toHaveLength(1);
    expect(allTools[0]!.name).toBe("legacy_tool");
  });

  it("unregister removes tools by name", () => {
    const registry = new ToolRegistry();
    registry.register(createTestToolDefinition("echo"));
    expect(registry.unregister("echo")).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.has("echo")).toBe(false);
  });

  it("resolveForLLM generates LlmToolDefinition list", () => {
    const registry = new ToolRegistry();
    registry.register(createTestToolDefinitionWithSchema("shell"));
    registry.register(createTestToolDefinition("echo"));

    const llmDefs = registry.resolveForLLM();
    expect(llmDefs).toHaveLength(2);

    // Schema tool
    const shellDef = llmDefs.find((d) => d.name === "shell");
    expect(shellDef?.inputSchema).toBeDefined();
    expect(shellDef?.description).toBe("Test tool: shell");

    // No-schema tool
    const echoDef = llmDefs.find((d) => d.name === "echo");
    expect(echoDef?.inputSchema).toBeUndefined();
  });

  it("has() checks tool existence", () => {
    const registry = new ToolRegistry();
    expect(registry.has("echo")).toBe(false);
    registry.register(createTestToolDefinition("echo"));
    expect(registry.has("echo")).toBe(true);
  });

  it("listRegistered returns only RegisteredTool instances", () => {
    const registry = new ToolRegistry();
    registry.register(createTestToolDefinition("echo"));
    const rawTool: AgentTool = {
      name: "raw",
      label: "Raw",
      description: "Raw tool",
      category: "internal",
      concurrency: "parallel",
      isReadOnly: () => true,
      summarize: () => "raw",
      execute: async () => ({ text: "raw" }),
    };
    registry.registerAgentTool(rawTool);

    const registered = registry.listRegistered();
    expect(registered).toHaveLength(1);
    expect(registered[0]!).toBeInstanceOf(RegisteredTool);
  });
});