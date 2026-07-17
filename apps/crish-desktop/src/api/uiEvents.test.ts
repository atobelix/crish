import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UI_EVENT_NAMES,
  UI_EVENT_PREFIX,
  emitUiEvent,
  fromUiEventDomName,
  isUiEventName,
  onUiEvent,
  onUiEvents,
  onceUiEvent,
  toUiEventDomName,
  type UiEventMap,
  type UiEventName,
} from './uiEvents';

type Listener = (ev: Event) => void;

/**
 * 可靠的 window 事件总线：node vitest setup 仅 stub 了空 dispatchEvent，
 * 这里补齐 add/remove/dispatch + CustomEvent，保证 on/off 身份对称。
 */
function installReliableWindowBus(): {
  restore: () => void;
  listenerCount: (type: string) => number;
} {
  const buckets = new Map<string, Map<EventListenerOrEventListenerObject, Listener>>();
  const win = globalThis.window as Window & typeof globalThis;

  const prev = {
    addEventListener: win.addEventListener,
    removeEventListener: win.removeEventListener,
    dispatchEvent: win.dispatchEvent,
    CustomEvent: globalThis.CustomEvent,
  };

  globalThis.CustomEvent = class TestCustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  } as typeof CustomEvent;

  win.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
    let map = buckets.get(type);
    if (!map) {
      map = new Map();
      buckets.set(type, map);
    }
    if (map.has(listener)) return;
    const wrapped: Listener =
      typeof listener === 'function'
        ? (listener as Listener)
        : (ev) => (listener as EventListenerObject).handleEvent(ev);
    map.set(listener, wrapped);
  }) as typeof win.addEventListener;

  win.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
    const map = buckets.get(type);
    if (!map) return;
    map.delete(listener);
    if (map.size === 0) buckets.delete(type);
  }) as typeof win.removeEventListener;

  win.dispatchEvent = ((event: Event) => {
    const map = buckets.get(event.type);
    if (!map) return true;
    // 快照：允许 handler 中 remove 自身
    for (const wrapped of [...map.values()]) {
      wrapped(event);
    }
    return true;
  }) as typeof win.dispatchEvent;

  return {
    restore: () => {
      win.addEventListener = prev.addEventListener;
      win.removeEventListener = prev.removeEventListener;
      win.dispatchEvent = prev.dispatchEvent;
      globalThis.CustomEvent = prev.CustomEvent;
      buckets.clear();
    },
    listenerCount: (type: string) => buckets.get(type)?.size ?? 0,
  };
}

describe('uiEvents bus', () => {
  let restore: () => void;
  let listenerCount: (type: string) => number;

  beforeEach(() => {
    const bus = installReliableWindowBus();
    restore = bus.restore;
    listenerCount = bus.listenerCount;
  });

  afterEach(() => {
    restore();
  });

  describe('registry / name guards', () => {
    it('UI_EVENT_NAMES covers key map entries without duplicates', () => {
      const names = [...UI_EVENT_NAMES];
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('model-changed');
      expect(names).toContain('profiles-changed');
      expect(names).toContain('open-agent-panel');
      expect(names).toContain('open-chat');
      for (const n of names) {
        expect(isUiEventName(n)).toBe(true);
      }
    });

    it('isUiEventName rejects unknown / non-string', () => {
      expect(isUiEventName('open-chat')).toBe(true);
      expect(isUiEventName('model-changed')).toBe(true);
      expect(isUiEventName('not-a-real-event')).toBe(false);
      expect(isUiEventName('crish-open-chat')).toBe(false);
      expect(isUiEventName('')).toBe(false);
      expect(isUiEventName(null)).toBe(false);
      expect(isUiEventName(undefined)).toBe(false);
      expect(isUiEventName(42)).toBe(false);
      expect(isUiEventName({})).toBe(false);
    });

    it('toUiEventDomName / fromUiEventDomName round-trip', () => {
      for (const name of UI_EVENT_NAMES) {
        const dom = toUiEventDomName(name);
        expect(dom).toBe(`${UI_EVENT_PREFIX}${name}`);
        expect(fromUiEventDomName(dom)).toBe(name);
      }
      expect(fromUiEventDomName('open-chat')).toBeNull();
      expect(fromUiEventDomName('crish-not-registered')).toBeNull();
      expect(fromUiEventDomName('')).toBeNull();
      expect(fromUiEventDomName(null)).toBeNull();
      expect(fromUiEventDomName(undefined)).toBeNull();
    });
  });

  describe('emitUiEvent', () => {
    it('dispatches prefixed CustomEvent for void events', () => {
      const seen: string[] = [];
      window.addEventListener('crish-open-chat', () => {
        seen.push('open-chat');
      });
      expect(emitUiEvent('open-chat')).toBe(true);
      expect(seen).toEqual(['open-chat']);
    });

    it('carries typed detail for model-changed', () => {
      const details: Array<UiEventMap['model-changed']> = [];
      onUiEvent('model-changed', (d) => {
        details.push(d);
      });
      const payload = { profileId: 'p1', model: 'gpt-x' };
      expect(emitUiEvent('model-changed', payload)).toBe(true);
      expect(details).toEqual([payload]);
    });

    it('profiles-changed and open-agent-panel payloads', () => {
      const profileHits: unknown[] = [];
      const agentHits: Array<UiEventMap['open-agent-panel']> = [];
      onUiEvent('profiles-changed', (d) => profileHits.push(d));
      onUiEvent('open-agent-panel', (d) => agentHits.push(d));

      emitUiEvent('profiles-changed');
      emitUiEvent('open-agent-panel', { agentId: 'a-9' });
      emitUiEvent('open-agent-panel', {});

      expect(profileHits).toHaveLength(1);
      expect(agentHits).toEqual([{ agentId: 'a-9' }, {}]);
    });

    it('returns false for unknown event name at runtime', () => {
      const ok = emitUiEvent('totally-unknown' as UiEventName);
      expect(ok).toBe(false);
      expect(listenerCount('crish-totally-unknown')).toBe(0);
    });

    it('is compatible with raw window CustomEvent crish-* listeners', () => {
      const raw: unknown[] = [];
      window.addEventListener('crish-model-changed', (ev) => {
        raw.push((ev as CustomEvent).detail);
      });
      emitUiEvent('model-changed', { profileId: 'x', model: 'm' });
      expect(raw).toEqual([{ profileId: 'x', model: 'm' }]);
    });
  });

  describe('onUiEvent subscribe / unsubscribe', () => {
    it('delivers detail and off stops further delivery', () => {
      const calls: Array<UiEventMap['model-changed']> = [];
      const off = onUiEvent('model-changed', (d) => calls.push(d));
      emitUiEvent('model-changed', { profileId: 'a', model: 'm1' });
      off();
      emitUiEvent('model-changed', { profileId: 'b', model: 'm2' });
      expect(calls).toEqual([{ profileId: 'a', model: 'm1' }]);
      expect(listenerCount('crish-model-changed')).toBe(0);
    });

    it('unsubscribe is idempotent', () => {
      const fn = vi.fn();
      const off = onUiEvent('open-chat', fn);
      off();
      off();
      off();
      emitUiEvent('open-chat');
      expect(fn).not.toHaveBeenCalled();
    });

    it('multiple subscribers all receive; one off does not affect others', () => {
      const a = vi.fn();
      const b = vi.fn();
      const offA = onUiEvent('update-changed', a);
      onUiEvent('update-changed', b);
      emitUiEvent('update-changed');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      offA();
      emitUiEvent('update-changed');
      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(2);
    });

    it('handler throw does not block sibling subscribers', () => {
      const good = vi.fn();
      onUiEvent('open-overview', () => {
        throw new Error('boom');
      });
      onUiEvent('open-overview', good);
      expect(() => emitUiEvent('open-overview')).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    });

    it('non-function handler yields no-op off', () => {
      const off = onUiEvent('open-chat', null as unknown as () => void);
      expect(() => off()).not.toThrow();
      expect(listenerCount('crish-open-chat')).toBe(0);
    });

    it('unknown name yields no-op off and no listeners', () => {
      const off = onUiEvent('nope' as UiEventName, vi.fn());
      off();
      expect(listenerCount('crish-nope')).toBe(0);
    });
  });

  describe('onceUiEvent', () => {
    it('fires only on first emit then auto-unsubscribes', () => {
      const fn = vi.fn();
      onceUiEvent('pick-workspace', fn);
      emitUiEvent('pick-workspace');
      emitUiEvent('pick-workspace');
      emitUiEvent('pick-workspace');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(listenerCount('crish-pick-workspace')).toBe(0);
    });

    it('receives payload then cleans up', () => {
      const fn = vi.fn();
      onceUiEvent('model-changed', fn);
      emitUiEvent('model-changed', { profileId: 'p', model: 'm' });
      expect(fn).toHaveBeenCalledWith({ profileId: 'p', model: 'm' });
      emitUiEvent('model-changed', { profileId: 'p2', model: 'm2' });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('manual off before fire prevents handler', () => {
      const fn = vi.fn();
      const off = onceUiEvent('export-session-md', fn);
      off();
      emitUiEvent('export-session-md');
      expect(fn).not.toHaveBeenCalled();
    });

    it('manual off after fire is idempotent', () => {
      const fn = vi.fn();
      const off = onceUiEvent('toggle-msg-filter', fn);
      emitUiEvent('toggle-msg-filter');
      expect(fn).toHaveBeenCalledTimes(1);
      expect(() => {
        off();
        off();
      }).not.toThrow();
    });

    it('handler throw still unsubscribes', () => {
      onceUiEvent('open-tasks', () => {
        throw new Error('once-fail');
      });
      expect(() => emitUiEvent('open-tasks')).not.toThrow();
      expect(listenerCount('crish-open-tasks')).toBe(0);
      expect(() => emitUiEvent('open-tasks')).not.toThrow();
    });
  });

  describe('onUiEvents multi-subscribe', () => {
    it('wires several handlers and offs all at once', () => {
      const chat = vi.fn();
      const model = vi.fn();
      const profiles = vi.fn();
      const off = onUiEvents({
        'open-chat': chat,
        'model-changed': model,
        'profiles-changed': profiles,
      });

      emitUiEvent('open-chat');
      emitUiEvent('model-changed', { profileId: '1', model: 'x' });
      emitUiEvent('profiles-changed');
      expect(chat).toHaveBeenCalledTimes(1);
      expect(model).toHaveBeenCalledWith({ profileId: '1', model: 'x' });
      expect(profiles).toHaveBeenCalledTimes(1);

      off();
      emitUiEvent('open-chat');
      emitUiEvent('model-changed', { profileId: '2', model: 'y' });
      emitUiEvent('profiles-changed');
      expect(chat).toHaveBeenCalledTimes(1);
      expect(model).toHaveBeenCalledTimes(1);
      expect(profiles).toHaveBeenCalledTimes(1);
      expect(listenerCount('crish-open-chat')).toBe(0);
      expect(listenerCount('crish-model-changed')).toBe(0);
      expect(listenerCount('crish-profiles-changed')).toBe(0);
    });

    it('multi off is idempotent', () => {
      const off = onUiEvents({ 'open-scheduled': vi.fn() });
      off();
      expect(() => off()).not.toThrow();
    });

    it('ignores empty / non-object handlers map', () => {
      const off1 = onUiEvents({});
      const off2 = onUiEvents(null as unknown as { [K in UiEventName]?: () => void });
      expect(() => {
        off1();
        off2();
      }).not.toThrow();
    });
  });

  describe('SSR / missing window APIs', () => {
    it('emit/on/once degrade when addEventListener missing', () => {
      const win = globalThis.window as Window & typeof globalThis;
      const savedAdd = win.addEventListener;
      (win as { addEventListener?: typeof win.addEventListener }).addEventListener =
        undefined;

      const off = onUiEvent('open-chat', vi.fn());
      const onceOff = onceUiEvent('open-chat', vi.fn());
      expect(typeof off).toBe('function');
      expect(typeof onceOff).toBe('function');
      off();
      onceOff();

      win.addEventListener = savedAdd;
    });

    it('emit returns false when dispatchEvent missing', () => {
      const win = globalThis.window as Window & typeof globalThis;
      const saved = win.dispatchEvent;
      (win as { dispatchEvent?: typeof win.dispatchEvent }).dispatchEvent = undefined;
      expect(emitUiEvent('open-chat')).toBe(false);
      win.dispatchEvent = saved;
    });
  });
});
