# Provider Development Environment

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Run provider unit tests

```bash
# All provider tests
npx vitest run packages/agent-runtime/src/provider/__tests__/

# Specific test file
npx vitest run packages/agent-runtime/src/provider/__tests__/registry.test.ts
npx vitest run packages/agent-runtime/src/provider/__tests__/factory.test.ts
npx vitest run packages/agent-runtime/src/provider/__tests__/base-engine.test.ts
npx vitest run packages/agent-runtime/src/provider/__tests__/declarative-loader.test.ts
npx vitest run packages/agent-runtime/src/provider/__tests__/auth.test.ts
```

### 3. Validate all built-in provider JSON files

```bash
npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts \
  packages/agent-runtime/src/provider/builtin/providers/
```

### 4. Test a provider connection

```bash
# Set the API key for the provider you want to test
OPENAI_API_KEY=sk-xxx \
  npx tsx packages/agent-runtime/src/provider/cli/provider-test.ts openai

GROQ_API_KEY=gsk_xxx \
  npx tsx packages/agent-runtime/src/provider/cli/provider-test.ts groq
```

### 5. List all registered providers

```bash
npx tsx packages/agent-runtime/src/provider/cli/provider-list.ts
```

## Testing Strategy

| Test Type | Command | What It Covers |
|-----------|---------|----------------|
| Unit | `vitest run provider/__tests__/registry.test.ts` | ProviderRegistry: register, get, list, unregister, file index |
| Unit | `vitest run provider/__tests__/factory.test.ts` | ProviderFactory: engine selection, provider creation, credential passthrough |
| Unit | `vitest run provider/__tests__/base-engine.test.ts` | classifyError: auth, rate-limit, quota, timeout, network, etc. |
| Unit | `vitest run provider/__tests__/declarative-loader.test.ts` | DeclarativeLoader: file scanning, hot reload, error handling |
| Unit | `vitest run provider/__tests__/auth.test.ts` | Secret store, encrypted file store, base URL validation |
| CLI validate | `provider-validate.ts <file>` | JSON schema, SSRF, required fields |
| CLI test | `provider-test.ts <providerId>` | Model list endpoint, streaming, tool call format |
| Rust | `cargo test -p conex-stream` | SSE frame parsing, ToolAccumulator |
| Bench | `cargo bench -p conex-stream` | Streaming latency, throughput |

## Programmatic Usage

### Creating a provider programmatically

```typescript
import { ProviderRegistry, ProviderFactory } from "./packages/agent-runtime/src/provider";

const registry = new ProviderRegistry();
const factory = new ProviderFactory(registry);

// Register from file
registry.registerFromFile("path/to/provider.json");

// Or register inline
import { normalizeDeclarativeDef } from "./packages/agent-runtime/src/provider";
const def = normalizeDeclarativeDef({
  providerId: "my-provider",
  name: "My Provider",
  engine: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  auth: { type: "api-key", placement: "header", keyHeader: "Authorization", defaultEnvVar: "MY_API_KEY" },
  models: [{ id: "my-model", contextWindow: 4096, maxOutputTokens: 4096 }],
});
registry.register({
  providerId: "my-provider",
  engine: "openai-compatible",
  metadata: { name: "My Provider", models: ["my-model"], defaultBaseUrl: "https://api.example.com/v1", apiKeyEnv: "MY_API_KEY", endpointType: "auto", streamingSupport: "streaming", capabilities: [] as string[], description: undefined, website: undefined, docsUrl: undefined },
  declarative: def,
}, "json", "my-provider.json");

// Create a provider and stream a response
const provider = factory.createProvider("my-provider", { apiKey: process.env.MY_API_KEY });

for await (const event of provider.stream({
  messages: [{ role: "user", blocks: [{ type: "text", text: "Hello!" }] }],
  signal: new AbortController().signal,
})) {
  if (event.type === "text-delta") process.stdout.write(event.text);
}
```

### Using the GatewayV2Bridge

```typescript
import { GatewayV2Bridge } from "./packages/agent-runtime/src/provider";

const bridge = new GatewayV2Bridge();
bridge.registerBuiltinProviders();

const factory = bridge.getProviderFactory();
const provider = factory({
  route: { providerId: "openai" },
  credential: { apiKey: process.env.OPENAI_API_KEY },
} as any);
```

## Debugging

### Enable verbose logging

```bash
DEBUG=conex:provider* npx vitest run packages/agent-runtime/src/provider/__tests__/
```

### Test error classification

```typescript
import { OpenAICompatibleEngine } from "./packages/agent-runtime/src/provider/engines";

const engine = new OpenAICompatibleEngine();

// Auth errors
console.log(engine.classifyError(new Error("Unauthorized"), 401));
// { kind: "auth", retryable: false }

// Rate limits
console.log(engine.classifyError(new Error("Rate limit exceeded"), 429));
// { kind: "rate-limit", retryable: true }

// Server errors
console.log(engine.classifyError(new Error("Internal Server Error"), 500));
// { kind: "server", retryable: true }

// Context overflow
console.log(engine.classifyError(new Error("maximum context length exceeded")));
// { kind: "context-overflow", retryable: false }
```

### Test SSRF validation

```typescript
import { validateBaseUrl } from "./packages/agent-runtime/src/provider/auth";

console.log(validateBaseUrl("https://api.openai.com/v1"));          // { valid: true }
console.log(validateBaseUrl("https://localhost:11434/api/chat"));    // { valid: false, error: "Forbidden hostname: localhost" }
console.log(validateBaseUrl("http://192.168.1.1/secret"));           // { valid: false, error: "Private IP ranges are not allowed" }
```

### Integration test with mock data

```typescript
import { ProviderRegistry, ProviderFactory } from "./packages/agent-runtime/src/provider";
import { normalizeDeclarativeDef } from "./packages/agent-runtime/src/provider";

const registry = new ProviderRegistry();
const factory = new ProviderFactory(registry);

const def = normalizeDeclarativeDef({
  providerId: "mock",
  name: "Mock Provider",
  engine: "openai-compatible",
  baseUrl: "https://mock-api.example.com/v1",
  auth: { type: "api-key", placement: "header", keyHeader: "Authorization", defaultEnvVar: "MOCK_API_KEY" },
  models: [{ id: "mock-model", contextWindow: 4096, maxOutputTokens: 4096 }],
});

registry.register({
  providerId: "mock",
  engine: "openai-compatible",
  metadata: { name: "Mock", models: ["mock-model"], defaultBaseUrl: "", apiKeyEnv: "MOCK_API_KEY", endpointType: "chat-completions", streamingSupport: "streaming", capabilities: [] as string[], description: undefined, website: undefined, docsUrl: undefined },
  declarative: def,
}, "json", "mock.json");

const provider = factory.createProvider("mock", { apiKey: "test-key" });
```

## Environment Variable Reference

| Provider | Env Variable | Where to Get It |
|----------|-------------|-----------------|
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |
| DeepSeek | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/api_keys |
| Groq | `GROQ_API_KEY` | https://console.groq.com/keys |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| Mistral | `MISTRAL_API_KEY` | https://console.mistral.ai/api-keys |
| Together | `TOGETHER_API_KEY` | https://api.together.ai/settings/api-keys |
| Fireworks | `FIREWORKS_API_KEY` | https://fireworks.ai/account/api-keys |
| Perplexity | `PERPLEXITY_API_KEY` | https://www.perplexity.ai/settings/api |
| xAI | `XAI_API_KEY` | https://console.x.ai/ |
| GitHub Models | `GITHUB_TOKEN` | https://github.com/settings/tokens |
| Ollama (local) | — | No auth needed |

## Test coverage goals

| Module | File | Tests | Coverage |
|--------|------|-------|----------|
| Registry | `registry.test.ts` | 8 | register, get, list, unregister, file index |
| Factory | `factory.test.ts` | 9 | engine selection, provider creation, error handling |
| Base Engine | `base-engine.test.ts` | 24 | classifyError for all error categories |
| Declarative Loader | `declarative-loader.test.ts` | 7 | file scanning, hot reload, malformed JSON |
| Auth | `auth.test.ts` | 18 | secret store, encryption, SSRF validation |
