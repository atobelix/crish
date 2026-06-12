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
