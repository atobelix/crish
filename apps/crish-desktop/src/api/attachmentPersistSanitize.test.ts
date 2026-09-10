import { beforeEach, describe, expect, it, vi } from 'vitest';

// 可切换工作区根：默认 c:/work；空根 fail-closed 用例临时置 ''
let mockWorkspacePath = 'c:/work';
vi.mock('./projectStore', () => ({
  getWorkspacePath: () => mockWorkspacePath,
}));

import {
  sanitizeAttachmentForPersist,
  sanitizeImageRefForPersist,
  toWorkspaceRelativeRef,
} from './attachmentPersistSanitize';

describe('attachmentPersistSanitize §3.3', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWorkspacePath = 'c:/work';
  });

  it('绝对路径转相对引用', () => {
    expect(toWorkspaceRelativeRef('c:/work/src/a.png')).toBe('src/a.png');
    expect(toWorkspaceRelativeRef('c:/elsewhere/x.png')).toBeNull();
  });

  it('工作区内图片：保留相对路径，剥离 dataUrl 本体', () => {
    const ref = sanitizeImageRefForPersist(
      {
        name: 'a.png',
        path: 'c:/work/a.png',
        dataUrl: 'data:image/png;base64,AAAA',
        thumbnailUrl: 'data:image/png;base64,thumb',
        mime: 'image/png',
      },
      'img-1'
    );
    const dumped = JSON.stringify(ref);
    expect(ref.source).toBe('a.png');
    expect(ref.kind).toBe('local');
    // dataUrl / data: 缩略图一律不得进入落盘字段
    expect(ref.resolvedUrl).toBeUndefined();
    expect(dumped).not.toContain('data:');
    expect(dumped).not.toContain('c:/work');
    expect(dumped).not.toContain('base64,AAAA');
    expect(dumped).not.toContain('base64,thumb');
    // 有 dataUrl 时提供稳定 hash 线索（非本体）
    expect(ref.contentHint).toMatch(/^content:[0-9a-f]+:\d+$/);
  });

  it('工作区外绝对路径：脱敏为 basename + pathRedacted，禁止完整路径落盘', () => {
    const outside = 'C:\\Users\\alice\\Secrets\\salary.png';
    const ref = sanitizeImageRefForPersist(
      {
        name: 'salary.png',
        path: outside,
        mime: 'image/png',
      },
      'img-out'
    );
    const dumped = JSON.stringify(ref);
    expect(ref.source).toBe('salary.png');
    expect(ref.pathRedacted).toBe(true);
    expect(dumped).not.toContain('Users');
    expect(dumped).not.toContain('alice');
    expect(dumped).not.toContain('Secrets');
    expect(dumped).not.toContain('C:');
    // 完整绝对路径任何片段均不得出现
    expect(dumped.includes(outside)).toBe(false);
  });

  it('仅 dataUrl 无路径：不落盘 data: 本体，只留文件名 + contentHint', () => {
    const dataUrl = 'data:image/png;base64,QQQQQQQQ';
    const ref = sanitizeImageRefForPersist(
      {
        name: 'paste.png',
        dataUrl,
        mime: 'image/png',
      },
      'img-data'
    );
    const dumped = JSON.stringify(ref);
    expect(ref.source).toBe('paste.png');
    expect(ref.kind).toBe('data');
    expect(ref.resolvedUrl).toBeUndefined();
    expect(dumped).not.toContain('data:');
    expect(dumped).not.toContain('QQQQQQQQ');
    expect(ref.contentHint).toMatch(/^content:[0-9a-f]+:\d+$/);
  });

  it('http(s) 外链缩略图可保留为 resolvedUrl；blob/data 剥离', () => {
    const httpRef = sanitizeImageRefForPersist(
      {
        name: 'remote.png',
        path: 'c:/work/remote.png',
        thumbnailUrl: 'https://cdn.example.com/t.png',
        mime: 'image/png',
      },
      'img-http'
    );
    expect(httpRef.resolvedUrl).toBe('https://cdn.example.com/t.png');

    const blobRef = sanitizeImageRefForPersist(
      {
        name: 'b.png',
        path: 'c:/work/b.png',
        thumbnailUrl: 'blob:null/abc',
        mime: 'image/png',
      },
      'img-blob'
    );
    expect(blobRef.resolvedUrl).toBeUndefined();
    expect(JSON.stringify(blobRef)).not.toContain('blob:');
  });

  it('落盘附件剥离 dataUrl；工作区外路径脱敏为 basename', () => {
    const inside = sanitizeAttachmentForPersist({
      name: 'a.png',
      path: 'c:/work/a.png',
      dataUrl: 'data:image/png;base64,AAAA',
      mime: 'image/png',
    });
    expect(inside.path).toBe('a.png');
    expect(inside.pathRedacted).toBeUndefined();
    expect(inside).not.toHaveProperty('dataUrl');
    expect(JSON.stringify(inside)).not.toContain('data:');

    const outsidePath = 'D:/private/vacation/photo.jpg';
    const outside = sanitizeAttachmentForPersist({
      name: 'photo.jpg',
      path: outsidePath,
      mime: 'image/jpeg',
    });
    const dumped = JSON.stringify(outside);
    expect(outside.path).toBe('photo.jpg');
    expect(outside.pathRedacted).toBe(true);
    expect(dumped).not.toContain('private');
    expect(dumped).not.toContain('D:');
    expect(dumped).not.toContain(outsidePath);
    expect(dumped).not.toContain('data:');
  });

  it('工作区内受控相对路径允许保留', () => {
    const att = sanitizeAttachmentForPersist({
      name: 'notes.md',
      path: 'docs/notes.md',
      text: 'hello',
    });
    // 无工作区根解析失败时：相对路径原样保留（已是工作区相对语义）
    expect(att.path).toBe('docs/notes.md');
    expect(att.pathRedacted).toBeUndefined();
  });

  it('含 .. 遍历的相对路径不得原样落盘', () => {
    const att = sanitizeAttachmentForPersist({
      name: 'x.txt',
      path: '../outside/x.txt',
    });
    expect(att.path).toBe('x.txt');
    expect(att.pathRedacted).toBe(true);
    expect(JSON.stringify(att)).not.toContain('..');
  });

  it('工作区根为空时 fail-closed：绝对路径仍必须 redacted', () => {
    mockWorkspacePath = '';
    // 无根：任何路径都不得解析为工作区相对引用
    expect(toWorkspaceRelativeRef('c:/work/a.png')).toBeNull();
    expect(toWorkspaceRelativeRef('c:/anywhere/secret.png')).toBeNull();

    // 绝对路径：仍走 basename + pathRedacted（禁止完整路径落盘）
    const outside = 'C:\\Users\\alice\\Secrets\\salary.png';
    const ref = sanitizeImageRefForPersist(
      {
        name: 'salary.png',
        path: outside,
        mime: 'image/png',
      },
      'img-empty-root'
    );
    const dumped = JSON.stringify(ref);
    expect(ref.source).toBe('salary.png');
    expect(ref.pathRedacted).toBe(true);
    expect(dumped).not.toContain('Users');
    expect(dumped).not.toContain('alice');
    expect(dumped).not.toContain('Secrets');
    expect(dumped).not.toContain('C:');
    expect(dumped.includes(outside)).toBe(false);

    // POSIX 绝对路径同样 fail-closed
    const posix = sanitizeAttachmentForPersist({
      name: 'id_rsa',
      path: '/home/bob/.ssh/id_rsa',
    });
    expect(posix.path).toBe('id_rsa');
    expect(posix.pathRedacted).toBe(true);
    expect(JSON.stringify(posix)).not.toContain('home');
    expect(JSON.stringify(posix)).not.toContain('bob');
  });
});
