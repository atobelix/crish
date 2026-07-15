/**
 * 通用 debounce：合并高频调用（搜索输入等）。
 */

export type DebouncedController<T> = {
  /** 调度一次调用（覆盖 pending 参数） */
  schedule: (value: T) => void;
  /** 立即执行 pending（若有） */
  flush: () => void;
  /** 取消 pending，不执行 */
  cancel: () => void;
};

export function createDebounced<T>(
  fn: (value: T) => void,
  waitMs: number,
  opts?: {
    setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  },
): DebouncedController<T> {
  const setTimer = opts?.setTimer ?? ((f, ms) => setTimeout(f, ms));
  const clearTimer =
    opts?.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { has: boolean; value: T } = { has: false, value: undefined as T };

  const flush = () => {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
    if (!pending.has) return;
    const v = pending.value;
    pending = { has: false, value: undefined as T };
    fn(v);
  };

  return {
    schedule(value: T) {
      pending = { has: true, value };
      if (timer != null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        flush();
      }, waitMs);
    },
    flush,
    cancel() {
      if (timer != null) {
        clearTimer(timer);
        timer = null;
      }
      pending = { has: false, value: undefined as T };
    },
  };
}
