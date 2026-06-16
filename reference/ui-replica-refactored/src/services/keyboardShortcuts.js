import { eventBus } from './eventBus.js';

/**
 * KeyboardShortcuts — global hotkey manager.
 */
export const KeyboardShortcuts = {
  init() {
    document.addEventListener('keydown', (e) => {
      // Ctrl+P — Command Palette
      if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        eventBus.emit('command-palette:open');
      }
      // Escape — Close modals/palettes
      if (e.key === 'Escape') {
        eventBus.emit('escape');
      }
      // Ctrl+B — Toggle sidebar
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        eventBus.emit('sidebar:toggle');
      }
      // Ctrl+N — New chat
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        eventBus.emit('chat:new');
      }
    });
  }
};
