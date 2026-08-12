// fileMeta 纯函数单测（R2-06b 展示面）：类型判定/图标/格式化/敏感规则/错误文案
import {
  detectFileKind,
  fileKindGlyph,
  fileKindColor,
  formatFileSize,
  formatRelativeTime,
  isSensitiveFile,
  mapFilesErrorCode,
} from './fileMeta';
import type { FileKind } from './fileMeta';

// ── 1. 类型判定（F4 §2.8 detectFileKind 手机端子集） ───────────────────────

describe('detectFileKind（F4 §2.8）', () => {
  it('常见代码/文档扩展名 → text', () => {
    for (const name of [
      'a.ts',
      'b.tsx',
      'c.js',
      'd.rs',
      'e.py',
      'f.go',
      'g.json',
      'h.md',
      'i.css',
      'j.html',
      'k.yaml',
      'l.toml',
      'm.txt',
      'n.log',
      'o.sql',
      'p.sh',
      'q.vue',
      'Dockerfile',
    ]) {
      expect(detectFileKind(name)).toBe('text');
    }
  });

  it('图片扩展名 → image', () => {
    for (const name of [
      'a.png',
      'b.jpg',
      'c.jpeg',
      'd.gif',
      'e.webp',
      'f.svg',
      'g.bmp',
      'h.avif',
    ]) {
      expect(detectFileKind(name)).toBe('image');
    }
  });

  it('pdf / csv/tsv → pdf / table', () => {
    expect(detectFileKind('readme.pdf')).toBe('pdf');
    expect(detectFileKind('data.csv')).toBe('table');
    expect(detectFileKind('data.tsv')).toBe('table');
  });

  it('未知扩展名 → binary；无扩展名 → text（README/LICENSE 常见无后缀文本）', () => {
    expect(detectFileKind('a.exe')).toBe('binary');
    expect(detectFileKind('b.wasm')).toBe('binary');
    expect(detectFileKind('c.zip')).toBe('binary');
    expect(detectFileKind('README')).toBe('text');
    expect(detectFileKind('.env')).toBe('text');
  });

  it('大小写不敏感（.PNG → image）', () => {
    expect(detectFileKind('A.PNG')).toBe('image');
    expect(detectFileKind('B.TS')).toBe('text');
  });
});

// ── 2. 图标字形与配色（F4 §6.2 图标语言） ─────────────────────────────────

describe('fileKindGlyph / fileKindColor', () => {
  it('每种类型有稳定字形（目录单独处理）', () => {
    expect(fileKindGlyph('text')).toBe('📄');
    expect(fileKindGlyph('image')).toBe('🖼');
    expect(fileKindGlyph('pdf')).toBe('📕');
    expect(fileKindGlyph('table')).toBe('📊');
    expect(fileKindGlyph('binary')).toBe('⚙');
  });

  it('每种类型有配色且各不相同', () => {
    const colors = new Set(
      (['text', 'image', 'pdf', 'table', 'binary'] as FileKind[]).map((k) =>
        fileKindColor(k)
      )
    );
    expect(colors.size).toBe(5);
    for (const c of colors) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});

// ── 3. 大小 / 相对时间格式化（F4-F17） ───────────────────────────────────

describe('formatFileSize（F4-F17 B/K/M）', () => {
  it('B 档：< 1024 原样', () => {
    expect(formatFileSize(0)).toBe('0B');
    expect(formatFileSize(412)).toBe('412B');
    expect(formatFileSize(1023)).toBe('1023B');
  });

  it('K 档：≥1KB 保留 1 位小数（≥100K 取整）', () => {
    expect(formatFileSize(1024)).toBe('1K');
    expect(formatFileSize(2048)).toBe('2K');
    expect(formatFileSize(3277)).toBe('3.2K');
    expect(formatFileSize(102400)).toBe('100K');
  });

  it('M 档：≥1MB 保留 1 位小数', () => {
    expect(formatFileSize(1024 * 1024)).toBe('1M');
    expect(formatFileSize(Math.round(1.5 * 1024 * 1024))).toBe('1.5M');
  });

  it('非法输入 → 空串', () => {
    expect(formatFileSize(Number.NaN)).toBe('');
    expect(formatFileSize(-1)).toBe('');
  });
});

describe('formatRelativeTime（F4 §6.1 相对时间口径）', () => {
  const NOW = 1_800_000_000_000;

  it('一分钟内 → 刚刚', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('刚刚');
  });

  it('N 分钟前', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
  });

  it('N 小时前', () => {
    expect(formatRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2 小时前');
  });

  it('昨天 / N 天前', () => {
    expect(formatRelativeTime(NOW - 24 * 3_600_000, NOW)).toBe('昨天');
    expect(formatRelativeTime(NOW - 3 * 24 * 3_600_000, NOW)).toBe('3 天前');
  });

  it('≥7 天 → 日期兜底（YYYY/MM/DD）', () => {
    expect(formatRelativeTime(NOW - 30 * 24 * 3_600_000, NOW)).toMatch(
      /^\d{4}\/\d{2}\/\d{2}$/
    );
  });

  it('非法/未来时间 → 空串', () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('');
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe('');
  });
});

// ── 4. 敏感文件判定（F4 §7.1 规则表） ────────────────────────────────────

describe('isSensitiveFile（F4 §7.1）', () => {
  it('密钥/凭证类命中（含 F4 §7.1 前缀规则 token*/credentials*/id_rsa*）', () => {
    for (const name of [
      '.env',
      '.env.local',
      '.env.production',
      '.env.example',
      'id_rsa',
      'id_rsa.pub',
      'id_rsa_doc.md',
      'credentials.json',
      'credentials.test.ts',
      'secrets.txt',
      'token.yaml',
      'tokenizer.ts',
      'a.pem',
      'b.key',
      'c.p12',
      'd.pfx',
    ]) {
      expect(isSensitiveFile(name)).toBe(true);
    }
  });

  it('配置类命中（.npmrc/.yarnrc）', () => {
    expect(isSensitiveFile('.npmrc')).toBe(true);
    expect(isSensitiveFile('.yarnrc')).toBe(true);
  });

  it('普通文件不命中', () => {
    for (const name of [
      'a.ts',
      'index.js',
      'package.json',
      'README.md',
      'keynote.pdf',
      'mytoken.md',
      'notoken.yaml',
    ]) {
      // 注：.env.example 命中 F4 §7.1 `.env.*` 规则（敏感），不在此列
      expect(isSensitiveFile(name)).toBe(false);
    }
  });

  it('大小写不敏感（.ENV → 命中）', () => {
    expect(isSensitiveFile('.ENV')).toBe(true);
    expect(isSensitiveFile('ID_RSA')).toBe(true);
  });
});

// ── 5. 错误码 → UI 文案（F4 附录 B 映射表） ───────────────────────────────

describe('mapFilesErrorCode（F4 附录 B）', () => {
  it('已登记错误码映射为专属文案', () => {
    expect(mapFilesErrorCode('outside_workspace').title).toBe(
      '路径不在已授权工作区内'
    );
    expect(mapFilesErrorCode('path_not_found').title).toBe('文件或目录不存在');
    expect(mapFilesErrorCode('not_directory').title).toBe('路径类型不匹配');
    expect(mapFilesErrorCode('file_too_large').title).toBe(
      '文件过大，无法预览'
    );
    expect(mapFilesErrorCode('binary_file').title).toBe('二进制文件，无法预览');
    expect(mapFilesErrorCode('unsupported_encoding').title).toBe(
      '文件编码不受支持'
    );
    expect(mapFilesErrorCode('workspace_not_granted').title).toBe(
      '工作区未授权'
    );
    expect(mapFilesErrorCode('transport.closed').title).toBe('未连接');
    expect(mapFilesErrorCode('cmd.timeout').title).toBe('请求超时');
    expect(mapFilesErrorCode('internal').title).toBe('桌面端内部错误');
  });

  it('未登记码 → 通用文案（保真不丢）', () => {
    const t = mapFilesErrorCode('some_future_code');
    expect(t.title).toBe('加载失败');
    expect(t.hint).toBeTruthy();
  });

  it('null/undefined → 尚未加载', () => {
    expect(mapFilesErrorCode(null).title).toBe('尚未加载');
    expect(mapFilesErrorCode(undefined).title).toBe('尚未加载');
  });
});
