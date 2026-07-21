import { useShallow } from 'zustand/react/shallow';

export { useShallow };

export function useShallowSelector<S, U>(
  selector: (state: S) => U,
): (state: S) => U {
  return useShallow(selector);
}
