import { describe, expect, it, vi } from 'vitest';
import { tryOpenExistingNoteForArtifact } from './artifactNoteOpen';

describe('tryOpenExistingNoteForArtifact', () => {
  it('无 docId 不调用 openTool、不创建 persist', () => {
    const openTool = vi.fn();
    expect(
      tryOpenExistingNoteForArtifact({
        sessionId: 'sess-1',
        docId: undefined,
        openTool,
      })
    ).toBe('missing-docId');
    expect(
      tryOpenExistingNoteForArtifact({
        sessionId: 'sess-1',
        docId: 'silent-doc',
        openTool,
      })
    ).toBe('missing-docId');
    expect(
      tryOpenExistingNoteForArtifact({
        sessionId: 'sess-1',
        docId: 'strict-ws',
        openTool,
      })
    ).toBe('missing-docId');
    expect(openTool).not.toHaveBeenCalled();
  });

  it('已有 docId 才 openTool(sid, note)', () => {
    const openTool = vi.fn();
    expect(
      tryOpenExistingNoteForArtifact({
        sessionId: 'sess-1',
        docId: 'doc-exist',
        openTool,
      })
    ).toBe('opened');
    expect(openTool).toHaveBeenCalledTimes(1);
    expect(openTool).toHaveBeenCalledWith('sess-1', 'note');
  });

  it('无 sessionId 也不打开', () => {
    const openTool = vi.fn();
    expect(
      tryOpenExistingNoteForArtifact({
        sessionId: '  ',
        docId: 'doc-exist',
        openTool,
      })
    ).toBe('missing-docId');
    expect(openTool).not.toHaveBeenCalled();
  });
});
