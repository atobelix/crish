/**
 * 偏好跨层通信唯一权威客户端（SSOT N5）
 *
 * 契约规范（对齐 docs/design-token-ssot/00-总方案 §6.3 N5）：
 * - 全仓唯一允许调用 prefs_* (prefs_get / prefs_set / prefs_delete) 的通信客户端；
 * - 强类型约束：所有写入与读取经由 preferencesSchema 严格校验；
 * - 拦截未知 key 与非法载荷，严禁静默容错。
 */

import { getTransport } from '../transport';
import {
  getDefaultPreferences,
  isKnownPreferenceKey,
  normalizePreferenceKey,
  PREFERENCES_SCHEMA,
  validatePreferenceValue,
  type PreferenceKey,
  type PreferencesMap,
} from './preferencesSchema';

/**
 * 序列化偏好值为存储格式字符串
 */
export function serializePreferenceValue<K extends PreferenceKey>(
  key: K,
  value: PreferencesMap[K]
): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * 反序列化原始存储值至目标类型
 */
export function deserializePreferenceValue<K extends PreferenceKey>(
  key: K,
  raw: unknown
): PreferencesMap[K] {
  const schema = PREFERENCES_SCHEMA[key];
  if (raw === null || raw === undefined) {
    return schema.defaultValue;
  }

  try {
    if (schema.type === 'string') {
      const strVal = String(raw);
      if (schema.allowedValues && !schema.allowedValues.includes(strVal as any)) {
        return schema.defaultValue;
      }
      return strVal as PreferencesMap[K];
    }

    if (schema.type === 'number') {
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(num)) {
        if (!schema.validate || schema.validate(num)) {
          return num as PreferencesMap[K];
        }
      }
      return schema.defaultValue;
    }

    if (schema.type === 'boolean') {
      if (typeof raw === 'boolean') {
        return raw as PreferencesMap[K];
      }
      if (raw === 'true' || raw === '1' || raw === 1) {
        return true as PreferencesMap[K];
      }
      if (raw === 'false' || raw === '0' || raw === 0) {
        return false as PreferencesMap[K];
      }
      return schema.defaultValue;
    }

    if (schema.type === 'object') {
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        if (!schema.validate || schema.validate(raw)) {
          return raw as PreferencesMap[K];
        }
      } else if (typeof raw === 'string') {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          if (!schema.validate || schema.validate(parsed)) {
            return parsed as PreferencesMap[K];
          }
        }
      }
      return schema.defaultValue;
    }
  } catch {
    return schema.defaultValue;
  }

  return schema.defaultValue;
}

/**
 * 获取单项偏好配置（未知 key 抛错）
 */
export async function getPreference<K extends PreferenceKey>(
  key: K
): Promise<PreferencesMap[K]> {
  if (!isKnownPreferenceKey(key as string)) {
    throw new Error(`Unknown preference key: "${String(key)}"`);
  }

  const canonicalKey = normalizePreferenceKey(key as string) as K;
  const transport = getTransport();

  const response = await transport.request<unknown>('prefs_get', {
    key: canonicalKey,
  });

  let rawValue: unknown = response;
  if (response && typeof response === 'object') {
    if ('value' in response) {
      rawValue = (response as { value: unknown }).value;
    } else if (canonicalKey in response) {
      rawValue = (response as Record<string, unknown>)[canonicalKey];
    }
  }

  return deserializePreferenceValue(canonicalKey, rawValue);
}

/**
 * 写入单项偏好配置（带强校验与非法拦截）
 */
export async function setPreference<K extends PreferenceKey>(
  key: K,
  value: PreferencesMap[K]
): Promise<void> {
  if (!isKnownPreferenceKey(key as string)) {
    throw new Error(`Unknown preference key: "${String(key)}"`);
  }

  const canonicalKey = normalizePreferenceKey(key as string) as K;
  validatePreferenceValue(canonicalKey, value);

  const transport = getTransport();
  const serialized = serializePreferenceValue(canonicalKey, value);

  await transport.request('prefs_set', {
    key: canonicalKey,
    value: serialized,
  });
}

/**
 * 删除单项偏好配置（恢复默认，未知 key 抛错）
 */
export async function deletePreference(key: PreferenceKey): Promise<void> {
  if (!isKnownPreferenceKey(key as string)) {
    throw new Error(`Unknown preference key: "${String(key)}"`);
  }

  const canonicalKey = normalizePreferenceKey(key as string);
  const transport = getTransport();

  await transport.request('prefs_delete', {
    key: canonicalKey,
  });
}

/**
 * 获取全量偏好配置字典（缺省项补齐默认值）
 */
export async function getAllPreferences(): Promise<PreferencesMap> {
  const transport = getTransport();
  const result = getDefaultPreferences();
  const mutableResult = result as unknown as Record<string, unknown>;

  const response = await transport.request<unknown>('prefs_get', {});

  if (Array.isArray(response)) {
    for (const item of response) {
      if (item && typeof item === 'object' && 'key' in item && 'value' in item) {
        const itemKey = String(item.key);
        if (isKnownPreferenceKey(itemKey)) {
          const canonical = normalizePreferenceKey(itemKey);
          mutableResult[canonical] = deserializePreferenceValue(
            canonical,
            item.value
          );
        }
      }
    }
  } else if (response && typeof response === 'object') {
    for (const [k, v] of Object.entries(response)) {
      if (isKnownPreferenceKey(k)) {
        const canonical = normalizePreferenceKey(k);
        let rawVal = v;
        if (v && typeof v === 'object' && 'value' in v) {
          rawVal = (v as { value: unknown }).value;
        }
        mutableResult[canonical] = deserializePreferenceValue(
          canonical,
          rawVal
        );
      }
    }
  }

  return result;
}

/**
 * 偏好客户端统一门面对象
 */
export const preferencesClient = {
  getPreference,
  setPreference,
  deletePreference,
  getAllPreferences,
  serializePreferenceValue,
  deserializePreferenceValue,
};
