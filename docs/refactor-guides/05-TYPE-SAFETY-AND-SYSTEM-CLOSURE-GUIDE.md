# 维度五指导方案：类型安全 Zero-any、异常捕获与单元测试验收指南 (05-TYPE-SAFETY-AND-SYSTEM-CLOSURE-GUIDE)

> **Document ID**: CX-GUIDE-005  
> **Version**: v1.0 Final  
> **Target Files**: `apps/crish-desktop/src/services/SessionSyncService.ts` / `apps/crish-desktop/src/api/SessionRuntimeRegistry.ts` / `apps/crish-desktop/src/hooks/useAgentStream.ts` / `packages/shared-utils/src/dynamic-adaptation.ts` / `scripts/check-no-as-any-store.mjs`  
> **Core Objective**: Eliminate all `as any` type escapes across services and stores; close silent exception swallowing loops; and enforce unit testing and CI/CD quality gates to ensure 100% architectural compliance.

---

## 1. Problem Audit & Quality Gaps

Agent 5 identified structural type leaks, swallowed exceptions, and missing test coverage across the repository:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   Type Safety, Silent Catch & Testing Gap Audit                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Type Escapes (`as any`): Key service files bypass TypeScript strict checking:       │
│    - `SessionSyncService.ts:510, 518, 524`: `msg as any`, `status as any`              │
│    - `SessionRuntimeRegistry.ts:81-84`: `(state as any).diffFiles = null`              │
│    - `useAgentStream.ts:214`: `m.toolCalls.push(entry as any)`                         │
│    - `server-runtime-factory.ts:355`: `(manager as any).startServer(...)`              │
│ 2. Silent Exception Swallowing: Operations silently swallow errors without logging:     │
│    - `dynamic-adaptation.ts:238, 338, 362`: Empty `catch { /* swallow */ }` blocks     │
│    - `useChatAutoScroll.ts:71-73`: Empty `catch` block degrades measurement silently. │
│ 3. Missing Unit Tests: No automated regression tests for Pretext LRU cache hit-rate,   │
│    FpsMonitor CPU idle pause, or Lazy Tooltip zero-hook unmounted behavior.            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Refactoring Standards & Implementation Guidelines

### 2.1 Eliminating `as any` Type Escapes

#### 1. Refactoring `SessionSyncService.ts` (Lines 500–530)
Replace `as any` casts with strict TypeScript interfaces for Session Messages:

```typescript
// SessionSyncService.ts
import type { SessionMessage, MessageStatus } from '../store/layoutStore';

// BEFORE (Bug): Type escape with as any
// const status = change.status as any;
// messages: [...session.messages, msg as any]

// AFTER (Refactored): Strict typed update with Discriminated Unions
export function mergeSessionMessage(
  existingMessages: readonly SessionMessage[],
  incomingMessage: SessionMessage
): SessionMessage[] {
  const index = existingMessages.findIndex((m) => String(m.id) === String(incomingMessage.id));

  if (index >= 0) {
    const updated = [...existingMessages];
    updated[index] = {
      ...existingMessages[index],
      ...incomingMessage,
      status: incomingMessage.status satisfies MessageStatus | undefined,
    };
    return updated;
  }

  return [...existingMessages, incomingMessage];
}
```

#### 2. Refactoring `SessionRuntimeRegistry.ts` (Lines 80–90)
Define explicit interface for State reset instead of mutating `(state as any)`:

```typescript
// SessionRuntimeRegistry.ts
interface SessionRuntimeState {
  diffFiles: FileDiff[] | null;
  attachments: Attachment[] | null;
  activeToolCallId: string | null;
}

export function resetSessionRuntimeState(state: SessionRuntimeState): void {
  // Strict typed assignment without `as any`
  state.diffFiles = null;
  state.attachments = null;
  state.activeToolCallId = null;
}
```

---

### 2.2 Closing Silent Exception Loops & Structural Error Handling

#### 1. Refactoring `dynamic-adaptation.ts` Listener & Metrics Catch Blocks
Replace empty `catch { /* swallow */ }` with telemetry logging and error reporting:

```typescript
// packages/shared-utils/src/dynamic-adaptation.ts
private emit(event: MetricEvent): void {
  for (const listener of this.listeners) {
    try {
      listener(event);
    } catch (err) {
      // Log exception to dev logger instead of silent swallowing
      if (process.env.NODE_ENV === 'development') {
        console.error('[DynamicAdaptationEngine] Listener error:', err);
      }
    }
  }
}

private getMemoryInfo(): { heapUsed: number; heapTotal: number; freeRatio: number } {
  try {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (mem && mem.jsHeapSizeLimit > 0) {
      return {
        heapUsed: mem.usedJSHeapSize,
        heapTotal: mem.jsHeapSizeLimit,
        freeRatio: 1 - mem.usedJSHeapSize / mem.jsHeapSizeLimit,
      };
    }
  } catch (err) {
    // Log fallback warning
    console.debug('[DynamicAdaptationEngine] performance.memory unavailable, fallback used');
  }
  return { heapUsed: 0, heapTotal: 512 * 1024 * 1024, freeRatio: 0.5 };
}
```

---

### 2.3 Unit Testing & Quality Gate Automation

Create unit tests to verify performance refactoring compliance.

#### 1. Pretext LRU Cache Unit Test (`tests/pretextCache.test.ts`)
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { globalPretextCache } from '../apps/crish-desktop/src/api/pretextCache';

describe('PretextCacheManager', () => {
  beforeEach(() => {
    globalPretextCache.clear();
  });

  it('should cache and reuse PreparedText for identical input', () => {
    const p1 = globalPretextCache.getOrCreate('msg-1', 'Hello World', '14px Inter');
    const p2 = globalPretextCache.getOrCreate('msg-1', 'Hello World', '14px Inter');

    expect(p1).not.toBeNull();
    // Same instance handle returned from LRU cache
    expect(p1).toBe(p2);
  });

  it('should invalidate cache when text length changes', () => {
    const p1 = globalPretextCache.getOrCreate('msg-1', 'Hello World', '14px Inter');
    const p2 = globalPretextCache.getOrCreate('msg-1', 'Hello World Streaming', '14px Inter');

    expect(p1).not.toBe(p2);
  });
});
```

#### 2. CI/CD Static Type Checker Gate Script (`scripts/check-no-as-any-store.mjs`)
Enforce Zero `as any` in core stores and services during `npm run check:all`:

```javascript
// scripts/check-no-as-any-store.mjs
import fs from 'fs';
import path from 'path';

const TARGET_FILES = [
  'apps/crish-desktop/src/store/layoutStore.ts',
  'apps/crish-desktop/src/services/SessionSyncService.ts',
  'apps/crish-desktop/src/api/SessionRuntimeRegistry.ts',
  'packages/shared-utils/src/dynamic-adaptation.ts',
];

let hasError = false;

for (const file of TARGET_FILES) {
  const fullPath = path.resolve(file);
  if (!fs.existsSync(fullPath)) continue;

  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    if (line.includes('as any') && !line.includes('// eslint-disable')) {
      console.error(`❌ [Type Check Error] Forbidden 'as any' found in ${file}:${idx + 1}`);
      console.error(`   Line: ${line.trim()}`);
      hasError = true;
    }
  });
}

if (hasError) {
  process.exit(1);
} else {
  console.log('✅ [Type Check Passed] Zero forbidden `as any` in core stores/services.');
}
```

---

## 3. SLA & Quality Verification Summary

| Verification Gate | Command | Pass Criteria |
|---|---|---|
| **Type Check** | `npm run check:core && npm run check:desktop` | Zero TypeScript errors |
| **No `as any` Check** | `npm run check:store-types` | Zero un-annotated `as any` in core files |
| **Unit Tests** | `npm run test` | 100% test pass rate for pretextCache & FpsMonitor |
| **Linting** | `npm run lint:all` | Zero ESLint & Stylelint warnings |
