/**
 * 扩展市场纯函数与工具（从 useExtensionMarket 提取）。
 * 无 React / 状态依赖，可单测。
 */

/** 统一错误文案：优先取 Error.message，否则 String(e)。 */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 给 Promise 套一个超时回退：超时返回 fallback，不抛错（调用方自行处理空值）。
 * 用于刷新扩展市场时对 skills/mcp/settings 三路并发做 4s 软超时，
 * 避免任一路卡死拖住整个面板。
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    const t = window.setTimeout(() => {
      if (done) return;
      done = true;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        if (done) return;
        done = true;
        window.clearTimeout(t);
        resolve(v);
      },
      () => {
        if (done) return;
        done = true;
        window.clearTimeout(t);
        resolve(fallback);
      }
    );
  });
}
