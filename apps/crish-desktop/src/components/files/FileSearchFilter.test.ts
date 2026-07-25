import { describe, expect, it } from 'vitest';
import { filterTreeNodes, filterBcFlyoutEntries } from './FileSearchFilter';
import type { FsDirEntry } from '../../api/workspaceFsApi';

describe('FileSearchFilter', () => {
  const sampleEntries: FsDirEntry[] = [
    { name: 'src', path: '/project/src', isDir: true },
    { name: 'package.json', path: '/project/package.json', isDir: false, size: 1024 },
    { name: 'README.md', path: '/project/README.md', isDir: false, size: 512 },
  ];

  const childEntries: FsDirEntry[] = [
    { name: 'components', path: '/project/src/components', isDir: true },
    { name: 'index.ts', path: '/project/src/index.ts', isDir: false, size: 256 },
  ];

  describe('filterTreeNodes', () => {
    it('returns flat list with depth when filter is empty', () => {
      const expanded = { '/project/src': childEntries };
      const result = filterTreeNodes(sampleEntries, expanded, '');

      expect(result).toHaveLength(5);
      expect(result[0]).toEqual({ name: 'src', path: '/project/src', isDir: true, depth: 0 });
      expect(result[1]).toEqual({ name: 'components', path: '/project/src/components', isDir: true, depth: 1 });
      expect(result[2]).toEqual({ name: 'index.ts', path: '/project/src/index.ts', isDir: false, size: 256, depth: 1 });
      expect(result[3]).toEqual({ name: 'package.json', path: '/project/package.json', isDir: false, size: 1024, depth: 0 });
      expect(result[4]).toEqual({ name: 'README.md', path: '/project/README.md', isDir: false, size: 512, depth: 0 });
    });

    it('filters nodes case-insensitively', () => {
      const expanded = { '/project/src': childEntries };
      const result = filterTreeNodes(sampleEntries, expanded, 'INDEX');

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('index.ts');
    });

    it('returns empty array when no node matches filter', () => {
      const result = filterTreeNodes(sampleEntries, {}, 'nonexistent');
      expect(result).toHaveLength(0);
    });

    it('handles unexpanded directory list', () => {
      const result = filterTreeNodes(sampleEntries, {}, '');
      expect(result).toHaveLength(3);
      expect(result.every((n) => n.depth === 0)).toBe(true);
    });
  });

  describe('filterBcFlyoutEntries', () => {
    const unsortedEntries: FsDirEntry[] = [
      { name: 'zebra.txt', path: '/project/zebra.txt', isDir: false },
      { name: 'docs', path: '/project/docs', isDir: true },
      { name: 'alpha.txt', path: '/project/alpha.txt', isDir: false },
      { name: 'src', path: '/project/src', isDir: true },
    ];

    it('sorts directories first, then alphabetically', () => {
      const result = filterBcFlyoutEntries(unsortedEntries, '');
      expect(result.map((e) => e.name)).toEqual(['docs', 'src', 'alpha.txt', 'zebra.txt']);
    });

    it('filters items by query before sorting', () => {
      const result = filterBcFlyoutEntries(unsortedEntries, 'A');
      expect(result.map((e) => e.name)).toEqual(['alpha.txt', 'zebra.txt']);
    });

    it('returns empty array for empty entries input', () => {
      const result = filterBcFlyoutEntries([], 'test');
      expect(result).toEqual([]);
    });
  });
});
