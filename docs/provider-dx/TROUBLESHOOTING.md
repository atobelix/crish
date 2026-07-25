# Provider Troubleshooting Guide

Common issues when connecting to LLM providers via Conex.

---

## Connection Failures

### Error by HTTP Status Code

| Status | Meaning | Likely Cause | Solution |
|--------|---------|-------------|----------|
| **401** | Unauthorized | API key is missing, invalid, or revoked | Check env var is set (`echo %<PROVIDER>_API_KEY%`); verify key at provider dashboard |
| **403** | Forbidden | API key lacks permissions or region-locked | Check key has correct scope; some providers require specific regions (e.g., China endpoints) |
| **404** | Not Found | Wrong base URL or endpoint path | Verify `baseUrl` in provider JSON; try `/v1/chat/completions` vs `/v1/messages` |
| **429** | Rate Limited | Exceeded requests/min or tokens/min | Wait and retry; reduce concurrency; check `rateLimiting` config; exponential backoff is built in |
| **500** | Server Error | Provider-side outage | Retry with backoff (built-in); check provider status page |
| **502/503** | Gateway/Busy | Provider upstream error or overload | Retry after 30s; switch to fallback provider |
| **504** | Gateway Timeout | Provider took too long to respond | Reduce `maxTokens`; check `timeoutMs` setting (default 120s) |
| **520/522/523/524** | Cloudflare errors | CDN/connectivity issues behind provider | Retry; check network/proxy |

### Diagnostic Command

```bash
# Enable debug logging to see HTTP request/response details
DEBUG=conex:provider* npx tsx packages/agent-runtime/src/provider/cli/provider-test.ts <providerId>
```

### ClassifyError Reference

All HTTP errors are classified in `base-engine.ts` via `classifyError()`:

| Error Kind | Retryable | Typical Status |
|------------|:---------:|----------------|
| `auth` | No | 401, 403 |
| `rate-limit` | Yes | 429 |
| `quota` | No | 402 |
| `server` | Yes | 500, 502, 503, 504, 520+ |
| `timeout` | Yes | — |
| `network` | Yes | ECONNRESET, ENOTFOUND |
| `context-overflow` | No | — |
| `cancelled` | No | AbortSignal |
| `unknown` | No | Other |

---

## Model Issues

### Model Not Found / Bad Request

```
Error: Model 'gpt-4-32k' not found
```

- Model ID is wrong: check exact ID from provider docs
- Model has been deprecated/removed: check provider changelog
- Built-in provider JSON may be outdated: update model list in `<providerId>.json`

### Context Window Exceeded

```
classifyError: kind=context-overflow, retryable=false
```

- Conversation exceeds `contextWindow` for the model
- Built-in retryable: no, but system will auto-compress/truncate messages
- Check `contextWindow` in provider JSON (e.g., `deepseek-chat` = 128K, `gemini-2.5-flash` = 1M)
- Solution: reduce message history, use smaller model, or increase `contextWindow` if provider supports it

### Max Output Tokens Hit

```
Stop reason: max_tokens
```

- Response was truncated; increase `maxTokens` in request
- Check `maxOutputTokens` in provider JSON matches your use case

### Wrong Engine Assigned

If an OpenAI-compatible provider fails with protocol errors:
- Check `engine` field in JSON: must be `"openai-compatible"`, `"anthropic-messages"`, or `"ollama"`
- Anthropic native provider uses `anthropic-messages` engine, **not** OpenAI-compatible
- Google Gemini uses OpenAI-compatible engine (via `generativelanguage.googleapis.com/v1beta/openai`)

---

## Streaming Issues

### SSE Parsing Failed

```
provider-diagnostic: code=stream_parse_error
```

- Provider returned non-SSE response (e.g., HTML error page)
- Common causes: network proxy injecting HTML, expired auth redirect
- Check raw response: enable `DEBUG=conex:provider*`
- For non-streaming providers, set `streamingSupport: "non-streaming"` in JSON

### Streaming Timeout

```
Error: Timeout after 120000ms
```

- Default timeout is 120s. Adjust via `timeoutMs` in `EngineOptions`
- First-byte timeout: some providers take long to start streaming
- Fix: increase timeout, or switch to a faster provider

### Incomplete Stream / Connection Drops

- Network instability: check WiFi/proxy
- Provider-side: some providers drop idle streams after 30s
- Built-in retry will attempt reconnection (1 retry by default; configure with `fetchWithRetry`)

### Tool Call Streaming

Tool calls arrive as `tool-call` events with partial JSON. The `ToolAccumulator` (Rust crate `conex-stream`) merges streaming tool call chunks. Issues:
- Tool call JSON malformed: check provider's tool schema
- Parallel tool calls not supported: set `parallelToolCalls: false` in capabilities
- Tool call truncated: increase model's `maxOutputTokens`

---

## Authentication Issues

### API Key Not Found

```
Error: No credential found for provider 'deepseek'
```

Check all three secret layers:

1. **Env var**: `echo %PROVIDER_API_KEY%` (or `$env:PROVIDER_API_KEY` in PowerShell)
2. **Encrypted file**: `~/.crish-secrets.enc` (AES-256-GCM)
3. **OS keychain**: Platform keychain (may be unavailable)

Env var naming:
- Standard: `<PROVIDER>_API_KEY` (e.g., `OPENAI_API_KEY`, `GROQ_API_KEY`)
- Generic: `CONEX_SECRET_<UPPERCASE_ID>_API_KEY` (e.g., `CONEX_SECRET_MY_PROVIDER_API_KEY`)
- For `apiKeyEnv` in JSON: the value of `defaultEnvVar` field

### Key Format Issues

| Provider | Expected Format | Common Mistake |
|----------|----------------|----------------|
| OpenAI | `sk-...` (starts with `sk-`) | Including extra whitespace or newlines |
| Anthropic | `sk-ant-...` | Using Bearer token instead of `x-api-key` |
| DeepSeek | `sk-...` | Same as OpenAI format |
| Groq | `gsk_...` | Using OpenAI key for Groq |
| GitHub | `ghp_...` or `github_pat_...` | Token lacks `models:read` scope |
| xAI | `xai-...` | Case-sensitive |

### Auth Header Mismatch

If you get 401 despite having a valid key, check the `authHeader` in `engineOptions`:

| `authHeader` value | HTTP Header |
|--------------------|-------------|
| `authorization` | `Authorization: Bearer <key>` |
| `x-api-key` | `x-api-key: <key>` |
| `x-goog-api-key` | `x-goog-api-key: <key>` |

Anthropic requires `x-api-key`. Google Gemini requires `x-goog-api-key`. Most others use `Authorization: Bearer`.

---

## Chinese Network Special Notes

### Proxy Configuration

```bash
# For users behind GFW accessing international providers
set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890

# Or set in app config (if applicable)
# Conex respects HTTP_PROXY / HTTPS_PROXY env vars natively
```

### Recommended Domestic Providers

For users in China who cannot reliably access OpenAI/Anthropic:

| Provider | Base URL | Stability |
|----------|----------|-----------|
| Qwen (Alibaba) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | High |
| DeepSeek | `https://api.deepseek.com` | High |
| Zhipu (GLM) | `https://open.bigmodel.cn/api/paas/v4` | High |
| Doubao (ByteDance) | `https://ark.cn-beijing.volces.com/api/v3` | High |
| Moonshot (Kimi) | `https://api.moonshot.cn/v1` | High |
| Baichuan | `https://api.baichuan-ai.com/v1` | High |
| Yi (01.AI) | `https://api.lingyiwanwu.com/v1` | High |

### Proxy / Relay Services

Services that relay international providers via Chinese-accessible endpoints:

| Service | Base URL | Notes |
|---------|----------|-------|
| OpenRouter | `https://openrouter.ai/api/v1` | Accessible from China with proxy |
| AI Proxy | `https://api.aiproxy.io/v1` | Dedicated relay |
| API2D | `https://api2d.com/v1` | OpenAI relay |

### SSRF Protection

Conex blocks requests to private/internal IPs by default:
- `localhost`, `127.0.0.1`, `10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`
- If using a local proxy or Ollama, ensure base URL is valid (localhost is allowed for Ollama)

```typescript
validateBaseUrl("https://api.openai.com/v1");     // { valid: true }
validateBaseUrl("http://192.168.1.1/secret");      // { valid: false }
```

---

## CLI Troubleshooting

### Validation Errors

```bash
npx tsx packages/agent-runtime/src/provider/cli/provider-validate.ts path/to/provider.json
```

Common validation errors:

| Error | Fix |
|-------|-----|
| `Missing required field: providerId` | Add `providerId` field |
| `Invalid engine: "anthropic"` | Must be `"anthropic-messages"` (not just `"anthropic"`) |
| `baseUrl must be http or https` | Only http/https schemes allowed |
| `SSRF validation failed` | `baseUrl` points to private IP — change to public endpoint |
| `model[0].id is required` | Each model entry needs an `id` field |
| `auth.type must be one of: api-key, bearer, header, none` | Check auth type |

### Connection Test Failures

```bash
PROVIDER_API_KEY=sk-xxx npx tsx packages/agent-runtime/src/provider/cli/provider-test.ts <providerId>
```

| Symptom | Likely Cause |
|---------|-------------|
| `401 Unauthorized` | Wrong API key or auth header |
| `404 Not Found` | Wrong `baseUrl` or endpoint path |
| `Could not resolve host` | Network issue — check proxy/DNS |
| `Timeout` | Provider slow or unreachable |
| `Stream parse error` | Provider returned non-SSE response |
| `Model list empty` | `/v1/models` endpoint not supported; check `paths` config |

---

## Quick Reference: Log Levels

```bash
# Minimal
DEBUG=conex:provider:error npx tsx ...

# Normal
DEBUG=conex:provider* npx tsx ...

# Verbose (includes HTTP headers, request bodies)
DEBUG=conex:* npx tsx ...
```

## Report a Provider Bug

If you encounter an issue not covered here:
1. Check the provider JSON in `packages/agent-runtime/src/provider/builtin/providers/<providerId>.json`
2. Run validation: `npx tsx .../cli/provider-validate.ts`
3. Collect debug output with `DEBUG=conex:provider*`
4. Open a GitHub issue with the provider name, error message, and debug log
