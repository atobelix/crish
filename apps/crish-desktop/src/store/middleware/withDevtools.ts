/**
 * Redux DevTools 中间件包装器：透传 mutator 元组类型。
 *
 * 直接复用 zustand/middleware 的 devtools，仅固定 name 与 enabled 选项。
 * 泛型签名与 devtools 完全一致，确保 immer / persist 等中间件的
 * mutator 元组正确传播，不丢失类型信息。
 */
import { devtools } from 'zustand/middleware';
import type { StateCreator, StoreMutatorIdentifier } from 'zustand/vanilla';

export const withDevtools = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
  U = T,
>(
  config: StateCreator<T, [...Mps, ['zustand/devtools', never]], Mcs, U>,
  name: string,
): StateCreator<T, Mps, [['zustand/devtools', never], ...Mcs], U> =>
  devtools(config, {
    name,
    enabled: process.env.NODE_ENV === 'development',
  });
