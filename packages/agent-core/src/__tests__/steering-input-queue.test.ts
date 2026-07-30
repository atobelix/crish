import { describe, expect, it } from 'vitest';
import { SteeringInputQueue, type SteeringInputEntry } from '../steering/steering-input-queue';

function entry(overrides: Partial<SteeringInputEntry> & { isSteering: boolean }): SteeringInputEntry {
  return {
    id: 'e1',
    sessionId: 's1',
    text: 'test',
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

const steering = (overrides?: Partial<SteeringInputEntry>) =>
  entry({ isSteering: true, ...overrides });

const nonSteering = (overrides?: Partial<SteeringInputEntry>) =>
  entry({ isSteering: false, ...overrides });

describe('SteeringInputQueue', () => {
  it('concurrently enqueues multiple messages', () => {
    const q = new SteeringInputQueue(100);
    const inputs = Array.from({ length: 10 }, (_, i) =>
      steering({ id: `s${i}`, text: `msg-${i}` })
    );
    for (const inp of inputs) {
      q.enqueue(inp);
    }
    expect(q.size).toBe(10);
    const all = q.dequeueAll();
    expect(all).toHaveLength(10);
    expect(all.map(e => e.text)).toEqual(inputs.map(e => e.text));
  });

  it('dequeueAll consumes all entries', () => {
    const q = new SteeringInputQueue();
    q.enqueue(steering({ id: 's1' }));
    q.enqueue(nonSteering({ id: 'n1' }));
    q.enqueue(steering({ id: 's2' }));
    const all = q.dequeueAll();
    expect(all).toHaveLength(3);
    expect(q.hasPending()).toBe(false);
    expect(q.size).toBe(0);
  });

  it('hasPending returns false for empty queue', () => {
    const q = new SteeringInputQueue();
    expect(q.hasPending()).toBe(false);
    expect(q.hasPendingSteering()).toBe(false);
  });

  it('continues working after consuming all entries', () => {
    const q = new SteeringInputQueue();
    q.enqueue(steering({ id: 's1' }));
    q.dequeueAll();
    expect(q.hasPending()).toBe(false);
    q.enqueue(nonSteering({ id: 'n1' }));
    expect(q.hasPending()).toBe(true);
    expect(q.dequeueAll()).toHaveLength(1);
  });

  it('transferTo migrates all entries across runs', () => {
    const src = new SteeringInputQueue();
    const dst = new SteeringInputQueue();
    src.enqueue(steering({ id: 's1', text: 'a' }));
    src.enqueue(nonSteering({ id: 'n1', text: 'b' }));
    src.transferTo(dst);
    expect(src.size).toBe(0);
    expect(src.hasPending()).toBe(false);
    expect(dst.size).toBe(2);
    expect(dst.dequeueAll().map(e => e.text)).toEqual(['a', 'b']);
  });

  it('clear empties the queue', () => {
    const q = new SteeringInputQueue();
    q.enqueue(steering({ id: 's1' }));
    q.enqueue(nonSteering({ id: 'n1' }));
    expect(q.hasPending()).toBe(true);
    q.clear();
    expect(q.size).toBe(0);
    expect(q.hasPending()).toBe(false);
    expect(q.dequeueAll()).toEqual([]);
  });

  it('handles 50 messages under pressure', () => {
    const q = new SteeringInputQueue(50);
    for (let i = 0; i < 50; i++) {
      q.enqueue(nonSteering({ id: `n${i}` }));
    }
    expect(q.size).toBe(50);
    const all = q.dequeueAll();
    expect(all).toHaveLength(50);
    expect(all[0]!.id).toBe('n0');
    expect(all[49]!.id).toBe('n49');
  });

  it('replaces entry with same id across runs using replaceOrEnqueue', () => {
    const q = new SteeringInputQueue();
    q.enqueue(steering({ id: 's1', groupId: 'g1', text: 'old' }));
    const replaced = q.replaceOrEnqueue(steering({ id: 's2', groupId: 'g1', text: 'new' }));
    expect(replaced).toBe(true);
    expect(q.size).toBe(1);
    expect(q.peek()!.text).toBe('new');
    expect(q.peek()!.id).toBe('s2');
  });
});
