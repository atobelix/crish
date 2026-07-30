import { describe, expect, it, beforeEach, vi, afterEach } from "vitest";
import { AsyncEventQueue, DEFAULT_QUEUE_OPTIONS } from "./index";
import type { ConexCanonicalEvent } from "@crish/agent-context";

function makeEvent(): ConexCanonicalEvent {
  return {
    eventId: `evt-${Date.now()}`,
    eventType: "test-event",
    domain: "test",
    sourceLayer: "runtime",
    traceId: "trace-1",
    spanId: "span-1",
    occurredAt: new Date().toISOString(),
    payload: { key: "value" },
  } as ConexCanonicalEvent;
}

describe("AsyncEventQueue", () => {
  let queue: AsyncEventQueue;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enqueues and dequeues a single event", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 10, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    const event = makeEvent();
    const result = queue.enqueue(event);
    expect(result.accepted).toBe(true);
    const events = queue.dequeue(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("test-event");
  });

  it("returns empty array when dequeuing from empty queue", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 10, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    expect(queue.dequeue()).toEqual([]);
  });

  it("rejects events when queue is full with reject strategy", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 2, backpressureStrategy: "reject", maxMemoryBytes: 0, enableMemoryMonitoring: false });
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    const result = queue.enqueue(makeEvent());
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("queue-full");
  });

  it("drops oldest event when queue is full with drop-oldest strategy", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 2, backpressureStrategy: "drop-oldest", maxMemoryBytes: 0, enableMemoryMonitoring: false });
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    expect(queue.getStats().currentSize).toBe(2);
    expect(queue.getStats().totalDropped).toBe(1);
  });

  it("drops newest event with drop-newest strategy", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 2, backpressureStrategy: "drop-newest", maxMemoryBytes: 0, enableMemoryMonitoring: false });
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    const result = queue.enqueue(makeEvent());
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("queue-full-drop-newest");
  });

  it("rejects events when closed", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 10, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    queue.close();
    const result = queue.enqueue(makeEvent());
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("queue-closed");
  });

  it("enqueues batch of events", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 10, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    const events = [makeEvent(), makeEvent(), makeEvent()];
    const result = queue.enqueueBatch(events);
    expect(result.accepted).toBe(3);
    expect(result.rejected).toBe(0);
  });

  it("getStats returns correct stats", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 100, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    const stats = queue.getStats();
    expect(stats.currentSize).toBe(2);
    expect(stats.totalEnqueued).toBe(2);
    expect(stats.totalDequeued).toBe(0);
    expect(stats.isFull).toBe(false);
    expect(stats.isEmpty).toBe(false);
  });

  it("startConsuming calls consumers with batched events", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 100, batchSize: 2, consumeIntervalMs: 50, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    const consumer = vi.fn();
    queue.addConsumer(consumer);
    queue.startConsuming();
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    vi.advanceTimersByTime(50);
    expect(consumer).toHaveBeenCalled();
    expect(consumer.mock.calls[0]?.[0]).toHaveLength(2);
    queue.stopConsuming();
  });

  it("stopConsuming stops the consumer interval", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 100, batchSize: 2, consumeIntervalMs: 50, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    const consumer = vi.fn();
    queue.addConsumer(consumer);
    queue.startConsuming();
    queue.stopConsuming();
    queue.enqueue(makeEvent());
    vi.advanceTimersByTime(100);
    expect(consumer).not.toHaveBeenCalled();
  });

  it("close drains remaining events to consumers", async () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 100, batchSize: 10, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    const consumer = vi.fn();
    queue.addConsumer(consumer);
    queue.enqueue(makeEvent());
    queue.enqueue(makeEvent());
    await queue.close();
    expect(consumer).toHaveBeenCalled();
  });

  it("consumer errors do not affect other consumers", () => {
    queue = new AsyncEventQueue({ ...DEFAULT_QUEUE_OPTIONS, maxQueueSize: 100, batchSize: 1, consumeIntervalMs: 50, maxMemoryBytes: 0, enableMemoryMonitoring: false });
    const badConsumer = vi.fn().mockImplementation(() => { throw new Error("oops"); });
    const goodConsumer = vi.fn();
    queue.addConsumer(badConsumer);
    queue.addConsumer(goodConsumer);
    queue.startConsuming();
    queue.enqueue(makeEvent());
    vi.advanceTimersByTime(50);
    expect(goodConsumer).toHaveBeenCalled();
    queue.stopConsuming();
  });
});
