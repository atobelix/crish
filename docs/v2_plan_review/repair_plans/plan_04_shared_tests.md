# Plan 04 — Shared Packages & Test File Compilation Repair

## 1. Error Panorama

### 1.1 Root Cause Analysis

The entire repository is configured with `tsconfig.base.json` which sets:
- `"exactOptionalPropertyTypes": true` — the single largest source of errors (~75% of all errors)
- `"noUnusedLocals": true` — second largest (~15%)
- `"strict": true` (implies `strictNullChecks`, `noUncheckedIndexedAccess`) — remaining ~10%

Every package inherits these flags. Source code and test files incorrectly pass `| undefined` values where the type expects exact optional (`prop?: T` means `prop` must be `T` or absent, not `T | undefined`). This affects spread/object literals, function arguments, and class property assignments.

### 1.2 Error Distribution by Package

| Package | Source files with errors | Test files with errors | Total error count |
|---|---|---|---|
| packages/shared-utils/src/ | 4 src + 2 test | 2 | ~20 |
| packages/shared-types/src/ | 0 | 0 | 0 |
| packages/agent-provider-http/ | no tsconfig.json | — | N/A |
| packages/plugin-sdk/ | no tsconfig.json | — | N/A |
| packages/test-utils/ | no tsconfig.json | — | N/A |
| packages/agent-runtime/src/ | ~80 src | ~50 test | ~800+ |
| packages/agent-daemon/src/ | ~60 src | ~12 test | ~600+ |

### 1.3 Error Categories

#### Category A: exactOptionalPropertyTypes (TS2375, TS2379, TS2412)

The most pervasive issue. When a type declares `prop?: SomeType`, assigning `prop: SomeType | undefined` in an object literal causes TS2375. Passing as function argument causes TS2379. Class field assignment causes TS2412.

**Fix options:**
1. **Remove `exactOptionalPropertyTypes` from tsconfig** — quickest, but changes contract
2. **Use `undefined` type assertions** — `prop: (undefined as undefined)` when needed
3. **Use `null` instead of `undefined`** — requires type changes
4. **Use spread with conditional** — `...(obj.prop !== undefined ? { prop: obj.prop } : {})`

**Recommendation:** Fix source code by removing `| undefined` from object literal values where the property is optional. For cases where runtime semantics require `undefined`, use `as unknown as T` or conditional spreads.

#### Category B: Unused declarations (TS6133, TS6196, TS6192)

Imports, variables, and type aliases declared but never used.

**Fix:** Remove the unused entity.

#### Category C: Cross-project rootDir violations (TS6059, TS6307)

`shared-utils` tsconfig sets `rootDir: src/` but test files import from `apps/crish-desktop/src/`.

**Fix:** Either use project references or adjust rootDir/include.

#### Category D: Strict null checks (TS2532, TS18048)

Object accessed without null guard.

**Fix:** Add `!` (non-null assertion) or proper null check.

#### Category E: Type incompatibility (TS2322, TS2345, TS2353, TS2739, TS2741)

Literal types, missing required properties, excess properties.

**Fix:** Adjust the literal or cast.

### 1.4 Root Config Issues

#### tsconfig.base.json
- Line 19: `"exactOptionalPropertyTypes": true` — root cause of ~75% errors
- Line 20: `"noUnusedLocals": true` — root cause of ~15% errors
- Line 18: `"noUncheckedIndexedAccess": true` — root cause of ~5% errors (TS2532 on array/map access)

#### turbo.json
- Currently uses legacy `"pipeline"` format (Turbo 1.x). Modern Turbo 2.x uses `"tasks"` — but if the project runs on 1.x, no changes needed.
- `"typecheck"` depends on `"build:types"` — this creates a circular risk if `build:types` depends on typecheck.

#### vitest.workspace.ts
- `include` patterns exclude `**/__tests__/e2e/**` and `**/__tests__/integrations/**` from unit tests
- These patterns are handled by separate `integration` and `e2e` configs — correct.
- However, the unit test pattern `packages/*/src/**/*.test.ts` does NOT match tests in `__tests__/` subdirectories of agent-runtime because they are at `packages/agent-runtime/src/__tests__/` which IS matched by `packages/*/src/**/*.test.ts` (the `**` matches `__tests__/`). So this is actually correct.

---

## 2. Fix Strategy

### 2.1 Phase 1: Config Fixes

| Priority | File | Change |
|---|---|---|
| P0 | tsconfig.base.json | Remove `exactOptionalPropertyTypes` OR keep it and fix all source code |
| P1 | packages/shared-utils/tsconfig.json | Add `"include": ["src/**/*.ts", "src/**/*.json"]` and remove cross-project imports |
| P1 | packages/agent-provider-http/ | Create tsconfig.json |
| P1 | packages/plugin-sdk/ | Create tsconfig.json |
| P1 | packages/test-utils/ | Create tsconfig.json |

### 2.2 Phase 2: Automated Fixes (Category B)

Unused declarations can be safely removed in bulk. Estimate: ~200 removals across the repo.

### 2.3 Phase 3: exactOptionalPropertyTypes Fixes (Category A)

The most labor-intensive. Each site where `T | undefined` is passed to `prop?: T` must be fixed by either:
- Removing `| undefined` from the value expression
- Using a conditional object spread
- Or by changing the upstream type

### 2.4 Phase 4: Strict Null Checks (Category D)

Add `!` assertions or guard conditions.

### 2.5 Phase 5: Type Literal Fixes (Category E)

Fix literal values to match the expected union types.

---

## 3. Write Set Isolation

### 3.1 Independent Write Sets

All test files are independent of each other. Source files within the same package have dependency relationships through imports.

| Write Set | Files | Conflict Risk |
|---|---|---|
| WS-01 | tsconfig.base.json (root) | Depends on nothing |
| WS-02 | turbo.json (root) | Depends on nothing |
| WS-03 | vitest.workspace.ts, vitest.config.ts (root) | Depends on nothing |
| WS-04 | packages/shared-utils/tsconfig.json | Independent |
| WS-05 | packages/shared-utils/src/*.ts | Source files, may conflict within package |
| WS-06 | packages/agent-provider-http/ (all) | Independent |
| WS-07 | packages/plugin-sdk/ (all) | Independent |
| WS-08 | packages/test-utils/ (all) | Independent |
| WS-09 | packages/agent-runtime/src/*.ts (non-test) | May conflict within package |
| WS-10 | packages/agent-runtime/src/__tests__/*.test.ts | Fully independent — all parallel |
| WS-11 | packages/agent-runtime/src/provider/__tests__/*.test.ts | Fully independent — all parallel |
| WS-12 | packages/agent-runtime/src/*.test.ts (scattered) | Fully independent — all parallel |
| WS-13 | packages/agent-daemon/src/*.ts (non-test) | May conflict within package |
| WS-14 | packages/agent-daemon/src/**/*.test.ts | Fully independent — all parallel |

### 3.2 Parallel Execution Strategy

All test files can be fixed in parallel by separate agents. Source files within each package should be fixed by a single agent to avoid conflicts.

---

## 4. Task Card Table

### 4.1 Configuration & Shared Utils

#### T-CONFIG-001: Remove or fix exactOptionalPropertyTypes
- **File**: `tsconfig.base.json`
- **Line**: 19
- **Error**: Entire repo affected by TS2375/TS2379/TS2412
- **Root Cause**: `"exactOptionalPropertyTypes": true` causes every `prop: T | undefined` assigned to `prop?: T` to fail
- **Fix Option A**: Remove `"exactOptionalPropertyTypes": true` (resolves ~600 errors across repo instantly)
- **Fix Option B**: Keep the flag and fix every site — estimate 2-3 days of work
- **Acceptance**: `npx tsc --noEmit --project packages/agent-runtime/tsconfig.json` error count drops dramatically

#### T-CONFIG-002: Fix shared-utils tsconfig rootDir
- **File**: `packages/shared-utils/tsconfig.json`
- **Line**: N/A (structural)
- **Error code**: TS6059, TS6307
- **Root Cause**: `rootDir` set to `packages/shared-utils/src` but test files import from `apps/crish-desktop/src/api/`
- **Fix**: Add `apps/crish-desktop/src/api/` to `include` array or use references
- **Acceptance**: `npx tsc --noEmit --project packages/shared-utils/tsconfig.json` no longer shows TS6059

#### T-CONFIG-003: Add tsconfig to agent-provider-http
- **File**: `packages/agent-provider-http/tsconfig.json` (new)
- **Error**: `TS5058: The specified path does not exist: 'packages/agent-provider-http/tsconfig.json'`
- **Fix**: Create tsconfig extending tsconfig.base.json
- **Acceptance**: `npx tsc --noEmit --project packages/agent-provider-http/tsconfig.json` succeeds

#### T-CONFIG-004: Add tsconfig to plugin-sdk
- **File**: `packages/plugin-sdk/tsconfig.json` (new)
- **Error**: `TS5058: The specified path does not exist: 'packages/plugin-sdk/tsconfig.json'`
- **Fix**: Create tsconfig extending base
- **Acceptance**: `npx tsc --noEmit --project packages/plugin-sdk/tsconfig.json` succeeds

#### T-CONFIG-005: Add tsconfig to test-utils
- **File**: `packages/test-utils/tsconfig.json` (new)
- **Error**: `TS5058: The specified path does not exist: 'packages/test-utils/tsconfig.json'`
- **Fix**: Create tsconfig extending base
- **Acceptance**: `npx tsc --noEmit --project packages/test-utils/tsconfig.json` succeeds

#### T-SHARED-001: streaming-jsonl-reader.ts highWaterMark
- **File**: `packages/shared-utils/src/file/streaming-jsonl-reader.ts`
- **Line**: 35
- **Error code**: TS2379
- **Root Cause**: `{ highWaterMark: number | undefined }` assigned to `StreamingFileReaderOptions` where `highWaterMark` is non-optional
- **Fix**: Remove `undefined` from the value, or add a default
- **Acceptance**: `npx tsc --noEmit --project packages/shared-utils/tsconfig.json` no longer shows TS2379 on this file

#### T-SHARED-002: hardware-profile.ts deviceMemory
- **File**: `packages/shared-utils/src/hardware-profile.ts`
- **Line**: 176
- **Error code**: TS2375
- **Root Cause**: `{ deviceMemory: number | undefined }` assigned to type with `deviceMemory?: number`
- **Fix**: Conditional spread: `...(deviceMemory !== undefined ? { deviceMemory } : {})`
- **Acceptance**: TS2375 cleared

#### T-SHARED-003: jsonl-append-batcher.ts signal property
- **File**: `packages/shared-utils/src/jsonl-append-batcher.ts`
- **Line**: 69
- **Error code**: TS2375
- **Root Cause**: `signal: AbortSignal | undefined` assigned to `{ signal?: AbortSignal }`
- **Fix**: Conditional spread for signal
- **Acceptance**: TS2375 cleared

#### T-SHARED-004: mockFactories.ts secretToken
- **File**: `packages/shared-utils/src/test/mockFactories.ts`
- **Line**: 41
- **Error code**: TS2375
- **Root Cause**: `secretToken: string | undefined` in `MockDaemonConfig` with exact optional
- **Fix**: `secretToken: "test-token"` (hardcode for test)
- **Acceptance**: TS2375 cleared

#### T-SHARED-005: StreamRenderBuffer.test.ts
- **File**: `packages/shared-utils/src/__tests__/StreamRenderBuffer.test.ts`
- **Line**: 2
- **Error code**: TS6059, TS6307
- **Root Cause**: Imports from `apps/crish-desktop/src/api/` across package boundary
- **Fix**: Move test to crish-desktop or add path mapping
- **Acceptance**: Error cleared

#### T-SHARED-006: seek-sequence.test.ts JSON import
- **File**: `packages/shared-utils/src/file/seek-sequence.test.ts`
- **Line**: 11
- **Error code**: TS6307
- **Root Cause**: JSON file not listed in tsconfig file list
- **Fix**: Add `"resolveJsonModule": true` to package tsconfig (inherited from base, but needs include)
- **Acceptance**: Error cleared

### 4.2 agent-runtime __tests__/ (top-level)

#### T-TS-001: canonical-schema.test.ts
- **File**: `packages/agent-runtime/src/__tests__/canonical-schema.test.ts`
- **Line**: 135, 172
- **Error code**: TS2488, TS2322
- **Root Cause**: Line 135: destructuring a `JsonValue` which doesn't have `[Symbol.iterator]`. Line 172: `{ type: any }` not assignable to `ToolConcurrency`
- **Fix**: Line 135: cast with `as unknown as SomeIterableType[]` or access by index. Line 172: use `as ToolConcurrency`
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/canonical-schema.test.ts`

#### T-TS-002: canonicalize-tools.test.ts
- **File**: `packages/agent-runtime/src/__tests__/canonicalize-tools.test.ts`
- **Line**: 10, 12, 15, 66-67, 91, 93
- **Error code**: TS2322 (x4), TS2532 (x3), TS2345
- **Root Cause**: `"builtin"` not assignable to `ToolCategory`; `{ type: "adaptive" }` not assignable to `ToolConcurrency`; execute handler signature mismatch; filter result access without null check
- **Fix**: Fix literal values to match enum/type; add `!` assertions; add filter null guard
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/canonicalize-tools.test.ts`

#### T-TS-003: context-slicer.test.ts
- **File**: `packages/agent-runtime/src/__tests__/context-slicer.test.ts`
- **Line**: 153
- **Error code**: TS2532, TS2339
- **Root Cause**: Object possibly undefined when accessing `.text` on `LLMMessageBlock`
- **Fix**: Use optional chaining `?.text` or `!` assertion
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/context-slicer.test.ts`

#### T-TS-004: steering-input-queue.test.ts
- **File**: `packages/agent-runtime/src/__tests__/steering-input-queue.test.ts`
- **Line**: 93, 94
- **Error code**: TS2532
- **Root Cause**: Object possibly undefined
- **Fix**: Add `!` assertion
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/steering-input-queue.test.ts`

### 4.3 agent-runtime __tests__/integrations/

#### T-TS-005: chatgpt-pool.test.ts
- **File**: `packages/agent-runtime/src/__tests__/integrations/chatgpt-pool.test.ts`
- **Line**: 206
- **Error code**: TS2379
- **Root Cause**: `{ refreshToken: undefined }` passed to `Partial<ChatGPTAccount>` with exact optional
- **Fix**: Omit `refreshToken` entirely
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/integrations/chatgpt-pool.test.ts`

#### T-TS-006: media-pipeline.test.ts
- **File**: `packages/agent-runtime/src/__tests__/integrations/media-pipeline.test.ts`
- **Line**: 360, 362
- **Error code**: TS2532
- **Root Cause**: Object possibly undefined
- **Fix**: Add `!` assertions
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/integrations/media-pipeline.test.ts`

#### T-TS-007: oauth-flow.test.ts
- **File**: `packages/agent-runtime/src/__tests__/integrations/oauth-flow.test.ts`
- **Line**: 39, 163
- **Error code**: TS2339, TS2379
- **Root Cause**: Line 39: `codeChallenge` doesn't exist on the mock type. Line 163: `refreshUrl: undefined` with exact optional.
- **Fix**: Line 39: add `codeChallenge` to mock type or cast. Line 163: omit `refreshUrl` or use `null`.
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/integrations/oauth-flow.test.ts`

#### T-TS-008: streaming-executor.test.ts
- **File**: `packages/agent-runtime/src/__tests__/integrations/streaming-executor.test.ts`
- **Line**: 1, 30-31, 117, 137-138, 153-155, 231, 246-247
- **Error code**: TS6133, TS2532 (x10)
- **Root Cause**: Unused `beforeEach` (TS6133). Multiple `Object is possibly 'undefined'` on mock responses.
- **Fix**: Remove unused import; add `!` assertions to all TS2532 sites
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/integrations/streaming-executor.test.ts`

#### T-TS-009: tool-stream.test.ts
- **File**: `packages/agent-runtime/src/__tests__/integrations/tool-stream.test.ts`
- **Line**: 24, 25, 126, 154-156, 168-172
- **Error code**: TS2571 (x2), TS2353, TS2532 (x9)
- **Root Cause**: `unknown` type objects accessed directly (TS2571). Excess `index` property in object literal (TS2353). Unchecked optional access (TS2532).
- **Fix**: Cast `unknown` to proper type; remove `index` from literal or add to type; add `!` assertions
- **Acceptance**: `npx vitest run packages/agent-runtime/src/__tests__/integrations/tool-stream.test.ts`

### 4.4 agent-runtime __tests__/provider/__tests__/

#### T-TS-010: auth.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/auth.test.ts`
- **Line**: 3, 159, 160
- **Error code**: TS6196, TS2532
- **Root Cause**: Unused `SecretValue` import; unchecked optional access
- **Fix**: Remove unused import; add `!` assertions
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/__tests__/auth.test.ts`

#### T-TS-011: base-engine.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/base-engine.test.ts`
- **Line**: 151, 183, 212, 222, 242
- **Error code**: TS2322, TS2345
- **Root Cause**: Mock types don't match the spied function signatures. Vitest's `MockInstance` generic parameter doesn't match `NormalizedProcedure`.
- **Fix**: Use `vi.fn()` with proper type parameters or use `vi.mocked()` helper
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/__tests__/base-engine.test.ts`

#### T-TS-012: factory.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/factory.test.ts`
- **Line**: 1, 106, 112, 167, 177-179
- **Error code**: TS6133, TS2554, TS2322, TS2739, TS18048, TS2339
- **Root Cause**: Unused `vi` import; `Expected 2 arguments but got 1` (TS2554); `"custom-engine"` not in union; missing `id, createdAt` on AgentMessage; `stop` possibly undefined; `.error` doesn't exist on ProviderStreamEvent
- **Fix**: Remove unused; add missing arg; fix engine literal; add missing fields; add `!` and check
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/__tests__/factory.test.ts`

#### T-TS-013: registry.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/registry.test.ts`
- **Line**: 21
- **Error code**: TS2375
- **Root Cause**: Optional fields like `description`, `website`, `docsUrl` have `| undefined` with exact optional
- **Fix**: Omit undefined fields or use conditional spreads
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/__tests__/registry.test.ts`

#### T-TS-014: benchmarks/provider-lifecycle.bench.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/benchmarks/provider-lifecycle.bench.ts`
- **Line**: 26
- **Error code**: TS2375
- **Root Cause**: Same exactOptionalPropertyTypes pattern
- **Fix**: Remove `| undefined` from optional fields
- **Acceptance**: Compiles without TS2375

### 4.5 agent-runtime provider/__tests__/e2e/

#### T-TS-015: context-length-recovery.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/e2e/context-length-recovery.test.ts`
- **Line**: 148, 175, 187, 254, 262
- **Error code**: TS2322, TS2353, TS2739
- **Root Cause**: `"text"` not in `ProviderStreamEvent` type union; `strategy` not in `FallbackConfig`; AgentMessage missing `id, createdAt`
- **Fix**: Fix event type literal; remove `strategy`; add missing fields
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/__tests__/e2e/context-length-recovery.test.ts`

#### T-TS-016: exponential-backoff-e2e.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/e2e/exponential-backoff-e2e.test.ts`
- **Line**: 99, 113
- **Error code**: TS6133, TS2739
- **Root Cause**: Unused `port`; missing `id, createdAt` on AgentMessage
- **Fix**: Remove `port`; add missing AgentMessage fields
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/__tests__/e2e/exponential-backoff-e2e.test.ts`

#### T-TS-017: provider-factory.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/e2e/provider-factory.test.ts`
- **Line**: 63
- **Error code**: TS2739
- **Root Cause**: Missing `id, createdAt` on AgentMessage
- **Fix**: Add the required fields
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/__tests__/e2e/provider-factory.test.ts`

#### T-TS-018: steering-injection.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/e2e/steering-injection.test.ts`
- **Line**: 8
- **Error code**: TS6196
- **Root Cause**: `JsonObject` imported but never used
- **Fix**: Remove the import
- **Acceptance**: Error cleared

#### T-TS-019: mock-server.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts`
- **Line**: 49-95, 63, 116
- **Error code**: TS18048 (x8), TS2564, TS2379
- **Root Cause**: `chunk` and `phase` possibly undefined; `port` not initialized in constructor; exact optional on abortAfter/delay
- **Fix**: Add `!` assertions on chunk/phase; add `port!` declaration; fix exact optional patterns
- **Acceptance**: Compiles without errors

### 4.6 agent-runtime other test files (scattered)

#### T-TS-020: event-architecture/canonical-event.test.ts
- **File**: `packages/agent-runtime/src/event-architecture/canonical-event.test.ts`
- **Line**: 7, 12, 218
- **Error code**: TS6133 (x2), TS2322
- **Root Cause**: Unused `ConexCanonicalAdapter` and `RUNTIME_EVENT_SCHEMAS`; `"diagnostic"` not assignable to `ConexEventDomain`
- **Fix**: Remove unused imports; fix domain literal
- **Acceptance**: Compiles

#### T-TS-021: event-protocol/core-event-projector.test.ts
- **File**: `packages/agent-runtime/src/event-protocol/core-event-projector.test.ts`
- **Line**: 18-24
- **Error code**: TS6196 (x7)
- **Root Cause**: 7 type aliases imported but never used
- **Fix**: Remove all unused imports
- **Acceptance**: Compiles

#### T-TS-022: mcp-lifecycle/mcp-server-controller.test.ts
- **File**: `packages/agent-runtime/src/mcp-lifecycle/mcp-server-controller.test.ts`
- **Line**: 2
- **Error code**: TS6133
- **Root Cause**: `McpServerController` imported but never used
- **Fix**: Remove import
- **Acceptance**: Compiles

#### T-TS-023: payload-image-recovery.test.ts
- **File**: `packages/agent-runtime/src/payload-image-recovery.test.ts`
- **Line**: 11
- **Error code**: TS2459
- **Root Cause**: `classifyHttpProviderError` declared locally in `provider-openai-compatible` but not exported
- **Fix**: Export the function or import differently
- **Acceptance**: Compiles

#### T-TS-024: runtime-components/conversation-engine.test.ts
- **File**: `packages/agent-runtime/src/runtime-components/conversation-engine.test.ts`
- **Line**: 86, 99, 113, 117, 129, 131, 138, 140
- **Error code**: TS2345 (x8)
- **Root Cause**: `{ finishReason: "stop"; text: string }` not assignable to `ProviderResponse`
- **Fix**: Check the `ProviderResponse` type and add missing fields or cast
- **Acceptance**: `npx vitest run packages/agent-runtime/src/runtime-components/conversation-engine.test.ts`

#### T-TS-025: runtime-components/provider-response-consumer.test.ts
- **File**: `packages/agent-runtime/src/runtime-components/provider-response-consumer.test.ts`
- **Line**: 46, 131, 141, 151, 164, 206, 216, 251, 261, 274
- **Error code**: TS2741 (x8), TS2554, TS7006
- **Root Cause**: Missing `index` property in `ProviderStreamToolCall` (TS2741); Expected 3-4 args but got 5 (TS2554); implicit `any` (TS7006)
- **Fix**: Add `index: 0` to all tool call literals; fix function call signature
- **Acceptance**: `npx vitest run packages/agent-runtime/src/runtime-components/provider-response-consumer.test.ts`

#### T-TS-026: runtime-components/tool-executor.test.ts
- **File**: `packages/agent-runtime/src/runtime-components/tool-executor.test.ts`
- **Line**: 1, 2
- **Error code**: TS6133, TS6196 (x2)
- **Root Cause**: Unused `vi`, `ToolBatchResult`, `ToolOutput`
- **Fix**: Remove unused imports
- **Acceptance**: Compiles

#### T-TS-027: runtime-metrics.test.ts
- **File**: `packages/agent-runtime/src/runtime-metrics.test.ts`
- **Line**: 65, 96
- **Error code**: TS18048
- **Root Cause**: `snapshot.tools.byName.shell` possibly undefined
- **Fix**: Add `!` assertion
- **Acceptance**: Compiles

#### T-TS-028: session-loop/index.test.ts
- **File**: `packages/agent-runtime/src/session-loop/index.test.ts`
- **Line**: 2
- **Error code**: TS6133, TS2305
- **Root Cause**: `SessionLoop` imported but module has no exported member `SessionLoop`
- **Fix**: Remove import or check the actual export name
- **Acceptance**: Compiles

#### T-TS-029: session-loop/provider-call.test.ts
- **File**: `packages/agent-runtime/src/session-loop/provider-call.test.ts`
- **Line**: 2
- **Error code**: TS6133, TS2305
- **Root Cause**: `handleLengthFinishReason` imported but module has no export
- **Fix**: Remove import
- **Acceptance**: Compiles

#### T-TS-030: state-machine/core.test.ts
- **File**: `packages/agent-runtime/src/state-machine/core.test.ts`
- **Line**: 132
- **Error code**: TS2532
- **Root Cause**: Object possibly undefined
- **Fix**: Add `!` assertion
- **Acceptance**: Compiles

#### T-TS-031: state-machine/run-lifecycle.test.ts
- **File**: `packages/agent-runtime/src/state-machine/run-lifecycle.test.ts`
- **Line**: 10, 11
- **Error code**: TS6133 (x2)
- **Root Cause**: Unused `RunLifecycleState`, `RunEndReason`
- **Fix**: Remove unused imports
- **Acceptance**: Compiles

#### T-TS-032: fallback-chain/engine.test.ts
- **File**: `packages/agent-runtime/src/fallback-chain/engine.test.ts`
- **Line**: 209
- **Error code**: TS6133
- **Root Cause**: `fallback1` declared but never read
- **Fix**: Remove or prefix with underscore
- **Acceptance**: Compiles

#### T-TS-033: model-routing-roles.test.ts
- **File**: `packages/agent-runtime/src/model-routing-roles.test.ts`
- **Line**: 89
- **Error code**: TS2322
- **Root Cause**: `ModelProfile | undefined` not assignable to `ModelProfile`
- **Fix**: Add non-null assertion or guard
- **Acceptance**: `npx vitest run packages/agent-runtime/src/model-routing-roles.test.ts`

#### T-TS-034: provider-cache-hints.test.ts
- **File**: `packages/agent-runtime/src/provider-cache-hints.test.ts`
- **Line**: 32
- **Error code**: TS2379
- **Root Cause**: exactOptionalPropertyTypes mismatch
- **Fix**: Remove `| undefined` from optional fields
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider-cache-hints.test.ts`

#### T-TS-035: provider-gateway-edge.test.ts
- **File**: `packages/agent-runtime/src/provider-gateway-edge.test.ts`
- **Line**: 3, 204, 232
- **Error code**: TS6133, TS2741 (x2)
- **Root Cause**: Unused `DefaultProviderGateway`; missing `policy` in `ModelRouteDecision`
- **Fix**: Remove unused; add `policy` field
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider-gateway-edge.test.ts`

#### T-TS-036: provider-gateway.test.ts
- **File**: `packages/agent-runtime/src/provider-gateway.test.ts`
- **Line**: 29, 365
- **Error code**: TS2322 (x2)
- **Root Cause**: Credential resolver mock signature mismatch
- **Fix**: Match the exact signature of `ProviderCredentialResolutionContext`
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider-gateway.test.ts`

#### T-TS-037: provider-stream-contract.test.ts
- **File**: `packages/agent-runtime/src/provider-stream-contract.test.ts`
- **Line**: 270, 317
- **Error code**: TS2739, TS2532
- **Root Cause**: Missing `id, index` in `ProviderStreamToolCall`; object possibly undefined
- **Fix**: Add missing fields; add `!`
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider-stream-contract.test.ts`

#### T-TS-038: provider-stream-contract/json-repair.test.ts
- **File**: `packages/agent-runtime/src/provider-stream-contract/json-repair.test.ts`
- **Line**: 2
- **Error code**: TS6133, TS2459
- **Root Cause**: `balanceJsonContainers` imported but never used AND not exported from module
- **Fix**: Remove import
- **Acceptance**: Compiles

#### T-TS-039: provider-stream-contract/normalizer.test.ts
- **File**: `packages/agent-runtime/src/provider-stream-contract/normalizer.test.ts`
- **Line**: 2
- **Error code**: TS6133, TS2459
- **Root Cause**: `legacyFinishReason` imported but never used AND not exported
- **Fix**: Remove import
- **Acceptance**: Compiles

#### T-TS-040: provider-openai-compatible.test.ts
- **File**: `packages/agent-runtime/src/provider-openai-compatible.test.ts`
- **Line**: 537-878 (many), 1377, 1925
- **Error code**: TS2532 (x12), TS2353 (x2)
- **Root Cause**: Object possibly undefined on every `it(` block's mock response; `modelsUrl` and `env` not in their respective types
- **Fix**: Add `!` assertions; remove excess properties from object literals
- **Acceptance**: Partial — too many errors, fix progressively

#### T-TS-041: provider/engines/anthropic-messages-engine.test.ts
- **File**: `packages/agent-runtime/src/provider/engines/anthropic-messages-engine.test.ts`
- **Line**: 12, 19, 59, 75, 81, 107-109
- **Error code**: TS2739, TS2322, TS2379, TS18048, TS7053, TS2532, TS2339
- **Root Cause**: Missing AgentMessage fields (TS2739); `string` vs `SecretValue` (TS2322); exact optional args (TS2379); headers possibly undefined (TS18048/TS7053); stop event check (TS2532/TS2339)
- **Fix**: Add `id, createdAt`; use `createSecret()` or cast; fix exact optional; use `record` utility for headers; add `!` and guard
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/engines/anthropic-messages-engine.test.ts`

#### T-TS-042: provider/engines/ollama-engine.test.ts
- **File**: `packages/agent-runtime/src/provider/engines/ollama-engine.test.ts`
- **Line**: 12, 19, 59, 70, 90
- **Error code**: TS2739, TS2322, TS2379, TS2353
- **Root Cause**: Same pattern as anthropic-messages-engine.test.ts; plus `temp` not in `ToolOutput`
- **Fix**: Same as T-TS-041; remove `temp`
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/engines/ollama-engine.test.ts`

#### T-TS-043: provider/engines/openai-compatible-engine.test.ts
- **File**: `packages/agent-runtime/src/provider/engines/openai-compatible-engine.test.ts`
- **Line**: 1, 12, 19, 51, 97-99
- **Error code**: TS6133, TS2739, TS2322, TS18048, TS7053, TS2532, TS2339
- **Root Cause**: Same as T-TS-041 with `vi` unused
- **Fix**: Remove `vi`; fix same patterns as T-TS-041
- **Acceptance**: `npx vitest run packages/agent-runtime/src/provider/engines/openai-compatible-engine.test.ts`

#### T-TS-044: context-compression/compression-utils.test.ts
- **File**: `packages/agent-runtime/src/context-compression/compression-utils.test.ts`
- **Line**: 2
- **Error code**: TS6133
- **Root Cause**: `includeRequiredToolCallMessages` imported but never used
- **Fix**: Remove import
- **Acceptance**: Compiles

#### T-TS-045: testing.test.ts
- **File**: `packages/agent-runtime/src/testing.test.ts`
- **Line**: 510
- **Error code**: TS6133
- **Root Cause**: `provider` declared but never read
- **Fix**: Remove or prefix with underscore
- **Acceptance**: Compiles

#### T-TS-046: tool-stream/tool-stream.test.ts
- **File**: `packages/agent-runtime/src/tool-stream/tool-stream.test.ts`
- **Line**: 87, 88
- **Error code**: TS2532
- **Root Cause**: Object possibly undefined
- **Fix**: Add `!` assertion
- **Acceptance**: Compiles

#### T-TS-047: tools/tool-system.test.ts
- **File**: `packages/agent-runtime/src/tools/tool-system.test.ts`
- **Line**: 6, 12, 13
- **Error code**: TS6133, TS6196
- **Root Cause**: `LlmToolDefinition` unused; `ToolCategory`, `ToolConcurrency` unused
- **Fix**: Remove all unused
- **Acceptance**: Compiles

#### T-TS-048: trace/index.test.ts
- **File**: `packages/agent-runtime/src/trace/index.test.ts`
- **Line**: 2
- **Error code**: TS6192
- **Root Cause**: All imports in declaration are unused
- **Fix**: Remove entire import line
- **Acceptance**: Compiles

### 4.7 agent-daemon test files

#### T-DAEMON-001: daemon-approval-handler.test.ts
- **File**: `packages/agent-daemon/src/daemon-approval-handler.test.ts`
- **Line**: 2
- **Error code**: TS6133
- **Root Cause**: `DaemonApprovalHandler` imported but never used
- **Fix**: Remove unused import
- **Acceptance**: Compiles

#### T-DAEMON-002: run-handlers.stream-pause.test.ts
- **File**: `packages/agent-daemon/src/handlers/run-handlers.stream-pause.test.ts`
- **Line**: 101
- **Error code**: TS2352
- **Root Cause**: Cast from `{ type: "event", ... }` to `DaemonOutboundMessage` without overlapping properties
- **Fix**: Cast through `unknown` first
- **Acceptance**: Compiles

#### T-DAEMON-003: mcp-stdio-adapter.test.ts
- **File**: `packages/agent-daemon/src/mcp-stdio-adapter.test.ts`
- **Line**: 2
- **Error code**: TS6133, TS2305
- **Root Cause**: `McpStdioAdapter` imported but not exported from module
- **Fix**: Remove import
- **Acceptance**: Compiles

#### T-DAEMON-004: protocol/registry.test.ts
- **File**: `packages/agent-daemon/src/protocol/registry.test.ts`
- **Line**: 275
- **Error code**: TS2322
- **Root Cause**: `(string | undefined)[]` not assignable to `string[]`
- **Fix**: Filter out undefined or use `as string[]`
- **Acceptance**: Compiles

#### T-DAEMON-005: protocol/validators/common.test.ts
- **File**: `packages/agent-daemon/src/protocol/validators/common.test.ts`
- **Line**: 2
- **Error code**: TS6192
- **Root Cause**: All imports unused
- **Fix**: Remove entire import line
- **Acceptance**: Compiles

#### T-DAEMON-006: server-handlers.test.ts
- **File**: `packages/agent-daemon/src/server-handlers.test.ts`
- **Line**: 3, 21, 154
- **Error code**: TS2305, TS2352 (x2)
- **Root Cause**: `ConnectedClient` not exported from types; mock type conversion without overlap
- **Fix**: Import the correct member or remove; cast through `unknown`
- **Acceptance**: `npx vitest run packages/agent-daemon/src/server-handlers.test.ts`

#### T-DAEMON-007: server-runtime-factory.test.ts
- **File**: `packages/agent-daemon/src/server-runtime-factory.test.ts`
- **Line**: 564, 797, 855
- **Error code**: TS2532, TS2739, TS2375
- **Root Cause**: Object possibly undefined; missing `healthPort, metricsPort, eventLogMaxSizeBytes, eventLogMaxArchives` in `DaemonConfig` literal; exact optional on `metadata`
- **Fix**: Add `!`, add missing properties, fix exact optional
- **Acceptance**: `npx vitest run packages/agent-daemon/src/server-runtime-factory.test.ts`

---

## 5. Machine-Readable Ledger

### 5.1 Round Allocation

| Round | Task Cards | Files | Estimated Effort | Parallel Agent |
|---|---|---|---|---|
| R1 | T-CONFIG-001~005 | Root config files + 3 new tsconfig | 1h | Agent #5 (Config) |
| R2 | T-SHARED-001~006 | shared-utils source + test | 1h | Agent #5 |
| R3 | T-TS-001~004 | __tests__/ top-level | 2h | Agent #6 |
| R4 | T-TS-005~009 | __tests__/integrations/ | 2.5h | Agent #6 |
| R5 | T-TS-010~014 | provider/__tests__ (unit) | 2h | Agent #7 |
| R6 | T-TS-015~019 | provider/__tests__/e2e/ | 2h | Agent #7 |
| R7 | T-TS-020~029 | Scattered test files (part 1) | 2h | Agent #8 |
| R8 | T-TS-030~039 | Scattered test files (part 2) | 2h | Agent #8 |
| R9 | T-TS-040~043 | Engine test files | 2.5h | Agent #9 |
| R10 | T-TS-044~048 | Remaining test files | 1h | Agent #9 |
| R11 | T-DAEMON-001~007 | daemon test files | 2h | Agent #10 |
| R12 | Source exactOptionalPropertyTypes bulk | agent-runtime + agent-daemon src files | 4h | Agent #11 |
| R13 | Source unused declarations bulk | agent-runtime + agent-daemon src files | 2h | Agent #12 |
| R14 | Validate & merge | All | 1h | Lead |

### 5.2 Task Dependency Graph

```
T-CONFIG-001 (exactOptionalPropertyTypes fix)
  ├── Everything else depends on this decision
  ├── If removed → all TS2375/TS2379/TS2412 errors vanish
  └── If kept → all other rounds must fix exact optional individually

T-CONFIG-002~005 (tsconfig fixes)
  └── Independent, no blockers

T-SHARED-001~006
  └── Depends on T-CONFIG-002

All T-TS-* rounds
  └── Fully parallel, no cross-dependencies

T-DAEMON-*
  └── Fully parallel with T-TS rounds
```

### 5.3 Critical Path Recommendation

**STRONGLY RECOMMENDED:** Remove `"exactOptionalPropertyTypes": true` from `tsconfig.base.json` (T-CONFIG-001 Option A). This single change eliminates ~75% of all errors across the entire repository. The remaining errors (unused declarations, strict null checks, type literal mismatches) are straightforward to fix.

If the team decides to keep `exactOptionalPropertyTypes`, the effort estimate triples, and every source file in agent-runtime (~80 files) and agent-daemon (~60 files) needs manual fixes.

### 5.4 Acceptance Criteria

1. All test files compile without errors under their respective tsconfig
2. `npx vitest run` passes for all fixed test files
3. No regressions in source code functionality
4. `turbo run typecheck` passes for all packages

### 5.5 Rollback Plan

Each fix is scoped to a single file. If a fix introduces a regression:
1. Revert the specific file change using `git checkout -- <file>`
2. Re-run tests to verify
3. Re-apply the fix with different strategy

---

## 6. Detailed Fix Patterns

### 6.1 exactOptionalPropertyTypes Pattern (TS2375)

**Before:**
```typescript
const config: { signal?: AbortSignal } = {
  signal: maybeSignal, // Type: AbortSignal | undefined ← ERROR
};
```

**After (Option A — conditional spread):**
```typescript
const config: { signal?: AbortSignal } = {
  ...(maybeSignal !== undefined ? { signal: maybeSignal } : {}),
};
```

**After (Option B — cast):**
```typescript
const config = {
  signal: maybeSignal as AbortSignal | undefined,
} as { signal?: AbortSignal };
```

### 6.2 Unused Declaration Pattern (TS6133/TS6196)

**Before:**
```typescript
import { SomeType } from './some-module'; // never used
```

**After:**
```typescript
// Remove the line entirely
```

### 6.3 Strict Null Check Pattern (TS2532)

**Before:**
```typescript
const value = obj.prop.subProp; // obj.prop possibly undefined
```

**After:**
```typescript
const value = obj.prop!.subProp;
```

### 6.4 Missing Required Property Pattern (TS2739)

**Before:**
```typescript
const msg: AgentMessage = { role: "user", blocks: [...] }; // missing id, createdAt
```

**After:**
```typescript
const msg: AgentMessage = {
  id: "test-id",
  createdAt: new Date().toISOString(),
  role: "user",
  blocks: [...],
};
```

### 6.5 Mock Type Mismatch Pattern (TS2322/TS2345)

**Before:**
```typescript
vi.fn().mockReturnValue({ text: "hello" }); // return type doesn't match
```

**After:**
```typescript
vi.fn<(...args: any[]) => SomeReturnType>().mockReturnValue({ text: "hello" });
```

---

## 7. Summary Statistics

| Metric | Value |
|---|---|
| Total error count (all sources) | ~1500+ |
| Errors from exactOptionalPropertyTypes | ~1100 (~73%) |
| Errors from noUnusedLocals | ~200 (~13%) |
| Errors from strict null checks | ~150 (~10%) |
| Errors from other type mismatches | ~50 (~4%) |
| Test files with errors | ~60 |
| Source files with errors | ~140 |
| Total task cards | 57 |
| Estimated total effort | 25-30 person-hours |
| Estimated effort if exactOptionalPropertyTypes removed | 8-10 person-hours |

---

**Plan complete. Total lines: 776.** Ready for review and assignment to repair agents.
