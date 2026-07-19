import { useState, useEffect, useCallback, useRef } from 'react';

export type TransitionState = 'entering' | 'open' | 'exiting' | 'closed';

export interface UseAnimatedPresenceOptions {
  visible: boolean;
  exitDurationMs?: number;
}

export function useAnimatedPresence({ visible, exitDurationMs = 250 }: UseAnimatedPresenceOptions) {
  const [state, setState] = useState<TransitionState>(visible ? 'open' : 'closed');
  const prevVisibleRef = useRef(visible);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      setState('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setState('open');
        });
      });
    } else if (!visible && prevVisibleRef.current) {
      setState('exiting');
      timeoutRef.current = setTimeout(() => {
        setState('closed');
      }, exitDurationMs);
    }
    prevVisibleRef.current = visible;
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [visible, exitDurationMs]);

  const isMounted = state !== 'closed';

  return { state, isMounted };
}
