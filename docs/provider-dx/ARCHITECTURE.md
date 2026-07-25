# Provider System Architecture

## Overview

The Conex Provider system uses a **declarative JSON configuration + three-engine** architecture. External contributors can add a new provider by writing a single JSON file — no TypeScript required.

### Architecture Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    ProviderRegistry                             │
│              Map<providerId, DeclarativeProviderEntry>          │
│           register() / get() / list() / getByFile()            │
├────────────────────────────────────────────────────────────────┤
│                    ProviderFactory                              │
│         Selects Engine + builds EngineProvider instance         │
├────────────────────────────────────────────────────────────────┤
│                   Three Protocol Engines                        │
│  ┌────────────────────┐ ┌──────────────────┐ ┌──────────────┐  │
│  │ OpenAICompatible   │ │ AnthropicMessages│ │  OllamaEngine│  │
│  │ (90% of providers) │ │ (Claude only)    │ │ (local only) │  │
│  └────────────────────┘ └──────────────────┘ └──────────────┘  │
├────────────────────────────────────────────────────────────────┤
│              GatewayV2Bridge (Adapter)                          │
│     Adapts old AgentProviderFactory interface to new system    │
├────────────────────────────────────────────────────────────────┤
│                     Auth Subsystem                              │
│  ┌──────────┐ ┌───────────────┐ ┌───────────────┐             │
│  │SecretStore│ │ EncryptedFile │ │ BaseUrlValidator │            │
│  │(3 layers) │ │ (AES-256-GCM) │ │ (SSRF guard)  │             │
│  └──────────┘ └───────────────┘ └───────────────┘             │
├────────────────────────────────────────────────────────────────┤
│                     CLI Tools                                   │
│  provider-validate.ts / provider-test.ts / provider-list.ts    │
└────────────────────────────────────────────────────────────────┘
```

## Core Flow

### Startup Sequence

```
Application Start
  │
  ▼
GatewayV2Bridge.registerBuiltinProviders()
  │
  ▼
DeclarativeLoader scans builtin/providers/*.json
  │
  ▼
Each JSON → normalizeDeclarativeDef()
  │
  ▼
ProviderRegistry.register(providerId, entry)
  │
  ▼
ProviderFactory registers 3 engines (openai-compatible, anthropic-messages, ollama)
```

### Request Flow

```
AgentRuntime needs a provider
  │
  ▼
GatewayV2Bridge.getProviderFactory() → returns factory function
  │
  ▼
ProviderFactory.createProvider(providerId, credentials)
  │
  ├── ProviderRegistry.get(providerId) → looks up declarative def
  ├── ProviderFactory selects engine by def.engine
  └── Returns EngineProvider instance
  │
  ▼
EngineProvider.stream(request)
  │
  ├── Engine.buildRequest() → construct URL + headers + body
  ├── fetchWithRetry() → HTTP call with timeout + retry
  ├── Content-Type check → parseStream (SSE) or parseResponse (JSON)
  └── Yields ProviderStreamEvent[] (text-delta, tool-call, stop, etc.)
```

## File Structure

```
packages/agent-runtime/src/provider/
├── index.ts                           # Public API exports
├── types.ts                           # Engine, EngineOptions, EngineRequest, ProviderDef
├── registry.ts                        # ProviderRegistry — provider registration & lookup
├── declarative-schema.ts              # DeclarativeProviderDef + NormalizedDeclarativeDef + normalizeDeclarativeDef()
├── loader.ts                          # DeclarativeLoader — file scanning + hot reload via fs.watch
├── factory.ts                         # ProviderFactory + EngineProvider
├── provider-gateway-v2.ts             # GatewayV2Bridge — adapter for old gateway interface
├── builtin/
│   ├── index.ts                       # registerBuiltinProviders()
│   └── providers/                     # Declarative JSON files (12+ providers)
│       ├── openai.json
│       ├── anthropic.json
│       ├── deepseek.json
│       ├── groq.json
│       └── ...
├── engines/
│   ├── index.ts                       # Engine exports
│   ├── base-engine.ts                 # AbstractBaseEngine + fetchWithRetry + classifyError
│   ├── openai-compatible-engine.ts    # OpenAI Chat Completions / Responses API
│   ├── anthropic-messages-engine.ts   # Anthropic Messages API
│   └── ollama-engine.ts               # Ollama /api/chat
├── auth/
│   ├── index.ts                       # Auth exports
│   ├── types.ts                       # SecretValue, AuthMethod (9 types), OAuth2Config
│   ├── secret-store.ts                # AutoSecretStore — 3-layer key storage
│   ├── encrypted-file-store.ts        # AES-256-GCM encrypted vault
│   ├── base-url-validator.ts          # SSRF protection — blocks private IPs
│   └── base-url-validator.test.ts     # URL validation tests
├── cli/
│   ├── index.ts                       # CLI exports
│   ├── provider-validate.ts           # JSON schema + SSRF validation
│   ├── provider-test.ts               # Connection testing (model list, streaming, tool calls)
│   └── provider-list.ts               # List all registered providers
└── __tests__/
    ├── registry.test.ts               # 8 tests
    ├── factory.test.ts                # 9 tests
    ├── base-engine.test.ts            # 24 tests
    ├── declarative-loader.test.ts     # 7 tests
    ├── auth.test.ts                   # 18 tests
    └── e2e/                           # E2E integration tests
```

## Key Interfaces

### Engine (protocol handler)

```typescript
interface Engine {
  readonly id: string;   // "openai-compatible" | "anthropic-messages" | "ollama"

  buildRequest(request: AgentProviderRequest, options: EngineOptions): EngineRequest;
  parseStream(response: Response, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
  parseResponse(body: unknown): AsyncIterable<ProviderStreamEvent>;
}
```

### EngineRequest (wire format)

```typescript
interface EngineRequest {
  url: string;           // Full URL including endpoint path
  init: RequestInit;     // Method, headers, body
}
```

### DeclarativeProviderDef (JSON schema)

```typescript
interface DeclarativeProviderDef {
  providerId: string;
  name: string;
  engine: "openai-compatible" | "anthropic-messages" | "ollama";
  baseUrl: string;
  auth?: { type: "api-key" | "bearer" | "header" | "none"; placement: "header" | "query"; ... };
  models: Array<{ id: string; capabilities?: string[]; contextWindow?: number; ... }>;
  capabilities?: { toolUse?: boolean; vision?: boolean; ... };
  engineOptions?: { authHeader?: string; maxTokensField?: string; ... };
  // ... see declarative-schema.ts for full definition
}
```

## Engine Details

### OpenAI Compatible Engine (`openai-compatible-engine.ts`)

- **Supports**: Both Chat Completions (`/chat/completions`) and Responses (`/responses`) API
- **Endpoint selection**: `endpointType` in JSON (`"auto"`, `"chat-completions"`, `"responses"`)
  - `"auto"` defaults to `"responses"` when tools are present, else `"chat-completions"`
- **Request building**: Delegates to `buildChatCompletionsRequestBody()` or `buildResponsesRequestBody()`
- **Stream parsing**: Delegates to `parseChatCompletionsStreamingResponse()` or `parseResponsesStreamingResponse()`
- **Auth header**: Controlled by `engineOptions.authHeader` (`authorization`, `x-api-key`, `x-goog-api-key`)
- **Max tokens field**: Controlled by `engineOptions.maxTokensField` (`max_tokens`, `max_completion_tokens`)
- **Reasoning content**: Controlled by `engineOptions.reasoningContent` (`omit`, `thought-delta`, `text-delta`)
- **Cache hints**: Built automatically via `createProviderCacheHintPlan()` for prompt caching

### Anthropic Messages Engine (`anthropic-messages-engine.ts`)

- **Endpoint**: Anthropic Messages API (`/v1/messages`)
- **Auth**: `x-api-key` header + `anthropic-version` header
- **Thinking support**: Configurable via `thinking` option with `budget_tokens`
- **Beta features**: Uses `anthropic-beta: interleaved-thinking-2025-05-14` header when thinking is enabled
- **Message conversion**: Delegates to `toAnthropicMessages()`, `resolveAnthropicSystem()`, `toAnthropicTool()`
- **Stream parsing**: Delegates to `parseAnthropicMessagesStreamingResponse()`

### Ollama Engine (`ollama-engine.ts`)

- **Endpoint**: Ollama `/api/chat`
- **Auth**: None (local service)
- **Keep-alive**: Configurable via `keepAlive` option (default `"5m"`)
- **Message conversion**: Manual mapping from AgentMessage to OllamaMessage
- **Tool support**: Tools are formatted as Ollama's `tools` field in the request body
- **Stream parsing**: Manual NDJSON line-by-line parsing with JSON chunk extraction
- **Usage extraction**: From `prompt_eval_count` and `eval_count` fields

## Auth Subsystem

### Three-Layer Secret Store

```
AutoSecretStore.load("MY_PROVIDER_API_KEY")
  │
  ├── Layer 1: OSKeychainStore (platform keychain — may be unavailable)
  ├── Layer 2: EncryptedFileSecretStore (AES-256-GCM, PBKDF2, ~/.crish-secrets.enc)
  └── Layer 3: EnvVarStore (CONEX_SECRET_MY_PROVIDER_API_KEY env var)
```

### SSRF Protection

`base-url-validator.ts` blocks:
- Private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x)
- Link-local addresses (169.254.x)
- Forbidden hostnames (localhost, metadata services)
- Only `http:` and `https:` schemes allowed

## Dependency Graph

```
provider-gateway.ts (old system)
    │
    ▼
provider-gateway-v2.ts → GatewayV2Bridge
    │
    ├── registry.ts → ProviderRegistry (map of provider entries)
    │       │
    │       ├── declarative-schema.ts → DeclarativeProviderDef, normalizeDeclarativeDef()
    │       │
    │       └── builtin/providers/*.json (loaded via DeclarativeLoader or registerFromFile)
    │
    ├── factory.ts → ProviderFactory
    │       │
    │       ├── engines/base-engine.ts → AbstractBaseEngine, fetchWithRetry
    │       ├── engines/openai-compatible-engine.ts → OpenAICompatibleEngine
    │       ├── engines/anthropic-messages-engine.ts → AnthropicMessagesEngine
    │       └── engines/ollama-engine.ts → OllamaEngine
    │
    ├── loader.ts → DeclarativeLoader (hot reload via fs.watch)
    │
    └── auth/
        ├── secret-store.ts → AutoSecretStore (3-layer key lookup)
        ├── encrypted-file-store.ts → EncryptedFileSecretStore (AES-256-GCM)
        └── base-url-validator.ts → validateBaseUrl (SSRF guard)
```

## Extension Points

### Adding a new Engine (only for fundamentally different protocols)

1. Create file in `engines/<name>-engine.ts`
2. Implement the `Engine` interface:
   - `buildRequest()` — convert AgentProviderRequest + EngineOptions to HTTP request
   - `parseStream()` — parse SSE/NDJSON response body into ProviderStreamEvent
   - `parseResponse()` — parse JSON response body into ProviderStreamEvent
3. Register in `ProviderFactory` constructor

### Adding a new declarative Provider (recommended, no code)

1. Create JSON file in `builtin/providers/<providerId>.json`
2. Follow the `DeclarativeProviderDef` schema (see `declarative-schema.ts`)
3. Validate with CLI: `npx tsx src/provider/cli/provider-validate.ts <file>`
4. Test connection with CLI: `npx tsx src/provider/cli/provider-test.ts <providerId>`

## CLI Tools

### provider-validate.ts

```bash
# Validate a single provider JSON file
npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts path/to/file.json

# Validate all JSON files in a directory
npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts path/to/dir/
```

Checks: required fields, engine validity, baseUrl format, SSRF safety, model structure, normalization.

### provider-test.ts

```bash
# Test a registered provider's connection
PROVIDER_API_KEY=sk-xxx \
  npx tsx packages/agent-runtime/src/provider/cli/provider-test.ts <providerId>
```

Tests: model list endpoint, streaming response, tool call format.

### provider-list.ts

```bash
# List all registered providers
npx tsx packages/agent-runtime/src/provider/cli/provider-list.ts
```
