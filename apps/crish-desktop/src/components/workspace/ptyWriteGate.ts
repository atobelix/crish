/**
 * 隐藏终端 write=0 门闩（D8.1 / FE-INV-7）。
 *
 * 纯逻辑：隐藏期 chunk 只进 pending 缓冲（history 由 ptySessionApi 独立记录），
 * 显现时合并为单次 write 重放。活跃判定与 TreeLeafPanel 的
 * `data-active-panel` / `display:none` 同源。
 */

export interface TerminalWriteTarget {
  write(data: string): void;
}

export const MAX_PENDING_BYTES = 512 * 1024; // 512KB
export const CHUNK_FLUSH_BYTES = 32 * 1024; // 32KB
export const FRAME_BUDGET_MS = 8; // 8ms
export const OVERFLOW_WARNING =
  '\r\n\x1b[33m[Conex Stream Gate: High output rate capped at 512KB]\x1b[0m\r\n';

export type PtyWriteGate = {
  /** 切换隐藏态；由隐藏→显现时分片排空 pending */
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  /** 输出写入：进入有界缓冲并分片调度排空 */
  write(data: string): void;
  /** 待 flush 的 chunk 数（探针/单测用） */
  pendingCount(): number;
  /** 待 flush 合并后的字符长度（探针用） */
  pendingLength(): number;
  /** 清空 pending（dispose / 测试 reset） */
  reset(): void;
  /** 执行单帧排空（上限 32KB / 8ms 预算，单测与调度器通用） */
  flushFrame(): { bytesWritten: number; remaining: number };
  /** 同步排空全部队列（单测/紧急排空） */
  flushAllPending(): void;
  /** 探针：是否已触发溢出截断并注入 ANSI 警示 */
  hasOverflowWarning(): boolean;
};

const scheduleRaf = (cb: () => void): number => {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestAnimationFrame === 'function'
  ) {
    return window.requestAnimationFrame(cb);
  }
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb);
  }
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

/**
 * 创建针对 PTY 写入的高频流控门闩（ptyWriteGate / ring buffer gate）：
 * - 512KB 有界上限（截断最旧数据 + ANSI 警示注入）
 * - 分片排空（单帧上限 32KB / 8ms 预算）
 * - try/catch 异常捕获与自愈
 * - 隐藏 tab write=0 门闩
 */
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

  function enqueue(data: string): void {
    if (!data) return;

    // 单块数据直接超过上限：直接裁切保留最新部分并注入警告
    if (data.length >= MAX_PENDING_BYTES) {
      cancelScheduledFlush();
      const keep = MAX_PENDING_BYTES - OVERFLOW_WARNING.length;
      pending = [OVERFLOW_WARNING, data.slice(-keep)];
      pendingBytes = MAX_PENDING_BYTES;
      warningInjected = true;
      return;
    }

    // 未超限正常入队
    if (pendingBytes + data.length <= MAX_PENDING_BYTES) {
      pending.push(data);
      pendingBytes += data.length;
      return;
    }

    // 超限截断最旧数据并注入 ANSI 警示
    if (!warningInjected) {
      const targetMax = MAX_PENDING_BYTES - OVERFLOW_WARNING.length;
      let bytesToDrop = pendingBytes + data.length - targetMax;

      while (bytesToDrop > 0 && pending.length > 0) {
        const head = pending[0];
        if (!head) {
          pending.shift();
          continue;
        }
        if (head.length <= bytesToDrop) {
          pending.shift();
          pendingBytes -= head.length;
          bytesToDrop -= head.length;
        } else {
          pending[0] = head.slice(bytesToDrop);
          pendingBytes -= bytesToDrop;
          bytesToDrop = 0;
        }
      }

      pending.unshift(OVERFLOW_WARNING);
      pendingBytes += OVERFLOW_WARNING.length;
      warningInjected = true;
      pending.push(data);
      pendingBytes += data.length;

      // 若追加后仍有微量超限，从紧随 warning 后的头部裁切
      if (pendingBytes > MAX_PENDING_BYTES && pending.length > 1) {
        const excess = pendingBytes - MAX_PENDING_BYTES;
        const next = pending[1];
        if (next && next.length <= excess) {
          pending.splice(1, 1);
          pendingBytes -= next.length;
        } else if (next) {
          pending[1] = next.slice(excess);
          pendingBytes -= excess;
        }
      }
    } else {
      // warning 已存在于头部：从紧随 warning 后的位置丢弃最旧数据
      let bytesToDrop = pendingBytes + data.length - MAX_PENDING_BYTES;

      while (bytesToDrop > 0 && pending.length > 1) {
        const next = pending[1];
        if (!next) {
          pending.splice(1, 1);
          continue;
        }
        if (next.length <= bytesToDrop) {
          pending.splice(1, 1);
          pendingBytes -= next.length;
          bytesToDrop -= next.length;
        } else {
          pending[1] = next.slice(bytesToDrop);
          pendingBytes -= bytesToDrop;
          bytesToDrop = 0;
        }
      }

      if (bytesToDrop > 0) {
        const keep = MAX_PENDING_BYTES - OVERFLOW_WARNING.length;
        data = data.slice(-keep);
      }
      pending.push(data);
      pendingBytes += data.length;
    }
  }

  function flushFrame(): { bytesWritten: number; remaining: number } {
    if (hidden) {
      return { bytesWritten: 0, remaining: pendingBytes };
    }

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

      const chunk = pending[0];
      if (!chunk) {
        pending.shift();
        continue;
      }
      const remainingBudget = CHUNK_FLUSH_BYTES - bytesWritten;

      if (chunk.length <= remainingBudget) {
        pending.shift();
        pendingBytes -= chunk.length;
        bytesWritten += chunk.length;
        if (chunk === OVERFLOW_WARNING) {
          warningInjected = false;
        }
        try {
          sink.write(chunk);
        } catch {
          // 异常自愈：当 xterm 抛出异常（如终端正在重置或 dispose）时，清空待写入队列并安全恢复
          reset();
          return { bytesWritten, remaining: 0 };
        }
      } else {
        let sliceLen = remainingBudget;
        if (sliceLen > 0 && sliceLen < chunk.length) {
          const code = chunk.charCodeAt(sliceLen - 1);
          if (code >= 0xd800 && code <= 0xdbff) {
            sliceLen -= 1;
          }
        }
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

    return { bytesWritten, remaining: pendingBytes };
  }

  function scheduleFlush(): void {
    if (hidden || rafId !== null || pending.length === 0) return;
    rafId = scheduleRaf(() => {
      rafId = null;
      if (hidden) return;
      const { remaining } = flushFrame();
      if (remaining > 0 && !hidden) {
        scheduleFlush();
      }
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
      if (!hidden) {
        scheduleFlush();
      }
    },
    pendingCount: () => pending.length,
    pendingLength: () => pendingBytes,
    reset,
    flushFrame,
    flushAllPending(): void {
      if (hidden) return;
      cancelScheduledFlush();
      while (pending.length > 0 && !hidden) {
        const { remaining } = flushFrame();
        if (remaining === 0) break;
      }
    },
    hasOverflowWarning: () =>
      warningInjected || pending.includes(OVERFLOW_WARNING),
  };
}

/**
 * 宿主可见性判定（与 TreeLeafPanel 激活 tab 同源）。
 * 优先 `data-active-panel`；否则回落 offsetParent / computed display。
 */
export function isTerminalHostHidden(
  el: HTMLElement | null | undefined
): boolean {
  if (!el || typeof el.closest !== 'function') return true;
  const panel = el.closest('[data-active-panel]');
  if (panel) {
    return panel.getAttribute('data-active-panel') !== 'true';
  }
  try {
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * 观察宿主可见性变化（attribute 子树 + data-active-panel / style）。
 * 返回 disconnect。
 */
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

  // 初始对齐一次（挂载时已隐藏）
  if (last) onChange(true);

  return () => mo.disconnect();
}

/** 探针：隐藏期 term.write 调用计数（单测 / 运行时可选） */
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
