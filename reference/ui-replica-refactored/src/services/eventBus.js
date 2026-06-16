/**
 * EventBus — cross-component communication.
 */
class EventBus {
  constructor() {
    this._handlers = {};
  }

  on(event, fn) {
    (this._handlers[event] = this._handlers[event] || []).push(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const arr = this._handlers[event];
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emit(event, ...args) {
    (this._handlers[event] || []).forEach(fn => fn(...args));
  }
}

export const eventBus = new EventBus();
