/**
 * 组合多个 AbortSignal：任一源 abort 即 abort 组合信号，并保留**首个**
 * abort 的 reason。
 *
 * 不使用 `AbortSignal.any` 原生短路：部分 Node 版本在同步连续 abort 时
 * 会按 signals 数组顺序而非实际 abort 顺序选 reason（A5 跨环境漂移）。
 * 显式监听保证「先 abort 者胜出」语义确定，并在组合信号 abort 时移除
 * 其余监听器，避免长生命周期源信号上的监听器泄漏。
 */
export function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0]!;

  const controller = new AbortController();
  const unsubscribers: Array<() => void> = [];
  const cleanup = () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    unsubscribers.length = 0;
  };

  for (const signal of new Set(signals)) {
    if (signal.aborted) {
      cleanup();
      controller.abort(signal.reason);
      return controller.signal;
    }
    const onAbort = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    unsubscribers.push(() => signal.removeEventListener('abort', onAbort));
  }

  return controller.signal;
}
