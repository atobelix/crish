/**
 * 02 / 08 激活模块 import 面：禁深路径、禁第二套插件、禁 sessionId 打开旁路。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.includes('.test.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (extname(name) === '.ts' || extname(name) === '.tsx') {
      out.push(full);
    }
  }
  return out;
}

describe('note-paper extension import 边界', () => {
  const files = listSourceFiles(DIR);

  it('产品源无 plugins / ContributeViewRegistry / setChatMainSurface(note)', () => {
    const hits: string[] = [];
    const banned = [
      /from\s+['"][^'"]*\/plugins\//,
      /ContributeViewRegistry/,
      /setChatMainSurface\s*\(\s*['"]note['"]/,
      /from\s+['"]@crish\/block-paper\/src\//,
      /from\s+['"][^'"]*reference[/\\]markdown-editor/,
      /invoke\s*\(\s*['"]note_document_hydrate['"]/,
      /\bDocSession\b/,
      /createDocSessionApplySink/,
    ];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const line of src.split(/\r?\n/)) {
        if (!/^\s*import\b/.test(line) && !line.includes('setChatMainSurface')) {
          if (!/\bDocSession\b/.test(line) && !/invoke\s*\(/.test(line)) {
            continue;
          }
        }
        for (const re of banned) {
          if (re.test(line)) hits.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('activate 不同步引用 NotePaperStrictPanel', () => {
    const src = readFileSync(join(DIR, 'activate.ts'), 'utf8');
    expect(src).not.toMatch(/NotePaperStrictPanel/);
    expect(src).not.toMatch(/from\s+['"].*note-paper\/NotePaper/);
  });
});
