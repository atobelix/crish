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

export type PtyWriteGate = {
  /** 切换隐藏态；由隐藏→显现时合并 flush pending */
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  /** 输出写入：隐藏缓冲 / 显示直写 */
  write(data: string): void;
  /** 待 flush 的 chunk 数（探针/单测用） */
  pendingCount(): number;
  /** 待 flush 合并后的字符长度（探针用） */
  pendingLength(): number;
  /** 清空 pending（dispose / 测试 reset） */
  reset(): void;
};

/**
 * 创建 write 门闩。`startHidden` 供挂载时已处于隐藏 tab 的终端初始化。
 */
export function createPtyWriteGate(
  sink: TerminalWriteTarget,
  startHidden = false,
): PtyWriteGate {
  let hidden = startHidden;
  let pending: string[] = [];

  return {
    setHidden(next: boolean): void {
      if (hidden && !next) {
        const merged = pending.join('');
        pending = [];
        if (merged) {
          try {
            sink.write(merged);
          } catch {
            /* swallow-ok: 终端销毁后 flush 失败不抛 */
          }
        }
      }
      hidden = next;
    },
    isHidden: () => hidden,
    write(data: string): void {
      if (!data) return;
      if (hidden) {
        pending.push(data);
        return;
      }
      try {
        sink.write(data);
      } catch {
        /* swallow-ok */
      }
    },
    pendingCount: () => pending.length,
    pendingLength: () => pending.reduce((n, c) => n + c.length, 0),
    reset(): void {
      pending = [];
    },
  };
}

/**
 * 宿主可见性判定（与 TreeLeafPanel 激活 tab 同源）。
 * 优先 `data-active-panel`；否则回落 offsetParent / computed display。
 */
export function isTerminalHostHidden(el: HTMLElement | null | undefined): boolean {
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
  onChange: (hidden: boolean) => void,
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
    el.closest('[data-panel-id]')?.parentElement ?? el.parentElement ?? document.body;
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
