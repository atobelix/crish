/**
 * deepEqual / shallowEqual
 *
 * 字段级深度相等比较，替代 `JSON.stringify(a) === JSON.stringify(b)` 反模式。
 *
 * 动机：JSON.stringify 比较是 O(n) 字符串化 + O(n) 字符串比较，且对 key 顺序敏感
 * （同内容不同 key 顺序会判定为不等）。字段级递归比较更高效、更正确。
 *
 * 仅适用于 JSON 可序列化结构（不处理 Map/Set/Date/RegExp 等，那些应单独比较）。
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  // 原始类型与引用相等
  if (a === b) return true;
  // null/undefined 处理（=== 已覆盖，但防御 NaN）
  if (a == null || b == null) return a === b;

  const typeA = typeof a;
  const typeB = typeof b;
  if (typeA !== typeB) return false;
  if (typeA !== "object") return false; // 原始类型已被 === 覆盖

  const arrA = Array.isArray(a);
  const arrB = Array.isArray(b);
  if (arrA !== arrB) return false;

  if (arrA) {
    if (!arrB) return false;
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (!deepEqual(aa[i], bb[i])) return false;
    }
    return true;
  }

  // 对象比较：按 key 集合 + 值递归
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key)) return false;
    if (!deepEqual(objA[key], objB[key])) return false;
  }
  return true;
}

/**
 * shallowEqual
 *
 * 仅比较对象一层字段是否相等。用于 React props 比较或 store record 比较
 * （当 record 字段都是原始值或引用不可变时）。
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return false;

  const arrA = Array.isArray(a);
  const arrB = Array.isArray(b);
  if (arrA !== arrB) return false;
  if (arrA) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (aa[i] !== bb[i]) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (objA[key] !== objB[key]) return false;
  }
  return true;
}
