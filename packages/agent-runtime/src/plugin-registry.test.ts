import { describe, expect, it } from "vitest";
import { DeferredToolSource, ToolDiscoveryIndex } from "./tool-discovery";
import type { AgentTool } from "./types";
import type { JsonObject } from "@crish/shared-types";
import { PluginRegistry } from "./plugin-registry";

function makeTool(options: { name: string; label?: string; description?: string; schemaKeys?: string[] }): AgentTool {
  return {
    name: options.name,
    label: options.label ?? options.name,
    description: options.description ?? `${options.name} tool`,
    category: "internal",
    concurrency: "parallel",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries((options.schemaKeys ?? []).map((key) => [key, { type: "string" }]))
    },
    isReadOnly: () => true,
    summarize: () => options.name,
    async execute(input: JsonObject) {
      return { text: String(input.value ?? "ok") };
    }
  };
}

describe("PluginRegistry", () => {
  it("registers and unregisters plugin tools and contribution metadata", async () => {
    const registry = new PluginRegistry();
    const readNotes = makeTool({ name: "notes_read", description: "Read note files" });

    registry.registerPlugin({
      manifest: {
        id: "notes",
        name: "Notes",
        version: "1.0.0",
        contributes: {
          commands: [{ id: "notes.open", label: "Open notes" }]
        }
      },
      tools: [readNotes],
      events: [{ id: "notes.changed" }],
      renderers: [{ id: "notes.markdown", mediaTypes: ["text/markdown"] }]
    });

    expect(registry.listPlugins().map((plugin) => plugin.manifest.id)).toEqual(["notes"]);
    await expect(registry.listTools()).resolves.toEqual([readNotes]);
    expect(registry.listPluginTools("notes")).toEqual([readNotes]);
    expect(registry.listContributions().map((contribution) => contribution.kind).sort()).toEqual([
      "command",
      "event",
      "renderer",
      "tool"
    ]);

    expect(registry.unregisterPlugin("notes")).toBe(true);
    await expect(registry.listTools()).resolves.toEqual([]);

    registry.registerPlugin({
      manifest: { id: "notes-v2", name: "Notes v2" },
      tools: [readNotes]
    });
    await expect(registry.listTools()).resolves.toEqual([readNotes]);
  });

  it("rejects duplicate plugin ids and duplicate tool ownership", () => {
    const registry = new PluginRegistry();
    const shared = makeTool({ name: "shared_tool" });

    registry.registerPlugin({
      manifest: { id: "alpha", name: "Alpha" },
      tools: [shared]
    });

    expect(() =>
      registry.registerPlugin({
        manifest: { id: "alpha", name: "Alpha copy" }
      })
    ).toThrow("Duplicate plugin registered: alpha");

    expect(() =>
      registry.registerPlugin({
        manifest: { id: "beta", name: "Beta" },
        tools: [shared]
      })
    ).toThrow("Tool shared_tool is already registered by plugin alpha");
  });

  it("does not return tools or metadata from disabled plugins", async () => {
    const registry = new PluginRegistry();
    const hidden = makeTool({ name: "hidden_tool" });

    registry.registerPlugin({
      manifest: { id: "hidden", name: "Hidden" },
      enabled: false,
      tools: [hidden],
      commands: [{ id: "hidden.run" }]
    });

    await expect(registry.listTools()).resolves.toEqual([]);
    expect(registry.listToolDiscoveryMetadata()).toEqual([]);
    expect(registry.listCommands()).toEqual([]);
    expect(registry.listPluginTools("hidden")).toEqual([]);

    expect(registry.listPluginTools("hidden", { includeDisabled: true })).toEqual([hidden]);
    expect(registry.listCommands({ pluginId: "hidden", includeDisabled: true }).map((entry) => entry.contribution.id)).toEqual([
      "hidden.run"
    ]);

    expect(registry.enablePlugin("hidden")).toBe(true);
    await expect(registry.listTools()).resolves.toEqual([hidden]);

    expect(registry.disablePlugin("hidden")).toBe(true);
    await expect(registry.listTools()).resolves.toEqual([]);
  });

  it("provides plugin tool metadata to discovery and deferred activation", async () => {
    const registry = new PluginRegistry();
    const active = makeTool({ name: "calendar_read", description: "Read calendar entries" });
    const deferred = makeTool({
      name: "calendar_schedule_meeting",
      label: "Schedule meeting",
      description: "Create a calendar event",
      schemaKeys: ["attendee", "time"]
    });

    registry.registerPlugin({
      manifest: {
        id: "calendar-suite",
        name: "Calendar Suite",
        description: "Scheduling and availability helpers",
        keywords: ["availability", "agenda"]
      },
      tools: [
        { tool: active, activation: "active" },
        {
          tool: deferred,
          activation: "deferred",
          label: "Meeting scheduler",
          tokens: ["room", "invite"]
        }
      ]
    });

    const index = new ToolDiscoveryIndex(registry.listToolDiscoveryMetadata({ activation: "deferred" }));
    const metadataMatches = index.search("availability invite");
    expect(metadataMatches[0]?.tool.name).toBe("calendar_schedule_meeting");
    expect(metadataMatches[0]?.fieldScores.token).toBeGreaterThan(0);

    const source = new DeferredToolSource({
      activeSource: registry,
      deferredSource: registry
    });

    await expect(source.listTools()).resolves.toEqual([active]);

    const activation = await source.activate("agenda room");
    expect(activation.activatedNames).toEqual(["calendar_schedule_meeting"]);
    await expect(source.listTools()).resolves.toEqual([active, deferred]);
  });
});
