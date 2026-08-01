/**
 * IPC 错误负载类型守卫（Round 11-A / 11-C）。
 *
 * 共存阶段（禁令 23）：IpcResponse.error 在 R10 后运行时携带 CrishErrorPayload，
 * 但 ts-rs 生成的类型仍为 IpcError。此模块提供运行时类型守卫，统一识别新格式与旧格式，
 * 并将任意错误形状归一为 CrishErrorPayload。
 *
 * 设计依据：analysis/iterative-repair/v2/ROUND-11-frontend.md §2.3 步骤 4
 *
 * 约束：
 * - 仅依赖 @crish/shared-types，不引入新运行时依赖（禁令 8）
 * - 旧 CoreError tagged enum（{ kind, detail }）通过映射表转换为 CrishErrorCode
 * - 删除阶段（R12）移除 isLegacyIpcError / 旧码映射，仅保留 CrishErrorPayload
 */

import type { CrishErrorPayload } from '@crish/shared-types';

/**
 * 旧 CoreError tagged enum 格式（Rust serde 序列化）。
 *
 * `kind` 是 variant 名（如 "InvalidInput"），`detail` 是人类可读消息。
 * R10 前 Tauri invoke reject 抛出此格式；R10 后改为 CrishErrorPayload。
 */
export interface LegacyIpcError {
  readonly kind: string;
  readonly detail?: unknown;
}

/**
 * IpcResponse.error 的共存类型：R10 后为 CrishErrorPayload，R10 前为 LegacyIpcError。
 *
 * 共存阶段（R11）：前端解析时先尝试 CrishErrorPayload，失败回退 LegacyIpcError。
 * 删除阶段（R12）：仅保留 CrishErrorPayload，移除 LegacyIpcError 分支。
 */
export type IpcResponseError = CrishErrorPayload | LegacyIpcError | null;

/**
 * 旧 CoreError kind（variant 名）-> 新 CrishErrorCode 映射表。
 *
 * 对齐 03-ERROR-MIGRATION.md §3.5 Rust CoreError -> CrishErrorCode 映射，
 * 与 tauriInvoke.ts 的 legacyKindToCode 保持一致。
 * 未命中的 kind 回退到 common.unknown。
 */
const LEGACY_KIND_TO_CODE: Readonly<Record<string, CrishErrorPayload['code']>> = {
  InvalidInput: 'common.unsupported',
  Encoding: 'store.corrupted',
  Io: 'store.write_failed',
  NotFound: 'common.unknown',
  Cancelled: 'runtime.aborted',
  Internal: 'common.unknown',
};

/**
 * 类型守卫：判断值是否为 CrishErrorPayload。
 *
 * 检查 code（字符串）与 category（字符串）字段存在。
 * 这是 CrishErrorPayload 的最小结构签名（R10 后 Rust serde 序列化的新格式）。
 */
export function isCrishErrorPayload(value: unknown): value is CrishErrorPayload {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.code === 'string' &&
    typeof o.category === 'string'
  );
}

/**
 * 类型守卫：判断值是否为旧 IPC 错误（{ kind, detail } 格式）。
 *
 * 检查 kind（字符串）字段存在。这是 Rust CoreError tagged enum 的 serde 序列化格式。
 * R10 前的 Tauri invoke reject 抛出此格式；R10 后已迁移为 CrishErrorPayload。
 */
export function isLegacyIpcError(value: unknown): value is LegacyIpcError {
  if (value === null || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return typeof o.kind === 'string';
}

/** 构造默认 common.unknown payload（null / 未知形状兜底） */
function makeDefaultPayload(message = 'Unknown error'): CrishErrorPayload {
  return {
    code: 'common.unknown',
    message,
    category: 'permanent',
    retryable: false,
    public: true,
    action: 'action.common.report_bug',
    timestamp: Date.now(),
  };
}

/**
 * 将任意错误形状统一转换为 CrishErrorPayload。
 *
 * 转换优先级：
 * 1. null / undefined -> 默认 common.unknown payload
 * 2. CrishErrorPayload（含 code + category 字符串字段）-> 原样返回
 * 3. LegacyIpcError（含 kind 字段）-> 映射 kind -> code，构造 payload
 * 4. 字符串 -> 包裹为 common.unknown，message = 字符串
 * 5. 含 message 字段的对象 -> 包裹为 common.unknown，message = 对象 message
 * 6. 其他 -> 默认 common.unknown payload
 *
 * 此函数始终返回 CrishErrorPayload（不返回 null），调用方可安全使用返回值。
 */
export function toCrishErrorPayload(value: unknown): CrishErrorPayload {
  if (value === null || value === undefined) {
    return makeDefaultPayload();
  }
  if (isCrishErrorPayload(value)) {
    return value;
  }
  if (isLegacyIpcError(value)) {
    const code = LEGACY_KIND_TO_CODE[value.kind] ?? 'common.unknown';
    // LegacyIpcError 声明了 kind/detail，但运行时可能也携带 message（部分 CoreError variant）
    const v = value as unknown as Record<string, unknown>;
    const message =
      typeof v.detail === 'string'
        ? v.detail
        : typeof v.message === 'string'
          ? v.message
          : value.kind;
    return {
      code,
      message,
      category: 'permanent',
      retryable: false,
      public: true,
      action: 'action.common.report_bug',
      timestamp: Date.now(),
    };
  }
  if (typeof value === 'string') {
    return makeDefaultPayload(value);
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.message === 'string') {
      return makeDefaultPayload(o.message);
    }
  }
  return makeDefaultPayload();
}
