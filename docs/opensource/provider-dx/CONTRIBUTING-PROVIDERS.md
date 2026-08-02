# Contributing a New LLM Provider

**Expected time**: 30 minutes. Adding an OpenAI-compatible provider requires **zero TypeScript code**.

---

## Quick Start (30 min)

### Step 1: Create JSON file

```bash
# Navigate to the providers directory
cd packages/agent-runtime/src/provider/builtin/providers/
# Create <providerId>.json
touch my-provider.json
```

### Step 2: Write the JSON

```json
{
  "providerId": "my-provider",
  "name": "My Provider",
  "description": "My Provider API",
  "engine": "openai-compatible",
  "baseUrl": "https://api.my-provider.com/v1",
  "auth": {
    "type": "api-key",
    "placement": "header",
    "keyHeader": "Authorization",
    "defaultEnvVar": "MY_PROVIDER_API_KEY"
  },
  "models": [
    {
      "id": "my-model-1",
      "capabilities": ["code", "tool-use"],
      "contextWindow": 32768,
      "maxOutputTokens": 8192,
      "costPer1kInput": 0.0005,
      "costPer1kOutput": 0.0015
    }
  ],
  "capabilities": {
    "toolUse": true,
    "vision": false,
    "reasoning": false,
    "streaming": true,
    "systemPrompt": true
  }
}
```

### Step 3: Validate

```bash
npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts \
  packages/agent-runtime/src/provider/builtin/providers/my-provider.json
```

### Step 4: Test connection

```bash
MY_PROVIDER_API_KEY=sk-xxx \
  npx tsx packages/agent-runtime/src/provider/cli/provider-test.ts my-provider
```

---

## JSON Schema Reference

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `providerId` | string | **yes** | Unique identifier (used as the filename) |
| `name` | string | **yes** | Display name |
| `engine` | "openai-compatible" \| "anthropic-messages" \| "ollama" | **yes** | Protocol engine |
| `baseUrl` | string | **yes** | API base URL |
| `description` | string | no | Brief description |
| `website` | string | no | Vendor website |
| `docsUrl` | string | no | Official API docs URL |
| `endpointType` | "chat-completions" \| "responses" \| "auto" | no | Which endpoint format to prefer |
| `streamingSupport` | "streaming" \| "non-streaming" \| "optional" | no | Streaming capability |
| `rateLimiting` | object | no | Rate limit configuration |
| `metadata` | object | no | Extra metadata |

### Auth configuration

```json
{
  "auth": {
    "type": "api-key",
    "placement": "header",
    "keyHeader": "Authorization",
    "defaultEnvVar": "MY_PROVIDER_API_KEY"
  }
}
```

| `type` | `placement` | Description | Example |
|--------|-------------|-------------|---------|
| `api-key` | `header` | Standard Bearer token — sends `Authorization: Bearer <key>` | OpenAI, DeepSeek, Groq |
| `bearer` | `header` | Bearer token (alias for api-key) | OpenRouter, Together |
| `header` | `header` | Custom header — sends `X-Api-Key: <key>` | Anthropic |
| `none` | — | No authentication | Ollama (local) |

The `keyHeader` field controls the HTTP header name:
- `"Authorization"` → `Authorization: Bearer <key>`
- `"x-api-key"` → `x-api-key: <key>`
- `"x-goog-api-key"` → `x-goog-api-key: <key>`

If omitted, defaults are inferred from `auth.type`:
- `api-key` / `bearer` → `"Authorization"`
- `header` → `"x-api-key"`

### Models array

```json
{
  "models": [
    {
      "id": "gpt-4o",
      "aliases": ["gpt-4o-latest"],
      "capabilities": ["code", "vision", "tool-use"],
      "contextWindow": 128000,
      "maxOutputTokens": 16384,
      "costPer1kInput": 0.0025,
      "costPer1kOutput": 0.01
    }
  ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | — | Official model ID **(required)** |
| `aliases` | string[] | `[]` | Alternative model IDs that map to this one |
| `capabilities` | string[] | `[]` | Tags like `"code"`, `"vision"`, `"tool-use"`, `"reasoning"` |
| `contextWindow` | number | `4096` | Maximum context window in tokens |
| `maxOutputTokens` | number | `4096` | Maximum output tokens |
| `costPer1kInput` | number | `0` | Cost per 1K input tokens (USD) |
| `costPer1kOutput` | number | `0` | Cost per 1K output tokens (USD) |

### Capabilities object

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolUse` | boolean | `false` | Supports tool/function calling |
| `vision` | boolean | `false` | Supports image input |
| `reasoning` | boolean | `false` | Supports thinking/reasoning |
| `streaming` | boolean | `true` | Supports streaming output |
| `systemPrompt` | boolean | `true` | Supports system messages |
| `jsonMode` | boolean | `false` | Supports JSON-structured output |
| `parallelToolCalls` | boolean | `false` | Supports parallel tool calls |

### Engine options

```json
{
  "engineOptions": {
    "authHeader": "authorization",
    "maxTokensField": "max_completion_tokens",
    "reasoningContent": "thought-delta",
    "toolChoice": "auto",
    "anthropicVersion": "2023-06-01",
    "keepAlive": "5m"
  }
}
```

| Field | Values | Description |
|-------|--------|-------------|
| `authHeader` | `"authorization"` \| `"x-api-key"` \| `"x-goog-api-key"` \| `"custom"` | Which header to use for auth |
| `maxTokensField` | `"max_tokens"` \| `"max_completion_tokens"` \| `"max_output_tokens"` \| `"none"` | Field name for max tokens |
| `reasoningContent` | `"omit"` \| `"text-delta"` \| `"thought-delta"` | How to surface reasoning content |
| `toolChoice` | `"auto"` \| `"required"` \| `"none"` | Default tool choice behavior |
| `anthropicVersion` | string | Anthropic API version header (Anthropic only) |
| `keepAlive` | string | Model keep-alive duration (Ollama only) |

### Rate limiting

```json
{
  "rateLimiting": {
    "requestsPerMinute": 30,
    "tokensPerMinute": 100000
  }
}
```

### Paths (optional override)

```json
{
  "paths": {
    "chatCompletions": "/v1/chat/completions",
    "models": "/v1/models"
  }
}
```

Defaults: `"/v1/chat/completions"` and `"/v1/models"`.

---

## Engine Selection Guide

| Engine | Applicable API Format | Example Providers |
|--------|-----------------------|-------------------|
| `openai-compatible` | OpenAI Chat Completions / Responses API | DeepSeek, Groq, Together, Mistral, Perplexity, xAI, Fireworks, OpenRouter, GitHub Models |
| `anthropic-messages` | Anthropic Messages API | Anthropic Claude |
| `ollama` | Ollama `/api/chat` | Local Ollama instance |

### Decision tree

```
Your API compatible with OpenAI format?
├── Yes → engine: "openai-compatible"
│   ├── Supports both chat + responses → endpointType: "auto" (recommended)
│   ├── Chat completions only → endpointType: "chat-completions"
│   └── Responses API only → endpointType: "responses"
│
├── Yes, Anthropic Messages API → engine: "anthropic-messages"
│   └── Uses x-api-key header + anthropic-version
│
├── Yes, Ollama /api/chat → engine: "ollama"
│   └── No auth needed; supports keep_alive
│
└── None of the above? → A new engine may be needed
     Contact the core team
```

---

## Testing Guide

### Unit tests

```bash
# All provider tests
npx vitest run packages/agent-runtime/src/provider/__tests__/

# Specific test file
npx vitest run packages/agent-runtime/src/provider/__tests__/registry.test.ts

# Auth tests
npx vitest run packages/agent-runtime/src/provider/__tests__/auth.test.ts
```

### CLI validation

```bash
# Validate a single file
npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts \
  packages/agent-runtime/src/provider/builtin/providers/my-provider.json

# Validate all built-in providers
npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts \
  packages/agent-runtime/src/provider/builtin/providers/
```

### Connection test

```bash
# Test a registered provider
MY_PROVIDER_API_KEY=sk-xxx \
  npx tsx packages/agent-runtime/src/provider/cli/provider-test.ts my-provider

# List all registered providers
npx tsx packages/agent-runtime/src/provider/cli/provider-list.ts
```

### Programmatic test

```typescript
import { ProviderRegistry, ProviderFactory } from "./packages/agent-runtime/src/provider";
const registry = new ProviderRegistry();
const factory = new ProviderFactory(registry);

// Register your JSON file
registry.registerFromFile("path/to/my-provider.json");

// Create a provider instance
const provider = factory.createProvider("my-provider", {
  apiKey: process.env.MY_PROVIDER_API_KEY,
});

// Stream a response
for await (const event of provider.stream({
  messages: [{ role: "user", blocks: [{ type: "text", text: "Hello!" }] }],
  signal: new AbortController().signal,
})) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}
```

---

## PR Checklist

- [ ] JSON file placed at `packages/agent-runtime/src/provider/builtin/providers/<providerId>.json`
- [ ] JSON passes schema validation (`provider-validate.ts`)
- [ ] `baseUrl` passes SSRF validation (no localhost/private IP)
- [ ] Model IDs use the official IDs from the provider's docs
- [ ] Authentication matches the provider's documentation
- [ ] Connection test passes (`provider-test.ts`)
- [ ] Pricing/cost information is filled for each model (or `0` if unknown)
- [ ] `rateLimiting` is set if the provider has known rate limits
