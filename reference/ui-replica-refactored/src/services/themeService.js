import { store } from './store.js';

/**
 * ThemeService — manages light/dark/system theme.
 * Defaults to light. Only persists when user explicitly toggles via settings.
 * 'system' mode follows prefers-color-scheme.
 * Later: config file based.
 */
export const ThemeService = {
  init() {
    const saved = localStorage.getItem('mycodex_theme');
    if (saved === 'system') this._applySystem();
    else if (saved === 'dark') this.setDark(true);
    else this.setDark(false); // default light
  },

  setDark(isDark) {
    document.body.classList.toggle('dark-theme', isDark);
    document.body.classList.toggle('dark-mode', isDark);
    store.set('darkTheme', isDark);
  },

  /** Called when user explicitly toggles in settings */
  setUserTheme(mode) {
    // mode: 'light' | 'dark' | 'system'
    if (mode === 'system') {
      this._applySystem();
    } else {
      this.setDark(mode === 'dark');
    }
    localStorage.setItem('mycodex_theme', mode);
  },

  _applySystem() {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    this.setDark(prefersDark);
  },

  toggle() {
    const current = store.get('darkTheme');
    this.setUserTheme(current ? 'light' : 'dark');
  }
};
