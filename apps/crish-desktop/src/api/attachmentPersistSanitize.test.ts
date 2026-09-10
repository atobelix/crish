import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./projectStore', () => ({
  getWorkspacePath: () => 'c:/work',
}));

import {
  sanitizeAttachmentForPersist,
  sanitizeImageRefForPersist,
  toWorkspaceRelativeRef,
} from './attachmentPersistSanitize';

describe('attachmentPersistSanitize §3.3', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('绝对路径转相对引用', () => {
    expect(toWorkspaceRelativeRef('c:/work/src/a.png')).toBe('src/a.png');
    expect(toWorkspaceRelativeRef('c:/elsewhere/x.png')).toBeNull();
  });

  it('落盘图片不含 dataUrl / 绝对路径', () => {
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
    expect(ref.source).toBe('a.png');
    expect(ref.kind).toBe('local');
    expect(ref.resolvedUrl).toBe('data:image/png;base64,thumb');
    expect(JSON.stringify(ref)).not.toContain('data:image/png;base64,AAAA');
    expect(JSON.stringify(ref)).not.toContain('c:/work');
  });

  it('落盘附件剥离 dataUrl', () => {
    const att = sanitizeAttachmentForPersist({
      name: 'a.png',
      path: 'c:/work/a.png',
      dataUrl: 'data:image/png;base64,AAAA',
      mime: 'image/png',
    });
    expect(att.path).toBe('a.png');
    expect(att).not.toHaveProperty('dataUrl');
  });
});