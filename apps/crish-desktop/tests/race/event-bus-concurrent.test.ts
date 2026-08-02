import { describe, it, expect, beforeEach } from 'vitest';
import { eventBus } from '../../src/services/EventBus';

describe('EventBus Race Conditions', () => {
  beforeEach(() => {
    eventBus.removeAllListeners();
  });

  it('handles concurrent emit and subscribe/unsubscribe', async () => {
    const received = new Set<number>();
    
    eventBus.on('test', () => { received.add(1); });
    const sub2 = eventBus.on('test', () => { 
      received.add(2);
      sub2();
    });
    
    await Promise.all([
      eventBus.emitAsync('test', { seq: 1 }),
      Promise.resolve().then(() => eventBus.emit('test', { seq: 2 })),
      Promise.resolve().then(() => eventBus.emit('test', { seq: 3 })),
    ]);
    
    expect(received.size).toBeGreaterThan(0);
  });

  it('handles 100 rapid emits without handler mutation', async () => {
    let count = 0;
    eventBus.on('rapid', () => { count++; });
    
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => 
        Promise.resolve().then(() => eventBus.emit('rapid', { i }))
      )
    );
    
    expect(count).toBe(100);
  });

  it('handles onAny subscription during active emits', async () => {
    const received: string[] = [];
    
    const emitLoop = setInterval(() => {
      eventBus.emit('loop', { ts: Date.now() });
    }, 1);
    
    await new Promise<void>(resolve => {
      setTimeout(() => {
        const unsub = eventBus.onAny((event) => {
          received.push(event.type);
          if (received.length >= 10) {
            clearInterval(emitLoop);
            unsub();
            resolve();
          }
        });
      }, 5);
    });
    
    expect(received.length).toBeGreaterThanOrEqual(10);
  });
});
