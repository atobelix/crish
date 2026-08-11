/**
 * note-paper 目录边界静态扫描（**W5-B-S Skeleton** · B-03 / A-SURF-02）
 *
 * 禁止本目录源码 import：
 * - EditorStore / useEditorStore
 * - markdown-editor 的 store 路径
 * - lines[] 写 API 当局
 *
 * 本测只扫 note-paper 目录；bridges 是允许「知两边」的薄层，不在此扫禁 import。
 * 本包 ≠ W5-B Strict；边界绿 ≠ EL 关闭。
 *
 * W5-C 加深：同目录 Strict 轨文件（NotePaperStrictPanel / w5bStrict / hydrateProjection）
 * 亦在扫范围内；**≠ EL-08 关闭**（完整隔离见 `__tests__/dual-engine-surface.isolation.test.ts`）。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** vitest 下 import.meta.url 偶发非 file: 时回退到 cwd 相对路径（边界扫本目录） */
const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : import.meta.url.startsWith('file:')
      ? dirname(fileURLToPath(import.meta.url))
      : resolve(process.cwd(), 'src/components/note-paper');

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.md']);

/** 禁止出现的 import / 路径模式 */
const FORBIDDEN_PATTERNS: Array<{ id: string; re: RegExp }> = [
  {
    id: 'EditorStore',
    re: /\bEditorStore\b|\buseEditorStore\b|\bcreateEditorStore\b/,
  },
  {
    id: 'markdown-editor-store-path',
    re: /markdown-editor[/\\].*[/\\](?:EditorStore|store)|from\s+['"][^'"]*markdown-editor[^'"]*EditorStore/,
  },
  {
    id: 'reference-markdown-editor-import',
    re: /from\s+['"][^'"]*reference[/\\]markdown-editor/,
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    // 边界测试自身可提到禁词（模式表），排除
    if (name === 'note-paper.boundary.test.ts') continue;
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) {
      // 测试文件同样不得 import 行级 store
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (SOURCE_EXTS.has(extname(name))) {
      out.push(full);
    }
  }
  return out;
}

describe('note-paper 边界：禁止行级 EditorStore / markdown-editor store', () => {
  const files = listSourceFiles(DIR);

  it('目录内存在源码文件', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN_PATTERNS.map((p) => [p.id, p.re] as const))(
    '无禁止模式：%s',
    (_id, re) => {
      const hits: string[] = [];
      for (const file of files) {
        // README 可讨论禁词（文档声明），仅扫可执行源
        if (file.endsWith('.md') || file.endsWith('.css')) continue;
        const src = readFileSync(file, 'utf8');
        // 去掉块注释与行注释中的提及，避免文档字符串误报？
        // 产品纪律：源码注释可提「禁止 EditorStore」，故对「禁止」语境放宽。
        // 严格扫 import 行：
        const importLines = src
          .split(/\r?\n/)
          .filter(
            (line) => /^\s*import\b/.test(line) || /\bfrom\s+['"]/.test(line)
          );
        for (const line of importLines) {
          if (re.test(line)) {
            hits.push(`${file}: ${line.trim()}`);
          }
        }
        // 对标识符使用：排除「禁止 … EditorStore」类中文注释
        const codeWithoutComments = src
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '');
        // import 已查；再查实际标识符调用（非字符串）
        if (_id === 'EditorStore') {
          // 若去注释后仍有 useEditorStore( 或 createEditorStore( 则失败
          if (
            /\buseEditorStore\s*\(/.test(codeWithoutComments) ||
            /\bcreateEditorStore\s*\(/.test(codeWithoutComments)
          ) {
            hits.push(`${file}: EditorStore API 调用`);
          }
        }
      }
      expect(hits, hits.join('\n')).toEqual([]);
    }
  );

  it('源码 import 仅允许 block-paper / editor-kit / 本仓 bridges 等白名单方向', () => {
    const forbiddenPkg = /from\s+['"][^'"]*markdown-editor[^'"]*['"]/;
    const hits: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
      if (file.includes('.test.')) continue;
      const src = readFileSync(file, 'utf8');
      for (const line of src.split(/\r?\n/)) {
        if (!line.includes('from')) continue;
        if (forbiddenPkg.test(line)) {
          hits.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
