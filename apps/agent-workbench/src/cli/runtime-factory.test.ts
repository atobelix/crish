import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "@crish/agent-runtime";
import { createDefaultWorkbenchSettings } from "../shared/workbench-config";
import { createWorkbenchRuntime, loadWorkbenchRuntimeSettings, refreshWorkbenchProviderModels, toProviderOptions } from "./runtime-factory";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("workbench runtime factory", () => {
  it("uses the run-budget request output cap unless provider maxTokens is explicitly set", async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const runtime = await createWorkbenchRuntime({
      cwd: process.cwd(),
      settings: createDefaultWorkbenchSettings(),
      maxTurns: 1
    });

    for await (const _event of runtime.runtime.run("hi")) {
      // Drain the provider request.
    }

    expect(requestBody.max_output_tokens).toBe(32_000);
  });

  it("preserves an explicit provider maxTokens override", async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    const settings = createDefaultWorkbenchSettings();
    const runtime = await createWorkbenchRuntime({
      cwd: process.cwd(),
      settings: {
        ...settings,
        provider: {
          ...settings.provider,
          maxTokens: 12_345
        }
      },
      maxTurns: 1
    });

    for await (const _event of runtime.runtime.run("hi")) {
      // Drain the provider request.
    }

    expect(requestBody.max_output_tokens).toBe(12_345);
  });

  it("keeps background command control behind the unified shell_command tool by default", async () => {
    let toolNames: string[] = [];
    const provider: AgentProvider = {
      id: "inspect-tools",
      async *stream(request) {
        toolNames = request.tools.map((tool) => tool.name);
        yield { type: "text-delta", text: "ok" };
        yield { type: "stop", reason: "stop" };
      }
    };

    const runtime = await createWorkbenchRuntime({
      cwd: process.cwd(),
      settings: createDefaultWorkbenchSettings(),
      provider,
      maxTurns: 1
    });

    for await (const _event of runtime.runtime.run("hi")) {
      // Drain the provider request.
    }

    expect(toolNames).toContain("shell_command");
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("edit");
    expect(toolNames).not.toContain("start_background_command");
    expect(toolNames).not.toContain("get_background_command");
    expect(toolNames).not.toContain("list_background_commands");
    expect(toolNames).not.toContain("cancel_background_command");
  });

  it("uses the selected model profile for automatic context compression thresholds", async () => {
    const provider: AgentProvider = {
      id: "inspect-context",
      async *stream() {
        yield { type: "text-delta", text: "ok" };
        yield { type: "stop", reason: "stop" };
      }
    };
    const settings = createDefaultWorkbenchSettings();
    const runtime = await createWorkbenchRuntime({
      cwd: process.cwd(),
      settings,
      provider,
      maxTurns: 1
    });
    const options = (runtime.runtime as unknown as { options: { contextCompression?: unknown } }).options;

    expect(options.contextCompression).toMatchObject({
      enabled: true,
      contextWindowTokens: 1_000_000,
      thresholdTokens: 180_000,
      targetRecentTokens: 64_000
    });
  });

  it("passes explicit thinking settings through to provider options and request bodies", async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: "completed", output: [] }), {
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const settings = createDefaultWorkbenchSettings();
    const runtime = await createWorkbenchRuntime({
      cwd: process.cwd(),
      settings: {
        ...settings,
        provider: {
          ...settings.provider,
          endpoint: "responses",
          stream: false,
          reasoningEffort: "high",
          reasoningEffortFormat: "responses"
        }
      },
      maxTurns: 1
    });

    for await (const _event of runtime.runtime.run("hi")) {
      // Drain the provider request.
    }

    expect(requestBody.model).toBe("mimo-v2.5");
    expect(requestBody).toMatchObject({ reasoning: { effort: "high" } });
    expect(requestBody).not.toHaveProperty("reasoning_effort");
  });

  it("keeps the configured model fixed when refreshing the remote model catalog", async () => {
    let requestUrl = "";
    let requestHeaders = new Headers();
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          data: [
            { id: "remote-only-model", owned_by: "crish" },
            { id: "another-remote-model", owned_by: "crish" }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );
    };
    const settings = createDefaultWorkbenchSettings();

    const result = await refreshWorkbenchProviderModels({
      settings: {
        ...settings,
        provider: {
          ...settings.provider,
          baseUrl: "https://api.crish.me",
          apiKey: "test-key",
          apiKeyEnv: undefined,
          modelsPath: "/models"
        }
      },
      fetch: fetchMock
    });

    expect(requestUrl).toBe("https://api.crish.me/v1/models");
    expect(requestHeaders.get("authorization")).toBe("Bearer test-key");
    expect(result.discoveredModelIds).toEqual(["remote-only-model", "another-remote-model"]);
    expect(result.selectedModelId).toBe("mimo-v2.5");
    expect(result.selectedModelAvailable).toBe(false);
    expect(result.settings.provider.model.id).toBe("mimo-v2.5");
    expect(result.settings.provider.models.map((model) => model.id)).toContain("remote-only-model");
    expect(result.settings.provider.models.map((model) => model.id)).toContain("mimo-v2.5");
    expect(result.settings.provider.models.find((model) => model.id === "mimo-v2.5")?.available).toBe(false);
  });

  it("keeps selected model provider options stable even when catalog discovery found different models", async () => {
    const settings = createDefaultWorkbenchSettings();
    const refreshed = await refreshWorkbenchProviderModels({
      settings: {
        ...settings,
        provider: {
          ...settings.provider,
          baseUrl: "https://api.crish.me",
          apiKey: "test-key",
          apiKeyEnv: undefined
        }
      },
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ id: "remote-only-model", owned_by: "crish" }] }), {
          headers: { "content-type": "application/json" }
        })
    });

    await expect(toProviderOptions(refreshed.settings.provider, undefined, 64_000)).resolves.toMatchObject({
      model: "mimo-v2.5",
      baseUrl: "https://api.crish.me",
      apiKey: "test-key",
      transport: "auto",
      reasoningEffort: "auto",
      reasoningEffortFormat: "auto"
    });
  });

  it("resolves relative provider secret files from the config file directory", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-workbench-provider-paths-"));
    const configDir = join(tempDir, ".config");
    const configPath = join(configDir, "provider.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "crish.key"), "relative-secret", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          id: "relative-secret-test",
          baseUrl: "https://api.crish.me",
          apiKeyFile: "crish.key",
          model: "mimo-v2.5"
        }
      }),
      "utf8"
    );

    try {
      const settings = await loadWorkbenchRuntimeSettings(configPath);
      await expect(toProviderOptions(settings.provider)).resolves.toMatchObject({
        apiKey: "relative-secret"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
