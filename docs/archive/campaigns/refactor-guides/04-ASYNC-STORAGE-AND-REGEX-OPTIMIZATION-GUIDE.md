# 维度四指导方案：异步 IndexedDB 存储、零拷贝快照与正则 Fast-Path 优化指南 (04-ASYNC-STORAGE-AND-REGEX-OPTIMIZATION-GUIDE)

> **Document ID**: CX-GUIDE-004
> **Version**: v1.0 Final
> **Target Files**: `apps/crish-desktop/src/api/sessionPersistence.ts` / `apps/crish-desktop/src/store/storeTransaction.ts` / `apps/crish-desktop/src/api/toolFeedback.ts` / `apps/crish-desktop/src/store/actions/session.ts`
> **Core Objective**: Migrate 270+ synchronous `localStorage` calls to asynchronous IndexedDB / Tauri backend; eliminate 14.79% V8 GC memory allocation spikes caused by `structuredClone` on Zustand Stores; and refactor `toolFeedback.ts` 25-regex pipeline with Fast-Path short-circuiting and compiled unified regex matching.

---

## 1. Problem Audit & Structural Bottlenecks

Agent 4 identified three major CPU and I/O performance killers in the desktop runtime:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   Storage I/O, GC Memory Spike & Regex Audit Findings                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Synchronous Disk I/O: 270+ calls to `localStorage.getItem/setItem` in renderer.    │
│    `sessionPersistence.ts` writes JSONL message histories synchronously to disk on     │
│    every single streaming token, freezing the UI thread for 10ms - 200ms (Long Task). │
│ 2. O(N) Key Scan: `sessionPersistence.ts` runs `for (let i = 0; i < localStorage.length)`│
│    scanning all keys to purge orphan data, triggering synchronous cross-process IPC.   │
│ 3. 14.79% GC Spikes from `structuredClone`: `storeTransaction.ts` executes             │
│    `structuredClone` on THREE full Zustand store trees (`session`, `workspace`,        │
│    `settingsUi`) on every transaction `begin()`, allocating thousands of heap objects. │
│ 4. `JSON.parse(JSON.stringify)` Branching: Forking sessions parses full message array,│
│    causing double text parsing and temporary plain object pollution.                   │
│ 5. 25-Regex Pipeline: `toolFeedback.ts` runs 25 `/gim` `text.replace` regexes in      │
│    sequence without Fast-Path short-circuiting, creating 25 intermediate strings per   │
│    tool output update.                                                                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Guidance & Refactoring Implementation

### 2.1 Asynchronous Storage Layer (`idb-keyval` / IndexedDB)

#### 1. Create `asyncStorage` Adapter (`apps/crish-desktop/src/api/asyncStorage.ts`)
Replace synchronous `localStorage` with `idb-keyval` (IndexedDB) or Tauri Async Core:

```typescript
// apps/crish-desktop/src/api/asyncStorage.ts
import { get, set, del, keys } from 'idb-keyval';

export async function setAsyncItem<T>(key: string, value: T): Promise<void> {
  try {
    await set(key, value);
  } catch (err) {
    console.error(`[asyncStorage] Failed to set key: ${key}`, err);
  }
}

export async function getAsyncItem<T>(key: string, fallback: T): Promise<T> {
  try {
    const val = await get<T>(key);
    return val !== undefined ? val : fallback;
  } catch {
    return fallback;
  }
}

export async function removeAsyncItem(key: string): Promise<void> {
  try {
    await del(key);
  } catch (err) {
    console.error(`[asyncStorage] Failed to delete key: ${key}`, err);
  }
}

/**
 * Memory-cached key set to eliminate O(N) disk scans
 */
class StorageKeyIndex {
  private keySet = new Set<string>();
  private initialized = false;

  public async getKeys(): Promise<Set<string>> {
    if (!this.initialized) {
      try {
        const allKeys = await keys();
        this.keySet = new Set(allKeys.map(String));
        this.initialized = true;
      } catch {
        this.keySet = new Set();
      }
    }
    return this.keySet;
  }

  public addKey(key: string): void {
    this.keySet.add(key);
  }

  public deleteKey(key: string): void {
    this.keySet.delete(key);
  }
}

export const keyIndexManager = new StorageKeyIndex();
```

#### 2. Refactoring `sessionPersistence.ts`
Replace synchronous `localStorage.setItem` and `localStorage.getItem` with async calls and maintain active session messages in memory:

```typescript
// sessionPersistence.ts
import { getAsyncItem, setAsyncItem, removeAsyncItem, keyIndexManager } from './asyncStorage';

// BEFORE (Bug): Synchronous disk I/O on main thread
// localStorage.setItem(BODY_PREFIX + id, JSON.stringify(messages));

// AFTER (Refactored): Async non-blocking write to IndexedDB
export async function saveSessionBodyAsync(id: string, messages: SessionMessage[]): Promise<void> {
  const key = BODY_PREFIX + id;
  await setAsyncItem(key, messages);
  keyIndexManager.addKey(key);
}

// BEFORE (Bug): O(N) localStorage.length key scanning
// for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ... }

// AFTER (Refactored): O(1) Memory Set check
export async function cleanupOrphanSessionsAsync(activeIds: Set<string>): Promise<void> {
  const allKeys = await keyIndexManager.getKeys();
  for (const k of allKeys) {
    if (k.startsWith(BODY_PREFIX)) {
      const sessionId = k.slice(BODY_PREFIX.length);
      if (!activeIds.has(sessionId)) {
        await removeAsyncItem(k);
        keyIndexManager.deleteKey(k);
      }
    }
  }
}
```

---

### 2.2 Eliminating `structuredClone` GC Spikes in `storeTransaction.ts`

#### Problem
`storeTransaction.ts` runs `deepClone` (using `structuredClone`) on all three Zustand stores (`session`, `workspace`, `settingsUi`) on every `begin()` call.

#### Refactored Code (`apps/crish-desktop/src/store/storeTransaction.ts`)
Replace full-tree `structuredClone` with **Lightweight Patch Record / Shallow Immutable Snapshots**:

```typescript
// storeTransaction.ts
import { useLayoutStore } from './layoutStore';

interface StoreSnapshot {
  activeSessionId: string | null;
  activeWorkspaceIndex: number;
  // Store ONLY primitive scalar state & entity IDs, NOT deep nested message tree!
  sessionIds: string[];
}

export class StoreTransactionManager {
  private snapshots: StoreSnapshot[] = [];

  public begin(): void {
    const state = useLayoutStore.getState();
    // Shallow record of key scalars - ZERO full-tree structuredClone overhead!
    this.snapshots.push({
      activeSessionId: state.activeSessionId,
      activeWorkspaceIndex: state.activeWorkspaceIndex,
      sessionIds: Object.keys(state.sessionsById ?? {}),
    });
  }

  public rollback(): void {
    const snapshot = this.snapshots.pop();
    if (!snapshot) return;

    useLayoutStore.setState({
      activeSessionId: snapshot.activeSessionId,
      activeWorkspaceIndex: snapshot.activeWorkspaceIndex,
    });
  }
}
```

#### Refactoring Session Forking (`session.ts` Line 281)
Replace `JSON.parse(JSON.stringify(messages))` with shallow map copying:

```typescript
// BEFORE (Bug): Double string parsing
// messages: original.messages ? JSON.parse(JSON.stringify(original.messages)) : []

// AFTER (Refactored): Fast shallow map
messages: original.messages ? original.messages.map((m) => ({ ...m, toolCalls: m.toolCalls ? [...m.toolCalls] : undefined })) : []
```

---

### 2.3 `toolFeedback.ts` Regex Fast-Path & Compiled Optimization

#### 1. Fast-Path Keyword Short-Circuit
If raw text does NOT contain system metadata keywords (e.g., `Checkpoint`, `Exit code`, `CWD:`, `CLIXML`), skip regex replacement entirely (**0ms overhead**).

#### 2. Compiled Single-Pass Regex Pattern
Merge 25 individual `.replace()` calls into a single compiled multi-line RegExp matching pattern.

#### Refactored Code (`apps/crish-desktop/src/api/toolFeedback.ts`)
```typescript
// Compiled Unified Pattern matching all 25 system output headers
const SYSTEM_FEEDBACK_REGEX = /^(?:Pre-mutation Git checkpoint:.*|Post-mutation Git checkpoint:.*|Workspace checkpoint:.*|Checkpoint (?:created|restored|id|path):.*|Exit code:\s*.*|Wall time:\s*.*|Duration:\s*.*|Elapsed:\s*.*|Signal:\s*.*|Timed out:\s*.*|Working directory:\s*.*|Current directory:\s*.*|CWD:\s*.*|Shell:\s*.*|Command:\s*|Output:\s*|Path:\s*|Stdout:\s*|Stderr:\s*|STDERR:\s*|STDOUT:\s*|Preparing modules for first use\..*|\[(?:system|runtime|engine|daemon)\]\s*.*|系统提示[：:].*|\[crish[^\]]*\]\s*.*)$/gim;

const CLIXML_REGEX = /#<\s*CLIXML[\s\S]*$/gim;

// Fast-path keywords for 0ms short-circuit check
const FAST_PATH_KEYWORDS = [
  'checkpoint', 'exit code', 'wall time', 'duration', 'elapsed',
  'signal', 'timed out', 'working directory', 'cwd', 'shell',
  'stdout', 'stderr', 'clixml', 'system', 'runtime', 'engine', 'daemon', '系统提示'
];

export function sanitizeToolDisplayOutput(raw: string): string {
  if (!raw) return '';

  const lower = raw.toLowerCase();
  // Fast-Path Short-Circuit: If no keywords match, return raw text immediately
  const hasMetadata = FAST_PATH_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasMetadata) {
    return raw;
  }

  // Single-pass replacement instead of 25 consecutive string allocations
  let cleaned = raw.replace(SYSTEM_FEEDBACK_REGEX, '');
  if (cleaned.includes('CLIXML')) {
    cleaned = cleaned.replace(CLIXML_REGEX, '');
  }

  return cleaned.trim();
}
```

---

## 3. SLA Verification & Testing

1. **Storage I/O Verification**:
   - DevTools Performance Profile: Zero `localStorage` disk writes on streaming AI tokens.
   - Long Tasks (>50ms) from disk persistence drop to **0**.
2. **GC Memory Spikes**:
   - V8 Minor/Major GC time percentage decreases from **14.79% to < 2.0%**.
3. **Regex Sanitize Speed**:
   - `sanitizeToolDisplayOutput()` execution time on 5,000-line log drops from **18ms to < 0.2ms** (90x speedup via Fast-Path).
