export interface MessageAttachment {
  type: string;
  data: unknown;
  mimeType?: string;
}

export interface SteeringInputEntry {
  id: string;
  sessionId: string;
  text: string;
  attachments?: MessageAttachment[];
  enqueuedAt: number;
  groupId?: string;
  isSteering: boolean;
}

const DEFAULT_MAX_SIZE = 50;

export class SteeringInputQueue {
  private readonly entries: SteeringInputEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  enqueue(entry: SteeringInputEntry): void {
    if (this.entries.length >= this.maxSize) {
      this.evictFor(entry);
    }
    if (this.entries.length < this.maxSize) {
      this.entries.push(entry);
    }
  }

  dequeueAll(): SteeringInputEntry[] {
    const result = [...this.entries];
    this.entries.length = 0;
    return result;
  }

  dequeueByGroup(groupId: string): SteeringInputEntry[] {
    const matched: SteeringInputEntry[] = [];
    const remaining: SteeringInputEntry[] = [];
    for (const e of this.entries) {
      if (e.groupId === groupId) {
        matched.push(e);
      } else {
        remaining.push(e);
      }
    }
    this.entries.length = 0;
    this.entries.push(...remaining);
    return matched;
  }

  withdraw(predicate: (entry: SteeringInputEntry) => boolean): SteeringInputEntry[] {
    const matched: SteeringInputEntry[] = [];
    const remaining: SteeringInputEntry[] = [];
    for (const e of this.entries) {
      if (predicate(e)) {
        matched.push(e);
      } else {
        remaining.push(e);
      }
    }
    this.entries.length = 0;
    this.entries.push(...remaining);
    return matched;
  }

  replaceOrEnqueue(entry: SteeringInputEntry): boolean {
    if (entry.groupId !== undefined) {
      const idx = this.entries.findIndex(e => e.groupId === entry.groupId);
      if (idx !== -1) {
        this.entries[idx] = entry;
        return true;
      }
    }
    this.enqueue(entry);
    return false;
  }

  hasPending(): boolean {
    return this.entries.length > 0;
  }

  hasPendingSteering(): boolean {
    return this.entries.some(e => e.isSteering);
  }

  peek(): SteeringInputEntry | undefined {
    return this.entries[0];
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }

  transferTo(other: SteeringInputQueue): void {
    for (const entry of this.entries) {
      other.enqueue(entry);
    }
    this.entries.length = 0;
  }

  private evictFor(entry: SteeringInputEntry): void {
    const idx = this.entries.findIndex(e => !e.isSteering);
    if (idx !== -1) {
      this.entries.splice(idx, 1);
    } else if (entry.isSteering) {
      this.entries.shift();
    }
  }
}
