import { describe, expect, it } from 'vitest';
import type { MenuGroup, MenuItem } from '../types';
import { filterSmartPanelItems } from '../smartPanelFilter';

const items = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', sublabel: 'second' },
  {
    id: 'g',
    label: 'Group',
    items: [
      { id: 'g1', label: 'Gamma', searchKeywords: 'third' },
      { id: 'g2', label: 'Delta' },
    ],
  },
] as unknown as Array<MenuItem | MenuGroup>;

describe('filterSmartPanelItems', () => {
  it('空查询原样返回同一引用', () => {
    expect(filterSmartPanelItems(items, '  ')).toBe(items);
  });

  it('按 label / sublabel / searchKeywords 大小写不敏感匹配', () => {
    expect(filterSmartPanelItems(items, 'ALPHA').map((i) => i.id)).toEqual([
      'a',
    ]);
    expect(filterSmartPanelItems(items, 'second').map((i) => i.id)).toEqual([
      'b',
    ]);
  });

  it('分组只保留命中子项，整组无命中则剔除', () => {
    const out = filterSmartPanelItems(items, 'third');
    expect(out).toHaveLength(1);
    expect((out[0] as MenuGroup).items.map((i) => i.id)).toEqual(['g1']);
    expect(filterSmartPanelItems(items, 'zzz')).toEqual([]);
  });
});
