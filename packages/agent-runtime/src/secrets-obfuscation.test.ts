import { describe, expect, it } from "vitest";
import { createSecretRedactorFromEnv, SecretRedactor, SecretRegistry, type SecretRestoreMap } from "./secrets-obfuscation";
import type { AgentMessage, JsonValue } from "@crish/shared-types";

describe("secrets obfuscation", () => {
  it("registers sensitive env values and keeps stable placeholders for repeated text", () => {
    const apiKey = "sk-live_abcdefghijklmnopqrstuvwxyz123456";
    const registry = new SecretRegistry();
    const registered = registry.registerEnv({
      OPENAI_API_KEY: apiKey,
      NODE_ENV: "production",
      SHORT_TOKEN: "short"
    });
    const redactor = new SecretRedactor(registry);

    const result = redactor.redactText(`first=${apiKey}\nsecond=${apiKey}\nmode=production token=short`);

    expect(registered).toHaveLength(1);
    expect(result.redacted).toBe(true);
    expect(result.value).not.toContain(apiKey);
    expect(result.value.match(/\[SECRET_1\]/g)).toHaveLength(2);
    expect(result.value).toContain("mode=production");
    expect(result.value).toContain("token=short");
    expect(result.entries).toEqual([
      {
        placeholder: "[SECRET_1]",
        kind: "env",
        label: "env:OPENAI_API_KEY",
        source: "OPENAI_API_KEY",
        valueLength: apiKey.length
      }
    ]);
    expect(result.displayMap).toEqual({ "[SECRET_1]": "env:OPENAI_API_KEY" });
    expect(result.resumeRestoreMap).toEqual({ "[SECRET_1]": apiKey });
    expect(redactor.restoreText(result.value)).toBe(`first=${apiKey}\nsecond=${apiKey}\nmode=production token=short`);
  });

  it("redacts registered bearer token and api key patterns without matching short values", () => {
    const bearer = "tok_live_abcdefghijklmnopqrstuvwxyz123456";
    const apiKey = "sk-proj_abcdefghijklmnopqrstuvwxyz123456";
    const registry = new SecretRegistry().registerTokenPatterns().registerApiKeyPatterns();
    const redactor = new SecretRedactor(registry);

    const result = redactor.redactText(`Authorization: Bearer ${bearer}\napi_key=${apiKey}\ntoken=abc123`);

    expect(result.value).toContain("Authorization: Bearer [SECRET_1]");
    expect(result.value).toContain("api_key=[SECRET_2]");
    expect(result.value).toContain("token=abc123");
    expect(result.value).not.toContain(bearer);
    expect(result.value).not.toContain(apiKey);
    expect(result.resumeRestoreMap).toEqual({
      "[SECRET_1]": bearer,
      "[SECRET_2]": apiKey
    });
    expect(redactor.restoreText(result.value)).toContain(`Bearer ${bearer}`);
    expect(redactor.restoreText(result.value)).toContain(`api_key=${apiKey}`);
  });

  it("redacts JSON deeply by value, key, and sensitive key context without mutating the original", () => {
    const envSecret = "env_secret_abcdefghijklmnopqrstuvwxyz123456";
    const jsonSecret = "json_secret_abcdefghijklmnopqrstuvwxyz123456";
    const token = "tok_json_abcdefghijklmnopqrstuvwxyz123456";
    const registry = new SecretRegistry().registerTokenPatterns();
    registry.registerEnv({ SERVICE_SECRET: envSecret });
    const redactor = new SecretRedactor(registry);
    const input: JsonValue = {
      nested: {
        apiKey: jsonSecret,
        shortApiKey: "abc123",
        output: `Bearer ${token}`,
        [`header-${envSecret}`]: "visible"
      }
    };

    const result = redactor.redactJson(input);
    const output = result.value as {
      nested: {
        apiKey: string;
        shortApiKey: string;
        output: string;
      };
    };

    expect(result.redacted).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain(envSecret);
    expect(JSON.stringify(result.value)).not.toContain(jsonSecret);
    expect(JSON.stringify(result.value)).not.toContain(token);
    expect(output.nested.apiKey).toBe("[SECRET_1]");
    expect(output.nested.shortApiKey).toBe("abc123");
    expect(output.nested.output).toContain("Bearer [SECRET_2]");
    expect(Object.keys((result.value as { nested: Record<string, unknown> }).nested)).toContain("header-[SECRET_3]");
    expect((input as { nested: { apiKey: string; output: string } }).nested.apiKey).toBe(jsonSecret);
    expect((input as { nested: { output: string } }).nested.output).toBe(`Bearer ${token}`);
    expect(redactor.restoreJson(result.value)).toEqual(input);
  });

  it("exports restore state for display and resume while preserving placeholder order", () => {
    const firstSecret = "first_secret_abcdefghijklmnopqrstuvwxyz123456";
    const secondSecret = "second_secret_abcdefghijklmnopqrstuvwxyz123456";
    const firstRegistry = new SecretRegistry();
    firstRegistry.registerEnv({ FIRST_SECRET: firstSecret });
    const firstRedactor = new SecretRedactor(firstRegistry);
    const first = firstRedactor.redactText(firstSecret);

    const resumeRestoreMap: SecretRestoreMap = first.resumeRestoreMap;
    const secondRegistry = new SecretRegistry();
    secondRegistry.registerEnv({ SECOND_SECRET: secondSecret });
    const secondRedactor = new SecretRedactor(secondRegistry, {
      restoreMap: resumeRestoreMap,
      displayMap: first.displayMap
    });
    const second = secondRedactor.redactText(`${firstSecret}\n${secondSecret}`);

    expect(first.value).toBe("[SECRET_1]");
    expect(second.value).toBe("[SECRET_1]\n[SECRET_2]");
    expect(second.displayMap).toEqual({
      "[SECRET_1]": "env:FIRST_SECRET",
      "[SECRET_2]": "env:SECOND_SECRET"
    });
    expect(secondRedactor.restoreText(second.value)).toBe(`${firstSecret}\n${secondSecret}`);
  });

  it("redacts provider-ready message copies without touching the raw transcript", () => {
    const secret = "message_secret_abcdefghijklmnopqrstuvwxyz123456";
    const redactor = createSecretRedactorFromEnv({ TOOL_TOKEN: secret });
    const messages: AgentMessage[] = [
      {
        id: "tool_1",
        role: "tool",
        createdAt: "2026-01-01T00:00:00.000Z",
        blocks: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "shell",
            isError: false,
            output: {
              text: `stdout ${secret}`,
              json: {
                token: secret,
                exitCode: 0
              }
            }
          }
        ]
      }
    ];

    const projected = redactor.redactMessages(messages).value;
    const rawBlock = messages[0]!.blocks[0]!;
    const projectedBlock = projected[0]!.blocks[0]!;

    expect(rawBlock.type === "tool-result" ? rawBlock.output.text : "").toContain(secret);
    expect(rawBlock.type === "tool-result" ? rawBlock.output.json : undefined).toMatchObject({ token: secret });
    expect(projectedBlock.type === "tool-result" ? projectedBlock.output.text : "").toBe("stdout [SECRET_1]");
    expect(projectedBlock.type === "tool-result" ? projectedBlock.output.json : undefined).toMatchObject({ token: "[SECRET_1]" });
    expect(redactor.restoreText(projectedBlock.type === "tool-result" ? projectedBlock.output.text ?? "" : "")).toBe(`stdout ${secret}`);
  });
});
