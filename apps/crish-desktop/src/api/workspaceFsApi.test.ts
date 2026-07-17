import { describe, expect, it } from 'vitest';
import {
  detectFileKind,
  FILE_PREVIEW_CHUNK_LINES,
  FILE_PREVIEW_MAX_LINES,
  isMarkdownFilename,
  nextFilePreviewLineBudget,
  pathBasename,
  pathRelativeToRoot,
} from './workspaceFsApi';

describe('detectFileKind', () => {
  it('classifies image / pdf / table / text / binary', () => {
    expect(detectFileKind('shot.png')).toBe('image');
    expect(detectFileKind('doc.PDF')).toBe('pdf');
    expect(detectFileKind('data.csv')).toBe('table');
    expect(detectFileKind('app.tsx')).toBe('text');
    expect(detectFileKind('readme.md')).toBe('text');
    expect(detectFileKind('archive.zip')).toBe('binary');
  });
});

describe('isMarkdownFilename', () => {
  it('accepts md / markdown / mdx only', () => {
    expect(isMarkdownFilename('a.md')).toBe(true);
    expect(isMarkdownFilename('a.markdown')).toBe(true);
    expect(isMarkdownFilename('a.mdx')).toBe(true);
    expect(isMarkdownFilename('a.tsx')).toBe(false);
    expect(isMarkdownFilename('')).toBe(false);
  });
});

describe('nextFilePreviewLineBudget', () => {
  it('steps by chunk and caps at max', () => {
    expect(nextFilePreviewLineBudget(0)).toBe(FILE_PREVIEW_CHUNK_LINES);
    expect(nextFilePreviewLineBudget(FILE_PREVIEW_CHUNK_LINES)).toBe(
      FILE_PREVIEW_CHUNK_LINES * 2,
    );
    expect(
      nextFilePreviewLineBudget(FILE_PREVIEW_MAX_LINES - 50, 400, FILE_PREVIEW_MAX_LINES),
    ).toBe(FILE_PREVIEW_MAX_LINES);
    expect(nextFilePreviewLineBudget(FILE_PREVIEW_MAX_LINES)).toBeNull();
  });

  it('rejects zero/negative step via floor clamp to 1', () => {
    expect(nextFilePreviewLineBudget(10, 0, 100)).toBe(11);
  });
});

describe('path helpers', () => {
  it('basename and relative-to-root', () => {
    expect(pathBasename('C:/repo/src/a.ts')).toBe('a.ts');
    expect(pathRelativeToRoot('C:/repo/src/a.ts', 'C:/repo')).toBe('src/a.ts');
    expect(pathRelativeToRoot('C:/repo', 'C:/repo')).toBe('.');
  });
});
