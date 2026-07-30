import { describe, expect, it } from 'vitest';
import {
  budgetTextForContext,
  budgetToolOutputForContext,
} from './tool-output-budget';

describe('tool output budgeting', () => {
  it('leaves short output unchanged', () => {
    const output = { text: 'small result' };

    expect(budgetToolOutputForContext(output, { inlineChars: 100 })).toBe(
      output
    );
  });

  it('keeps head and tail for long text with omission metadata', () => {
    const budgeted = budgetTextForContext(
      'a'.repeat(400) + 'MIDDLE' + 'z'.repeat(400),
      {
        inlineChars: 300,
        headRatio: 0.5,
      }
    );

    expect(budgeted.truncated).toBe(true);
    expect(budgeted.text.startsWith('a'.repeat(150))).toBe(true);
    expect(budgeted.text.endsWith('z'.repeat(150))).toBe(true);
    expect(budgeted.omittedChars).toBeGreaterThan(0);
  });

  it('preserves artifacts while replacing the model-facing text', () => {
    const output = budgetToolOutputForContext(
      {
        text: 'x'.repeat(120),
        artifacts: [{ kind: 'log', title: 'full log', uri: 'artifact://log' }],
      },
      { inlineChars: 80, toolName: 'shell_command' }
    );

    expect(output.text).toContain('characters omitted');
    expect(output.artifacts?.[0]?.title).toBe('full log');
    expect(output.json).toMatchObject({
      contextBudget: {
        toolName: 'shell_command',
        truncated: true,
        originalChars: 120,
      },
    });
  });
});
