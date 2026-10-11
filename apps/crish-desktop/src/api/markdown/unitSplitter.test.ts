// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { splitHtmlIntoUnits } from './unitSplitter';

describe('splitHtmlIntoUnits', () => {
  it('preserves rendered element and text-node nesting as structural units', () => {
    const units = splitHtmlIntoUnits(
      '<p class="md-p">任务 <strong>正在进行</strong></p>\n' +
        '<div class="md-table-wrap"><table class="md-table"><thead>' +
        '<tr><th scope="col">任务</th></tr></thead><tbody>' +
        '<tr><td>编译中</td></tr></tbody></table></div>'
    );

    expect(units.map((unit) => unit.kind)).toEqual([
      'paragraph',
      'text',
      'html',
    ]);
    expect(units[0]?.children.length).toBeGreaterThan(0);
    expect(units[0]?.children.map((unit) => unit.kind)).toEqual([
      'text',
      'other',
    ]);
    expect(units[2]?.children[0]?.kind).toBe('table');
    expect(units[2]?.children[0]?.children.map((unit) => unit.tagName)).toEqual([
      'THEAD',
      'TBODY',
    ]);
    expect(units[2]?.children[0]?.children[1]?.children[0]?.tagName).toBe('TR');
  });

  it('returns no units for empty renderer output', () => {
    expect(splitHtmlIntoUnits('')).toEqual([]);
  });
});
