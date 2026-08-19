/**
 * S6：openFileInPanel 只进 files / file-viewer 叶。
 * 不挂 Notebook、不写 persist、不叠开 files+file-viewer。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractFilePathFromToolArgs,
  looksLikeOpenableFilePath,
  openFileInPanel,
  pathFromFileOpenClickTarget,
  registerFileViewerOpener,
  resolveFilePreviewHost,
  takePendingOpenPath,
} from './filePanelOpener';

const WORKSPACE_KEY = 'crish_workspace';

beforeEach(() => {
  localStorage.setItem(WORKSPACE_KEY, 'c:/work');
  registerFileViewerOpener(null);
  takePendingOpenPath();
});

afterEach(() => {
  registerFileViewerOpener(null);
  takePendingOpenPath();
});

describe('resolveFilePreviewHost', () => {
  it('代码走 file-viewer，md/图/表走 files；diff 强制 file-viewer', () => {
    expect(resolveFilePreviewHost('src/app.ts')).toBe('file-viewer');
    expect(resolveFilePreviewHost('lib/main.rs')).toBe('file-viewer');
    expect(resolveFilePreviewHost('README.md')).toBe('files');
    expect(resolveFilePreviewHost('docs/note.mdx')).toBe('files');
    expect(resolveFilePreviewHost('shot.png')).toBe('files');
    expect(resolveFilePreviewHost('doc.pdf')).toBe('files');
    expect(resolveFilePreviewHost('data.csv')).toBe('files');
    expect(resolveFilePreviewHost('pack.zip')).toBe('files');
    expect(resolveFilePreviewHost('README.md', 'diff')).toBe('file-viewer');
    expect(resolveFilePreviewHost('src/app.ts')).not.toBe('preview');
  });
});

describe('looksLikeOpenableFilePath', () => {
  it('拒绝 note / 无扩展 id，接受路径与文件名', () => {
    expect(looksLikeOpenableFilePath('note')).toBe(false);
    expect(looksLikeOpenableFilePath('notebook:abc')).toBe(false);
    expect(looksLikeOpenableFilePath('file-123')).toBe(false);
    expect(looksLikeOpenableFilePath('')).toBe(false);
    expect(looksLikeOpenableFilePath('src/index.ts')).toBe(true);
    expect(looksLikeOpenableFilePath('report.md')).toBe(true);
    expect(looksLikeOpenableFilePath('shot.png')).toBe(true);
    expect(looksLikeOpenableFilePath('archive.zip')).toBe(true);
  });
});

describe('pathFromFileOpenClickTarget', () => {
  it('附件 data-file-open-path 可抽，移除钮忽略', () => {
    const chip = document.createElement('span');
    chip.setAttribute('data-file-open-path', 'src/a.ts');
    const name = document.createElement('span');
    name.appendChild(document.createTextNode('a.ts'));
    chip.appendChild(name);
    expect(pathFromFileOpenClickTarget(name)).toBe('src/a.ts');
    expect(pathFromFileOpenClickTarget(name.firstChild)).toBe('src/a.ts');

    const remove = document.createElement('button');
    remove.className = 'chat-attach-remove';
    chip.appendChild(remove);
    expect(pathFromFileOpenClickTarget(remove)).toBeNull();
  });

  it('file mention 用 id，agent mention 忽略', () => {
    const file = document.createElement('span');
    file.setAttribute('data-type', 'mention');
    file.setAttribute('data-kind', 'file');
    file.setAttribute('data-id', 'src/index.ts');
    file.setAttribute('data-label', 'index.ts');
    expect(pathFromFileOpenClickTarget(file)).toBe('src/index.ts');

    const agent = document.createElement('span');
    agent.setAttribute('data-type', 'mention');
    agent.setAttribute('data-kind', 'agent');
    agent.setAttribute('data-id', 'agent-007');
    expect(pathFromFileOpenClickTarget(agent)).toBeNull();
  });
});

describe('openFileInPanel', () => {
  it('代码路径只调 file-viewer opener，不派 files 事件', () => {
    const opener = vi.fn();
    registerFileViewerOpener(opener);
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);

    const host = openFileInPanel('src/app.ts');
    expect(host).toBe('file-viewer');
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener.mock.calls[0]?.[0].replace(/\\/g, '/')).toMatch(/src\/app\.ts$/);
    expect(ev).not.toHaveBeenCalled();
    expect(takePendingOpenPath()).toBeNull();

    window.removeEventListener('crish-open-file', ev);
  });

  it('md / 图走 files 事件，即使 opener 已注册也不开 file-viewer', () => {
    const opener = vi.fn();
    registerFileViewerOpener(opener);
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);

    expect(openFileInPanel('docs/readme.md')).toBe('files');
    expect(opener).not.toHaveBeenCalled();
    expect(ev).toHaveBeenCalledTimes(1);
    const pending = takePendingOpenPath();
    expect(pending?.replace(/\\/g, '/')).toMatch(/docs\/readme\.md$/);

    expect(openFileInPanel('assets/a.png')).toBe('files');
    expect(opener).not.toHaveBeenCalled();

    window.removeEventListener('crish-open-file', ev);
  });

  it('note / 空路径 / 越界路径不打开、不写 persist', () => {
    const opener = vi.fn();
    registerFileViewerOpener(opener);
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);

    expect(openFileInPanel('')).toBeNull();
    expect(openFileInPanel('note')).toBeNull();
    expect(openFileInPanel('notebook:abc')).toBeNull();
    expect(openFileInPanel('c:/outside/x.ts')).toBeNull();
    expect(opener).not.toHaveBeenCalled();
    expect(ev).not.toHaveBeenCalled();
    expect(takePendingOpenPath()).toBeNull();

    window.removeEventListener('crish-open-file', ev);
  });

  it('无 opener 时代码也回落 files 叶', () => {
    const ev = vi.fn();
    window.addEventListener('crish-open-file', ev);
    expect(openFileInPanel('src/app.ts')).toBe('files');
    expect(ev).toHaveBeenCalledTimes(1);
    window.removeEventListener('crish-open-file', ev);
  });
});

describe('extractFilePathFromToolArgs', () => {
  it('从 JSON path 与单行路径抽出', () => {
    expect(extractFilePathFromToolArgs('{"path":"src/a.ts"}')).toBe('src/a.ts');
    expect(extractFilePathFromToolArgs('{"file_path":"lib/b.rs"}')).toBe(
      'lib/b.rs'
    );
    expect(extractFilePathFromToolArgs('foo/bar/baz.ts')).toBe('foo/bar/baz.ts');
    expect(extractFilePathFromToolArgs('just text')).toBeNull();
  });
});
