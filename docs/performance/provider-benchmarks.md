# Provider Engine Performance Benchmarks

## Rust Benchmarks

Streaming and SSE parsing benchmarks (Rust native):

```bash
cargo bench -p conex-stream
```

Key metrics:
- SSE frame parsing latency: < 5μs/frame
- Tool call accumulation: < 100μs/10 tools
- Streaming throughput: > 500 MB/s parsing

## TypeScript Benchmarks

Provider system benchmarks:

```bash
npx vitest bench packages/agent-runtime/src/provider/__tests__/benchmarks/
```

Key metrics:
- Provider factory creation: < 1ms/instance
- Registry lookup by ID: < 0.1ms/lookup
- Registry lookup by file: < 0.1ms/lookup
- Provider registration: < 50ms/100 providers
- DeclarativeLoader directory scan: < 5ms/50 JSON files
- Normalize declarative def: < 0.5ms/def
- Auth header construction: < 0.1ms/request
- Base URL validation: < 0.1ms/URL

## Running Benchmarks

```bash
# Rust stream benchmarks
cargo bench -p conex-stream

# TypeScript provider benchmarks
npx vitest bench packages/agent-runtime/src/provider/__tests__/benchmarks/

# All tests (unit + benchmark)
npx vitest run packages/agent-runtime/src/provider/__tests__/
```

## Benchmark History

| Date | Metric | Value | Notes |
|------|--------|-------|-------|
| — | SSE frame parsing | < 5μs/frame | Rust native |
| — | Provider factory creation | < 1ms | First-time init |
| — | Registry lookup | < 0.1ms | Map.get |

## Performance Optimization Tips

1. **SSE streaming**: Use `fetchWithRetry` with proper timeout to avoid hanging connections
2. **Concurrent requests**: Each `EngineProvider` instance is lightweight — create one per request
3. **Hot reload**: `DeclarativeLoader` uses `fs.watch` — avoid rapid file writes that trigger cascading reloads
4. **Secret store**: `AutoSecretStore` tries 3 layers — for production, use env vars (Layer 3) to skip file I/O
5. **URL validation**: `validateBaseUrl` is called on every `GatewayV2Bridge.getProviderFactory()` call — use cached URLs when possible
