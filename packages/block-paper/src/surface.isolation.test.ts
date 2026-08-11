/**
 * A-SURF 架构隔离（block-paper / note-paper 侧）
 *
 * - A-SURF-02：禁止 EditorStore / markdown-editor import / lines[] 权威路径
 * - A-SURF-08：createSilentFixture 不以 lines 为权威数组；块用 blockId
 *
 * 对齐 dual-engine-surface.md §2.2 N-01 / §3 NS-02 / §7
 *
 * // A-SURF：本文件为守卫测，可讨论禁词；扫描范围排除 *.test.*
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSilentFixture,
  listSilentBlocks,
  type SilentFixture,
} from './chrome/silentFixture';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const SRC_ROOT = join(PKG_ROOT, 'src');

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function walkProductTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkProductTs(p));
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !/\.test\.(ts|tsx)$/.test(name) &&
      !/\.spec\.(ts|tsx)$/.test(name)
    ) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 白名单：
 * - 纯注释 / JSDoc（纪律说明可出现 EditorStore、lines[] 名称）
 * - 行内 `// A-SURF` 且代码侧无禁词
 */
function isExemptLine(line: string): boolean {
  const t = line.trim();
  if (
    t.startsWith('//') ||
    t.startsWith('*') ||
    t.startsWith('/*') ||
    t.startsWith('*/') ||
    t === ''
  ) {
    return true;
  }
  if (t.includes('// A-SURF')) {
    const codePart = t.split('//')[0] ?? '';
    if (
      !/\bEditorStore\b|markdown-editor|lines\s*:\s*string\s*\[|export\s+\w+\s+lines\b/i.test(
        codePart
      )
    ) {
      return true;
    }
  }
  return false;
}

type Hit = { file: string; line: number; text: string; rule: string };

/**
 * note-paper 包禁止：
 * - EditorStore 标识符（行级 store）
 * - from '...markdown-editor'
 * - lines[] **文档权威**路径（export 名为 lines 的缓冲、store/doc.lines、显式权威标记）
 *
 * 不误杀：叶子 lineWindow 的局部 `lines` / `splitLines` 返回字段
 * （那是单块文本的行切片算法，≠ chat 的 lines[] 文档模型）
 */
function scanNotePaperForbidden(files: string[]): Hit[] {
  const hits: Hit[] = [];
  const reEditorStore = /\bEditorStore\b/;
  const reMdImport =
    /from\s+['"][^'"]*markdown-editor[^'"]*['"]|require\s*\(\s*['"][^'"]*markdown-editor[^'"]*['"]\s*\)/;
  // 权威路径（故意不匹配普通 `lines: string[]` 局部字段 —— 见 lineWindow.splitLines）
  const reLinesAuthority =
    /\b(?:export\s+(?:const|let|var|type|interface|function)\s+lines\b|(?:EditorStore|DocStore|LineStore|editorStore|lineStore)\s*\.\s*lines\b|\b(?:state|store|doc|document)\s*\.\s*lines\b\s*[=:]|\blines\s*\[\s*\]\s*(?:store|authority|权威)|['"]lines\s*\[\s*\]['"]|\bauthorityLines\b|\blinesAuthority\b|\bas\s+const\s+satisfies\s+.*lines|createLinesStore\b|useLinesStore\b)/i;

  for (const file of files) {
    const rel = relative(PKG_ROOT, file).replace(/\\/g, '/');
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isExemptLine(line)) continue;
      if (reEditorStore.test(line)) {
        hits.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          rule: 'EditorStore',
        });
      }
      if (reMdImport.test(line)) {
        hits.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          rule: 'markdown-editor-import',
        });
      }
      if (reLinesAuthority.test(line)) {
        hits.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          rule: 'lines-authority',
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// A-SURF-02
// ---------------------------------------------------------------------------

describe('A-SURF-02 note-paper 禁止行级 EditorStore / markdown-editor / lines 权威', () => {
  it('packages/block-paper/src 产品源码无禁词命中', () => {
    const files = walkProductTs(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const hits = scanNotePaperForbidden(files);
    expect(
      hits,
      hits.map((h) => `${h.rule} @ ${h.file}:${h.line}: ${h.text}`).join('\n')
    ).toEqual([]);
  });

  it('package.json 不依赖 markdown-editor', () => {
    const pkg = JSON.parse(
      readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(names.some((n) => n.toLowerCase().includes('markdown-editor'))).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// A-SURF-08
// ---------------------------------------------------------------------------

describe('A-SURF-08 createSilentFixture 不以 lines[] 为权威', () => {
  it('fixture 无 lines 字段；块以 blockId 为键', () => {
    const fixture = createSilentFixture(5, { docId: 'surf-08', idPrefix: 'b' });

    expect(fixture).not.toHaveProperty('lines');
    expect(Object.prototype.hasOwnProperty.call(fixture, 'lines')).toBe(false);

    // 权威形状：order + blocks Map（blockId）
    expect(Array.isArray(fixture.order)).toBe(true);
    expect(fixture.order).toHaveLength(5);
    expect(fixture.blocks).toBeInstanceOf(Map);

    for (const id of fixture.order) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(fixture.blocks.has(id)).toBe(true);
      const block = fixture.blocks.get(id)!;
      expect(block.id).toBe(id);
    }

    const listed = listSilentBlocks(fixture);
    expect(listed.map((b) => b.id)).toEqual(fixture.order);
  });

  it('SilentFixture 运行时键集合不含 lines', () => {
    const fixture: SilentFixture = createSilentFixture(2);
    const keys = Object.keys(fixture).sort();
    expect(keys).not.toContain('lines');
    // 预期投影键
    expect(keys).toEqual(
      expect.arrayContaining([
        'docId',
        'rev',
        'order',
        'blocks',
        'state',
        'initialDiff',
      ])
    );
  });

  it('空文档同样无 lines 权威数组', () => {
    const empty = createSilentFixture(0);
    expect(empty).not.toHaveProperty('lines');
    expect(empty.order).toEqual([]);
    expect(empty.blocks.size).toBe(0);
  });
});
