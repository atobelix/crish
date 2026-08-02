# Provider System Changelog

## M4 (Completion)

- **Extended to 35+ declarative providers**: Added 23 new built-in providers including Chinese-market (Qwen, Zhipu, Moonshot, Baichuan, Yi, Doubao, Hunyuan, Baidu, Stepfun, MiniMax, SenseTime), hosted platforms (OpenRouter, GitHub Models, Perplexity, Together, Fireworks), and niche providers (Anyscale, Replicate, HuggingFace, Cohere, AI21, Writer, Cerebras, SambaNova)
- **Old code cleanup**: Deprecated `provider-factory.ts` dual-track interface; consolidated into unified `ProviderFactory` + `GatewayV2Bridge`
- **CLI tools finalized**: `provider-validate.ts` — JSON schema + SSRF validation; `provider-test.ts` — connection testing (model list, streaming, tool calls); `provider-list.ts` — list all registered providers
- **Documentation completed**: PROVIDER-CATALOG.md (full provider matrix with capabilities, pricing, auth), TROUBLESHOOOTING.md (error codes, streaming issues, network special cases), CHANGELOG-PROVIDER.md
- **M4 audit**: Security audit passed; no remaining stubs in production paths

## M3 (Advanced Features)

- **OAuth PKCE flow**: Full OAuth 2.0 PKCE implementation with local server, cross-process lock, and state machine (`auth/oauth/`)
- **ChatGPT account pool**: `ChatGptAccountPool` + `TokenGuardian` for credential rotation and session management
- **Vendor-specific stream parsers**: Dedicated SSE parsers for OpenAI Chat/Responses API, Anthropic Messages API, and Google Gemini (`crates/conex-stream/src/parser/`)
- **ToolStream accumulation engine**: Rust `ToolAccumulator` in `crates/conex-stream/src/state/tool_accumulator.rs` — merges streaming tool call delta chunks with JSON repair
- **Multimodal processing pipeline**: Vision input handling across all engines (base64 images, URL references, PDF input support)
- **StreamingToolExecutor**: Real-time tool call execution during stream without waiting for full response
- **Performance benchmarks**: Rust bench suite (`crates/conex-stream/benches/stream_bench.rs`) for streaming latency and throughput

## M2 (Routing + UI)

- **ProviderGateway v2 bridge**: `GatewayV2Bridge` — adapter layer that bridges old `AgentProviderFactory` interface with new declarative provider system; SSRF validation at gateway level
- **ModelCatalog + LiteLLM loading**: `ModelCatalog` class in `model-catalog/types.ts` — loads from LiteLLM-format JSON; `CatalogSync` for periodic sync; `lookup()` / `forProvider()` / `listAll()` query methods
- **Cost-aware routing**: `DefaultProviderGateway` with priority/weight-based route selection, health scoring, cooldown logic (exponential backoff up to 60min), fallback chains
- **FallbackChain**: Automatic fallback between providers when primary route is unhealthy or rate-limited; configurable priority and routing weight per route
- **Settings UI**: Three-tab settings interface — Provider (API key configuration), Routing (model routes, priorities, fallback), Account (OAuth credentials, account pool)
- **CI pipeline enhancements**: E2E test framework with mock SSE server (`__tests__/e2e/mock-server.ts`); performance benchmarks integrated into CI
- **Security audit M1-M2**: Comprehensive audit (`docs/security/SECURITY-AUDIT-M1M2.md`) — SSRF, OOM, encryption, key rotation, credential pooling reviewed

## M1 (Infrastructure)

- **ProviderRegistry**: Central registry `Map<providerId, DeclarativeProviderEntry>` with `register()`, `get()`, `list()`, `unregister()`, `getByFile()`; file index for hot-reload tracking
- **ProviderFactory**: Engine selection logic — dispatches to OpenAICompatibleEngine, AnthropicMessagesEngine, or OllamaEngine based on `engine` field in declarative def
- **Three protocol engines**:
  - `OpenAICompatibleEngine` — Chat Completions (`/chat/completions`) and Responses (`/responses`) API; endpoint auto-selection; configurable auth header and max tokens field
  - `AnthropicMessagesEngine` — Anthropic Messages API (`/v1/messages`); thinking/reasoning support; `anthropic-beta` headers; prompt caching
  - `OllamaEngine` — Local `/api/chat`; keep-alive config; NDJSON parsing
- **Declarative JSON system**: `DeclarativeProviderDef` schema — providerId, name, engine, baseUrl, auth, models, capabilities, engineOptions, rateLimiting; `normalizeDeclarativeDef()` sets all defaults
- **12 built-in providers**: OpenAI, Anthropic, DeepSeek, Google Gemini, Groq, Mistral, xAI, Together, Fireworks, OpenRouter, Perplexity, GitHub Models
- **Auth system (9 AuthMethod types)**:
  - `no_auth`, `bearer_token`, `api_key`, `basic`, `aws_sig_v4`, `azure_api_key`, `oauth`, `custom`, `chain`
- **Three-layer key storage** (`AutoSecretStore`):
  - Layer 1: OSKeychain (platform keychain)
  - Layer 2: EncryptedFile (`~/.crish-secrets.enc`, AES-256-GCM, PBKDF2)
  - Layer 3: EnvVar (`CONEX_SECRET_<KEY>`)
- **StreamParser trait + SSE parser**: `AbstractBaseEngine` with `parseStream()` / `parseResponse()`; SSE frame parsing in Rust crate `crates/conex-stream/src/parser/sse.rs`
- **Security fixes**:
  - SSRF protection: `base-url-validator.ts` blocks private IPs, localhost, metadata services; only http/https schemes allowed
  - OOM guard: configurable `maxTokens` limits, context window enforcement
  - Key encryption: AES-256-GCM encrypted vault with PBKDF2 key derivation
  - Log sanitizer: `auth/log-sanitizer.ts` — redacts API keys from logs before output
- **DeclarativeLoader**: File scanning with `fs.watch` hot-reload; `registerFromFile()` — reads JSON, normalizes, registers
- **Error classification**: `classifyError()` in `base-engine.ts` — 9 error kinds: auth, rate-limit, quota, server, timeout, network, cancelled, context-overflow, unknown; retryable determination
- **CredentialResolver + CredentialPool**: Flexible credential resolution with pooling, key rotation, and status tracking
- **Base URL validation test suite**: `base-url-validator.test.ts` — SSRF edge cases, private IPs, valid public URLs

---

## Provider JSON Schema Evolution

| Version | Changes |
|---------|---------|
| M1 | Initial schema: providerId, engine, baseUrl, auth, models, capabilities, endpointType |
| M2 | Added: engineOptions (authHeader, maxTokensField, reasoningContent), rateLimiting, paths override, metadata |
| M3 | Added: streamingSupport, toolChoice, keepAlive (Ollama), anthropicVersion, parallelToolCalls |
| M4 | Finalized schema with full normalization; backwards-compatible defaults for all fields |

## Migration Guide

### M1 → M2
- Provider JSON files moved from inline registration to `builtin/providers/*.json`
- `ProviderGateway` replaced by `GatewayV2Bridge` as the main entry point
- Routes now can have health tracking and cooldown

### M2 → M3
- OAuth credentials stored in new `auth/oauth/` subsystem
- Stream parsing moved to Rust crate `conex-stream` for performance
- Tool calls now support streaming accumulation via `ToolAccumulator`

### M3 → M4
- `provider-factory.ts` old dual-track interface is **deprecated** — use `ProviderFactory` directly
- New provider JSON files should include `engineOptions.maxTokensField` and `engineOptions.reasoningContent`
- All new built-in providers should pass `provider-validate.ts` before merge
