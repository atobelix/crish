/**
 * reverseFileDiff 测试（PE-07 T07.3 C-03 修复）：
 * - full_write 反向（删除）改走 workbench_fs_delete_file（Rust 侧 remove_file），
 *   不再经 PowerShell Remove-Item 拼串（原双引号内 $(...) / 反引号可被求值）；
 * - 越界等错误信息传播；
 * - 非桌面壳（missing）→ 明确失败信息（不再有 shell 通道兜底）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../store/types';
import { reverseFileDiffToDisk } from './reverseFileDiff';

const mocks = vi.hoisted(() => ({
  getTransport: vi.fn(),
  call: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock('./transport', () => ({
  getTransport: mocks.getTransport,
}));

vi.mock('./workspaceFsApi', () => ({
  readTextFile: mocks.readTextFile,
  writeTextFile: mocks.writeTextFile,
}));

function fullWriteDiff(filePath: string, content: string): FileDiff {
  const lines = content.split('\n');
  return {
    filePath,
    additions: lines.length,
    deletions: 0,
    changes: lines.map((l) => ({ type: 'addition' as const, content: l })),
  };
}

function deleteCalls() {
  return mocks.call.mock.calls.filter((c) => c[0] === 'workbench_fs_delete_file');
}

beforeEach(() => {
  mocks.getTransport.mockReturnValue({ call: mocks.call });
  mocks.call.mockReset();
  mocks.readTextFile.mockReset();
  mocks.writeTextFile.mockReset();
});

describe('PE-07 T07.3 C-03：删除走 workbench_fs_delete_file', () => {
  it('T07.3 用例 10：full_write 反向删除调用 workbench_fs_delete_file（路径直传）', async () => {
    // 磁盘内容与 diff 全文一致 → 安全删除
    mocks.readTextFile.mockResolvedValueOnce({
      content: 'line1\nline2',
      truncated: false,
      path: 'evil/$x.txt',
    });
    mocks.call.mockResolvedValueOnce({
      status: 'ok',
      data: { path: 'evil/$x.txt', deleted: true },
    });

    const r = await reverseFileDiffToDisk(fullWriteDiff('evil/$x.txt', 'line1\nline2'));

    expect(r).toEqual({ ok: true, mode: 'delete' });
    expect(deleteCalls()).toEqual([
      ['workbench_fs_delete_file', { path: 'evil/$x.txt' }],
    ]);
  });

  it('恶意文件名（含 $() / ; / 反引号）作为 path 字符串直传，无任何 shell 拼串', async () => {
    mocks.readTextFile.mockResolvedValueOnce({ content: 'x', truncated: false, path: 'a$(whoami).txt' });
    mocks.call.mockResolvedValueOnce({ status: 'ok', data: { deleted: true } });

    const r = await reverseFileDiffToDisk(fullWriteDiff('a$(whoami).txt', 'x'));
    expect(r.ok).toBe(true);
    const payload = deleteCalls()[0]?.[1] as { path: string };
    expect(payload?.path).toBe('a$(whoami).txt');
    // 拒绝出现的旧拼串形态（PowerShell Remove-Item 通道不再存在）
    const allCalls = JSON.stringify(mocks.call.mock.calls);
    expect(allCalls).not.toContain('Remove-Item');
  });

  it('删除失败（越界 outside_workspace）→ 错误传播', async () => {
    mocks.readTextFile.mockResolvedValueOnce({ content: 'x', truncated: false, path: 'evil.txt' });
    mocks.call.mockResolvedValueOnce({
      status: 'error',
      kind: 'InvalidInput',
      message: 'outside_workspace: path is outside the allowed workspace root',
    });

    const r = await reverseFileDiffToDisk(fullWriteDiff('evil.txt', 'x'));
    expect(r).toEqual({
      ok: false,
      message: 'outside_workspace: path is outside the allowed workspace root',
    });
  });

  it('非桌面壳（missing）→ 明确失败（不再有 shell 通道兜底）', async () => {
    mocks.readTextFile.mockResolvedValueOnce({ content: 'x', truncated: false, path: 'evil.txt' });
    mocks.call.mockResolvedValueOnce({ status: 'missing' });

    const r = await reverseFileDiffToDisk(fullWriteDiff('evil.txt', 'x'));
    expect(r).toEqual({ ok: false, message: '删除文件失败（需桌面壳）' });
  });
});
