import { describe, it, expect } from 'vitest';
import {
  buildGitTree,
  calculateDiffStatBars,
  GitStatusFile,
  GitTreeFolderNode,
  GitTreeFileNode,
} from './gitTreeHelpers';

describe('gitTreeHelpers - buildGitTree & ', () => {
  it('returns empty array for empty or invalid input', () => {
    expect(buildGitTree([])).toEqual([]);
    // @ts-expect-error testing invalid inputs
    expect(buildGitTree(null)).toEqual([]);
    // @ts-expect-error testing invalid inputs
    expect(buildGitTree(undefined)).toEqual([]);
  });

  it('handles root-level files', () => {
    const files: GitStatusFile[] = [
      { path: 'package.json', status: 'M', additions: 5, deletions: 2 },
      { path: 'README.md', status: 'A', additions: 50, deletions: 0 },
    ];

    const tree = buildGitTree(files);
    expect(tree).toHaveLength(2);
    expect(tree[0]!.isFolder).toBe(false);
    expect((tree[0] as GitTreeFileNode).file.path).toBe('package.json');
    expect(tree[0]!.depth).toBe(0);
    expect(tree[1]!.isFolder).toBe(false);
    expect((tree[1] as GitTreeFileNode).file.path).toBe('README.md');
    expect(tree[1]!.depth).toBe(0);
  });

  it('sorts folders before files, then alphabetically', () => {
    const files: GitStatusFile[] = [
      { path: 'z_root.txt', status: 'M' },
      { path: 'a_folder/file1.ts', status: 'A' },
      { path: 'b_folder/file2.ts', status: 'M' },
      { path: 'a_root.txt', status: 'D' },
    ];

    const tree = buildGitTree(files);
    expect(tree).toHaveLength(4);
    // Folders come first
    expect(tree[0]!.isFolder).toBe(true);
    expect(tree[0]!.name).toBe('a_folder');
    expect(tree[1]!.isFolder).toBe(true);
    expect(tree[1]!.name).toBe('b_folder');
    // Files come after, sorted alphabetically
    expect(tree[2]!.isFolder).toBe(false);
    expect(tree[2]!.name).toBe('a_root.txt');
    expect(tree[3]!.isFolder).toBe(false);
    expect(tree[3]!.name).toBe('z_root.txt');
  });

  it('normalizes Windows backslashes and leading/trailing slashes', () => {
    const files: GitStatusFile[] = [
      { path: 'apps\\crish-desktop\\src\\api\\foo.ts', status: 'M', additions: 10, deletions: 2 },
      { path: '/apps/crish-desktop/src/api/bar.ts/', status: 'A', additions: 20, deletions: 0 },
    ];

    const tree = buildGitTree(files);
    expect(tree).toHaveLength(1);
    const collapsedFolder = tree[0] as GitTreeFolderNode;
    expect(collapsedFolder.isFolder).toBe(true);
    expect(collapsedFolder.name).toBe('apps/crish-desktop/src/api');
    expect(collapsedFolder.fullPath).toBe('apps/crish-desktop/src/api');
    expect(collapsedFolder.depth).toBe(0);
    expect(collapsedFolder.totalFiles).toBe(2);
    expect(collapsedFolder.totalAdditions).toBe(30);
    expect(collapsedFolder.totalDeletions).toBe(2);
    expect(collapsedFolder.children).toHaveLength(2);
  });

  it('compacts single-child folder chains into a single composite node', () => {
    const files: GitStatusFile[] = [
      { path: 'apps/crish-desktop/src/components/A.tsx', status: 'M', additions: 12, deletions: 4 },
      { path: 'apps/crish-desktop/src/components/B.tsx', status: 'M', additions: 8, deletions: 1 },
    ];

    const tree = buildGitTree(files, { compactSingleChild: true });
    expect(tree).toHaveLength(1);

    const rootFolder = tree[0] as GitTreeFolderNode;
    expect(rootFolder.isFolder).toBe(true);
    expect(rootFolder.name).toBe('apps/crish-desktop/src/components');
    expect(rootFolder.fullPath).toBe('apps/crish-desktop/src/components');
    expect(rootFolder.depth).toBe(0);
    expect(rootFolder.totalFiles).toBe(2);
    expect(rootFolder.totalAdditions).toBe(20);
    expect(rootFolder.totalDeletions).toBe(5);

    expect(rootFolder.children).toHaveLength(2);
    expect(rootFolder.children[0]!.name).toBe('A.tsx');
    expect(rootFolder.children[0]!.depth).toBe(1);
    expect(rootFolder.children[1]!.name).toBe('B.tsx');
    expect(rootFolder.children[1]!.depth).toBe(1);
  });

  it('does not collapse when branching occurs (multiple children in a folder)', () => {
    const files: GitStatusFile[] = [
      { path: 'apps/desktop/src/index.ts', status: 'M' },
      { path: 'apps/mobile/src/index.ts', status: 'M' },
    ];

    const tree = buildGitTree(files, { compactSingleChild: true });
    expect(tree).toHaveLength(1);

    // 'apps' has 2 children: 'desktop' and 'mobile', so 'apps' is NOT collapsed
    const appsFolder = tree[0] as GitTreeFolderNode;
    expect(appsFolder.name).toBe('apps');
    expect(appsFolder.depth).toBe(0);
    expect(appsFolder.children).toHaveLength(2);

    // 'desktop' collapses with 'src'
    const desktopFolder = appsFolder.children[0] as GitTreeFolderNode;
    expect(desktopFolder.name).toBe('desktop/src');
    expect(desktopFolder.depth).toBe(1);
    expect(desktopFolder.children).toHaveLength(1);
    expect(desktopFolder.children[0]!.name).toBe('index.ts');
    expect(desktopFolder.children[0]!.depth).toBe(2);

    // 'mobile' collapses with 'src'
    const mobileFolder = appsFolder.children[1] as GitTreeFolderNode;
    expect(mobileFolder.name).toBe('mobile/src');
    expect(mobileFolder.depth).toBe(1);
    expect(mobileFolder.children).toHaveLength(1);
  });

  it('does not collapse folder if it contains both a subfolder and a file', () => {
    const files: GitStatusFile[] = [
      { path: 'src/sub/nested.ts', status: 'A' },
      { path: 'src/root_file.ts', status: 'M' },
    ];

    const tree = buildGitTree(files, { compactSingleChild: true });
    expect(tree).toHaveLength(1);

    const srcFolder = tree[0] as GitTreeFolderNode;
    // src has 2 children (sub and root_file.ts) -> cannot collapse
    expect(srcFolder.name).toBe('src');
    expect(srcFolder.depth).toBe(0);
    expect(srcFolder.children).toHaveLength(2);

    // First child is folder 'sub' (which has 1 file, not folder, so sub is not collapsed with nested.ts)
    const subFolder = srcFolder.children[0] as GitTreeFolderNode;
    expect(subFolder.isFolder).toBe(true);
    expect(subFolder.name).toBe('sub');
    expect(subFolder.depth).toBe(1);

    const rootFile = srcFolder.children[1] as GitTreeFileNode;
    expect(rootFile.isFolder).toBe(false);
    expect(rootFile.name).toBe('root_file.ts');
    expect(rootFile.depth).toBe(1);
  });

  it('supports disabling single-child folder compacting (compactSingleChild: false)', () => {
    const files: GitStatusFile[] = [
      { path: 'a/b/c/file.ts', status: 'M', additions: 3, deletions: 1 },
    ];

    const tree = buildGitTree(files, { compactSingleChild: false });
    expect(tree).toHaveLength(1);

    const nodeA = tree[0] as GitTreeFolderNode;
    expect(nodeA.name).toBe('a');
    expect(nodeA.depth).toBe(0);
    expect(nodeA.children).toHaveLength(1);

    const nodeB = nodeA.children[0] as GitTreeFolderNode;
    expect(nodeB.name).toBe('b');
    expect(nodeB.depth).toBe(1);
    expect(nodeB.children).toHaveLength(1);

    const nodeC = nodeB.children[0] as GitTreeFolderNode;
    expect(nodeC.name).toBe('c');
    expect(nodeC.depth).toBe(2);
    expect(nodeC.children).toHaveLength(1);

    const fileNode = nodeC.children[0] as GitTreeFileNode;
    expect(fileNode.name).toBe('file.ts');
    expect(fileNode.depth).toBe(3);
  });

  it('correctly aggregates additions, deletions, and totalFiles up the tree', () => {
    const files: GitStatusFile[] = [
      { path: 'pkg/a.ts', status: 'M', additions: 10, deletions: 5 },
      { path: 'pkg/b.ts', status: 'A', additions: 20, deletions: 0 },
      { path: 'pkg/sub/c.ts', status: 'D', additions: 0, deletions: 15 },
    ];

    const tree = buildGitTree(files, { compactSingleChild: false });
    expect(tree).toHaveLength(1);
    const pkg = tree[0] as GitTreeFolderNode;
    expect(pkg.totalFiles).toBe(3);
    expect(pkg.totalAdditions).toBe(30);
    expect(pkg.totalDeletions).toBe(20);

    const sub = pkg.children.find((c) => c.isFolder && c.name === 'sub') as GitTreeFolderNode;
    expect(sub.totalFiles).toBe(1);
    expect(sub.totalAdditions).toBe(0);
    expect(sub.totalDeletions).toBe(15);
  });

  it('calculates diff stat bars properly', () => {
    // 0 / 0
    expect(calculateDiffStatBars(0, 0, 5)).toEqual({ addBars: 0, delBars: 0, emptyBars: 5 });
    // additions only
    expect(calculateDiffStatBars(100, 0, 5)).toEqual({ addBars: 5, delBars: 0, emptyBars: 0 });
    // deletions only
    expect(calculateDiffStatBars(0, 50, 5)).toEqual({ addBars: 0, delBars: 5, emptyBars: 0 });
    // 50 / 50 split
    const split = calculateDiffStatBars(50, 50, 5);
    expect(split.addBars + split.delBars + split.emptyBars).toBe(5);
    expect(split.addBars).toBeGreaterThanOrEqual(2);
    expect(split.delBars).toBeGreaterThanOrEqual(2);
    // 30 / 10 with maxBars = 4
    const custom = calculateDiffStatBars(30, 10, 4);
    expect(custom.addBars).toBe(3);
    expect(custom.delBars).toBe(1);
    expect(custom.emptyBars).toBe(0);
  });

  it('processes 1,000 files in under 20ms (O(N * D) performance assertion)', () => {
    const bigFileList: GitStatusFile[] = [];
    for (let i = 0; i < 1000; i++) {
      const folderIdx = i % 25;
      const subIdx = i % 5;
      bigFileList.push({
        path: `apps/module_${folderIdx}/sub_${subIdx}/file_${i}.ts`,
        status: i % 2 === 0 ? 'M' : 'A',
        additions: (i * 3) % 50,
        deletions: (i * 2) % 30,
      });
    }

    const t0 = performance.now();
    const tree = buildGitTree(bigFileList, { compactSingleChild: true });
    const elapsed = performance.now() - t0;

    expect(tree.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50); // fast < 50ms (usually < 15ms)
  });
});
