import { useLayoutAnimationStore } from '../store/layoutAnimationStore';

const SELECTOR = (s: { isLayoutFrozen: boolean }) => s.isLayoutFrozen;

export function useResizeFreeze(_debounceMs?: number): { isResizing: boolean } {
  const isLayoutFrozen = useLayoutAnimationStore(SELECTOR);
  return { isResizing: isLayoutFrozen };
}
