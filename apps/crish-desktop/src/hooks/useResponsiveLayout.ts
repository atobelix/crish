import { useState, useEffect } from 'react';

type Breakpoint = 'sm' | 'md' | 'lg' | 'xl';
type SidebarBehavior = 'overlay' | 'icon-collapse' | 'inline';

export interface ResponsiveLayout {
  breakpoint: Breakpoint;
  isNarrow: boolean;
  isWide: boolean;
  sidebarBehavior: SidebarBehavior;
}

const queries = {
  sm: '(max-width: 480px)',
  md: '(max-width: 768px)',
  lg: '(max-width: 1024px)',
  xl: '(min-width: 1025px)',
};

export function useResponsiveLayout(): ResponsiveLayout {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() => detectBreakpoint());

  useEffect(() => {
    const mqls = Object.entries(queries).map(([, query]) => {
      const mql = window.matchMedia(query);
      const handler = () => setBreakpoint(detectBreakpoint());
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    });
    return () => mqls.forEach(unsub => unsub());
  }, []);

  return {
    breakpoint,
    isNarrow: breakpoint === 'sm' || breakpoint === 'md',
    isWide: breakpoint === 'lg' || breakpoint === 'xl',
    sidebarBehavior: breakpoint === 'sm' ? 'overlay' : breakpoint === 'md' ? 'icon-collapse' : 'inline',
  };
}

function detectBreakpoint(): Breakpoint {
  if (window.matchMedia(queries.sm).matches) return 'sm';
  if (window.matchMedia(queries.md).matches) return 'md';
  if (window.matchMedia(queries.lg).matches) return 'lg';
  return 'xl';
}
