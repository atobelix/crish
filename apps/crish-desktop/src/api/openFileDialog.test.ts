import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openFileDialog, openFileDialogSafe, FileDialogUnavailableError } from './openFileDialog';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

import { open } from '@tauri-apps/plugin-dialog';

describe('openFileDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paths array when user selects multiple files', async () => {
    vi.mocked(open).mockResolvedValueOnce(['C:\\Desktop\\a.png', 'C:\\Desktop\\b.pptx']);
    const res = await openFileDialog();
    expect(res).toEqual(['C:\\Desktop\\a.png', 'C:\\Desktop\\b.pptx']);
    expect(open).toHaveBeenCalledWith({
      directory: false,
      multiple: true,
      title: '添加文件',
      filters: undefined,
    });
  });

  it('normalizes single string to array', async () => {
    vi.mocked(open).mockResolvedValueOnce('C:\\Desktop\\test.png');
    const res = await openFileDialog();
    expect(res).toEqual(['C:\\Desktop\\test.png']);
  });

  it('returns null when user cancels selection', async () => {
    vi.mocked(open).mockResolvedValueOnce(null);
    const res = await openFileDialog();
    expect(res).toBeNull();
  });

  it('throws FileDialogUnavailableError when plugin fails', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('ipc not available'));
    await expect(openFileDialog()).rejects.toThrow(FileDialogUnavailableError);
  });

  it('openFileDialogSafe returns null when plugin fails', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('ipc not available'));
    const res = await openFileDialogSafe();
    expect(res).toBeNull();
  });
});
