import type { JSONContent } from '@tiptap/core';

export interface Snapshot {
  id: string;
  timestamp: string;
  label: string;
  content: JSONContent;
}

export interface VisualDiffResult {
  addedNodes: number;
  removedNodes: number;
  unmodifiedNodes: number;
  diffSummary: string;
}

export class HistoryServiceImpl {
  private snapshots: Snapshot[] = [];

  createSnapshot(doc: JSONContent, label: string = 'Auto Save'): Snapshot {
    const snapshot: Snapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      label,
      content: JSON.parse(JSON.stringify(doc)),
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  getSnapshots(): Snapshot[] {
    return [...this.snapshots];
  }

  rollbackToSnapshot(id: string): JSONContent {
    const found = this.snapshots.find((s) => s.id === id);
    if (!found) {
      throw new Error(`Snapshot ${id} not found`);
    }
    return JSON.parse(JSON.stringify(found.content));
  }

  diffSnapshots(idA: string, idB: string): VisualDiffResult {
    const snapA = this.snapshots.find((s) => s.id === idA);
    const snapB = this.snapshots.find((s) => s.id === idB);

    if (!snapA || !snapB) {
      throw new Error('Invalid snapshot IDs for diffing');
    }

    const countA = snapA.content.content?.length || 0;
    const countB = snapB.content.content?.length || 0;

    return {
      addedNodes: Math.max(0, countB - countA),
      removedNodes: Math.max(0, countA - countB),
      unmodifiedNodes: Math.min(countA, countB),
      diffSummary: `Comparison between ${snapA.label} and ${snapB.label}: ${countB - countA} node change(s).`,
    };
  }

  clearSnapshots(): void {
    this.snapshots = [];
  }
}
