import { devtools } from 'zustand/middleware';
import type { StateCreator } from 'zustand';

export const withDevtools = <T>(config: StateCreator<T>, name: string): StateCreator<T> =>
  devtools(config, { name, enabled: process.env.NODE_ENV === 'development' });
