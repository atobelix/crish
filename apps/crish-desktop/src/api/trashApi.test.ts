import { describe, expect, it, vi } from 'vitest';
import {
  formatTrashedAt,
  listTrashEntries,
  purgeTrashEntry,
  restoreTrashEntry,
} from './trashApi';
import { invokeTyped } from './tauriInvoke';

vi.mock('./tauriInvoke', () => ({
  invokeTyped: vi.fn(),
}));

const mockInvoke = vi.mocked(invokeTyped);

const entry = {
  id: 'e1',
  originalPath: 'C:/repo/src/a.txt',
  trashedAt: 1754200000000,
  kind: 'file' as const,
  size: 2048,
  checksum: 'abc123',
};

describe('listTrashEntries', () => {
  it('ok：返回条目清单与回收站根', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: { entries: [entry], trashRoot: 'C:/trash' },
    });
    const res = await listTrashEntries();
    expect(res.entries).toEqual([entry]);
    expect(res.trashRoot).toBe('C:/trash');
    expect(mockInvoke).toHaveBeenCalledWith('trash_list');
  });

  it('missing：降级为空列表（面板空态）', async () => {
    mockInvoke.mockResolvedValueOnce({ status: 'missing' });
    expect(await listTrashEntries()).toEqual({ entries: [], trashRoot: '' });
  });

  it('WorkspaceAccess / Io error：抛出读取错误，不伪装成空回收站', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'error',
      kind: 'WorkspaceAccess',
      message: '工作区授权尚未完成',
    });
    await expect(listTrashEntries()).rejects.toThrow('工作区授权尚未完成');

    mockInvoke.mockResolvedValueOnce({
      status: 'error',
      kind: 'Io',
      message: '磁盘读取失败',
    });
    await expect(listTrashEntries()).rejects.toThrow('磁盘读取失败');
  });
});

describe('restoreTrashEntry', () => {
  it('ok：返回恢复目标路径；带 sessionId 透传', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: true, originalPath: 'C:/repo/src/a.txt' },
    });
    const res = await restoreTrashEntry('e1', 'sess-1');
    expect(res).toEqual({
      ok: true,
      data: { ok: true, originalPath: 'C:/repo/src/a.txt' },
    });
    expect(mockInvoke).toHaveBeenCalledWith('trash_restore', {
      entryId: 'e1',
      sessionId: 'sess-1',
    });
  });

  it('无 sessionId：参数仅 entryId', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: true, originalPath: 'p' },
    });
    await restoreTrashEntry('e1');
    expect(mockInvoke).toHaveBeenCalledWith('trash_restore', { entryId: 'e1' });
  });

  it('NotFound：结构化失败含未找到条目', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'error',
      kind: 'NotFound',
      message: 'nope',
    });
    const res = await restoreTrashEntry('e1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('未找到条目');
  });

  it('missing：命令不可用提示', async () => {
    mockInvoke.mockResolvedValueOnce({ status: 'missing' });
    const res = await restoreTrashEntry('e1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('trash_restore');
  });
});

describe('purgeTrashEntry', () => {
  it('ok：返回清除的条目 id', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'ok',
      data: { ok: true, entryId: 'e1' },
    });
    const res = await purgeTrashEntry('e1', 'sess-1');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.entryId).toBe('e1');
  });

  it('拒绝覆盖类错误：结构化失败', async () => {
    mockInvoke.mockResolvedValueOnce({
      status: 'error',
      kind: 'InvalidInput',
      message: '拒绝覆盖',
    });
    const res = await purgeTrashEntry('e1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain('清除失败');
  });
});

describe('formatTrashedAt', () => {
  it('纪元毫秒 → MM-DD HH:mm（本地时区）', () => {
    // 固定 2025-08-03 12:34 本地时间构造
    const d = new Date(2025, 7, 3, 12, 34);
    expect(formatTrashedAt(d.getTime())).toBe('08-03 12:34');
  });

  it('非法输入 → 空串', () => {
    expect(formatTrashedAt(0)).toBe('');
    expect(formatTrashedAt(NaN)).toBe('');
    expect(formatTrashedAt(-1)).toBe('');
  });
});
