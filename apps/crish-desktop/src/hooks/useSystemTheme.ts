import { useEffect } from 'react';
import { configService } from '../services/ConfigService';

export function useSystemTheme(): void {
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      const theme = configService.get<'light' | 'dark' | 'system'>('theme.mode');
      if (theme === 'system') {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    };
    mediaQuery.addEventListener('change', handler);
    handler(mediaQuery); // initial
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);
}
