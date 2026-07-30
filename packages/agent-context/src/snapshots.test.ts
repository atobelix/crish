import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFileSnapshot,
  joinUnderRoot,
  resolveArchiveRoot,
  resolveSnapshotLocation,
  resolveUnderRoot,
  restoreFileSnapshot,
  toRelativePosix,
} from './snapshots';

describe('snapshots path safety', () => {
  let workspaceRoot = '';

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-snap-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('toRelativePosix never double-prefixes workspace root', () => {
    const abs = resolve(workspaceRoot, 'src', 'a.ts');
    const rel = toRelativePosix(workspaceRoot, abs);
    expect(rel).toBe('src/a.ts');
    expect(rel.toLowerCase()).not.toContain(
      workspaceRoot.replace(/\\/g, '/').toLowerCase()
    );
  });

  it('resolveUnderRoot accepts absolute and relative without double-prefix', () => {
    const abs = resolve(workspaceRoot, 'nested', 'f.txt');
    expect(resolveUnderRoot(workspaceRoot, abs, 'file')).toBe(abs);
    expect(resolveUnderRoot(workspaceRoot, 'nested/f.txt', 'file')).toBe(abs);
    expect(
      resolveUnderRoot(workspaceRoot, join('nested', 'f.txt'), 'file')
    ).toBe(abs);
  });

  it('resolveUnderRoot rejects path escape', () => {
    expect(() =>
      resolveUnderRoot(workspaceRoot, '../outside.txt', 'file')
    ).toThrow(/escapes/);
  });

  it('joinUnderRoot rejects absolute mid-segment (prevents archive collapse)', () => {
    const archive = resolveArchiveRoot(workspaceRoot);
    expect(() =>
      joinUnderRoot(archive, absDriveLike(workspaceRoot, 'src/a.ts'))
    ).toThrow(/absolute path segment/);
  });

  it('createFileSnapshot writes under archive, not onto source (no absolute collapse)', async () => {
    const source = join(workspaceRoot, 'src', 'tracked.txt');
    await mkdir(join(workspaceRoot, 'src'), { recursive: true });
    await writeFile(source, 'before', 'utf8');

    const artifact = await createFileSnapshot({
      workspaceRoot,
      filePath: source,
      sessionId: 'sess-1',
      toolCallId: 'tool-1',
    });

    expect(artifact).toBeTruthy();
    expect(artifact?.uri).toBeTruthy();
    expect(artifact?.uri).not.toBe(source);
    expect(artifact?.uri).toContain(join('.agent-runtime', 'snapshots'));
    expect(String(artifact?.metadata?.sourcePath)).toBe('src/tracked.txt');
    expect(String(artifact?.metadata?.snapshotRelativePath || '')).toMatch(
      /^sess-1\//
    );

    // source unchanged until caller overwrites
    await expect(readFile(source, 'utf8')).resolves.toBe('before');

    // snapshot content is the pre-image
    await expect(readFile(String(artifact?.uri), 'utf8')).resolves.toBe(
      'before'
    );
  });

  it('restore accepts absolute uri and archive-relative path without double-prefix', async () => {
    const source = join(workspaceRoot, 'tracked.txt');
    await writeFile(source, 'v1', 'utf8');

    const artifact = await createFileSnapshot({
      workspaceRoot,
      filePath: 'tracked.txt',
      sessionId: 'sess-2',
      toolCallId: 'tool-2',
    });
    const absoluteSnap = String(artifact?.uri);
    const relativeSnap = String(artifact?.metadata?.snapshotRelativePath);

    await writeFile(source, 'v2', 'utf8');
    await restoreFileSnapshot({
      workspaceRoot,
      snapshotPath: absoluteSnap,
      targetPath: 'tracked.txt',
    });
    await expect(readFile(source, 'utf8')).resolves.toBe('v1');

    await writeFile(source, 'v3', 'utf8');
    await restoreFileSnapshot({
      workspaceRoot,
      snapshotPath: relativeSnap,
      targetPath: 'tracked.txt',
    });
    await expect(readFile(source, 'utf8')).resolves.toBe('v1');
  });

  it('resolveSnapshotLocation does not prefix archive twice for absolute paths', () => {
    const archive = resolveArchiveRoot(workspaceRoot);
    const inside = joinUnderRoot(archive, 'sess', 'stamp', 'file.txt');
    expect(resolveSnapshotLocation(archive, inside)).toBe(inside);
    const rel = toRelativePosix(archive, inside);
    expect(resolveSnapshotLocation(archive, rel)).toBe(inside);
  });
});

/** Helper: produce a path that looks absolute for joinUnderRoot rejection tests */
function absDriveLike(workspaceRoot: string, rel: string): string {
  return resolve(workspaceRoot, rel);
}
