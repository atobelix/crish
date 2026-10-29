// 样式 token 守卫（交接 §8「没有裸 hex」+ §7 第 10 步）：
// app/ 与 src/presentation/ 下的非测试源码禁止裸 hex 颜色、数字圆角、数字字号 / 行高，
// 颜色、圆角与字阶一律走 theme（useTheme）。白名单仅收冻结或待清理文件，清理后须同步移除。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['app', join('src', 'presentation')];

/** 暂缓治理的文件（相对 crish-mobile 根，正斜杠） */
const ALLOWLIST: Record<string, string> = {
  // 文件相关页面与组件在本次改版中冻结（交接 §7 第 9 步）
  'src/presentation/components/files/FilePreview.tsx': '文件模块冻结',
  // 待清理：新代码已不再引用（用户决定先保留）
  'src/presentation/components/dashboard/NewTaskSheet.tsx': '待清理',
};

const RULES: { name: string; pattern: RegExp }[] = [
  { name: '裸 hex 颜色', pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: '数字圆角', pattern: /[A-Za-z]*[rR]adius:\s*-?\d/ },
  { name: '数字字号 / 行高', pattern: /\b(fontSize|lineHeight):\s*\d/ },
];

function collect(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collect(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

/** 去掉注释行，避免把文档里的编号（如 #123）误判为颜色 */
function codeLines(source: string): { line: number; text: string }[] {
  return source
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

describe('样式 token 守卫', () => {
  const files = SCAN_DIRS.flatMap((dir) => collect(join(ROOT, dir))).map(
    (full) => ({
      full,
      rel: relative(ROOT, full).split(sep).join('/'),
    })
  );

  it('扫描范围非空', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(RULES)('不允许$name', ({ pattern }) => {
    const hits = files
      .filter(({ rel }) => !(rel in ALLOWLIST))
      .flatMap(({ full, rel }) =>
        codeLines(readFileSync(full, 'utf8'))
          .filter(({ text }) => pattern.test(text))
          .map(({ line, text }) => `${rel}:${line}: ${text.trim()}`)
      );
    expect(hits).toEqual([]);
  });

  it('白名单里的文件都还存在（清理后须同步移除）', () => {
    const existing = new Set(files.map(({ rel }) => rel));
    const stale = Object.keys(ALLOWLIST).filter((rel) => !existing.has(rel));
    expect(stale).toEqual([]);
  });
});
