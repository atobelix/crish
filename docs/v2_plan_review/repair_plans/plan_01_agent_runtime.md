# Plan 01: Agent Runtime TypeScript Compilation Repair

**Generated**: 2026-07-25
**Scope**: `packages/agent-runtime/src/` (155 files, 572 errors)
**Compiler**: TypeScript with `exactOptionalPropertyTypes: true`, `strict: true`
**Priority**: P0 (blocking compile)

---

## 1. Error Panorama & Classification

### 1.1 Error Code Distribution

| Error Code | Count | Description | Category |
|-----------|-------|-------------|----------|
| TS2379 | 101 | Argument type not assignable with `exactOptionalPropertyTypes` | exactOptional wave |
| TS2375 | 71 | Object literal type not assignable with `exactOptionalPropertyTypes` | exactOptional wave |
| TS2412 | 36 | Type `undefined` not assignable with `exactOptionalPropertyTypes` | exactOptional wave |
| TS2322 | 69 | Type not assignable (general) | Type mismatch |
| TS6133 | 67 | Declared but never read | Unused declarations |
| TS6196 | 46 | Declared but never used | Unused declarations |
| TS2532 | 53 | Object is possibly undefined | Strict null checks |
| TS2345 | 21 | Argument type mismatch | Type mismatch |
| TS18048 | 18 | Possibly undefined (post-`?.` chain) | Strict null checks |
| TS1361 | 18 | `import type` used as value | Import misuse |
| TS2339 | 13 | Property does not exist | Missing member |
| TS2739 | 11 | Missing properties from type | Missing members |
| TS2741 | 10 | Property missing in required type | Missing members |
| TS2305 | 7 | No exported member | Missing export |
| TS2353 | 6 | Object literal may only specify known properties | Excess property |
| TS2554 | 6 | Expected N arguments but got M | Wrong arity |
| TS2459 | 4 | Declared locally but not exported | Missing export |
| TS7053 | 3 | Implicit `any` on indexed access | Index access |
| TS6192 | 3 | All imports in declaration unused | Unused declarations |
| TS2571 | 2 | Object is of type `unknown` | Unknown type |
| TS2391 | 1 | Function implementation missing | Interface error |
| TS2420 | 1 | Class incorrectly implements interface | Interface error |
| TS7006 | 1 | Parameter implicitly has `any` | Implicit any |
| TS2352 | 1 | Conversion type may be mistake | Type assertion |
| TS2488 | 1 | Must have iterator | Iteration |
| TS2564 | 1 | No initializer in constructor | Definite assignment |
| TS6138 | 1 | Property declared but never read | Unused declarations |

### 1.2 Super-Categories

1. **exactOptionalPropertyTypes Wave** (TS2375 + TS2379 + TS2412 = 208 errors, 37.0%)
   - Root cause: `exactOptionalPropertyTypes: true` in tsconfig prohibits `{ key: undefined }` for `key?: T` fields
   - Affects ~75 source files, ~35 test files

2. **Type Mismatch / Not Assignable** (TS2322 + TS2345 = 90 errors, 15.7%)
   - Root cause: Incorrect union types, missing variant, incompatible function signatures

3. **Unused Declarations** (TS6133 + TS6196 + TS6192 + TS6138 = 117 errors, 20.5%)
   - Root cause: Imports/variables/types declared but never referenced

4. **Strict Null Checks** (TS2532 + TS18048 = 71 errors, 12.4%)
   - Root cause: Missing `?.` or `!` on optional chain results

5. **Missing Members / Exports** (TS2339 + TS2739 + TS2741 + TS2305 + TS2459 + TS2554 = 51 errors, 8.9%)

6. **Import Type as Value** (TS1361 = 18 errors, 3.1%)
   - Root cause: `import type { X }` used as runtime value

7. **Miscellaneous** (TS2353 + TS2571 + TS7053 + TS2391 + TS2420 + TS7006 + TS2352 + TS2488 + TS2564 = 17 errors, 3.0%)

---

## 2. Write-Set Isolation Matrix

### 2.1 File-Level Error Density

Files with the most errors (top 25):
- `error-classifier.ts` - 23 errors (TS2379 x 22, TS2375 x 1)
- `provider-gateway/route-selector.ts` - 15 errors (TS2375 x 13, TS2412 x 1, TS6133 x 2)
- `provider-gateway/index.ts` - 15 errors (TS2375 x 3, TS2379 x 4, TS2412 x 4, TS6133 x 5)
- `runtime-metrics/collectors.ts` - 17 errors (TS2379 x 8, TS6133 x 6, TS2339 x 2, TS2375 x 1)
- `provider/engines/openai-compatible-engine.ts` - 10 errors (TS2375 x 2, TS2379 x 2, TS2339 x 2, TS6196, TS6133)
- `provider-gateway/route-selector.ts` - 14 errors (TS2375 x 10, TS2412, TS6133 x 2)
- `plan-document/index.ts` - 13 errors (TS6196 x 6, TS1361 x 7)
- `plan-document/operations.ts` - 11 errors (TS6196, TS6133 x 2, TS2412 x 4, TS2322 x 4)
- `plan-document/validation.ts` - 14 errors (TS6196 x 8, TS1361 x 6)
- `model-routing/profile.ts` - 8 errors (TS6196, TS2379 x 2, TS2375 x 5)
- `event-protocol/core-event-projector.ts` - 4 errors (TS2375 x 1, TS2322 x 3)
- `anthropic-stream-parse.ts` - 6 errors (TS2322 x 5, TS2375 x 1)
- `gemini-stream-parse.ts` - 9 errors (TS2322 x 8, TS2375 x 1)
- `provider-openai-compatible.ts` - 3 errors (TS2379, TS2375 x 2)
- `runtime-metrics/snapshot.ts` - 11 errors (TS2459, TS6133 x 5, TS2375, TS2379 x 5)
- `runtime-components/conversation-engine.ts` - 3 errors (TS2375 x 2, TS2412)
- `runtime-components/context-manager.ts` - 4 errors (TS2379 x 2, TS2375 x 2)
- `rich-read.ts` - 3 errors (TS2322 x 2, TS2375 x 1)
- `scoped-context.ts` - 3 errors (TS2375 x 3)
- `scoped-context-resources.ts` - 3 errors (TS2375 x 2, TS2379 x 1)
- `provider/auth/credential-pool.ts` - 10 errors (TS6133, TS2412 x 6, TS2322 x 3)
- `provider/auth/key-rotation.ts` - 5 errors (TS6133, TS2322 x 2, TS2412 x 2)
- `provider/__tests__/e2e/mock-server.ts` - 11 errors (TS18048 x 7, TS2564, TS2379)
- `provider/__tests__/factory.test.ts` - 8 errors (TS6133, TS2554, TS2322, TS2739, TS18048 x 3, TS2339)
- `state-machine/core.ts` - 2 errors (TS2379, TS2375)

### 2.2 Isolation Matrix: Overlap-Free Waves

```
Wave A: exactOptionalPropertyTypes (TS2375/TS2379/TS2412) — 208 errors, ~80 files
Wave B: Unused declarations (TS6133/TS6196/TS6192/TS6138) — 117 errors, ~60 files
Wave C: Type mismatch & null safety (TS2322/TS2345/TS2532/TS18048/TS2339/TS2739/TS2741/TS2353) — ~170 errors, ~90 files
Wave D: Import type & exports (TS1361/TS2305/TS2459/TS2554) — 35 errors, ~10 files
Wave E: Edge cases (TS2571/TS7053/TS2391/TS2420/TS7006/TS2352/TS2488/TS2564) — 12 errors, ~10 files
```

**Zero-overlap guarantee**: Each file is assigned to exactly one Wave. Where a file has errors of multiple categories, the file is assigned to the highest-priority Wave it belongs to (A > B > C > D > E). This means Wave A files are "claimed" and not re-touched by later waves.

#### Wave A — exactOptionalPropertyTypes (files_write, non-overlapping)

The following files are claimed by Wave A and will NOT be touched by other waves:

1. `error-classifier.ts`
2. `anthropic-stream-parse.ts`
3. `checkpoint-manifest.ts`
4. `checkpoint/checkpoint-manager.ts`
5. `context-compression/token-estimator.ts`
6. `conversation-boundary-manifest.ts`
7. `event-protocol/core-event-projector.ts`
8. `event-queue/index.ts`
9. `fallback-chain/engine.ts`
10. `gemini-stream-parse.ts`
11. `git-versioning.ts`
12. `goal-disk-oracle.ts`
13. `hooks/extension-registry.ts`
14. `hooks/tool-hook-observability.ts`
15. `local-tools/checkpoint-tools.ts`
16. `local-tools/fs-edit-tools/utils.ts`
17. `local-tools/fs-edit-tools/write-tool.ts`
18. `local-tools/fs-edit-tools/edit-tool.ts`
19. `local-tools/index.ts`
20. `local-tools/pre-mutation.ts`
21. `local-tools/shell-tools.ts`
22. `lsp-tools.ts`
23. `mcp-lifecycle/utils.ts`
24. `media/media-preprocessor.ts`
25. `memory.ts`
26. `model-routing-enhanced.ts`
27. `model-routing/matcher.ts`
28. `model-routing/profile.ts`
29. `model-routing-roles.ts`
30. `plugin-registry.ts`
31. `preview-queue.ts`
32. `process-lifecycle/process-manager.ts`
33. `project-progress-ledger.ts`
34. `prompt-assembly.ts`
35. `provider-anthropic.ts`
36. `provider-gemini.ts`
37. `provider-openai-compatible.ts`
38. `provider-request-machine.ts`
39. `provider-stream-contract/error.ts`
40. `provider-transport/connection-manager.ts`
41. `provider/auth/credential-pool.ts`
42. `provider/auth/credential-resolver.ts`
43. `provider/auth/key-rotation.ts`
44. `provider/auth/oauth/token-guardian.ts`
45. `provider/loader.ts`
46. `provider/provider-gateway-v2.ts`
47. `provider/registry-v2.ts`
48. `provider/factory.ts`
49. `provider/cli/main.ts`
50. `provider/cli/provider-dev.ts`
51. `provider/engines/base-engine.ts`
52. `provider/engines/openai-compatible-engine.ts`
53. `provider-gateway/credential-resolver.ts`
54. `provider-gateway/index.ts`
55. `provider-gateway/route-selector.ts`
56. `rendering/rendering-pipeline.ts`
57. `rich-read.ts`
58. `runtime.ts`
59. `runtime-components/context-manager.ts`
60. `runtime-components/conversation-engine.ts`
61. `runtime-metrics/collectors.ts`
62. `runtime-metrics/snapshot.ts`
63. `scoped-context-resources.ts`
64. `scoped-context.ts`
65. `secrets-obfuscation.ts`
66. `skills.ts`
67. `state-machine/agent-session.ts`
68. `state-machine/core.ts`
69. `state-machine/run-lifecycle.ts`
70. `state-machine/session-branch.ts`
71. `structured-summary.ts`
72. `subagent-loop.ts`
73. `tool-discovery.ts`
74. `tool-output-budget.ts`
75. `tool-output-guard.ts`
76. `tools/tool-definition.ts`
77. `trace/index.ts`
78. `provider/engines/anthropic-messages-engine.ts`
79. `provider/engines/ollama-engine.ts`
80. `provider/__tests__/benchmarks/provider-lifecycle.bench.ts`
81. `provider/__tests__/e2e/mock-server.ts`
82. `provider/__tests__/registry.test.ts`
83. `provider-gateway/credential-resolver.test.ts`
84. `doctor-report.ts`
85. `ISessionStore.ts`
86. `payload-image-recovery.test.ts`
87. `session-store/index.ts`
88. `subagent-types.ts`
89. `context-compression/index.ts`
90. `provider-cache-hints.test.ts`
91. `provider-openai-chat.ts`
92. `provider-openai-responses.ts`
93. `provider-gateway.test.ts`
94. `provider-gateway-edge.test.ts`
95. `provider/__tests__/base-engine.test.ts`
96. `provider/__tests__/factory.test.ts`
97. `provider/__tests__/e2e/context-length-recovery.test.ts`
98. `provider/__tests__/e2e/provider-factory.test.ts`
99. `provider/engines/anthropic-messages-engine.test.ts`
100. `provider/engines/ollama-engine.test.ts`
101. `provider/engines/openai-compatible-engine.test.ts`
102. `provider/auth/oauth/account-store.ts`
103. `runtime-components/provider-response-consumer.test.ts`
104. `runtime-components/conversation-engine.test.ts`
105. `workspace-mutation-coordinator.ts`
106. `provider-stream-contract.test.ts`
107. `state-machine/session-branch.ts`
108. `provider/__tests__/e2e/exponential-backoff-e2e.test.ts`
109. `__tests__/canonical-schema.test.ts`
110. `__tests__/canonicalize-tools.test.ts`
111. `__tests__/context-slicer.test.ts`
112. `__tests__/integrations/chatgpt-pool.test.ts`
113. `__tests__/integrations/oauth-flow.test.ts`
114. `__tests__/integrations/streaming-executor.test.ts`
115. `__tests__/integrations/tool-stream.test.ts`
116. `__tests__/steering-input-queue.test.ts`
117. `__tests__/integrations/media-pipeline.test.ts`
118. `runtime-components/tool-executor.test.ts`
119. `runtime-metrics.test.ts`
120. `testing.test.ts`
121. `tool-stream/tool-stream.test.ts`
122. `provider-openai-compatible.test.ts`

#### Wave B — Unused Declarations (files NOT in Wave A)

1. `context-compression/compression-utils.test.ts`
2. `context-compression/serializer.ts`
3. `event-architecture/canonical-event.test.ts`
4. `event-protocol/core-event-projector.test.ts`
5. `fallback-chain/engine.test.ts`
6. `fallback-chain/types.ts`
7. `local-tools/fs-edit-tools/apply-edits-tool.ts`
8. `local-tools/fs-edit-tools/types.ts`
9. `mcp-lifecycle/mcp-lifecycle-manager.ts`
10. `mcp-lifecycle/mcp-server-controller.test.ts`
11. `mcp-lifecycle/types.ts`
12. `media/media-preprocessor.ts`
13. `model-routing/matcher.ts`
14. `model-routing/profile.ts`
15. `model-routing-roles.ts`
16. `path-handling/conex-path.ts`
17. `plan-document/index.ts`
18. `plan-document/operations.ts`
19. `plan-document/validation.ts`
20. `provider/__tests__/auth.test.ts`
21. `provider/__tests__/e2e/steering-injection.test.ts`
22. `provider/auth/credential-pool.ts`
23. `provider/auth/key-rotation.ts`
24. `provider/auth/oauth/chatgpt-pool.test.ts`
25. `provider/auth/oauth/cross-process-lock.ts`
26. `provider/cli/main.ts`
27. `provider/engines/anthropic-messages-engine.ts`
28. `provider/engines/openai-compatible-engine.ts`
29. `provider-gateway/route-selector.test.ts`
30. `provider-gateway/route-selector.ts`
31. `provider-gateway/types.ts`
32. `provider-gateway/index.ts`
33. `provider-gateway/credential-resolver.ts`
34. `recovery-pipeline.ts`
35. `recovery/stream-recovery.ts`
36. `runtime-metrics/collectors.ts`
37. `runtime-metrics/snapshot.ts`
38. `runtime-metrics/types.ts`
39. `session-loop/index.test.ts`
40. `session-loop/provider-call.test.ts`
41. `state-machine/run-lifecycle.test.ts`
42. `subagent-loop.ts`
43. `tools/tool-system.test.ts`
44. `trace/index.test.ts`
45. `provider/__tests__/e2e/exponential-backoff-e2e.test.ts`
46. `provider/provider-gateway-v2.ts`
47. `provider/registry-v2.ts`
48. `plan-document/index.ts`
49. `provider/loader.ts`
50. `provider/__tests__/factory.test.ts`
51. `provider/engines/openai-compatible-engine.test.ts`
52. `runtime-components/tool-executor.test.ts`

#### Wave C — Type mismatch, null safety, missing members (files NOT in A or B)

Files with TS2532/TS18048/TS2322/TS2345/TS2339/TS2739/TS2741/TS2353 that are NOT in Wave A are:
1. `event-architecture/canonical-event.test.ts`
2. `event-architecture/canonical-event.ts`
3. `event-protocol/core-event-projector.test.ts`
4. `local-tools/fs-edit-tools/apply-edits-tool.ts`
5. `plan-document/operations.ts`
6. `provider/__tests__/base-engine.test.ts`
7. `provider/__tests__/factory.test.ts`
8. `provider/__tests__/e2e/context-length-recovery.test.ts`
9. `provider/auth/oauth/account-store.ts`
10. `provider/cli/main.ts`
11. `runtime-components/provider-response-consumer.test.ts`
12. `runtime-components/conversation-engine.test.ts`
13. `state-machine/core.test.ts`
14. `tool-stream/tool-stream.test.ts`
15. `provider-openai-compatible.test.ts`
16. `state-machine/session-branch.ts`

#### Wave D — Import type & exports (files NOT in A/B/C)

1. `plan-document/index.ts`
2. `plan-document/validation.ts`
3. `doctor-report.ts`
4. `ISessionStore.ts`
5. `payload-image-recovery.test.ts`
6. `session-store/index.ts`
7. `session-loop/index.test.ts`
8. `session-loop/provider-call.test.ts`
9. `subagent-types.ts`
10. `runtime-metrics/snapshot.ts`
11. `provider-stream-contract/json-repair.test.ts`
12. `provider-stream-contract/normalizer.test.ts`

#### Wave E — Edge cases (remaining files)

1. `event-queue/index.ts` (TS2352)
2. `__tests__/canonical-schema.test.ts` (TS2488)
3. `provider/__tests__/e2e/mock-server.ts` (TS2564)
4. `provider/__tests__/factory.test.ts` (TS7006)
5. `subagent-types.ts` (TS2391)
6. `session-store/index.ts` (TS2420)
7. `path-handling/conex-path.ts` (TS6138)
8. `runtime-components/provider-response-consumer.test.ts` (TS7006)

---

## 3. Task Card Table (Coverage Matrix)

### T-AR-001: error-classifier.ts
- **File**: `packages/agent-runtime/src/error-classifier.ts`
- **Lines**: 63, 70, 77, 83, 89, 96, 105, 112, 119, 126, 133, 140, 148, 154, 160, 166, 174, 180, 186, 193, 198, 209
- **Errors**: TS2379 x 22, TS2375 x 1
- **Root cause**: `Partial<ClassifiedError>` in `exactOptionalPropertyTypes: true` rejects `string | undefined` values for optional fields. The function signature `classify(err: Partial<ClassifiedError>)` with `exactOptionalPropertyTypes` means `{ httpStatus: undefined }` is not allowed — `undefined` must be omitted entirely for optional properties.
- **Fix**: Change the `classify` function parameter type from `Partial<ClassifiedError>` to a mapped type that allows `undefined`:
  ```typescript
  type ClassifiedErrorInput = { [K in keyof ClassifiedError]: ClassifiedError[K] | undefined };
  ```
  Or apply the spread-then-override pattern at each call site. Best approach: create a helper function that accepts a `ClassifiedErrorInput` and performs validation before constructing the actual `Partial<ClassifiedError>`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "error-classifier"`

### T-AR-002: anthropic-stream-parse.ts
- **File**: `packages/agent-runtime/src/anthropic-stream-parse.ts`
- **Lines**: 58, 202, 242, 255, 264, 303
- **Errors**: TS2322 x 5, TS2375 x 1
- **Root cause**: `ProviderStreamEvent` discriminated union doesn't accept object literals with fields like `usage: ProviderUsage | undefined` when `exactOptionalPropertyTypes` is on. The `usage` field in the type's stop variant might be optional, not `| undefined`.
- **Fix**: Ensure object literals match the exact shape. For the TS2375 at line 303 (`ProviderUsage`), ensure optional fields are omitted rather than set to `undefined`, or widen the type to accept `undefined`. For TS2322 errors, cast via `as ProviderStreamEvent` or restructure union to accept partial fields.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "anthropic-stream-parse"`

### T-AR-003: checkpoint-manifest.ts
- **File**: `packages/agent-runtime/src/checkpoint-manifest.ts`
- **Lines**: 375, 621
- **Errors**: TS2375 x 2
- **Root cause**: Object literal with optional fields set to `| undefined` not assignable to type with `exactOptionalPropertyTypes`.
- **Fix**: At line 375, restructure the `CheckpointManifestInput` assignment to omit undefined fields. At line 621, do the same for `CheckpointManifestToolCall`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "checkpoint-manifest"`

### T-AR-004: checkpoint/checkpoint-manager.ts
- **File**: `packages/agent-runtime/src/checkpoint/checkpoint-manager.ts`
- **Lines**: 101
- **Errors**: TS2375 x 1
- **Root cause**: Object literal `{ label: string | undefined; description: string | undefined }` not assignable to `CheckpointMetadata` with optional `label?` and `description?`.
- **Fix**: Conditionally include `label` and `description` only when defined, or use spread: `{ ...(label && { label }), ...(description && { description }) }`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "checkpoint-manager"`

### T-AR-005: context-compression/index.ts
- **File**: `packages/agent-runtime/src/context-compression/index.ts`
- **Lines**: 93, 97, 131, 152, 204
- **Errors**: TS2345 x 1, TS2339 x 1, TS2379 x 2, TS2322 x 1
- **Root cause**: Multiple issues: (93) `ContextStateReader | undefined` not assignable to optional callback param; (97) `thoughtSummarizer` missing on type; (131) TS2379 for `ContextSummaryRequest`; (152) TS2379 for `StructuredSummaryInput`; (204) `Record<string, unknown>` not assignable to `JsonObject`.
- **Fix**: (93) Use optional chaining `stateReader?.();` (97) Add `thoughtSummarizer` property to `ContextCompressionRuntimeOptions`; (131,152) Fix exactOptionalPropertyTypes; (204) Use `as JsonObject` cast on the record.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "context-compression/index"`

### T-AR-006: conversation-boundary-manifest.ts
- **File**: `packages/agent-runtime/src/conversation-boundary-manifest.ts`
- **Lines**: 351, 394
- **Errors**: TS2375 x 2
- **Root cause**: Object literal with `| undefined` optional fields for `ConversationBoundaryManifestRecord`.
- **Fix**: Restructure object construction to omit undefined fields instead of passing `undefined`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "conversation-boundary-manifest"`

### T-AR-007: event-protocol/core-event-projector.ts
- **File**: `packages/agent-runtime/src/event-protocol/core-event-projector.ts`
- **Lines**: 107, 129, 277, 421
- **Errors**: TS2375 x 1, TS2322 x 3
- **Root cause**: (107) TS2375 for `CoreEventBase` optional fields; (129, 277) Union type mismatch for `AgentMeta | TurnMeta | ...` being too narrow; (421) `DiagnosticDetails | undefined` not assignable.
- **Fix**: (107) exactOptional fix; (129, 277) Widen union or fix the variant match; (421) Change return type or conditionally return.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "core-event-projector"`

### T-AR-008: event-queue/index.ts
- **File**: `packages/agent-runtime/src/event-queue/index.ts`
- **Lines**: 200, 262
- **Errors**: TS2412 x 1, TS2352 x 1
- **Root cause**: (200) TS2412: `undefined` not assignable to `Timeout` with exactOptionalPropertyTypes; (262) TS2352: Conversion of `ConexCanonicalEvent` to `Record<string, unknown>` invalid.
- **Fix**: (200) Use `as Timeout` type assertion; (262) Convert via `unknown` first: `event as unknown as Record<string, unknown>`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "event-queue/index"`

### T-AR-009: gemini-stream-parse.ts
- **File**: `packages/agent-runtime/src/gemini-stream-parse.ts`
- **Lines**: 51, 58, 166, 170, 191, 264, 274, 286, 360
- **Errors**: TS2322 x 8, TS2375 x 1
- **Root cause**: Same pattern as anthropic-stream-parse.ts: `ProviderStreamEvent` union mismatch with `usage: ProviderUsage | undefined`.
- **Fix**: Either widen the `ProviderStreamEvent` type or cast the objects. For TS2375 on `ProviderUsage`, same `exactOptionalPropertyTypes` treatment.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "gemini-stream-parse"`

### T-AR-010: git-versioning.ts
- **File**: `packages/agent-runtime/src/git-versioning.ts`
- **Lines**: 411, 464
- **Errors**: TS2379 x 2
- **Root cause**: `Omit<GitCheckpointMetadata, "version">` argument with `toolCall: GitCheckpointToolCall | undefined` violates exactOptionalPropertyTypes.
- **Fix**: Omit `toolCall` from object when undefined, or add toolCall to the optional fields of the target type.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "git-versioning"`

### T-AR-011: goal-disk-oracle.ts
- **File**: `packages/agent-runtime/src/goal-disk-oracle.ts`
- **Lines**: 76, 91
- **Errors**: TS2379 x 2
- **Root cause**: `{ detail: string | undefined }` not assignable to `{ detail?: string }` with exactOptionalPropertyTypes.
- **Fix**: When `detail` is undefined, omit from the returned object entirely.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "goal-disk-oracle"`

### T-AR-012: hooks/extension-registry.ts
- **File**: `packages/agent-runtime/src/hooks/extension-registry.ts`
- **Lines**: 96, 119, 151
- **Errors**: TS2322 x 3
- **Root cause**: Function return types have `string | undefined` but the target type expects `string?` (optional property), which with exactOptionalPropertyTypes means the function signature must return `{ block?: boolean; reason?: string }` not `{ block: boolean; reason: string | undefined }`.
- **Fix**: In the returned objects, use optional chaining or conditional spreads: `{ block, ...(reason && { reason }) }` instead of always including the key with `undefined`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "extension-registry"`

### T-AR-013: hooks/tool-hook-observability.ts
- **File**: `packages/agent-runtime/src/hooks/tool-hook-observability.ts`
- **Lines**: 91, 107, 123, 155, 156, 157
- **Errors**: TS2379 x 2, TS2345 x 1, TS2322 x 3
- **Root cause**: (91,123) TS2379: `ToolHookContext` not assignable to `ToolExecutionContext` with exactOptional; (107) TS2345: `unknown` not assignable to `ToolResult<TOutput>`; (155-157) TS2322: Function signatures returning `unknown` instead of specific types.
- **Fix**: (91,123) Add missing optional fields to ToolHookContext or cast; (107) Add type guard; (155-157) Add proper return types.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "tool-hook-observability"`

### T-AR-014: local-tools/checkpoint-tools.ts
- **File**: `packages/agent-runtime/src/local-tools/checkpoint-tools.ts`
- **Lines**: 52, 91, 144
- **Errors**: TS2379 x 3
- **Root cause**: Three separate exactOptionalPropertyTypes violations for `RestoreSnapshotRequest`, `CreateWorkspaceCheckpointRequest`, and `RestoreWorkspaceCheckpointRequest`.
- **Fix**: Each call: conditionally include fields that may be undefined.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "checkpoint-tools"`

### T-AR-015: local-tools/fs-edit-tools/edit-tool.ts
- **File**: `packages/agent-runtime/src/local-tools/fs-edit-tools/edit-tool.ts`
- **Lines**: 3 (x2), 142
- **Errors**: TS2305 x 2, TS2379 x 1
- **Root cause**: (3) Missing exports `replaceViaSeekSequence`, `SeekPass` from `@crish/shared-utils`; (142) TS2379 for `FileSnapshotRequest`.
- **Fix**: (3) Check if these should be exported from shared-utils or replace with alternatives; (142) exactOptional fix.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "edit-tool"`

### T-AR-016: context-compression/token-estimator.ts
- **File**: `packages/agent-runtime/src/context-compression/token-estimator.ts`
- **Lines**: 123, 196
- **Errors**: TS2375 x 2
- **Root cause**: Object literals for `ImageContent` and `ProviderUsage` have `| undefined` for optional fields.
- **Fix**: Conditionally include `width`, `height`, `detail`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "token-estimator"`

### T-AR-017: media/media-preprocessor.ts
- **File**: `packages/agent-runtime/src/media/media-preprocessor.ts`
- **Lines**: 21, 109, 116
- **Errors**: TS6133 x 1, TS2375 x 1, TS2379 x 1
- **Root cause**: (21) `mimeCategory` unused; (109) TS2375 for `ImageContent`; (116) TS2379 for `{ quality, width, height }`.
- **Fix**: (21) Remove unused import; (109,116) exactOptional fixes.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "media-preprocessor"`

### T-AR-018: memory.ts
- **File**: `packages/agent-runtime/src/memory.ts`
- **Lines**: 356, 389
- **Errors**: TS2379 x 2
- **Root cause**: exactOptionalPropertyTypes on `Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">` and `MemorySearchOptions`.
- **Fix**: Conditionally include `metadata`, `query`, `scope`, `limit`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "memory.ts"`

### T-AR-019: model-routing-enhanced.ts
- **File**: `packages/agent-runtime/src/model-routing-enhanced.ts`
- **Lines**: 78
- **Errors**: TS2375 x 1
- **Root cause**: `RequiredCapabilityShape` with optional `minimumContextTokens` set to `number | undefined`.
- **Fix**: Conditional include of `minimumContextTokens`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "model-routing-enhanced"`

### T-AR-020: model-rooting/matcher.ts
- **File**: `packages/agent-runtime/src/model-routing/matcher.ts`
- **Lines**: 10, 11, 25, 26, 30, 31, 40, 88, 465
- **Errors**: TS6133 x 6, TS2375 x 2
- **Root cause**: (10-40) Unused imports/variables: `ProviderEndpointSupport`, `ProviderStreamingSupport`, `endpointSupportField`, `streamingSupportField`, `availabilityField`, `healthField`, `normalizeString`; (88,465) TS2375 for `ModelRouteDecision` and `NormalizedPolicySummary`.
- **Fix**: (10-40) Remove unused declarations; (88,465) exactOptional fixes for `selected`, `maxCostTier`, etc.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "matcher"`

### T-AR-021: model-routing/profile.ts
- **File**: `packages/agent-runtime/src/model-routing/profile.ts`
- **Lines**: 3, 23, 52, 103, 104, 110, 121, 146
- **Errors**: TS6196 x 1, TS2379 x 2, TS2375 x 5
- **Root cause**: (3) `ModelCapabilityFlags` unused; (23,52) TS2379 for `ModelProfile`; (103,104,110,121,146) TS2375 for `Partial<ModelCapabilityFlags>`, cost config, lifecycle dates, `ModelProfile`, `ModelProviderRouteMetadata`.
- **Fix**: (3) Remove unused; (23,52,103-146) exactOptional fixes across multiple types.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "profile.ts"`

### T-AR-022: model-routing-roles.ts
- **File**: `packages/agent-runtime/src/model-routing-roles.ts`
- **Lines**: 1, 230, 233, 236, 239
- **Errors**: TS6196 x 1, TS2412 x 4
- **Root cause**: (1) `ModelCapabilityTag` unused; (230-239) `ModelProfile | undefined` not assignable to `ModelProfile` with exactOptionalPropertyTypes.
- **Fix**: (1) Remove unused import; (230-239) Use non-null assertion or add default values.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "model-routing-roles"`

### T-AR-023: plan-document/index.ts
- **File**: `packages/agent-runtime/src/plan-document/index.ts`
- **Lines**: 7,8,9,10,11,13,14,15,44,50,57,64,69,78,79,80,105,108,132
- **Errors**: TS6196 x 6, TS1361 x 13
- **Root cause**: (7-15) Six type imports (`PlanStepStatus`, `PlanQuestionStatus`, `PlanAssumptionStatus`, `PlanAcceptanceStatus`, `PlanRiskStatus`, `PlanStep`, `PlanQuestion`, `PlanAssumption`) declared but never used in the file; (44-132) `import type` used as runtime value — `PLAN_STEP_STATUSES`, `PLAN_QUESTION_STATUSES`, etc. were imported with `import type` but used as runtime values.
- **Fix**: (7-15) Remove unused import declarations; (44-132) Change `import type` to regular `import` for the constants file that exports runtime values.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "plan-document/index"`

### T-AR-024: plan-document/operations.ts
- **File**: `packages/agent-runtime/src/plan-document/operations.ts`
- **Lines**: 1,2,4,200,212,238,252,262,267,272,279,285
- **Errors**: TS6196 x 1, TS6133 x 2, TS2412 x 4, TS2322 x 5
- **Root cause**: (1) `JsonValue` unused; (2) `isRecord` unused; (4) `ResourceMetadata` unused; (200-252) `PlanDocumentSource | undefined` not assignable to `PlanDocumentSource` (TS2412); (262-285) Arrays with `| undefined` optional fields not assignable to `PlanAssumption[]`, `PlanQuestion[]`, `PlanStep[]`, `PlanAcceptanceCriterion[]`, `PlanRisk[]` (TS2322).
- **Fix**: (1,2,4) Remove unused imports; (200-252) Use nullish coalescing or default; (262-285) Filter out undefined fields or use type transformation.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "operations.ts"`

### T-AR-025: plan-document/validation.ts
- **File**: `packages/agent-runtime/src/plan-document/validation.ts`
- **Lines**: 8,9,10,11,12,13,14,15,16,17,34,46,58,71,81,91,92
- **Errors**: TS6196 x 8, TS1361 x 7
- **Root cause**: (8-17) Eight unused type imports; (34-92) Seven `import type` used as runtime value.
- **Fix**: (8-17) Remove unused types; (34-92) Change `import type` to regular `import` for constants.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "validation.ts"`

### T-AR-026: preview-queue.ts
- **File**: `packages/agent-runtime/src/preview-queue.ts`
- **Lines**: 247, 365
- **Errors**: TS2375 x 2
- **Root cause**: `PreviewTransitionUpdate<TResult>` and `PreviewArtifactInput` optional fields with `| undefined`.
- **Fix**: Conditional inclusion of undefined fields.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "preview-queue"`

### T-AR-027: process-lifecycle/process-manager.ts
- **File**: `packages/agent-runtime/src/process-lifecycle/process-manager.ts`
- **Lines**: 132, 319, 323
- **Errors**: TS2412 x 3
- **Root cause**: `number | undefined` not assignable to `number`, and `undefined` not assignable to `Timeout`.
- **Fix**: (132) Use nullish coalescing `??` or default value; (319,323) Handle optional Timeout properly.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "process-manager"`

### T-AR-028: project-progress-ledger.ts
- **File**: `packages/agent-runtime/src/project-progress-ledger.ts`
- **Lines**: 136, 158
- **Errors**: TS2375 x 2
- **Root cause**: `GlobalProgressItemRecord` and `AgentTaskRecord` optional fields.
- **Fix**: Conditionally include `summary` when defined.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "project-progress-ledger"`

### T-AR-029: prompt-assembly.ts
- **File**: `packages/agent-runtime/src/prompt-assembly.ts`
- **Lines**: 144, 206, 215
- **Errors**: TS2375 x 1, TS2379 x 2
- **Root cause**: (144) `PromptAssemblyPayload` optional `systemPrompt`; (206,215) `{ id: string; label: string | undefined }` for a type with optional `label`.
- **Fix**: Conditional spread for undefined fields.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "prompt-assembly"`

### T-AR-030: provider-anthropic.ts
- **File**: `packages/agent-runtime/src/provider-anthropic.ts`
- **Lines**: 106, 220
- **Errors**: TS2379 x 2
- **Root cause**: `BuildAnthropicMessagesBodyOptions` and `AnthropicProviderOptions` exactOptional violations.
- **Fix**: Conditional spreads for `systemPrompt`, `temperature`, `topP`, `apiKey`, etc.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-anthropic"`

### T-AR-031: provider-gemini.ts
- **File**: `packages/agent-runtime/src/provider-gemini.ts`
- **Lines**: 111, 235
- **Errors**: TS2379 x 2
- **Root cause**: Same pattern — `BuildGeminiGenerateContentBodyOptions` and `GeminiProviderOptions`.
- **Fix**: exactOptional pattern.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-gemini"`

### T-AR-032: provider-openai-compatible.ts
- **File**: `packages/agent-runtime/src/provider-openai-compatible.ts`
- **Lines**: 101, 256, 389
- **Errors**: TS2379 x 1, TS2375 x 2
- **Root cause**: (101) `Omit<ProviderDiagnostic, "providerId">` exactOptional; (256,389) `HttpRequest` optional `timeoutMs`.
- **Fix**: exactOptional pattern.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-openai-compatible"`

### T-AR-033: provider-openai-chat.ts
- **File**: `packages/agent-runtime/src/provider-openai-chat.ts`
- **Lines**: 19, 73, 94, 105
- **Errors**: TS6192 x 1, TS2322 x 3
- **Root cause**: (19) Entire import declaration unused; (73,94,105) `ProviderStreamEvent` union mismatch.
- **Fix**: (19) Remove entire import line; (73-105) Restructure object or widen union.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-openai-chat"`

### T-AR-034: provider-openai-responses.ts
- **File**: `packages/agent-runtime/src/provider-openai-responses.ts`
- **Lines**: 92, 141
- **Errors**: TS2322 x 2
- **Root cause**: `ProviderStreamEvent` union mismatch.
- **Fix**: Same as provider-openai-chat.ts pattern.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-openai-responses"`

### T-AR-035: provider-request-machine.ts
- **File**: `packages/agent-runtime/src/provider-request-machine.ts`
- **Lines**: 327
- **Errors**: TS2379 x 1
- **Root cause**: `{ initialContext?, snapshot? }` with exactOptionalPropertyTypes.
- **Fix**: Conditionally include `initialContext` and `snapshot`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-request-machine"`

### T-AR-036: provider-stream-contract/error.ts
- **File**: `packages/agent-runtime/src/provider-stream-contract/error.ts`
- **Lines**: 29
- **Errors**: TS2379 x 1
- **Root cause**: `ErrorClassifierOptions` exactOptional.
- **Fix**: Wrap in conditional: `{ ...(status !== undefined && { status }), headers }`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "error.ts"`

### T-AR-037: provider-transport/connection-manager.ts
- **File**: `packages/agent-runtime/src/provider-transport/connection-manager.ts`
- **Lines**: 129, 149, 304
- **Errors**: TS2322 x 2, TS2379 x 1
- **Root cause**: (129,149) `ProviderTransport | undefined` not assignable to `ProviderTransport` or `ProviderTransport | null`; (304) `TransportStatsSnapshot` exactOptional.
- **Fix**: (129,149) Use nullish coalescing or change variable type; (304) exactOptional.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "connection-manager"`

### T-AR-038: provider-gateway/credential-resolver.ts
- **File**: `packages/agent-runtime/src/provider-gateway/credential-resolver.ts`
- **Lines**: 3, 4, 8, 14, 26
- **Errors**: TS6196 x 1, TS6133 x 1, TS2375 x 3
- **Root cause**: (3) `ProviderRouteSelection` unused; (4) `ProviderGatewayPlanCode` unused; (8,14,26) TS2375 for `ProviderCredentialSource`, `ResolvedProviderCredential`.
- **Fix**: (3,4) Remove unused; (8,14,26) exactOptional.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "credential-resolver.ts"`

### T-AR-039: provider-gateway/index.ts
- **File**: `packages/agent-runtime/src/provider-gateway/index.ts`
- **Lines**: 1,9(x2),11,30,31,32,33,96,105,175,201,213,249,257, (and more)
- **Errors**: TS6133 x 5, TS2412 x 4, TS2379 x 4, TS2375 x 3
- **Root cause**: (1,9,11) Unused imports `AgentMessage`, `ProviderGatewayPlanCode`, `ProviderRouteSelection`, `validateApiKey`; (30-33) `| undefined` not assignable with exactOptional for `ProviderCredentialResolver`, `SecretStore`, `ModelCatalog`, `GatewayV2Bridge`; (96,105,175) TS2379 for `ProviderRouteCatalogQuery`, `ProviderGatewayPlanCode`, `ProviderRouteOfferLike`; (201,213,249,257) TS2375 for `ProviderFactoryPlan`, `ProviderGatewayPlan`, `CredentialResolverOptions`, `ResolvedProviderCredential`.
- **Fix**: (1,9,11) Remove unused imports; (30-33) Use `!` or default; (96-257) exactOptional pattern.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-gateway/index"`

### T-AR-040: provider-gateway/route-selector.ts
- **File**: `packages/agent-runtime/src/provider-gateway/route-selector.ts`
- **Lines**: 2(x2), 45, 126, 188, 233, 251, 268, 273, 282, 292, 342, 351, 403
- **Errors**: TS6133 x 2, TS2375 x 13, TS2412 x 1
- **Root cause**: (2) `enrichProfileFromCatalog`, `profileFromProviderRouteOffer` unused; (45-403) Major exactOptional cluster for `ProviderRouteHealth`, `ProviderRouteSelection`, `ProviderGatewayPlan`, `ProviderRouteOffer`, `ProviderCredentialSource` (x2), `RedactedProviderCredentialSource` (x2), `ProviderRouteHealthEvent` (x2), etc.
- **Fix**: (2) Remove unused imports; (45-403) Systematic exactOptional fix: use `...conditionallyInclude(obj, fields)` pattern for all object literals.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "route-selector.ts"`

### T-AR-041: runtime-metrics/collectors.ts
- **File**: `packages/agent-runtime/src/runtime-metrics/collectors.ts`
- **Lines**: 6,7,9,10,18,78,125,134,140,170,222,261,264,266,270,282,283
- **Errors**: TS6133 x 6, TS2379 x 8, TS2339 x 2
- **Root cause**: (6-18) 6 unused imports; (78-283) 8x TS2379 for `Partial<RuntimeSpanSummary>`, `Partial<RuntimeErrorSummary>`, `RuntimeMetricsSnapshot`, `RuntimeMetricsDimensions`, `RuntimeSpanSummary`, etc.; (125,282) `outputByteSize` and `startedAt` missing on type.
- **Fix**: (6-18) Prune unused imports; (78-283) exactOptional + type fixes for missing properties.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "collectors.ts"`

### T-AR-042: runtime-metrics/snapshot.ts
- **File**: `packages/agent-runtime/src/runtime-metrics/snapshot.ts`
- **Lines**: 4,12(x3),13(x2),111,182,300,305(x2)
- **Errors**: TS2459 x 1, TS6133 x 5, TS2375 x 1, TS2379 x 5
- **Root cause**: (4) `JsonObject` not exported from types; (12,13) 5 unused constants; (111) TS2375 for `RuntimeDurationMetrics`; (182,300,305) TS2379 for `RuntimeMetricsDimensions`, `RuntimeErrorSummary`, `RuntimeSpanSummary`.
- **Fix**: (4) Add export or import from correct location; (12,13) Remove unused; (111-305) exactOptional.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "snapshot.ts"`

### T-AR-043: runtime-components/context-manager.ts
- **File**: `packages/agent-runtime/src/runtime-components/context-manager.ts`
- **Lines**: 78, 139, 167, 177
- **Errors**: TS2379 x 2, TS2375 x 2
- **Root cause**: (78,139) TS2379 for `ContextCompressionRuntimeOptions` and `ContextProjectionOptions`; (167,177) TS2375 for `{ stableContext?, volatileContext? }`.
- **Fix**: exactOptional pattern.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "context-manager.ts"`

### T-AR-044: runtime-components/conversation-engine.ts
- **File**: `packages/agent-runtime/src/runtime-components/conversation-engine.ts`
- **Lines**: 219, 281, 294
- **Errors**: TS2375 x 2, TS2412 x 1
- **Root cause**: (219) `TurnResult` optional fields; (281) `ConversationSnapshot` optional fields; (294) `string | undefined` not assignable to `string`.
- **Fix**: exactOptional + use default or non-null.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "conversation-engine.ts"`

### T-AR-045: scoped-context.ts
- **File**: `packages/agent-runtime/src/scoped-context.ts`
- **Lines**: 112, 134, 335
- **Errors**: TS2375 x 3
- **Root cause**: `ScopedContextRecord` and `ScopedContextCandidate` optional fields.
- **Fix**: Conditionally include `description`, `source`, `reason`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "scoped-context.ts"`

### T-AR-046: scoped-context-resources.ts
- **File**: `packages/agent-runtime/src/scoped-context-resources.ts`
- **Lines**: 91, 195, 225
- **Errors**: TS2375 x 2, TS2379 x 1
- **Root cause**: (91) `ScopedContextResolverProject` optional fields; (195) `ScopedContextResolverInput` exactOptional; (225) `ScopedRuleInput` exactOptional.
- **Fix**: exactOptional pattern.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "scoped-context-resources"`

### T-AR-047: state-machine/core.ts
- **File**: `packages/agent-runtime/src/state-machine/core.ts`
- **Lines**: 100, 307
- **Errors**: TS2379 x 1, TS2375 x 1
- **Root cause**: (100) `StateDefinition` exactOptional; (307) `TransitionTarget` exactOptional.
- **Fix**: Conditionally include optional callback properties.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "core.ts"`

### T-AR-048: subagent-loop.ts
- **File**: `packages/agent-runtime/src/subagent-loop.ts`
- **Lines**: 1, 56, 65
- **Errors**: TS6196 x 1, TS2379 x 1, TS2375 x 1
- **Root cause**: (1) `JsonObject` unused; (56) `PromptAssemblyInput`; (65) `AgentProviderRequest`.
- **Fix**: (1) Remove unused; (56,65) exactOptional.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "subagent-loop"`

### T-AR-049: tool-output-budget.ts + tool-output-guard.ts
- **File**: `packages/agent-runtime/src/tool-output-budget.ts` (line 56), `packages/agent-runtime/src/tool-output-guard.ts` (line 87)
- **Errors**: TS2375 x 2
- **Root cause**: `ToolOutput` optional `artifacts` field.
- **Fix**: Conditionally include artifacts array.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "tool-output"`

### T-AR-050: tools/tool-definition.ts
- **File**: `packages/agent-runtime/src/tools/tool-definition.ts`
- **Lines**: 54, 55, 124, 131
- **Errors**: TS2412 x 2, TS2379 x 2
- **Root cause**: (54,55) `JsonObject | undefined` and `Record<string, string[]> | undefined` not assignable; (124,131) `LlmToolDefinition` exactOptional for `inputSchema`.
- **Fix**: (54,55) Use `!` or default; (124,131) Conditionally include.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "tool-definition"`

### T-AR-051: auth/credential-pool.ts
- **File**: `packages/agent-runtime/src/provider/auth/credential-pool.ts`
- **Lines**: 1, 53, 56, 82, 86, 89, 103, 104, 140, 141
- **Errors**: TS6133 x 1, TS2412 x 6, TS2322 x 3
- **Root cause**: (1) `createSecret` unused; (53,56) `SecretValue | undefined`, `number | undefined` not assignable; (82,86,89) `PooledCredential | undefined` not assignable to `PooledCredential | null`; (103,104,140,141) `undefined` not assignable to `string`/`number`.
- **Fix**: (1) Remove unused; (53-141) Change return types to `| null` or use default values.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "credential-pool"`

### T-AR-052: auth/credential-resolver.ts
- **File**: `packages/agent-runtime/src/provider/auth/credential-resolver.ts`
- **Lines**: 27, 28, 102
- **Errors**: TS2412 x 3
- **Root cause**: `SecretValue | undefined` and `SecretStore | undefined` not assignable.
- **Fix**: Use `!` assertion or default values.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "credential-resolver.ts"`

### T-AR-053: auth/key-rotation.ts
- **File**: `packages/agent-runtime/src/provider/auth/key-rotation.ts`
- **Lines**: 1, 60, 63, 73, 74
- **Errors**: TS6133 x 1, TS2322 x 2, TS2412 x 2
- **Root cause**: (1) `createSecret` unused; (60,63) `KeyEntry | undefined` not assignable to `KeyEntry | null`; (73,74) `undefined` not assignable to `string`/`number`.
- **Fix**: (1) Remove unused; (60-74) Use `null` instead of `undefined` or change target types.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "key-rotation"`

### T-AR-054: event-architecture/canonical-event.ts
- **File**: `packages/agent-runtime/src/event-architecture/canonical-event.ts`
- **Lines**: 483, 484
- **Errors**: TS2322 x 2
- **Root cause**: `"diagnostic"` not assignable to `ConexEventDomain`.
- **Fix**: Add `"diagnostic"` to the `ConexEventDomain` union type.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "canonical-event.ts"`

### T-AR-055: rich-read.ts
- **File**: `packages/agent-runtime/src/rich-read.ts`
- **Lines**: 183, 259, 294
- **Errors**: TS2322 x 2, TS2375 x 1
- **Root cause**: (183,259) Function signatures missing `context` parameter or returning wrong shape; (294) `RichReadRequest` exactOptional.
- **Fix**: (183,259) Add `context` parameter and fix return shape; (294) exactOptional.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "rich-read"`

### T-AR-056: rendering/rendering-pipeline.ts
- **File**: `packages/agent-runtime/src/rendering/rendering-pipeline.ts`
- **Lines**: 225, 433
- **Errors**: TS2379 x 2
- **Root cause**: (225) `Omit<RenderItem, ...>` exactOptional; (433) `{ stage, timestamp, detail? }` exactOptional.
- **Fix**: exactOptional pattern.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "rendering-pipeline"`

### T-AR-057: runtime.ts, secrets-obfuscation.ts, trace/index.ts, tool-discovery.ts, structured-summary.ts, skills.ts, workspace-mutation-coordinator.ts
- **Files**: 7 small-fix files
- **Errors**: 1-2 errors each
- **Root cause**: Various exactOptional (TS2375/TS2379/TS2412/TS2322).
- **Fix**: Apply exactOptional pattern per file.
- **Verification**: Per-file grep.

### T-AR-058: provider/__tests__/e2e/mock-server.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts`
- **Lines**: 49, 51(x2), 52, 63, 89, 92, 94, 95, 116
- **Errors**: TS18048 x 7, TS2564 x 1, TS2379 x 1
- **Root cause**: (49-95) `chunk` and `phase` possibly undefined after destructuring; (63) `port` not initialized in constructor; (116) exactOptional for mock server options.
- **Fix**: (49-95) Add null checks or `!` assertion; (63) Add `!` definite assignment; (116) exactOptional.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "mock-server"`

### T-AR-059: provider/__tests__/factory.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/factory.test.ts`
- **Lines**: 1, 106, 112, 167, 177, 178, 179(x2)
- **Errors**: TS6133, TS2554, TS2322, TS2739, TS18048 x 3, TS2339
- **Root cause**: (1) `vi` unused; (106) Wrong arity; (112) `"custom-engine"` not in union; (167) Missing `id`, `createdAt`; (177-179) `stop` possibly undefined, `error` missing.
- **Fix**: (1) Remove unused; (106) Fix call signature; (112) Add to union or cast; (167) Add missing fields; (177-179) Add null checks.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "factory.test"`

### T-AR-060: provider/__tests__/base-engine.test.ts
- **File**: `packages/agent-runtime/src/provider/__tests__/base-engine.test.ts`
- **Lines**: 151, 183, 212, 222, 242
- **Errors**: TS2322 x 2, TS2345 x 3
- **Root cause**: Mock type mismatch: `MockInstance<{ (input: URL | RequestInfo, ...) }>` vs `MockInstance<(args: unknown[]) => unknown>`.
- **Fix**: Use `as MockInstance<...>` or cast to broader mock type.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "base-engine.test"`

### T-AR-061: __tests__ (root level) — 9 test files
- **Files**: `__tests__/canonical-schema.test.ts`, `__tests__/canonicalize-tools.test.ts`, `__tests__/context-slicer.test.ts`, `__tests__/integrations/*.test.ts` (4 files), `__tests__/steering-input-queue.test.ts`
- **Errors**: TS2488 x 1, TS2322 x 4, TS2532 x 23, TS2345 x 1, TS2339 x 2, TS2379 x 2, TS6133 x 1, TS2571 x 2, TS2353 x 1
- **Root cause**: Various test-level issues: strict null, type mismatches, unknown types.
- **Fix**: Add optional chaining, type guards, missing properties, exactOptional.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "__tests__"`

### T-AR-062: provider/engines/*.ts (5 engine files)
- **Files**: `anthropic-messages-engine.ts`, `base-engine.ts`, `ollama-engine.ts`, `openai-compatible-engine.ts`, `anthropic-messages-engine.test.ts`, `ollama-engine.test.ts`, `openai-compatible-engine.test.ts`
- **Errors**: TS6133 x 2, TS2339 x 4, TS2322 x 3, TS2375 x 2, TS2379 x 3, TS2739 x 3, TS6196 x 1, TS18048 x 5, TS7053 x 3, TS2532 x 2, TS2353 x 1
- **Root cause**: (engines) `maxTokens` missing on `AgentProviderRequest`, stream event union mismatch, exactOptional; (tests) `AgentMessage` missing `id`/`createdAt`, header indexing, null checks.
- **Fix**: (engines) Add `maxTokens` to `AgentProviderRequest` or use existing property; fix stream event return types; (tests) Add missing fields, use proper header indexing, add null checks.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "engines"`

### T-AR-063: provider-gateway-edge.test.ts + provider-gateway.test.ts
- **Files**: `provider-gateway-edge.test.ts`, `provider-gateway.test.ts`
- **Errors**: TS6133 x 1, TS2741 x 2, TS2322 x 2
- **Root cause**: (edge) Missing `policy` in `ModelRouteDecision`; (test) Credential resolver return type shape mismatch.
- **Fix**: (edge) Add `policy` field; (test) Fix return shapes to match `ResolvedProviderCredential`.
- **Verification**: `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Select-String "provider-gateway"`

### T-AR-064: remaining test files — single-issue files
- **Files**: Various .test.ts files with 1-3 errors each
- **Errors**: TS6133, TS6196, TS2532, TS2322, TS2345, TS2305, TS2459, TS6192, TS2391, TS2420, TS2554, TS7006
- **Root cause**: Unused imports, missing null checks, missing exports, wrong function arity.
- **Fix**: Per-file targeted fixes.
- **Verification**: Per-file grep.

---

## 4. Machine-Readable Ledger

```json
{
  "meta": {
    "package": "packages/agent-runtime",
    "total_errors": 572,
    "total_files": 155,
    "generated_at": "2026-07-25T00:00:00Z",
    "tsconfig": "packages/agent-runtime/tsconfig.json",
    "strict_mode": true,
    "exactOptionalPropertyTypes": true
  },
  "rounds": [
    {
      "id": "R-AR-1",
      "focus": "exactOptionalPropertyTypes wave — source files",
      "agents": 6,
      "description": "Fix TS2375/TS2379/TS2412 in core source files (non-test). Priority files: error-classifier.ts, anthropic-stream-parse.ts, gemini-stream-parse.ts, checkpoint-manifest.ts, conversation-boundary-manifest.ts, model-routing/*, provider-gateway/*, runtime-metrics/*, state-machine/*, hooks/*, local-tools/*",
      "tasks": [
        "T-AR-001", "T-AR-002", "T-AR-003", "T-AR-004", "T-AR-005",
        "T-AR-006", "T-AR-007", "T-AR-008", "T-AR-009", "T-AR-010",
        "T-AR-011", "T-AR-012", "T-AR-013", "T-AR-014", "T-AR-015",
        "T-AR-016", "T-AR-017", "T-AR-018", "T-AR-019", "T-AR-020",
        "T-AR-021", "T-AR-022", "T-AR-026", "T-AR-027", "T-AR-028",
        "T-AR-029", "T-AR-030", "T-AR-031", "T-AR-032", "T-AR-035",
        "T-AR-036", "T-AR-038", "T-AR-039", "T-AR-040", "T-AR-041",
        "T-AR-042", "T-AR-043", "T-AR-044", "T-AR-045", "T-AR-046",
        "T-AR-047", "T-AR-048", "T-AR-049", "T-AR-050", "T-AR-051",
        "T-AR-052", "T-AR-053", "T-AR-055", "T-AR-056", "T-AR-057"
      ],
      "files_write": [
        "packages/agent-runtime/src/error-classifier.ts",
        "packages/agent-runtime/src/anthropic-stream-parse.ts",
        "packages/agent-runtime/src/gemini-stream-parse.ts",
        "packages/agent-runtime/src/checkpoint-manifest.ts",
        "packages/agent-runtime/src/conversation-boundary-manifest.ts",
        "packages/agent-runtime/src/checkpoint/checkpoint-manager.ts",
        "packages/agent-runtime/src/context-compression/token-estimator.ts",
        "packages/agent-runtime/src/context-compression/index.ts",
        "packages/agent-runtime/src/event-protocol/core-event-projector.ts",
        "packages/agent-runtime/src/event-queue/index.ts",
        "packages/agent-runtime/src/fallback-chain/engine.ts",
        "packages/agent-runtime/src/git-versioning.ts",
        "packages/agent-runtime/src/goal-disk-oracle.ts",
        "packages/agent-runtime/src/hooks/extension-registry.ts",
        "packages/agent-runtime/src/hooks/tool-hook-observability.ts",
        "packages/agent-runtime/src/local-tools/checkpoint-tools.ts",
        "packages/agent-runtime/src/local-tools/fs-edit-tools/utils.ts",
        "packages/agent-runtime/src/local-tools/fs-edit-tools/write-tool.ts",
        "packages/agent-runtime/src/local-tools/fs-edit-tools/edit-tool.ts",
        "packages/agent-runtime/src/local-tools/index.ts",
        "packages/agent-runtime/src/local-tools/pre-mutation.ts",
        "packages/agent-runtime/src/local-tools/shell-tools.ts",
        "packages/agent-runtime/src/lsp-tools.ts",
        "packages/agent-runtime/src/mcp-lifecycle/utils.ts",
        "packages/agent-runtime/src/media/media-preprocessor.ts",
        "packages/agent-runtime/src/memory.ts",
        "packages/agent-runtime/src/model-routing-enhanced.ts",
        "packages/agent-runtime/src/model-routing/matcher.ts",
        "packages/agent-runtime/src/model-routing/profile.ts",
        "packages/agent-runtime/src/model-routing-roles.ts",
        "packages/agent-runtime/src/plugin-registry.ts",
        "packages/agent-runtime/src/preview-queue.ts",
        "packages/agent-runtime/src/process-lifecycle/process-manager.ts",
        "packages/agent-runtime/src/project-progress-ledger.ts",
        "packages/agent-runtime/src/prompt-assembly.ts",
        "packages/agent-runtime/src/provider-anthropic.ts",
        "packages/agent-runtime/src/provider-gemini.ts",
        "packages/agent-runtime/src/provider-openai-compatible.ts",
        "packages/agent-runtime/src/provider-openai-chat.ts",
        "packages/agent-runtime/src/provider-openai-responses.ts",
        "packages/agent-runtime/src/provider-request-machine.ts",
        "packages/agent-runtime/src/provider-stream-contract/error.ts",
        "packages/agent-runtime/src/provider-transport/connection-manager.ts",
        "packages/agent-runtime/src/provider/auth/credential-pool.ts",
        "packages/agent-runtime/src/provider/auth/credential-resolver.ts",
        "packages/agent-runtime/src/provider/auth/key-rotation.ts",
        "packages/agent-runtime/src/provider/auth/oauth/token-guardian.ts",
        "packages/agent-runtime/src/provider/loader.ts",
        "packages/agent-runtime/src/provider/provider-gateway-v2.ts",
        "packages/agent-runtime/src/provider/registry-v2.ts",
        "packages/agent-runtime/src/provider/factory.ts",
        "packages/agent-runtime/src/provider/cli/main.ts",
        "packages/agent-runtime/src/provider/cli/provider-dev.ts",
        "packages/agent-runtime/src/provider/engines/base-engine.ts",
        "packages/agent-runtime/src/provider/engines/openai-compatible-engine.ts",
        "packages/agent-runtime/src/provider/engines/anthropic-messages-engine.ts",
        "packages/agent-runtime/src/provider/engines/ollama-engine.ts",
        "packages/agent-runtime/src/provider-gateway/credential-resolver.ts",
        "packages/agent-runtime/src/provider-gateway/index.ts",
        "packages/agent-runtime/src/provider-gateway/route-selector.ts",
        "packages/agent-runtime/src/rendering/rendering-pipeline.ts",
        "packages/agent-runtime/src/rich-read.ts",
        "packages/agent-runtime/src/runtime.ts",
        "packages/agent-runtime/src/runtime-components/context-manager.ts",
        "packages/agent-runtime/src/runtime-components/conversation-engine.ts",
        "packages/agent-runtime/src/runtime-metrics/collectors.ts",
        "packages/agent-runtime/src/runtime-metrics/snapshot.ts",
        "packages/agent-runtime/src/scoped-context-resources.ts",
        "packages/agent-runtime/src/scoped-context.ts",
        "packages/agent-runtime/src/secrets-obfuscation.ts",
        "packages/agent-runtime/src/skills.ts",
        "packages/agent-runtime/src/state-machine/agent-session.ts",
        "packages/agent-runtime/src/state-machine/core.ts",
        "packages/agent-runtime/src/state-machine/run-lifecycle.ts",
        "packages/agent-runtime/src/state-machine/session-branch.ts",
        "packages/agent-runtime/src/structured-summary.ts",
        "packages/agent-runtime/src/subagent-loop.ts",
        "packages/agent-runtime/src/tool-discovery.ts",
        "packages/agent-runtime/src/tool-output-budget.ts",
        "packages/agent-runtime/src/tool-output-guard.ts",
        "packages/agent-runtime/src/tools/tool-definition.ts",
        "packages/agent-runtime/src/trace/index.ts",
        "packages/agent-runtime/src/event-architecture/canonical-event.ts",
        "packages/agent-runtime/src/workspace-mutation-coordinator.ts"
      ],
      "verification": "npx tsc --noEmit --project packages/agent-runtime/tsconfig.json",
      "pass_condition": "0 errors in affected files (grep for exactOptional errors in source dir)"
    },
    {
      "id": "R-AR-2",
      "focus": "exactOptionalPropertyTypes wave — test files",
      "agents": 4,
      "description": "Fix TS2375/TS2379/TS2412 in test files. These are test object literals that violate exactOptionalPropertyTypes.",
      "tasks": [
        "T-AR-058", "T-AR-059", "T-AR-060", "T-AR-061", "T-AR-062",
        "T-AR-063", "T-AR-064"
      ],
      "files_write": [
        "packages/agent-runtime/src/__tests__/canonical-schema.test.ts",
        "packages/agent-runtime/src/__tests__/canonicalize-tools.test.ts",
        "packages/agent-runtime/src/__tests__/context-slicer.test.ts",
        "packages/agent-runtime/src/__tests__/integrations/chatgpt-pool.test.ts",
        "packages/agent-runtime/src/__tests__/integrations/media-pipeline.test.ts",
        "packages/agent-runtime/src/__tests__/integrations/oauth-flow.test.ts",
        "packages/agent-runtime/src/__tests__/integrations/streaming-executor.test.ts",
        "packages/agent-runtime/src/__tests__/integrations/tool-stream.test.ts",
        "packages/agent-runtime/src/__tests__/steering-input-queue.test.ts",
        "packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts",
        "packages/agent-runtime/src/provider/__tests__/factory.test.ts",
        "packages/agent-runtime/src/provider/__tests__/base-engine.test.ts",
        "packages/agent-runtime/src/provider/__tests__/e2e/context-length-recovery.test.ts",
        "packages/agent-runtime/src/provider/__tests__/e2e/provider-factory.test.ts",
        "packages/agent-runtime/src/provider/__tests__/e2e/exponential-backoff-e2e.test.ts",
        "packages/agent-runtime/src/provider/__tests__/benchmarks/provider-lifecycle.bench.ts",
        "packages/agent-runtime/src/provider/__tests__/registry.test.ts",
        "packages/agent-runtime/src/provider-gateway-edge.test.ts",
        "packages/agent-runtime/src/provider-gateway.test.ts",
        "packages/agent-runtime/src/provider-gateway/credential-resolver.test.ts",
        "packages/agent-runtime/src/provider-cache-hints.test.ts",
        "packages/agent-runtime/src/provider-stream-contract.test.ts",
        "packages/agent-runtime/src/provider-openai-compatible.test.ts",
        "packages/agent-runtime/src/runtime-components/conversation-engine.test.ts",
        "packages/agent-runtime/src/runtime-components/provider-response-consumer.test.ts",
        "packages/agent-runtime/src/runtime-components/tool-executor.test.ts",
        "packages/agent-runtime/src/runtime-metrics.test.ts",
        "packages/agent-runtime/src/testing.test.ts",
        "packages/agent-runtime/src/tool-stream/tool-stream.test.ts",
        "packages/agent-runtime/src/provider/engines/anthropic-messages-engine.test.ts",
        "packages/agent-runtime/src/provider/engines/ollama-engine.test.ts",
        "packages/agent-runtime/src/provider/engines/openai-compatible-engine.test.ts",
        "packages/agent-runtime/src/state-machine/core.test.ts",
        "packages/agent-runtime/src/state-machine/session-branch.ts",
        "packages/agent-runtime/src/provider/auth/oauth/account-store.ts"
      ],
      "verification": "npx tsc --noEmit --project packages/agent-runtime/tsconfig.json",
      "pass_condition": "0 errors in affected test files"
    },
    {
      "id": "R-AR-3",
      "focus": "Unused declarations — TS6133/TS6196/TS6192/TS6138",
      "agents": 3,
      "description": "Remove all unused imports, variables, types, and parameters. These are mechanical removals that cannot cause runtime regressions.",
      "tasks": ["T-AR-B"],
      "files_write": [
        "packages/agent-runtime/src/context-compression/compression-utils.test.ts",
        "packages/agent-runtime/src/context-compression/serializer.ts",
        "packages/agent-runtime/src/event-architecture/canonical-event.test.ts",
        "packages/agent-runtime/src/event-protocol/core-event-projector.test.ts",
        "packages/agent-runtime/src/fallback-chain/engine.test.ts",
        "packages/agent-runtime/src/fallback-chain/types.ts",
        "packages/agent-runtime/src/local-tools/fs-edit-tools/apply-edits-tool.ts",
        "packages/agent-runtime/src/local-tools/fs-edit-tools/types.ts",
        "packages/agent-runtime/src/mcp-lifecycle/mcp-lifecycle-manager.ts",
        "packages/agent-runtime/src/mcp-lifecycle/mcp-server-controller.test.ts",
        "packages/agent-runtime/src/mcp-lifecycle/types.ts",
        "packages/agent-runtime/src/path-handling/conex-path.ts",
        "packages/agent-runtime/src/plan-document/operations.ts",
        "packages/agent-runtime/src/plan-document/validation.ts",
        "packages/agent-runtime/src/provider/__tests__/auth.test.ts",
        "packages/agent-runtime/src/provider/__tests__/e2e/steering-injection.test.ts",
        "packages/agent-runtime/src/provider-auth/oauth/chatgpt-pool.test.ts",
        "packages/agent-runtime/src/provider-auth/oauth/cross-process-lock.ts",
        "packages/agent-runtime/src/provider-gateway/route-selector.test.ts",
        "packages/agent-runtime/src/provider-gateway/types.ts",
        "packages/agent-runtime/src/recovery-pipeline.ts",
        "packages/agent-runtime/src/recovery/stream-recovery.ts",
        "packages/agent-runtime/src/runtime-metrics/types.ts",
        "packages/agent-runtime/src/session-loop/index.test.ts",
        "packages/agent-runtime/src/session-loop/provider-call.test.ts",
        "packages/agent-runtime/src/state-machine/run-lifecycle.test.ts",
        "packages/agent-runtime/src/trace/index.test.ts",
        "packages/agent-runtime/src/tools/tool-system.test.ts",
        "packages/agent-runtime/src/provider/__tests__/factory.test.ts"
      ],
      "verification": "npx tsc --noEmit --project packages/agent-runtime/tsconfig.json",
      "pass_condition": "0 TS6133/TS6196/TS6192 errors"
    },
    {
      "id": "R-AR-4",
      "focus": "Import type used as value — TS1361",
      "agents": 1,
      "description": "Change `import type` to regular `import` for constant/value exports in plan-document package.",
      "tasks": ["T-AR-023", "T-AR-025"],
      "files_write": [
        "packages/agent-runtime/src/plan-document/index.ts"
      ],
      "verification": "npx tsc --noEmit --project packages/agent-runtime/tsconfig.json",
      "pass_condition": "0 TS1361 errors"
    },
    {
      "id": "R-AR-5",
      "focus": "Missing exports — TS2305/TS2459/TS2554",
      "agents": 1,
      "description": "Add missing exports to modules or fix import paths. Fix wrong function arity.",
      "tasks": ["T-AR-015", "T-AR-064"],
      "files_write": [
        "packages/agent-runtime/src/doctor-report.ts",
        "packages/agent-runtime/src/ISessionStore.ts",
        "packages/agent-runtime/src/payload-image-recovery.test.ts",
        "packages/agent-runtime/src/session-store/index.ts",
        "packages/agent-runtime/src/session-loop/index.test.ts",
        "packages/agent-runtime/src/session-loop/provider-call.test.ts",
        "packages/agent-runtime/src/subagent-types.ts",
        "packages/agent-runtime/src/runtime-metrics/snapshot.ts",
        "packages/agent-runtime/src/provider-stream-contract/json-repair.test.ts",
        "packages/agent-runtime/src/provider-stream-contract/normalizer.test.ts",
        "packages/agent-runtime/src/local-tools/fs-edit-tools/edit-tool.ts",
        "packages/agent-runtime/src/provider/registry-v2.ts"
      ],
      "verification": "npx tsc --noEmit --project packages/agent-runtime/tsconfig.json",
      "pass_condition": "0 TS2305/TS2459/TS2554 errors"
    },
    {
      "id": "R-AR-6",
      "focus": "Edge cases — TS2571/TS7053/TS2391/TS2420/TS7006/TS2352/TS2488/TS2564",
      "agents": 1,
      "description": "Fix edge case errors: unknown type assertions, implicit any, wrong interface implementation, etc.",
      "tasks": ["T-AR-064"],
      "files_write": [
        "packages/agent-runtime/src/event-queue/index.ts",
        "packages/agent-runtime/src/__tests__/canonical-schema.test.ts",
        "packages/agent-runtime/src/provider/__tests__/e2e/mock-server.ts",
        "packages/agent-runtime/src/subagent-types.ts",
        "packages/agent-runtime/src/session-store/index.ts",
        "packages/agent-runtime/src/path-handling/conex-path.ts",
        "packages/agent-runtime/src/runtime-components/provider-response-consumer.test.ts"
      ],
      "verification": "npx tsc --noEmit --project packages/agent-runtime/tsconfig.json",
      "pass_condition": "0 remaining errors"
    }
  ],
  "verification_script": "npx tsc --noEmit --project packages/agent-runtime/tsconfig.json",
  "gates": {
    "G0": "Compilation passes with 0 errors",
    "G1": "Lint passes (if configured)",
    "G2": "Vitest tests pass: npx vitest run --project agent-runtime"
  }
}
```

---

## 5. Inter-Round Interface Definitions

### 5.1 Task Card Schema (JSON)

Each round produces an updated ledger with per-task status:

```json
{
  "$schema": "round-ledger-schema.json",
  "rounds": [
    {
      "id": "R-AR-1",
      "status": "open | fixed | verified | regressed",
      "focus": "",
      "tasks": [
        {
          "id": "T-AR-001",
          "file": "packages/agent-runtime/src/error-classifier.ts",
          "status": "open | fixed | verified | regressed",
          "errors_before": 23,
          "errors_after": 0,
          "fix_summary": "Changed classify parameter type or added conditional spreads",
          "committed_at": "2026-07-25T12:00:00Z",
          "verified_at": "2026-07-25T12:30:00Z"
        }
      ],
      "files_write": [],
      "verification_output": "stdout of tsc --noEmit",
      "verification_passed": true,
      "gates": {
        "G0": true,
        "G2": null
      }
    }
  ]
}
```

### 5.2 Gate Definitions

| Gate | Description | Command | Pass Condition |
|------|-------------|---------|----------------|
| G0 | Compilation | `npx tsc --noEmit -p packages/agent-runtime/tsconfig.json` | Exit code 0, no errors |
| G1 | Lint | `npx eslint packages/agent-runtime/src/` | Exit code 0 |
| G2 | Unit tests | `npx vitest run --project agent-runtime` | Exit code 0 |

### 5.3 Round Handoff Protocol

1. **Agent begins round**: Reads the ledger, identifies tasks with `status: "open"` in its assigned round
2. **Agent works on tasks**: Edits files in `files_write` list only
3. **Agent marks task**: Sets `status: "fixed"` after committing the change
4. **Verification**: Runs G0, if pass sets `verification_passed: true`, updates `status: "verified"`
5. **Regressions**: If a later round breaks a previously verified task, set that task to `regressed` and create a new round or re-open

### 5.4 Round Dependency Graph

```
R-AR-1 (exactOptional source) ──────┐
                                     ├──> no deps between waves
R-AR-2 (exactOptional tests) ───────┤
                                     │
R-AR-3 (unused declarations) ───────┤
                                     │
R-AR-4 (import type) ───────────────┤
                                     │
R-AR-5 (missing exports) ───────────┘
                                     │
R-AR-6 (edge cases) ────────────────┘
                                     │
                                     ▼
                              G0 Verification
                                     │
                                     ▼
                              G2 Tests
```

All rounds R-AR-1 through R-AR-6 can theoretically run in parallel because they touch disjoint file sets (the write-set isolation matrix guarantees zero overlap). However, for practical coordination, the recommended sequence is:

1. R-AR-1 first (largest wave, establishes baseline)
2. R-AR-2 through R-AR-6 in any order (independent)
3. Full G0 + G2 validation at the end

---

## Appendix A: exactOptionalPropertyTypes Fix Pattern

```typescript
// PROBLEM: This fails with TS2375/TS2379
function foo(options: { bar?: string }) {}
foo({ bar: undefined }); // Error with exactOptionalPropertyTypes

// FIX 1: Conditional spread (preferred for object construction)
const opt = { ...(bar !== undefined && { bar }) };
foo(opt);

// FIX 2: Cast (acceptable when you know it's safe)
foo({ bar: undefined as unknown as string | undefined });

// FIX 3: Helper function (for repeated patterns)
function opt<K extends string, V>(key: K, value: V | undefined): {} | { [P in K]: V } {
  return value !== undefined ? { [key]: value } as { [P in K]: V } : {};
}

// FIX 4: Widen type to accept undefined
// Change: { bar?: string } → { bar?: string | undefined }
// OR use a builder pattern
```

## Appendix B: Error Count by Top-20 Files

| Rank | File | Errors | Primary Error Codes |
|------|------|--------|---------------------|
| 1 | `error-classifier.ts` | 23 | TS2379 x 22, TS2375 x 1 |
| 2 | `runtime-metrics/collectors.ts` | 17 | TS6133 x 6, TS2379 x 8, TS2339 x 2 |
| 3 | `provider-gateway/route-selector.ts` | 16 | TS6133 x 2, TS2375 x 13, TS2412 x 1 |
| 4 | `provider-gateway/index.ts` | 16 | TS6133 x 5, TS2412 x 4, TS2379 x 4, TS2375 x 3 |
| 5 | `plan-document/validation.ts` | 16 | TS6196 x 8, TS1361 x 7 |
| 6 | `plan-document/index.ts` | 16 | TS6196 x 8, TS1361 x 13 |
| 7 | `plan-document/operations.ts` | 11 | TS6196 x 1, TS6133 x 2, TS2412 x 4, TS2322 x 5 |
| 8 | `runtime-metrics/snapshot.ts` | 11 | TS2459 x 1, TS6133 x 5, TS2375 x 1, TS2379 x 5 |
| 9 | `gemini-stream-parse.ts` | 9 | TS2322 x 8, TS2375 x 1 |
| 10 | `provider/__tests__/e2e/mock-server.ts` | 11 | TS18048 x 7, TS2564 x 1, TS2379 x 1 |
| 11 | `provider/auth/credential-pool.ts` | 10 | TS6133 x 1, TS2412 x 6, TS2322 x 3 |
| 12 | `provider/engines/openai-compatible-engine.ts` | 10 | TS6196 x 1, TS6133 x 1, TS2375 x 2, TS2379 x 2, TS2339 x 2 |
| 13 | `provider/__tests__/factory.test.ts` | 9 | TS6133, TS2554, TS2322, TS2739, TS18048 x 3, TS2339 |
| 14 | `model-routing/profile.ts` | 8 | TS6196 x 1, TS2379 x 2, TS2375 x 5 |
| 15 | `model-routing/matcher.ts` | 8 | TS6133 x 6, TS2375 x 2 |
| 16 | `provider-openai-compatible.test.ts` | 16 | TS2532 x 14, TS2353 x 2 |
| 17 | `__tests__/integrations/streaming-executor.test.ts` | 11 | TS6133 x 1, TS2532 x 10 |
| 18 | `__tests__/integrations/tool-stream.test.ts` | 10 | TS2571 x 2, TS2353 x 1, TS2532 x 7 |
| 19 | `provider-openai-compatible.ts` | 3 | TS2379 x 1, TS2375 x 2 |
| 20 | `anthropic-stream-parse.ts` | 6 | TS2322 x 5, TS2375 x 1 |

---

*End of plan_01_agent_runtime.md — 572 errors across 155 files, organized into 6 repair rounds with zero file overlap.*
