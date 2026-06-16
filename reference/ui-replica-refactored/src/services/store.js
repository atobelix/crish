/**
 * Store — Central reactive state manager.
 * Pattern: Observer / Publish-Subscribe
 */
class Store {
  constructor(initialState = {}) {
    this._state = { ...initialState };
    this._listeners = {};
  }

  get(key) {
    return this._state[key];
  }

  getAll() {
    return { ...this._state };
  }

  set(key, value) {
    const old = this._state[key];
    if (old === value) return;
    this._state[key] = value;
    this._notify(key, value, old);
  }

  update(key, updater) {
    const old = this._state[key];
    const next = updater(old);
    this._state[key] = next;
    this._notify(key, next, old);
  }

  on(key, fn) {
    (this._listeners[key] = this._listeners[key] || []).push(fn);
    return () => this._off(key, fn);
  }

  once(key, fn) {
    const wrapper = (val, old) => { fn(val, old); this._off(key, wrapper); };
    this.on(key, wrapper);
  }

  _notify(key, value, old) {
    (this._listeners[key] || []).forEach(fn => fn(value, old));
  }

  _off(key, fn) {
    const arr = this._listeners[key];
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx !== -1) arr.splice(idx, 1);
  }
}

export const store = new Store({
  currentChatId: null,
  activeProject: 'mycodex-demo',
  activeTabId: 'tab-dual-chat-1',
  sidebarCollapsed: false,
  rightSidebarCollapsed: false,
  darkTheme: false,
  chatMessages: {},
  conversationDiffs: {},
  toolUidCounter: 0,
  currentToolGroup: null
});
