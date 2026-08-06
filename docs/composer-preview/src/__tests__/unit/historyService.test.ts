import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryServiceImpl } from '../../services/history/historyService';
import { SAMPLE_AST_FIXTURE } from '../harness/fixtures';
import { JSONContent } from '@tiptap/core';

describe('Document History & Snapshot Engine (Features 46-48)', () => {
  let historyService: HistoryServiceImpl;

  beforeEach(() => {
    historyService = new HistoryServiceImpl();
  });

  it('Feature 46: should create and retrieve document history snapshots', () => {
    const snap1 = historyService.createSnapshot(SAMPLE_AST_FIXTURE, 'Initial Draft');

    expect(snap1.id).toBeDefined();
    expect(snap1.label).toBe('Initial Draft');
    expect(snap1.timestamp).toBeDefined();

    const snapshots = historyService.getSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe(snap1.id);
  });

  it('Feature 48: should perform one-click version restoration to selected snapshot', () => {
    const snap1 = historyService.createSnapshot(SAMPLE_AST_FIXTURE, 'v1.0');

    // Create modified AST
    const modifiedAST: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Modified Heading' }],
        },
      ],
    };
    historyService.createSnapshot(modifiedAST, 'v2.0');

    expect(historyService.getSnapshots()).toHaveLength(2);

    // Rollback to v1.0 snapshot
    const restoredAST = historyService.rollbackToSnapshot(snap1.id);
    expect(restoredAST).toEqual(SAMPLE_AST_FIXTURE);
    expect(restoredAST).not.toEqual(modifiedAST);
  });

  it('Feature 47: should compute visual diff metrics between two snapshots', () => {
    const snap1 = historyService.createSnapshot(SAMPLE_AST_FIXTURE, 'v1.0');

    const expandedAST: JSONContent = {
      type: 'doc',
      content: [
        ...SAMPLE_AST_FIXTURE.content!,
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Additional paragraph' }],
        },
      ],
    };
    const snap2 = historyService.createSnapshot(expandedAST, 'v2.0');

    const diff = historyService.diffSnapshots(snap1.id, snap2.id);
    expect(diff.addedNodes).toBe(1);
    expect(diff.removedNodes).toBe(0);
    expect(diff.diffSummary).toContain('v1.0 and v2.0');
  });

  it('Tier 2: should throw explicit error when rolling back to non-existent snapshot ID', () => {
    expect(() => historyService.rollbackToSnapshot('non_existent_id')).toThrow(
      'Snapshot non_existent_id not found'
    );
  });
});
