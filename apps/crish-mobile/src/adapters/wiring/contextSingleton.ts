// 接线层上下文单例工厂（R4 批次6 自 filesWiring/quickRunWiring/runControlWiring/
// settingsWiring 四处复制粘贴提炼）：懒装配 + 幂等读取 + 测试隔离复位。
//
// 语义（与既有各 wiring 手写单例一致）：
// - get()：首调用以 factory 装配，此后返回同一实例（观测接线未就绪时 factory 可返回
//   null——本工厂缓存 null 结果，与手写版「未装配 → 每次重试装配」一致由调用方约束：
//   factory 仅在手写版 get 内调用且 null 不缓存；本工厂对齐该语义：null 不缓存）；
// - reset()：清空缓存（仅测试调用），下次 get 重新装配。
export interface ContextSingleton<T> {
  /** 幂等读取：未装配时执行 factory（可返回 null = 暂不可装配），装配成功后缓存 */
  get(): T | null;
  /** 测试隔离：清空缓存（下次 get 重新装配） */
  reset(): void;
}

export function createContextSingleton<T>(
  factory: () => T | null
): ContextSingleton<T> {
  let instance: T | null = null;
  return {
    get() {
      if (instance !== null) return instance;
      instance = factory();
      return instance;
    },
    reset() {
      instance = null;
    },
  };
}
