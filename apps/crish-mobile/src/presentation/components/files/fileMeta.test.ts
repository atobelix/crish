// 文件展示纯函数测试：类型 / 尺寸 / 敏感判定 / 错误文案。
import {
  detectFileKind,
  FILE_KIND_ICON,
  FILE_KIND_TONE,
  formatFileSize,
  isSensitiveFile,
  mapFilesErrorCode,
} from './fileMeta';

describe('detectFileKind', () => {
  it('按扩展名分类', () => {
    expect(detectFileKind('a.ts')).toBe('text');
    expect(detectFileKind('a.png')).toBe('image');
    expect(detectFileKind('a.pdf')).toBe('pdf');
    expect(detectFileKind('a.csv')).toBe('table');
    expect(detectFileKind('a.bin')).toBe('binary');
    expect(detectFileKind('README')).toBe('text');
  });

  it('图标与色调映射完整', () => {
    for (const kind of ['text', 'image', 'pdf', 'table', 'binary'] as const) {
      expect(FILE_KIND_ICON[kind]).toBeTruthy();
      expect(FILE_KIND_TONE[kind]).toBeTruthy();
    }
  });
});

describe('formatFileSize', () => {
  it('B / KB / MB', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatFileSize(-1)).toBe('');
  });
});

describe('isSensitiveFile', () => {
  it('密钥 / 凭证类命中', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('.env.local')).toBe(true);
    expect(isSensitiveFile('id_rsa')).toBe(true);
    expect(isSensitiveFile('server.pem')).toBe(true);
    expect(isSensitiveFile('a.ts')).toBe(false);
  });
});

describe('mapFilesErrorCode', () => {
  it('协议错误码 → 人话标题', () => {
    expect(mapFilesErrorCode('file.not_found').title).toContain('不存在');
    expect(mapFilesErrorCode('file.binary').title).toContain('二进制');
    expect(mapFilesErrorCode('transport.closed').title).toBe('未连接');
    expect(mapFilesErrorCode('unknown').title).toBe('加载失败');
  });
});
