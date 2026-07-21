import { persist, type PersistOptions } from 'zustand/middleware';
import type { StateCreator } from 'zustand';

export function withPersist<T>(
  config: StateCreator<T>,
  options: PersistOptions<T>,
): StateCreator<T> {
  return persist(config, {
    name: options.name ?? 'crish-store',
    partialize: options.partialize ?? ((state) => state),
    version: options.version ?? 1,
    ...options,
  });
}
