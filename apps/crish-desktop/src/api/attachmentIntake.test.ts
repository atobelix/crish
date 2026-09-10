import { describe, expect, it } from 'vitest';
import {
  attachmentStableKey,
  createAttachmentIntakeDedupe,
  extractFileSystemPath,
  mergeAttachmentsIdempotent,
  normalizeIntakePathKey,
} from './attachmentIntake';
import type { ChatAttachment } from '../hooks/chat-stream/types';

describe('attachmentIntake §3.1', () => {
  it('stable key prefers id then path then name', () => {
    expect(attachmentStableKey({ id: 'a1', name: 'x.png' })).toBe('id:a1');
    expect(
      attachmentStableKey({ name: 'x.png', path: 'C:\\work\\x.png' })
    ).toBe('path:c:/work/x.png');
    expect(attachmentStableKey({ name: 'x.png', dataUrl: 'data:...' })).toBe(
      'name:x.png|8'
    );
  });

  it('merge idempotent by path', () => {
    const prev: ChatAttachment[] = [{ name: 'a.png', path: 'c:/w/a.png' }];
    const next = mergeAttachmentsIdempotent(prev, [
      { name: 'a.png', path: 'C:/w/a.png' },
      { name: 'b.png', path: 'c:/w/b.png' },
    ]);
    expect(next).toHaveLength(2);
    expect(next[1]?.name).toBe('b.png');
  });

  it('short-window dedupe claims once', () => {
    let now = 1000;
    const d = createAttachmentIntakeDedupe(() => now);
    const k = normalizeIntakePathKey('C:\\w\\a.png');
    expect(d.claim([k])).toEqual([k]);
    expect(d.claim([k])).toEqual([]);
    now += 600;
    expect(d.claim([k])).toEqual([k]);
  });

  it('extractFileSystemPath only accepts absolute', () => {
    const abs = { name: 'a.png', path: 'C:\\w\\a.png' } as unknown as File;
    const rel = { name: 'a.png', path: 'subdir/a.png' } as unknown as File;
    expect(extractFileSystemPath(abs)).toBe('C:\\w\\a.png');
    expect(extractFileSystemPath(rel)).toBeNull();
  });
});