/**
 * S2 包边界锁：index / 源码不 import react，不 import apps/crish-desktop。
 * 本包保持纯函数；S3 叙事 UI 不得焊进此包。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const PKG_ROOT = join(DIR, '..');

type PkgJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const REACT_SPEC = /^(react|react-dom|react\/.*|react-dom\/.*)$/;
const DESKTOP_SPEC = /(?:^@crish\/crish-desktop$)|(?:apps\/crish-desktop)/;

function collectProdSrc(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...collectProdSrc(full));
      continue;
    }
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue;
    if (name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')) continue;
    const ext = extname(name);
    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
      out.push(full);
    }
  }
  return out;
}

function moduleSpecs(src: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[1]) specs.push(m[1].replace(/\\/g, '/'));
  }
  return specs;
}

function depBags(pkg: PkgJson): Array<[string, string]> {
  return [
    ...Object.entries(pkg.dependencies ?? {}),
    ...Object.entries(pkg.devDependencies ?? {}),
    ...Object.entries(pkg.peerDependencies ?? {}),
    ...Object.entries(pkg.optionalDependencies ?? {}),
  ];
}

describe('@crish/conversation-flow S2 边界锁', () => {
  it('package.json 依赖面无 react / desktop', () => {
    const pkg = JSON.parse(
      readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')
    ) as PkgJson;
    const hits: string[] = [];
    for (const [name, value] of depBags(pkg)) {
      const blob = `${name}=${value}`.replace(/\\/g, '/');
      if (REACT_SPEC.test(name) || name === '@types/react' || name === '@types/react-dom') {
        hits.push(`dep:${name}`);
      }
      if (DESKTOP_SPEC.test(name) || DESKTOP_SPEC.test(blob)) {
        hits.push(`dep:${blob}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('index.ts 与生产源码不 import react、不 import apps/crish-desktop', () => {
    const files = collectProdSrc(join(PKG_ROOT, 'src'));
    expect(files.some((f) => f.replace(/\\/g, '/').endsWith('/src/index.ts'))).toBe(
      true
    );
    expect(files.filter((f) => f.endsWith('.tsx') || f.endsWith('.jsx'))).toEqual(
      []
    );

    const indexPath = join(DIR, 'index.ts');
    const indexSrc = readFileSync(indexPath, 'utf8');
    for (const spec of moduleSpecs(indexSrc)) {
      expect(spec, `index.ts ← ${spec}`).not.toMatch(REACT_SPEC);
      expect(spec, `index.ts ← ${spec}`).not.toMatch(DESKTOP_SPEC);
    }

    for (const full of files) {
      const src = readFileSync(full, 'utf8');
      for (const spec of moduleSpecs(src)) {
        expect(spec, `${full} ← ${spec}`).not.toMatch(REACT_SPEC);
        expect(spec, `${full} ← ${spec}`).not.toMatch(DESKTOP_SPEC);
      }
    }
  });
});
