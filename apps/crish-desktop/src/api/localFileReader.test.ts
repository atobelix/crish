import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchLocalAsset,
  fetchWorkspaceAsset,
  getMimeFromPath,
  readLocalImageAsDataUrl,
  readLocalTextBestEffort,
  resolveLocalPath,
} from './localFileReader';

const WORKSPACE_KEY = 'crish_workspace';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((p: string) => `asset://localhost/${encodeURIComponent(p)}`),
}));

vi.mock('./imageProcessing', () => ({
  readBlobAsDataURL: vi.fn(async () => 'data:image/png;base64,aaa'),
  downscaleDataUrlIfNeeded: vi.fn(async (url: string) => url),
}));

describe('localFileReader helpers', () => {
  it('identifies image MIME types correctly', () => {
    expect(getMimeFromPath('test.png')).toBe('image/png');
    expect(getMimeFromPath('photo.JPG')).toBe('image/jpeg');
    expect(getMimeFromPath('img.webp')).toBe('image/webp');
    expect(getMimeFromPath('anim.gif')).toBe('image/gif');
    expect(getMimeFromPath('vector.svg')).toBe('image/svg+xml');
  });

  it('identifies office document types correctly', () => {
    expect(getMimeFromPath('deck.pptx')).toBe('application/vnd.ms-powerpoint');
    expect(getMimeFromPath('deck.ppt')).toBe('application/vnd.ms-powerpoint');
    expect(getMimeFromPath('doc.docx')).toBe('application/msword');
    expect(getMimeFromPath('sheet.xlsx')).toBe('application/vnd.ms-excel');
    expect(getMimeFromPath('paper.pdf')).toBe('application/pdf');
  });

  it('defaults to octet-stream for unknown files', () => {
    expect(getMimeFromPath('archive.bin')).toBe('application/octet-stream');
    expect(getMimeFromPath('code.rs')).toBe('application/octet-stream');
  });
});

describe('localFileReader path resolution & asset reading', () => {
  beforeEach(() => {
    localStorage.setItem(WORKSPACE_KEY, 'c:/work');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        blob: async () => new Blob(['x']),
        text: async () => 'hello-from-controlled-api',
      })),
    );
  });

  it('rejects empty path (image)', async () => {
    await expect(readLocalImageAsDataUrl('')).rejects.toThrow(/空/);
    await expect(readLocalImageAsDataUrl('   ')).rejects.toThrow(/空/);
  });

  it('rejects empty path (text)', async () => {
    await expect(readLocalTextBestEffort('')).rejects.toThrow(/空/);
  });

  it('rejects illegal path containing null byte', async () => {
    await expect(readLocalTextBestEffort('c:/work/\0evil.txt')).rejects.toThrow(/非法/);
    expect(() => resolveLocalPath('some/\0file.png')).toThrow(/非法/);
  });

  it('allows out-of-workspace absolute paths without workspace sandbox block or shell fallback', async () => {
    // 外部绝对路径放行读取
    const text = await readLocalTextBestEffort('c:/etc/passwd');
    expect(text).toBe('hello-from-controlled-api');

    const img = await readLocalImageAsDataUrl('c:/Windows/System32/x.png');
    expect(img).toBe('data:image/png;base64,aaa');

    // 确保未触发任何 shell 读盘（源码中绝无 workbench_run_shell 引用）
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile('apps/crish-desktop/src/api/localFileReader.ts', 'utf8'),
    );
    expect(src).not.toContain('workbench_run_shell');
    expect(src).not.toMatch(/ReadAllBytes|Get-Content/);
    expect(src).not.toContain('base64');
    expect(src.includes('head -c')).toBe(false);
  });

  it('reads text via controlled convertFileSrc + fetch inside workspace', async () => {
    const text = await readLocalTextBestEffort('c:/work/readme.md');
    expect(text).toBe('hello-from-controlled-api');
    expect(fetch).toHaveBeenCalled();
  });

  it('exports fetchLocalAsset and keeps fetchWorkspaceAsset compatibility', async () => {
    expect(fetchWorkspaceAsset).toBe(fetchLocalAsset);
    const res = await fetchLocalAsset('c:/work/test.txt');
    expect(res.ok).toBe(true);
  });

  it('throws clear error message on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
      })),
    );
    await expect(fetchLocalAsset('c:/missing/file.txt')).rejects.toThrow(
      '读取本地文件失败 (404): c:/missing/file.txt',
    );
  });
});
