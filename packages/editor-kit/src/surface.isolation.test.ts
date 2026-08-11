/**
 * A-SURF 架构隔离（editor-kit 侧）
 *
 * - A-SURF-09：package.json 不得依赖 markdown-editor / block-paper 业务 store
 * - A-SURF-03（包级）：src 禁止 DocSession / yrs / YText 类型导入
 * - surface re-export 烟测
 *
 * 对齐 dual-engine-surface.md §3 / §4.1 / §7
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EDITOR_SURFACES,
  SURFACE_CHAT,
  SURFACE_NOTE_PAPER,
  type EditorSurface,
} from './index';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..');
const SRC_ROOT = join(PKG_ROOT, 'src');

// ---------------------------------------------------------------------------
// 文件系统扫描工具
// ---------------------------------------------------------------------------

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out.push(...walkTsFiles(p));
    } else if (
      /\.(ts|tsx)$/.test(name) &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx')
    ) {
      // 隔离测自身可讨论禁词；产品源码不得 import
      out.push(p);
    }
  }
  return out;
}

/** 注释-only 行 → 不计入违规（纪律说明里可出现 DocSession / yrs 名称） */
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
  // 行尾注释中的纪律句：仅当代码侧无标识符时由下方 regex 决定；
  // 含 // A-SURF 的整行若仅文档用途，调用方应拆行。此处对整行注释前缀已覆盖。
  if (t.includes('// A-SURF')) {
    // 若 `code; // A-SURF ...` 且 code 含禁词，仍应失败——只豁免「纯注释意图」弱标记不行。
    // 保守：带 A-SURF 的行若在 // 之后才出现禁词则豁免整行。
    const codePart = t.split('//')[0] ?? '';
    if (!/\bDocSession\b|\bYText\b|['"]yrs['"]|['"]yjs['"]/.test(codePart)) {
      return true;
    }
  }
  return false;
}

type Hit = { file: string; line: number; text: string; rule: string };

function scanEditorKitForbidden(files: string[]): Hit[] {
  const hits: Hit[] = [];
  /** 禁止：类型/值标识符 DocSession（非注释） */
  const reDocSession = /\bDocSession\b/;
  /** 禁止：YText 类型 */
  const reYText = /\bYText\b/;
  /** 禁止：从 yrs / yjs 包 import */
  const reYrsImport =
    /(?:from|import)\s+['"](?:yrs|yjs)(?:\/[^'"]*)?['"]|require\s*\(\s*['"](?:yrs|yjs)['"]/;

  for (const file of files) {
    const rel = relative(PKG_ROOT, file).replace(/\\/g, '/');
    const content = readFileSync(file, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (isExemptLine(line)) continue;
      if (reDocSession.test(line)) {
        hits.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          rule: 'DocSession',
        });
      }
      if (reYText.test(line)) {
        hits.push({ file: rel, line: i + 1, text: line.trim(), rule: 'YText' });
      }
      if (reYrsImport.test(line)) {
        hits.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          rule: 'yrs-import',
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// A-SURF-09
// ---------------------------------------------------------------------------

describe('A-SURF-09 editor-kit 包依赖边界', () => {
  it('dependencies 不得含 markdown-editor / block-paper 业务包 / yrs', () => {
    const pkgPath = join(PKG_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    expect(pkg.name).toBe('@crish/editor-kit');

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
      ...pkg.optionalDependencies,
    };
    const names = Object.keys(allDeps);

    const forbidden = names.filter((n) => {
      const lower = n.toLowerCase();
      if (lower.includes('markdown-editor')) return true;
      // 允许 @crish/block-paper-contract；禁止 @crish/block-paper 业务 store
      if (lower === '@crish/block-paper' || lower.endsWith('/block-paper')) {
        return true;
      }
      if (lower === 'yrs' || lower === 'yjs' || lower.startsWith('yjs/')) {
        return true;
      }
      if (lower.includes('doc-session') || lower.includes('docsession')) {
        return true;
      }
      return false;
    });

    expect(forbidden, `禁止依赖: ${forbidden.join(', ')}`).toEqual([]);
    // 契约类型 only
    expect(names).toContain('@crish/block-paper-contract');
  });

  it('公开 index 导出 surface 常量且不导出 DocSession/YText 符号名', () => {
    const indexSrc = readFileSync(join(SRC_ROOT, 'index.ts'), 'utf8');
    // 不得 export type/value DocSession 或 YText
    expect(indexSrc).not.toMatch(
      /export\s+(?:type\s+|\{[^}]*\b)(?:DocSession|YText)\b/
    );
    expect(indexSrc).toMatch(/EDITOR_SURFACES/);
    expect(indexSrc).toMatch(/EditorSurface/);
  });
});

// ---------------------------------------------------------------------------
// A-SURF-03（editor-kit 包级静态守卫）
// ---------------------------------------------------------------------------

describe('A-SURF-03 editor-kit 源码禁止 DocSession/yrs/YText 导入', () => {
  it('packages/editor-kit/src 产品源码无 DocSession / YText / yrs import', () => {
    const files = walkTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    const hits = scanEditorKitForbidden(files);
    expect(
      hits,
      hits.map((h) => `${h.rule} @ ${h.file}:${h.line}: ${h.text}`).join('\n')
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// surface re-export 烟测
// ---------------------------------------------------------------------------

describe('editor-kit surface re-export', () => {
  it('EDITOR_SURFACES 与契约一致', () => {
    expect(EDITOR_SURFACES).toEqual(['chat', 'note-paper']);
    const chat: EditorSurface = SURFACE_CHAT;
    const note: EditorSurface = SURFACE_NOTE_PAPER;
    expect(chat).toBe('chat');
    expect(note).toBe('note-paper');
  });
});
