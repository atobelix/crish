/* eslint-disable no-control-regex */
/**
 * 终端 512KB 有界流控门闩与 ANSI 边界截断自愈中枢（Stage 07 SotaPtyWriteGate）：
 * - 512KB 有界环形缓冲（MAX_PENDING_BYTES），超限淘汰最旧数据并原子前置注入 \x1b[0m 重置与高亮告警
 * - findSafeSliceIndex 边界感知算法：识别未闭合 CSI/OSC 序列、裸 \x1b、UTF-16 代理对，内置 Zero-Progress Watchdog
 * - 32KB / 8ms rAF 预算平滑分片排空 + 隐藏窗格 write=0 物理门闩 + try/catch 异常零死锁自愈
 */

export interface TerminalWriteTarget {
  write(data: string): void;
}

export const MAX_PENDING_BYTES = 512 * 1024; // 512KB
export const CHUNK_FLUSH_BYTES = 32 * 1024; // 32KB
export const FRAME_BUDGET_MS = 8; // 8ms
export const ANSI_RESET = '\x1b[0m';
export const OVERFLOW_WARNING =
  '\x1b[0m\r\n\x1b[33;1m[Conex Stream Gate: High output rate capped at 512KB - Older output truncated]\x1b[0m\r\n';

export type PtyWriteGateState = 'PassThrough' | 'Buffering' | 'Draining';

export type PtyWriteGate = {
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  write(data: string): void;
  pendingCount(): number;
  pendingLength(): number;
  reset(): void;
  flushFrame(): { bytesWritten: number; remaining: number };
  flushAllPending(): void;
  hasOverflowWarning(): boolean;
  getState(): PtyWriteGateState;
};

/**
 * 尾部切片安全边界探测算法：
 * 1. UTF-16 高位代理对保护（0xD800..0xDBFF 回退 1 位）
 * 2. ANSI CSI (\x1b[...[a-zA-Z]) / OSC (\x1b]...(\x07|\x1b\\)) / 裸 \x1b 回看 48 字节保护
 * 3. Zero-Progress Watchdog（零步长死锁防护）：回退至 0 且 maxLen > 0 时前向寻踪闭合点或放行 maxLen
 */
export function findSafeSliceIndex(str: string, maxLen: number): number {
  if (maxLen >= str.length) return str.length;
  if (maxLen <= 0) return 0;
  let len = Math.max(0, Math.floor(maxLen));

  const code = str.charCodeAt(len - 1);
  if (code >= 0xd800 && code <= 0xdbff) len -= 1;

  const lookbackStart = Math.max(0, len - 48);
  const lastEscInLookback = str.slice(lookbackStart, len).lastIndexOf('\x1b');

  if (lastEscInLookback !== -1) {
    const escIndex = lookbackStart + lastEscInLookback;
    const sliceAfterEsc = str.slice(escIndex, len);
    if (sliceAfterEsc === '\x1b') {
      len = escIndex;
    } else if (sliceAfterEsc.startsWith('\x1b[')) {
      if (!/[a-zA-Z@`~]/.test(sliceAfterEsc.slice(2))) len = escIndex;
    } else if (sliceAfterEsc.startsWith('\x1b]')) {
      if (!/\x07|\x1b\\/.test(sliceAfterEsc.slice(2))) len = escIndex;
    }
  }

  // Zero-Progress Watchdog（零步长死锁防护）
  if (len === 0 && maxLen > 0) {
    const forwardWindow = str.slice(0, Math.min(str.length, 64));
    if (forwardWindow.startsWith('\x1b[')) {
      const csiEnd = forwardWindow.slice(2).search(/[a-zA-Z@`~]/);
      len = csiEnd !== -1 ? 2 + csiEnd + 1 : maxLen;
    } else if (forwardWindow.startsWith('\x1b]')) {
      const oscMatch = /\x07|\x1b\\/.exec(forwardWindow.slice(2));
      len = oscMatch ? 2 + oscMatch.index + oscMatch[0].length : maxLen;
    } else {
      len = maxLen;
    }
    if (len > 0 && len < str.length) {
      const c = str.charCodeAt(len - 1);
      if (c >= 0xd800 && c <= 0xdbff) {
        len = len > 1 ? len - 1 : Math.min(str.length, 2);
      }
    }
  }

  return len;
}

/**
 * 头部截断自愈算法：丢弃旧数据头部字节时，跳过孤立低位代理项与被腰斩的 CSI/OSC 残片
 */
export function healHeadSliceIndex(str: string, rawStartIndex: number): number {
  if (rawStartIndex <= 0) return 0;
  if (rawStartIndex >= str.length) return str.length;
  let idx = Math.floor(rawStartIndex);

  const code = str.charCodeAt(idx);
  if (code >= 0xdc00 && code <= 0xdfff) idx += 1;

  const lookbackStart = Math.max(0, idx - 48);
  const lastEsc = str.slice(lookbackStart, idx).lastIndexOf('\x1b');
  if (lastEsc !== -1) {
    const escPos = lookbackStart + lastEsc;
    const windowStr = str.slice(escPos, Math.min(str.length, idx + 48));
    if (windowStr.startsWith('\x1b[')) {
      const csiEnd = windowStr.slice(2).search(/[a-zA-Z@`~]/);
      if (csiEnd !== -1 && escPos + 3 + csiEnd > idx) idx = escPos + 3 + csiEnd;
    } else if (windowStr.startsWith('\x1b]')) {
      const oscMatch = /\x07|\x1b\\/.exec(windowStr.slice(2));
      if (oscMatch && escPos + 2 + oscMatch.index + oscMatch[0].length > idx) {
        idx = escPos + 2 + oscMatch.index + oscMatch[0].length;
      }
    }
  }

  return Math.min(str.length, idx);
}

function findCompleteTailEnd(str: string): number {
  const len = str.length;
  if (len === 0) return 0;
  let safeEnd = len;
  const code = str.charCodeAt(safeEnd - 1);
  if (code >= 0xd800 && code <= 0xdbff) safeEnd -= 1;

  const lookbackStart = Math.max(0, safeEnd - 48);
  const lastEsc = str.slice(lookbackStart, safeEnd).lastIndexOf('\x1b');
  if (lastEsc !== -1) {
    const escIndex = lookbackStart + lastEsc;
    const tail = str.slice(escIndex, safeEnd);
    if (
      tail === '\x1b' ||
      (tail.startsWith('\x1b[') && !/[a-zA-Z@`~]/.test(tail.slice(2))) ||
      (tail.startsWith('\x1b]') && !/\x07|\x1b\\/.test(tail.slice(2)))
    ) {
      safeEnd = escIndex;
    }
  }
  return safeEnd;
}

const scheduleRaf = (cb: () => void): number => {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
  ) {
    return window.requestAnimationFrame(cb);
  }
  if (typeof requestAnimationFrame === 'function')
    return requestAnimationFrame(cb);
  return setTimeout(cb, 16) as unknown as number;
};

const cancelRaf = (id: number): void => {
  if (
    typeof window !== 'undefined' &&
    typeof window.cancelAnimationFrame === 'function'
  ) {
    window.cancelAnimationFrame(id);
    return;
  }
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(id);
    return;
  }
  clearTimeout(id);
};

export function createPtyWriteGate(
  sink: TerminalWriteTarget,
  startHidden = false
): PtyWriteGate {
  let hidden = startHidden;
  let pending: string[] = [];
  let pendingBytes = 0;
  let warningInjected = false;
  let rafId: number | null = null;

  function cancelScheduledFlush() {
    if (rafId !== null) {
      cancelRaf(rafId);
      rafId = null;
    }
  }

  function dropOldestBytes(targetDrop: number, startIdx: number): void {
    let bytesToDrop = targetDrop;
    while (bytesToDrop > 0 && pending.length > startIdx) {
      const chunk = pending[startIdx];
      if (!chunk) {
        pending.splice(startIdx, 1);
        continue;
      }
      if (chunk.length <= bytesToDrop) {
        pending.splice(startIdx, 1);
        pendingBytes -= chunk.length;
        bytesToDrop -= chunk.length;
      } else {
        const safeCut = healHeadSliceIndex(chunk, bytesToDrop);
        const sliced = chunk.slice(safeCut);
        pendingBytes -= chunk.length - sliced.length;
        if (sliced.length === 0) pending.splice(startIdx, 1);
        else pending[startIdx] = sliced;
        bytesToDrop = 0;
      }
    }
  }

  function enqueue(data: string): void {
    if (!data) return;

    if (data.length >= MAX_PENDING_BYTES) {
      cancelScheduledFlush();
      const keep = MAX_PENDING_BYTES - OVERFLOW_WARNING.length;
      const safeStart = healHeadSliceIndex(
        data,
        Math.max(0, data.length - keep)
      );
      const tail = data.slice(safeStart);
      pending = [OVERFLOW_WARNING, tail];
      pendingBytes = OVERFLOW_WARNING.length + tail.length;
      warningInjected = true;
      return;
    }

    if (pendingBytes + data.length <= MAX_PENDING_BYTES) {
      pending.push(data);
      pendingBytes += data.length;
      return;
    }

    if (!warningInjected) {
      const targetMax = MAX_PENDING_BYTES - OVERFLOW_WARNING.length;
      dropOldestBytes(pendingBytes + data.length - targetMax, 0);
      pending.unshift(OVERFLOW_WARNING);
      pendingBytes += OVERFLOW_WARNING.length;
      warningInjected = true;
      pending.push(data);
      pendingBytes += data.length;
      if (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) {
        dropOldestBytes(pendingBytes - MAX_PENDING_BYTES, 1);
      }
    } else {
      dropOldestBytes(pendingBytes + data.length - MAX_PENDING_BYTES, 1);
      if (pendingBytes + data.length > MAX_PENDING_BYTES) {
        const keep = Math.max(0, MAX_PENDING_BYTES - pendingBytes);
        const safeStart = healHeadSliceIndex(
          data,
          Math.max(0, data.length - keep)
        );
        data = data.slice(safeStart);
      }
      pending.push(data);
      pendingBytes += data.length;
    }
  }

  function flushFrame(): { bytesWritten: number; remaining: number } {
    if (hidden) return { bytesWritten: 0, remaining: pendingBytes };

    const now = () =>
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
        ? performance.now()
        : Date.now();

    const startTime = now();
    let bytesWritten = 0;

    while (pending.length > 0) {
      const elapsed = now() - startTime;
      if (
        bytesWritten >= CHUNK_FLUSH_BYTES ||
        (elapsed >= FRAME_BUDGET_MS && bytesWritten > 0)
      ) {
        break;
      }

      let chunk = pending[0];
      if (!chunk) {
        pending.shift();
        continue;
      }

      if (chunk !== OVERFLOW_WARNING && pending.length > 1) {
        const safeTail = findCompleteTailEnd(chunk);
        if (safeTail < chunk.length) {
          pending[1] = chunk.slice(safeTail) + (pending[1] ?? '');
          if (safeTail === 0) {
            pending.shift();
            continue;
          }
          chunk = chunk.slice(0, safeTail);
          pending[0] = chunk;
        }
      }

      const remainingBudget = CHUNK_FLUSH_BYTES - bytesWritten;
      if (chunk.length <= remainingBudget) {
        pending.shift();
        pendingBytes -= chunk.length;
        bytesWritten += chunk.length;
        if (chunk === OVERFLOW_WARNING) warningInjected = false;
        try {
          sink.write(chunk);
        } catch {
          reset();
          return { bytesWritten, remaining: 0 };
        }
      } else {
        const sliceLen = findSafeSliceIndex(chunk, remainingBudget);
        const toWrite = chunk.slice(0, sliceLen);
        pending[0] = chunk.slice(sliceLen);
        pendingBytes -= toWrite.length;
        bytesWritten += toWrite.length;
        try {
          sink.write(toWrite);
        } catch {
          reset();
          return { bytesWritten, remaining: 0 };
        }
        break;
      }
    }

    if (pending.length === 0) {
      pendingBytes = 0;
      cancelScheduledFlush();
    }
    return { bytesWritten, remaining: pendingBytes };
  }

  function scheduleFlush(): void {
    if (hidden || rafId !== null || pending.length === 0) return;
    rafId = scheduleRaf(() => {
      rafId = null;
      if (hidden) return;
      const { remaining } = flushFrame();
      if (remaining > 0 && !hidden) scheduleFlush();
    });
  }

  function reset(): void {
    cancelScheduledFlush();
    pending = [];
    pendingBytes = 0;
    warningInjected = false;
  }

  return {
    setHidden(next: boolean): void {
      if (hidden && !next) {
        hidden = false;
        scheduleFlush();
      } else if (!hidden && next) {
        hidden = true;
        cancelScheduledFlush();
      }
    },
    isHidden: () => hidden,
    write(data: string): void {
      if (!data) return;
      enqueue(data);
      if (!hidden) scheduleFlush();
    },
    pendingCount: () => pending.length,
    pendingLength: () => pendingBytes,
    reset,
    flushFrame,
    flushAllPending(): void {
      if (hidden) return;
      cancelScheduledFlush();
      while (pending.length > 0 && !hidden) {
        if (flushFrame().remaining === 0) break;
      }
    },
    hasOverflowWarning: () =>
      warningInjected || pending.includes(OVERFLOW_WARNING),
    getState(): PtyWriteGateState {
      if (hidden) return 'Buffering';
      if (pending.length > 0 || rafId !== null) return 'Draining';
      return 'PassThrough';
    },
  };
}

export const createSotaPtyWriteGate = createPtyWriteGate;

export function isTerminalHostHidden(
  el: HTMLElement | null | undefined
): boolean {
  if (!el || typeof el.closest !== 'function') return true;
  const panel = el.closest('[data-active-panel]');
  if (panel) return panel.getAttribute('data-active-panel') !== 'true';
  try {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function observeTerminalHostVisibility(
  el: HTMLElement,
  onChange: (hidden: boolean) => void
): () => void {
  let last = isTerminalHostHidden(el);
  const check = () => {
    const next = isTerminalHostHidden(el);
    if (next !== last) {
      last = next;
      onChange(next);
    }
  };
  const root =
    el.closest('[data-panel-id]')?.parentElement ??
    el.parentElement ??
    document.body;
  const mo = new MutationObserver(check);
  mo.observe(root, {
    attributes: true,
    attributeFilter: ['style', 'data-active-panel', 'aria-hidden', 'class'],
    subtree: true,
  });
  if (last) onChange(true);
  return () => mo.disconnect();
}

export type HiddenWriteProbe = {
  writesWhileHidden: number;
  onWrite: (hidden: boolean) => void;
};

export function createHiddenWriteProbe(): HiddenWriteProbe {
  const probe: HiddenWriteProbe = {
    writesWhileHidden: 0,
    onWrite(hidden: boolean) {
      if (hidden) probe.writesWhileHidden += 1;
    },
  };
  return probe;
}
