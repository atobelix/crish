/**
 * 持久化中间件包装器：透传 mutator 元组类型。
 *
 * 直接复用 zustand/middleware 的 persist，补充默认选项
 *（name / version），同时允许调用方通过 options 覆盖。
 *
 * 泛型签名与 persist 完全一致，确保 immer / devtools 等中间件的
 * mutator 元组正确传播，不丢失类型信息。
 *
 * 设计说明：
 *   - partialize 不在本包装器内提供默认值。zustand persist 自身在
 *     partialize 缺省时会以全 state 持久化（identity 行为），
 *     在包装器层重复这一默认会让 U 的类型推导退化为 T | U 联合，
 *     破坏调用方按 partialize 返回类型推断 U 的能力。
 *     因此调用方需要自定义 partialize 时显式传入；不需要时省略即可。
 *   - 先展开 options 再覆盖 name / version，避免 TS2783（同名属性被覆盖）
 *     并保持调用方显式传入的字段优先级最高。
 */
import { persist, type PersistOptions } from 'zustand/middleware';
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla';

export function withPersist<
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
>(
  config: StateCreator<T, [...Mps, ['zustand/persist', unknown]], Mcs>,
  options: PersistOptions<T, U>,
): StateCreator<T, Mps, [['zustand/persist', U], ...Mcs]> {
  const mergedOptions: PersistOptions<T, U> = {
    ...options,
    name: options.name ?? 'crish-store',
    version: options.version ?? 1,
  };
  return persist(config, mergedOptions);
}
