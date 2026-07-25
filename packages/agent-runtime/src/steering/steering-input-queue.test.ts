import { describe, expect, it } from "vitest";
import { SteeringInputQueue, type SteeringInputEntry } from "./steering-input-queue";

function entry(overrides: Partial<SteeringInputEntry> & { isSteering: boolean }): SteeringInputEntry {
  return {
    id: "e1",
    sessionId: "s1",
    text: "test",
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

const steering = (overrides?: Partial<SteeringInputEntry>) =>
  entry({ isSteering: true, ...overrides });

const nonSteering = (overrides?: Partial<SteeringInputEntry>) =>
  entry({ isSteering: false, ...overrides });

describe("SteeringInputQueue", () => {
  describe("enqueue / dequeueAll", () => {
    it("enqueues and returns all entries in FIFO order", () => {
      const q = new SteeringInputQueue();
      q.enqueue(steering({ id: "s1", text: "a" }));
      q.enqueue(nonSteering({ id: "n1", text: "b" }));
      q.enqueue(steering({ id: "s2", text: "c" }));

      const all = q.dequeueAll();
      expect(all.map(e => e.id)).toEqual(["s1", "n1", "s2"]);
      expect(q.hasPending()).toBe(false);
    });

    it("returns empty array for empty queue", () => {
      const q = new SteeringInputQueue();
      expect(q.dequeueAll()).toEqual([]);
    });
  });

  describe("dequeueByGroup", () => {
    it("removes and returns entries matching the group", () => {
      const q = new SteeringInputQueue();
      q.enqueue(steering({ id: "s1", groupId: "g1" }));
      q.enqueue(nonSteering({ id: "n1", groupId: "g2" }));
      q.enqueue(steering({ id: "s2", groupId: "g1" }));

      const g1 = q.dequeueByGroup("g1");
      expect(g1.map(e => e.id)).toEqual(["s1", "s2"]);
      expect(q.size).toBe(1);
      expect(q.dequeueAll().map(e => e.id)).toEqual(["n1"]);
    });

    it("returns empty when no matching group", () => {
      const q = new SteeringInputQueue();
      q.enqueue(nonSteering({ id: "n1", groupId: "g1" }));
      expect(q.dequeueByGroup("g2")).toEqual([]);
      expect(q.size).toBe(1);
    });
  });

  describe("withdraw", () => {
    it("removes entries matching predicate", () => {
      const q = new SteeringInputQueue();
      q.enqueue(steering({ id: "s1" }));
      q.enqueue(nonSteering({ id: "n1" }));
      q.enqueue(steering({ id: "s2" }));

      const withdrawn = q.withdraw(e => e.isSteering);
      expect(withdrawn.map(e => e.id)).toEqual(["s1", "s2"]);
      expect(q.size).toBe(1);
      expect(q.peek()!.id).toBe("n1");
    });
  });

  describe("replaceOrEnqueue", () => {
    it("replaces entry with same groupId", () => {
      const q = new SteeringInputQueue();
      q.enqueue(nonSteering({ id: "n1", groupId: "g1", text: "old" }));

      const replaced = q.replaceOrEnqueue(steering({ id: "s1", groupId: "g1", text: "new" }));
      expect(replaced).toBe(true);
      expect(q.size).toBe(1);
      expect(q.peek()!.text).toBe("new");
      expect(q.peek()!.id).toBe("s1");
    });

    it("enqueues when no matching groupId", () => {
      const q = new SteeringInputQueue();
      const replaced = q.replaceOrEnqueue(steering({ id: "s1", groupId: "g1" }));
      expect(replaced).toBe(false);
      expect(q.size).toBe(1);
    });

    it("enqueues when entry has no groupId", () => {
      const q = new SteeringInputQueue();
      const replaced = q.replaceOrEnqueue(steering({ id: "s1" }));
      expect(replaced).toBe(false);
      expect(q.size).toBe(1);
    });
  });

  describe("hasPending / hasPendingSteering", () => {
    it("reports pending correctly", () => {
      const q = new SteeringInputQueue();
      expect(q.hasPending()).toBe(false);
      expect(q.hasPendingSteering()).toBe(false);

      q.enqueue(nonSteering());
      expect(q.hasPending()).toBe(true);
      expect(q.hasPendingSteering()).toBe(false);

      q.enqueue(steering());
      expect(q.hasPendingSteering()).toBe(true);
    });

    it("hasPendingSteering returns false after non-steering dequeueAll", () => {
      const q = new SteeringInputQueue();
      q.enqueue(steering());
      q.enqueue(nonSteering());
      q.dequeueAll();
      expect(q.hasPendingSteering()).toBe(false);
    });
  });

  describe("peek", () => {
    it("returns first entry without removing it", () => {
      const q = new SteeringInputQueue();
      q.enqueue(steering({ id: "first" }));
      q.enqueue(nonSteering({ id: "second" }));

      expect(q.peek()!.id).toBe("first");
      expect(q.size).toBe(2);
    });

    it("returns undefined on empty queue", () => {
      expect(new SteeringInputQueue().peek()).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes all entries", () => {
      const q = new SteeringInputQueue();
      q.enqueue(steering());
      q.enqueue(nonSteering());
      q.clear();
      expect(q.size).toBe(0);
      expect(q.hasPending()).toBe(false);
    });
  });

  describe("size", () => {
    it("reflects current entry count", () => {
      const q = new SteeringInputQueue();
      expect(q.size).toBe(0);
      q.enqueue(steering());
      expect(q.size).toBe(1);
      q.dequeueAll();
      expect(q.size).toBe(0);
    });
  });

  describe("capacity policy — steering priority", () => {
    it("steering message evicts oldest non-steering when full", () => {
      const q = new SteeringInputQueue(2);
      q.enqueue(nonSteering({ id: "n1" }));
      q.enqueue(nonSteering({ id: "n2" }));
      // queue full, both non-steering
      q.enqueue(steering({ id: "s1" }));
      // n1 should be evicted (oldest non-steering)
      expect(q.size).toBe(2);
      expect(q.peek()!.id).toBe("n2");
      expect(q.dequeueAll().map(e => e.id)).toEqual(["n2", "s1"]);
    });

    it("steering evicts oldest steering when all are steering", () => {
      const q = new SteeringInputQueue(2);
      q.enqueue(steering({ id: "s1" }));
      q.enqueue(steering({ id: "s2" }));
      q.enqueue(steering({ id: "s3" }));
      expect(q.size).toBe(2);
      expect(q.dequeueAll().map(e => e.id)).toEqual(["s2", "s3"]);
    });

    it("non-steering is dropped when full and all entries are steering", () => {
      const q = new SteeringInputQueue(2);
      q.enqueue(steering({ id: "s1" }));
      q.enqueue(steering({ id: "s2" }));
      q.enqueue(nonSteering({ id: "n1" }));
      expect(q.size).toBe(2);
      expect(q.dequeueAll().map(e => e.id)).toEqual(["s1", "s2"]);
    });

    it("non-steering evicts oldest non-steering when full with mixed entries", () => {
      const q = new SteeringInputQueue(2);
      q.enqueue(steering({ id: "s1" }));
      q.enqueue(nonSteering({ id: "n1" }));
      q.enqueue(nonSteering({ id: "n2" }));
      expect(q.size).toBe(2);
      // n1 (oldest non-steering) evicted, s1 stays
      expect(q.dequeueAll().map(e => e.id)).toEqual(["s1", "n2"]);
    });
  });

  describe("transferTo", () => {
    it("moves all entries to another queue", () => {
      const src = new SteeringInputQueue(10);
      const dst = new SteeringInputQueue(10);
      src.enqueue(steering({ id: "s1" }));
      src.enqueue(nonSteering({ id: "n1" }));

      src.transferTo(dst);
      expect(src.size).toBe(0);
      expect(dst.size).toBe(2);
      expect(dst.dequeueAll().map(e => e.id)).toEqual(["s1", "n1"]);
    });

    it("respects destination capacity", () => {
      const src = new SteeringInputQueue(10);
      const dst = new SteeringInputQueue(2);
      dst.enqueue(steering({ id: "s1" }));
      dst.enqueue(steering({ id: "s2" }));
      src.enqueue(nonSteering({ id: "n1" }));

      src.transferTo(dst);
      // dst is full with steering, non-steering n1 gets dropped
      expect(dst.size).toBe(2);
      expect(dst.dequeueAll().map(e => e.id)).toEqual(["s1", "s2"]);
    });

    it("moves steering to destination even when full if it can evict non-steering", () => {
      const src = new SteeringInputQueue(10);
      const dst = new SteeringInputQueue(2);
      dst.enqueue(nonSteering({ id: "n1" }));
      dst.enqueue(steering({ id: "s1" }));
      src.enqueue(steering({ id: "s2" }));
      src.enqueue(nonSteering({ id: "n2" }));

      src.transferTo(dst);
      // s2 fits (evicts n1), n2 gets dropped (dst full, all steering)
      expect(dst.size).toBe(2);
      expect(dst.dequeueAll().map(e => e.id)).toEqual(["s1", "s2"]);
    });
  });

  describe("default maxSize", () => {
    it("is 50", () => {
      expect(new SteeringInputQueue().size).toBe(0);
    });

    it("applies 50-entry pressure test", () => {
      const q = new SteeringInputQueue();
      for (let i = 0; i < 60; i++) {
        q.enqueue(nonSteering({ id: `n${i}` }));
      }
      expect(q.size).toBe(50);
    });

    it("allows steering to replace non-steering beyond capacity", () => {
      const q = new SteeringInputQueue(50);
      for (let i = 0; i < 50; i++) {
        q.enqueue(nonSteering({ id: `n${i}` }));
      }
      q.enqueue(steering({ id: "s1" }));
      expect(q.size).toBe(50);
      const ids = q.dequeueAll().map(e => e.id);
      // n0 should be evicted, s1 should be at the end
      expect(ids).not.toContain("n0");
      expect(ids[ids.length - 1]).toBe("s1");
    });
  });

  describe("concurrent-like behavior", () => {
    it("handles sequential enqueue/dequeue cycles", () => {
      const q = new SteeringInputQueue(5);
      const results: string[] = [];

      for (let round = 0; round < 3; round++) {
        q.enqueue(steering({ id: `s${round}` }));
        q.enqueue(nonSteering({ id: `n${round}` }));
        results.push(...q.dequeueAll().map(e => e.id));
      }

      expect(results).toEqual(["s0", "n0", "s1", "n1", "s2", "n2"]);
    });

    it("maintains order after multiple operations", () => {
      const q = new SteeringInputQueue(10);
      q.enqueue(steering({ id: "s1" }));
      q.enqueue(nonSteering({ id: "n1" }));
      q.dequeueByGroup("nonexistent");
      q.enqueue(steering({ id: "s2" }));
      q.withdraw(e => e.id === "n1");
      q.enqueue(nonSteering({ id: "n2" }));

      expect(q.dequeueAll().map(e => e.id)).toEqual(["s1", "s2", "n2"]);
    });
  });
});
