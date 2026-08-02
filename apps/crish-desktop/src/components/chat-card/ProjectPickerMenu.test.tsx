import { describe, expect, it } from 'vitest';
import { openDirectoryDialogSafe } from '../../api/openDirectoryDialog';

describe('ProjectPickerMenu / openDirectoryDialog', () => {
  it('should resolve via plugin-dialog helper without Function()/eval', async () => {
    // 非 Tauri 环境：插件调用失败 → Safe 版返回 null，不抛 Function/eval 语法错误
    const result = await openDirectoryDialogSafe('Test Title');
    expect(result).toBeNull();
  });
});
