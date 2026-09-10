import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectFileKind,
  FILE_PREVIEW_CHUNK_LINES,
  FILE_PREVIEW_MAX_LINES,
  isMarkdownFilename,
  nextFilePreviewLineBudget,
  pathBasename,
  pathRelativeToRoot,
  resolveWorkspacePath,
  assertWorkspacePath,
  isInsideWorkspace,
  toAssetUrl,
  writeTextFile,
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

describe('resolveWorkspacePath（14-T3：工作区根前缀匹配边界修复）', () => {
  // WORKSPACE_KEY 对齐 projectStore.ts:23（getWorkspacePath 读 localStorage 真实实现）
  const WORKSPACE_KEY = 'crish_workspace';

  beforeEach(() => {
    localStorage.setItem(WORKSPACE_KEY, 'c:/work');
  });

  it.each([
    // 兄弟前缀目录（根 c:/work 时 c:/workspace 非子路径，必须拒绝）
    'c:/workspace/x.txt',
    'c:/workspace',
    'c:/workspace/',
    // 前缀碰撞变体（root 再续字符仍非子路径）
    'c:/workx/x.txt',
    'c:/work-extra/a.txt',
  ])('越界拒绝（根 c:/work）：%s', (p) => {
    expect(resolveWorkspacePath(p)).toBe('');
  });

  it.each(['c:/work', 'c:/work/', 'C:/WORK/', 'c:\\work\\'])('根自身放行（尾斜杠归一）：%s', (p) => {
    expect(resolveWorkspacePath(p)).toBe(p);
  });

  it.each(['c:/work/x.txt', 'c:/work/sub/x.txt', 'C:/WORK/X.TXT'])('根下子路径放行：%s', (p) => {
    expect(resolveWorkspacePath(p)).toBe(p);
  });

  it('大小写不敏感：根与路径大小写互换均放行', () => {
    localStorage.setItem(WORKSPACE_KEY, 'C:/Work');
    expect(resolveWorkspacePath('c:/work/x.txt')).toBe('c:/work/x.txt');
    expect(resolveWorkspacePath('c:/work')).toBe('c:/work');
  });

  it('相对路径拼接到工作区根下', () => {
    expect(resolveWorkspacePath('x.txt')).toBe('c:/work/x.txt');
    expect(resolveWorkspacePath('./x.txt')).toBe('c:/work/x.txt');
    expect(resolveWorkspacePath('sub/dir/x.txt')).toBe('c:/work/sub/dir/x.txt');
  });

  it('未设置工作区时绝对与相对路径均拒绝（空串）', () => {
    localStorage.removeItem(WORKSPACE_KEY);
    expect(resolveWorkspacePath('c:/work/x.txt')).toBe('');
    expect(resolveWorkspacePath('x.txt')).toBe('');
    expect(resolveWorkspacePath('./x.txt')).toBe('');
  });

  it('既有防御保持：遍历/NUL/bidi/保留设备名/超长均拒绝', () => {
    expect(resolveWorkspacePath('../x.txt')).toBe('');
    expect(resolveWorkspacePath('c:/work/x/../y.txt')).toBe('');
    expect(resolveWorkspacePath('c:/work/\u0000x.txt')).toBe('');
    expect(resolveWorkspacePath('c:/work/\u202Ex.txt')).toBe('');
    expect(resolveWorkspacePath('c:/work/CON')).toBe('');
    expect(resolveWorkspacePath('c:/work/com1.txt')).toBe('');
    expect(resolveWorkspacePath(`c:/work/${'a'.repeat(5000)}`)).toBe('');
  });
});


describe('assertWorkspacePath / isInsideWorkspace', () => {
  const WORKSPACE_KEY = 'crish_workspace';

  beforeEach(() => {
    localStorage.setItem(WORKSPACE_KEY, 'c:/work');
  });

  it('rejects empty path', () => {
    expect(() => assertWorkspacePath('')).toThrow(/空/);
    expect(() => assertWorkspacePath('   ')).toThrow(/空/);
    expect(isInsideWorkspace('')).toBe(false);
  });

  it('rejects out-of-workspace absolute path', () => {
    expect(() => assertWorkspacePath('c:/etc/passwd')).toThrow(/工作区/);
    expect(isInsideWorkspace('c:/etc/passwd')).toBe(false);
  });

  it('accepts in-workspace path', () => {
    expect(assertWorkspacePath('c:/work/a.ts')).toBe('c:/work/a.ts');
    expect(assertWorkspacePath('a.ts')).toBe('c:/work/a.ts');
    expect(isInsideWorkspace('c:/work/a.ts')).toBe(true);
  });

  it('rejects relative path when workspace root unset', () => {
    localStorage.removeItem(WORKSPACE_KEY);
    expect(() => assertWorkspacePath('secrets.txt')).toThrow(/工作区/);
    expect(() => assertWorkspacePath('./x.txt')).toThrow(/工作区/);
    expect(isInsideWorkspace('secrets.txt')).toBe(false);
  });
});

describe('writeTextFile / toAssetUrl empty-path symmetry', () => {
  it('writeTextFile rejects empty path before invoke', async () => {
    await expect(writeTextFile('', 'x')).rejects.toThrow(/空/);
  });

  it('toAssetUrl rejects empty path', async () => {
    await expect(toAssetUrl('')).rejects.toThrow(/空/);
  });
});
