import type { StateCreator } from 'zustand';
import { checkBudget } from '../../api/performance-budget';

export const withLogger = <T>(config: StateCreator<T>): StateCreator<T> =>
  (set, get, api) =>
    config(
      (args) => {
        if (process.env.NODE_ENV === 'development') {
          const markName = `store:${api.setState.name || 'anonymous'}`;
          performance.mark(`${markName}:start`);
          const prev = get();
          set(args);
          const next = get();
          performance.mark(`${markName}:end`);
          performance.measure(markName, `${markName}:start`, `${markName}:end`);
          const measures = performance.getEntriesByName(markName);
          checkBudget('store:transaction', measures[measures.length - 1].duration);
          console.groupCollapsed(`[Store] ${api.setState.name || 'anonymous'}`);
          console.log('prev:', prev);
          console.log('next:', next);
          console.groupEnd();
        } else {
          set(args);
        }
      },
      get,
      api,
    );
