/**
 * 对象工具函数
 */

import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord } from "./guards";

/**
 * 深拷贝对象（使用 structuredClone）。
 *
 * 当值包含不可序列化属性（如函数、Symbol）时，structuredClone 会抛出 DataCloneError。
 * 此时自动降级为 JSON roundtrip（JSON.parse(JSON.stringify(value)），
 * 静默剥离不可序列化属性，确保不中断业务流程。
 */
export function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // DataCloneError fallback — strip non-serializable properties via JSON roundtrip
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/**
 * 递归冻结对象：返回同一个引用，但其自身及所有嵌套对象/数组都被 Object.freeze。
 *
 * 用于不可变 store 模式：写方法在 `this.state = nextState` 前调用 deepFreeze，
 * 读方法直接返回 frozen 引用（O(1)），调用方无法 mutate（Object.freeze 保证），
 * 消除 N×(全 state clone) 的防御性深拷贝开销。
 *
 * - 原始类型与 null 直接返回
 * - 已 frozen 的对象直接返回（幂等，避免重复遍历）
 * - 数组先冻结每个元素再冻结数组本身
 * - 普通对象先冻结每个属性值再冻结对象本身
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
}

/**
 * 递归剥离对象中的非 JSON 安全属性（函数、Symbol、undefined 等），
 * 返回一个纯数据对象，可安全通过 structuredClone / postMessage / WebSocket 传输。
 *
 * 典型用途：将包含方法引用的 AgentTool 对象转换为可序列化的描述符。
 */
export function stripNonSerializable<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : (undefined as unknown as T);
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return undefined as unknown as T;
  }
  if (Array.isArray(value)) {
    return value
      .map(stripNonSerializable)
      .filter((v) => v !== undefined) as unknown as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripNonSerializable(val);
      if (cleaned !== undefined) {
        result[key] = cleaned;
      }
    }
    return result as T;
  }
  return value;
}

/**
 * 将 unknown 值安全断言为 JsonObject。
 * 运行时检查确保输入是非 null 非数组的对象，避免错误的类型推断传播。
 * 用于统一管理 JSON 序列化边界的 `as unknown as JsonObject` 类型断言。
 */
export function toJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    throw new TypeError("Expected a non-null, non-array object for JsonObject conversion");
  }
  return value as JsonObject;
}

/**
 * 将 unknown 值安全断言为 JsonValue。
 * 运行时递归校验值及所有嵌套值为合法的 JSON 类型。
 * 用于统一管理 JSON 序列化边界的 `as unknown as JsonValue` 类型断言。
 */
export function toJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError("Expected a valid JSON value");
  }
  return value;
}

/**
 * 判断值是否为合法的 JsonValue（递归校验，拒绝 NaN/Infinity/undefined/function）
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

/**
 * 判断值是否为合法的 JsonObject（非 null 非数组的对象，且所有值均为合法 JsonValue）
 */
export function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

/**
 * 将 Record<string, unknown> 转换为 JsonObject：
 * - 递归移除 undefined 值
 * - 递归拒绝 NaN / Infinity（非 JSON 安全的数值）
 * - 递归处理嵌套对象和数组
 */
export function compactJsonObject(obj: Record<string, unknown>): JsonObject {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    if (isRecord(value)) {
      result[key] = compactJsonObject(value);
    } else if (Array.isArray(value)) {
      const filtered = value
        .filter((v) => v !== undefined && !(typeof v === "number" && !Number.isFinite(v)))
        .map((v) => {
          if (isRecord(v)) return compactJsonObject(v);
          if (Array.isArray(v)) {
            return v.filter(
              (item) => item !== undefined && !(typeof item === "number" && !Number.isFinite(item))
            ) as JsonValue[];
          }
          return v as JsonValue;
        });
      result[key] = filtered as JsonValue[];
    } else {
      result[key] = value as JsonValue;
    }
  }
  return result;
}
