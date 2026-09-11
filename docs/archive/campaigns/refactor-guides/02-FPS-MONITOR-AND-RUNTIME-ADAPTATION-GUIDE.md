# 维度二指导方案：FpsMonitor 采样、分值修正与运行时自适应降级防护指南 (02-FPS-MONITOR-AND-RUNTIME-ADAPTATION-GUIDE)

> **Document ID**: CX-GUIDE-002
> **Version**: v1.0 Final
> **Target Files**: `packages/shared-utils/src/dynamic-adaptation.ts` / `apps/crish-desktop/src/hooks/useFpsMonitor.ts` / `apps/crish-desktop/src/api/performanceEngine.ts` / `apps/crish-desktop/src/components/ChatToolCallBlock.tsx`
> **Core Objective**: Eliminate self-inflicted CPU overhead in `FpsMonitor`; fix `computeScore()` memory math bug causing permanent tier downgrade locks; replace high-overhead IndexedDB latency measurements; resolve boot-time Eco tier false positives; and synchronize performance tiers across the entire system.

---

## 1. Problem Audit & Severity Analysis

In the deep audit by Agent 2, the runtime performance engine and monitoring hooks were found to suffer from **9 critical issues and self-induced bottlenecks**:

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                   Runtime Performance Engine & FpsMonitor Defect Audit                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. `FpsMonitor` rAF Loop: Continuous `requestAnimationFrame` loop with $O(N)$           │
│    `push/shift` array ops on every single frame, draining CPU & triggering GC.          │
│ 2. Per-frame sampling: `onFpsSample` runs every frame, forcing `SlidingWindow` average │
│    math and `computeScore()` hardware evaluation every 16ms.                           │
│ 3. `computeScore()` Bug: Compares `jsHeapSizeLimit` (V8 cap ~2-4GB) against 8GB limit, │
│    guaranteeing a score deduction and PERMANENT tier downgrade with no upgrade path.  │
│ 4. IndexedDB Abuse: `measureWriteLatency()` creates and deletes a new IDB database     │
│    every 30 seconds, causing heavy SQLite/LevelDB disk lock contention & handle leaks.│
│ 5. Console Warn Pollution: `useFpsMonitor.ts` prints `console.warn` every second when  │
│    FPS < 30, flooding IPC serialization channels and worsening UI freezes.             │
│ 6. Engine Lifecycle Bug: `stop()` sets `stopped = true` without resetting timer refs,  │
│    preventing `start()` from ever restarting the adaptation engine.                    │
│ 7. Boot-time Misclassification: `performanceEngine.ts` samples FPS for only 150ms     │
│    during JS module boot, misclassifying high-end machines as `eco` mode.              │
│ 8. State Desynchronization: `data-perf-tier` (`high/eco`) in HTML is decoupled from    │
│    `PerformanceLevel` (Level 0-3) in `dynamic-adaptation.ts`.                         │
│ 9. Tool Block Interval: `ChatToolCallBlock.tsx` runs `setInterval(..., 100)` for       │
│    running tools, forcing 10 FPS component re-renders during active agent execution.   │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Comprehensive Architectural Solutions & Refactoring Rules

### 2.1 Low-Overhead `FpsMonitor` Refactoring (Interval-Based Accumulation)

#### Key Architectural Rule
Remove `requestAnimationFrame` recursion and per-frame array manipulation (`shift/push`). Transition to a **lightweight counter + low-frequency `setInterval` (1000ms)** evaluation model.

#### Refactored Code (`packages/shared-utils/src/dynamic-adaptation.ts`)
```typescript
// Refactored FpsMonitor: Zero array allocations, 0ms CPU overhead per frame
export class FpsMonitor {
  private frameCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTime = 0;
  private targetFps: number;
  private onSample: (fps: number, dropRate: number) => void;
  private rafId: number | null = null;

  constructor(targetFps: number, onSample: (fps: number, dropRate: number) => void) {
    this.targetFps = targetFps;
    this.onSample = onSample;
  }

  public setTargetFps(fps: number): void {
    this.targetFps = fps;
  }

  public start(): void {
    if (this.timer !== null) return;

    this.lastTime = performance.now();
    this.frameCount = 0;

    // Per-frame tick: ONLY increment a primitive counter, ZERO allocations
    const tick = () => {
      this.frameCount++;
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);

    // Evaluate stats once every 1000ms instead of every 16ms
    this.timer = setInterval(() => {
      const now = performance.now();
      const elapsedSec = (now - this.lastTime) / 1000;
      if (elapsedSec <= 0) return;

      const actualFps = Math.round(this.frameCount / elapsedSec);
      const expectedFrames = elapsedSec * this.targetFps;
      const dropRate = Math.max(0, 1 - (this.frameCount / Math.max(1, expectedFrames)));

      this.onSample(actualFps, dropRate);

      this.frameCount = 0;
      this.lastTime = now;
    }, 1000);
  }

  public stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

---

### 2.2 Fix Memory Score Calculation Bug in `computeScore()`

#### Problem & Root Cause
In `dynamic-adaptation.ts`, `computeScore()` checks:
`if (mem.heapTotal >= 8 * 1024 * 1024 * 1024) score += 40;`
However, V8's `performance.memory.jsHeapSizeLimit` is capped at **2GB or 4GB** by the Chromium engine regardless of system RAM. Checking for 8GB on `heapTotal` **always evaluates to false**, deducting 15-30 points from the system score. When temporary FPS drop triggers `tryDowngrade()`, the engine locks the system in `Level 1` or `Level 0` permanently.

#### Correct Refactored Code (`packages/shared-utils/src/dynamic-adaptation.ts`)
```typescript
private computeScore(): number {
  const profile = this.currentProfile;
  let score = 0;

  // 1. CPU Score based on hardware concurrency cores
  if (profile.cpu.cores >= 8) score += 40;
  else if (profile.cpu.cores >= 4) score += 25;
  else if (profile.cpu.cores >= 2) score += 10;

  // 2. Memory Score: Use actual deviceMemory (Physical RAM in GB) if available,
  // NOT V8 JS heap total limit!
  const deviceMemoryGB = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  if (deviceMemoryGB >= 8) score += 40;
  else if (deviceMemoryGB >= 4) score += 25;
  else if (deviceMemoryGB >= 2) score += 10;

  // 3. GPU Score
  if (profile.gpu.webgpu) score += 20;
  else if (profile.gpu.webgl) score += 10;
  else if (profile.gpu.canvas2d) score += 5;

  const vendor = (profile.gpu.vendor ?? '').toLowerCase();
  if ((vendor.includes('nvidia') || vendor.includes('amd') || vendor.includes('apple')) && profile.gpu.webgpu) {
    score += 10;
  }

  if (profile.storage.type === 'ssd') score += 5;

  return score;
}
```

---

### 2.3 Storage Monitor Optimization: Replace IDB Database Creation

#### Refactored Latency Measurement (`packages/shared-utils/src/dynamic-adaptation.ts`)
Replace creating and deleting IDB databases every 30 seconds with a lightweight `performance.now()` in-memory storage API check or static SSD detection from Tauri Rust hardware profile.

```typescript
private startStorageMonitor(): void {
  // If Tauri/Rust backend already confirmed SSD storage, skip IDB polling completely
  if (this.currentProfile.storage.type === 'ssd') {
    return;
  }
  // Otherwise use low-frequency static latency test without creating/deleting databases
}
```

---

### 2.4 Silence High-Frequency Console Warnings in `useFpsMonitor.ts`

#### Refactored Code (`apps/crish-desktop/src/hooks/useFpsMonitor.ts`)
Remove `console.warn` on low FPS. Store low-FPS metrics in a silent telemetry ref or trigger UI adaptation without writing to DevTools.

```typescript
import { useEffect, useRef } from 'react';

export function useFpsMonitor(enabled = process.env.NODE_ENV === 'development'): void {
  const framesRef = useRef(0);
  const lastTimeRef = useRef(performance.now());

  useEffect(() => {
    if (!enabled) return;

    let rafId: number;
    let timerId: ReturnType<typeof setInterval>;

    const tick = () => {
      framesRef.current++;
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    timerId = setInterval(() => {
      const now = performance.now();
      const elapsed = now - lastTimeRef.current;
      if (elapsed > 0) {
        const fps = Math.round((framesRef.current * 1000) / elapsed);
        // SILENCED: Do NOT call console.warn on every low FPS tick
        // Telemetry logging can be buffered asynchronously if needed
        framesRef.current = 0;
        lastTimeRef.current = now;
      }
    }, 2000); // Check every 2s

    return () => {
      cancelAnimationFrame(rafId);
      clearInterval(timerId);
    };
  }, [enabled]);
}
```

---

### 2.5 Fix Boot-Time FPS Sampling & Tier Synchronization

#### 1. Prolong Boot Sampling Window (`apps/crish-desktop/src/api/performanceEngine.ts`)
Extend the sampling window in `measureMaxFps()` from 150ms to **500ms**, and delay measurement until **after window load / initial React mount** so initial JS parsing doesn't force high-end PCs into `eco` mode.

#### 2. Synchronize `data-perf-tier` with `DynamicAdaptationEngine`
When `DynamicAdaptationEngine` upgrades/downgrades level, sync attribute to HTML document:

```typescript
// In dynamic-adaptation.ts emit event listener:
engine.onEvent((event) => {
  if (typeof document !== 'undefined') {
    const tierMap: Record<PerformanceLevel, string> = {
      [PerformanceLevel.Level3]: 'high',
      [PerformanceLevel.Level2]: 'balanced',
      [PerformanceLevel.Level1]: 'eco',
      [PerformanceLevel.Level0]: 'eco',
    };
    document.documentElement.setAttribute('data-perf-tier', tierMap[event.toLevel]);
  }
});
```

---

### 2.6 Fix High-Frequency Tool Block Re-render Interval

In `apps/crish-desktop/src/components/ChatToolCallBlock.tsx`, replace the 100ms `setInterval` for elapsed time during running tools with a **1000ms (1 second)** update rate or CSS-based timer animation.

```typescript
// ChatToolCallBlock.tsx Line 435
useEffect(() => {
  if (status !== 'running') return;
  // Change update interval from 100ms (10 FPS) to 1000ms (1 FPS)
  const timer = setInterval(() => setLiveNow(Date.now()), 1000);
  return () => clearInterval(timer);
}, [status]);
```

---

## 3. Verification & Acceptance Criteria

1. **CPU Usage in Idle Mode**:
   - `FpsMonitor` CPU footprint must be **< 0.1%** in DevTools Performance Tab.
2. **GC Memory Pauses**:
   - Zero $O(N)$ `shift()` allocations in rAF callbacks; GC pauses **< 2.0%** of runtime.
3. **Console Log Traffic**:
   - Zero `[Perf] Low FPS` warnings logged to DevTools during 4x CPU throttle test.
4. **Tier Consistency**:
   - `document.documentElement.getAttribute('data-perf-tier')` stays in sync with `DynamicAdaptationEngine` tier level.
