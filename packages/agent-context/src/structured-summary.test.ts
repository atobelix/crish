import { describe, expect, it } from 'vitest';
import {
  createStructuredSummary,
  mergeStructuredSummaries,
  parseStructuredSummaryJson,
  renderStructuredSummary,
  structuredSummaryCacheKey,
  structuredSummaryToJson,
} from './structured-summary';

describe('structured summary', () => {
  it('normalizes summary fields into a stable cacheable shape', () => {
    const first = createStructuredSummary({
      kind: 'context-compression',
      goal: '  Finish daemon run ownership  ',
      progress: [' Runtime path exists ', 'runtime path exists'],
      readFiles: ['src\\b.ts', 'src/a.ts'],
      modifiedFiles: ['src/z.ts', 'src/z.ts'],
    });
    const second = createStructuredSummary({
      kind: 'context-compression',
      goal: 'Finish daemon run ownership',
      progress: ['Runtime path exists'],
      readFiles: ['src/a.ts', 'src/b.ts'],
      modifiedFiles: ['src/z.ts'],
    });

    expect(first).toEqual(second);
    expect(first.stableHash).toHaveLength(32);
    expect(structuredSummaryCacheKey(first)).toBe(
      `structured-summary:v1:${first.stableHash}`
    );
  });

  it('roundtrips through JSON while ignoring unknown fields', () => {
    const summary = createStructuredSummary({
      kind: 'branch-summary',
      goal: 'Keep branch context',
      decisions: ['Use daemon as source of truth'],
      sourceIds: ['event_1'],
    });
    const parsed = parseStructuredSummaryJson(
      JSON.stringify({
        ...JSON.parse(structuredSummaryToJson(summary)),
        unknown: 'ignored',
      })
    );

    expect(parsed).toEqual(summary);
  });

  it('merges summaries without duplicating stable facts', () => {
    const merged = mergeStructuredSummaries(
      {
        kind: 'context-compression',
        goal: 'Ship rewind',
        progress: ['Manifest landed'],
        nextSteps: ['Daemon API'],
        modifiedFiles: ['packages/agent-runtime/src/manifest.ts'],
      },
      {
        kind: 'context-compression',
        progress: ['manifest landed', 'Preview API drafted'],
        nextSteps: ['Daemon API', 'Workbench button'],
        modifiedFiles: ['packages/agent-daemon/src/server-handlers.ts'],
      }
    );

    expect(merged.progress).toEqual(['Manifest landed', 'Preview API drafted']);
    expect(merged.nextSteps).toEqual(['Daemon API', 'Workbench button']);
    expect(merged.modifiedFiles).toEqual([
      'packages/agent-daemon/src/server-handlers.ts',
      'packages/agent-runtime/src/manifest.ts',
    ]);
  });

  it('renders all sections deterministically for model-visible context', () => {
    const rendered = renderStructuredSummary({
      kind: 'subagent-task',
      goal: 'Verify Workbench projector',
      constraints: ['Do not touch daemon'],
      progress: ['Replay path uses projector'],
      decisions: ['Keep daemon snapshot authoritative'],
      nextSteps: ['Run workbench check'],
      criticalContext: ['approval ids normalize at bridge boundary'],
      readFiles: ['apps/agent-workbench/src/core/app-state.ts'],
      pendingQuestions: ['Should sidebar display recent approvals?'],
      risks: ['ChatPanel still has local side effects'],
      sourceIds: ['run_1'],
    });

    expect(rendered).toContain(
      '<structured_summary version="1" kind="subagent-task"'
    );
    expect(rendered).toContain('## Goal\nVerify Workbench projector');
    expect(rendered).toContain('## Modified Files\n- None');
    expect(rendered.indexOf('## Progress')).toBeLessThan(
      rendered.indexOf('## Decisions')
    );
  });
});
