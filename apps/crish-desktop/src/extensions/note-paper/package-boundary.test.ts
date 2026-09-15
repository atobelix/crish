/**
 * 08 包边界：只读 package.json 依赖面 + 内置名单源码字符串。
 * 第 12 轮追加：factory 键集合、激活三文件旧轨、公共出口。
 *
 * 测头自钉：本测绿 ≠ 打开完成（G-HYD）≠ 关 EL ≠ 独立软件已拆。
 * 不扫整个 monorepo 源码；依赖方向只看 dependencies / devDependencies / peer。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTE_LEAF_HONESTY_ATTRS } from './honesty';

const HERE =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

type PkgJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
};

const FORBIDDEN_REF = 'reference/markdown-editor';

const BUILTIN_IDS = [
  'chat',
  'terminal',
  'preview',
  'overview',
  'files',
  'diff',
  'runtime',
  'agent',
  'flow-dag',
  'file-viewer',
] as const;

function flattenWorkspaces(raw: PkgJson['workspaces']): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return Array.isArray(raw.packages) ? raw.packages : [];
}

function locateRepoRoot(): string {
  let dir = HERE;
  while (true) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PkgJson;
        if (
          flattenWorkspaces(pkg.workspaces).includes(
            'packages/block-paper-contract'
          )
        ) {
          return dir;
        }
      } catch {
        /* 继续上溯 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`无法定位仓库根（起始 ${HERE}）`);
    }
    dir = parent;
  }
}

const REPO_ROOT = locateRepoRoot();

function readPkg(rel: string): PkgJson {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as PkgJson;
}

/** 只合并任务指定的三袋，不读 optional / 不扫源码 */
function depEntries(pkg: PkgJson): Array<[string, string]> {
  return [
    ...Object.entries(pkg.dependencies ?? {}),
    ...Object.entries(pkg.devDependencies ?? {}),
    ...Object.entries(pkg.peerDependencies ?? {}),
  ];
}

function depNames(pkg: PkgJson): string[] {
  return depEntries(pkg).map(([name]) => name);
}

function hitsNamedOrValued(
  pkg: PkgJson,
  forbiddenNames: string[],
  forbiddenValueNeedles: string[]
): string[] {
  const hits: string[] = [];
  for (const [name, value] of depEntries(pkg)) {
    if (forbiddenNames.includes(name)) {
      hits.push(`dep-name:${name}`);
    }
    const blob = `${name}=${value}`.replace(/\\/g, '/');
    for (const needle of forbiddenValueNeedles) {
      if (blob.includes(needle)) hits.push(`${blob} (~${needle})`);
    }
  }
  return hits;
}

function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

describe('08 包边界（绿 ≠ 打开完成 ≠ 关 EL ≠ 独立软件已拆）', () => {
  it('测头自钉：诚实钉仍是 not-claimed，本文件不关账', () => {
    expect(NOTE_LEAF_HONESTY_ATTRS['data-open-complete']).toBe('not-claimed');
    expect(NOTE_LEAF_HONESTY_ATTRS['data-el01']).toBe('not-claimed');
    expect(NOTE_LEAF_HONESTY_ATTRS['data-el08']).toBe('not-claimed');
  });

  it('contract 不依赖 editor-kit / block-paper / crish-desktop', () => {
    const pkg = readPkg('packages/block-paper-contract/package.json');
    expect(pkg.name).toBe('@crish/block-paper-contract');
    expect(
      hitsNamedOrValued(
        pkg,
        ['@crish/editor-kit', '@crish/block-paper', '@crish/crish-desktop'],
        [
          'packages/editor-kit',
          'packages/block-paper/',
          'apps/crish-desktop',
          FORBIDDEN_REF,
        ]
      )
    ).toEqual([]);
  });

  it('editor-kit 只允许契约；不依赖 block-paper / desktop', () => {
    const pkg = readPkg('packages/editor-kit/package.json');
    expect(pkg.name).toBe('@crish/editor-kit');
    expect(depNames(pkg)).toContain('@crish/block-paper-contract');
    expect(
      hitsNamedOrValued(
        pkg,
        ['@crish/block-paper', '@crish/crish-desktop'],
        ['packages/block-paper/', 'apps/crish-desktop', FORBIDDEN_REF]
      )
    ).toEqual([]);
  });

  it('block-paper 不依赖 desktop；可依赖 contract + editor-kit', () => {
    const pkg = readPkg('packages/block-paper/package.json');
    expect(pkg.name).toBe('@crish/block-paper');
    const names = depNames(pkg);
    expect(names).toContain('@crish/block-paper-contract');
    expect(names).toContain('@crish/editor-kit');
    expect(
      hitsNamedOrValued(
        pkg,
        ['@crish/crish-desktop'],
        ['apps/crish-desktop', FORBIDDEN_REF]
      )
    ).toEqual([]);
  });

  it('产品 package.json workspaces / 桌面依赖不得出现 reference/markdown-editor', () => {
    const root = readPkg('package.json');
    const desktop = readPkg('apps/crish-desktop/package.json');
    const ws = flattenWorkspaces(root.workspaces).map(posix);
    expect(ws.some((w) => w.includes(FORBIDDEN_REF))).toBe(false);
    expect(flattenWorkspaces(desktop.workspaces).map(posix)).toEqual([]);
    expect(
      hitsNamedOrValued(root, [], [FORBIDDEN_REF, 'markdown-editor'])
    ).toEqual([]);
    expect(
      hitsNamedOrValued(desktop, [], [FORBIDDEN_REF, 'markdown-editor'])
    ).toEqual([]);
    expect(desktop.name).toBe('@crish/crish-desktop');
  });

  it('registerBuiltInViews 源码：10 槽、无 registerView(note)、名单不含 note id', () => {
    const src = readFileSync(
      join(
        REPO_ROOT,
        'apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx'
      ),
      'utf8'
    );
    expect(src).not.toMatch(/registerView\s*\(\s*['"]note['"]/);
    expect(src).not.toMatch(/id:\s*['"]note['"]/);
    expect(src).not.toMatch(/['"]note['"]\s*:/);
    expect(src).not.toMatch(/factories\s*(?:\[\s*['"]note['"]\s*\]|\.note\b)/);
    expect(src).not.toMatch(/第\s*11|11\s*个内置|11\s*含\s*note/);
    expect(src).toMatch(/全部 10 个/);

    const ids = [...src.matchAll(/^\s*id:\s*['"]([^'"]+)['"]/gm)].map(
      (m) => m[1]
    );
    expect(ids).toEqual([...BUILTIN_IDS]);
    expect(ids).toHaveLength(10);
    expect(ids).not.toContain('note');
  });

  it('builtinViewFactories 键仍是 10 内置；登记器不焊激活 / 死 CTA / 裸 IPC', () => {
    // 工厂表真源是 builtinViewFactories.tsx（不再内联于 main.tsx）
    const factories = readFileSync(
      join(REPO_ROOT, 'apps/crish-desktop/src/builtinViewFactories.tsx'),
      'utf8'
    );
    const block = factories.match(
      /const builtinViewFactories:\s*ViewFactoryMap\s*=\s*\{([\s\S]*?)\n\};/
    );
    expect(block).not.toBeNull();
    const keys = [
      ...(block?.[1] ?? '').matchAll(
        /^  (?:'([^']+)'|([A-Za-z_][\w-]*))\s*:/gm
      ),
    ].map((m) => m[1] ?? m[2]);
    expect(keys).toEqual([...BUILTIN_IDS]);
    // 决策 1 视图路由收敛：browser 已并入 preview
    expect(keys).not.toContain('browser');

    const registrar = readFileSync(
      join(
        REPO_ROOT,
        'apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx'
      ),
      'utf8'
    );
    expect(registrar).not.toMatch(/\bactivateNotePaper\b/);
    expect(registrar).not.toMatch(/\bcreateNotePaperView\b/);
    expect(registrar).not.toMatch(/\bNoteLeafHost\b/);
    expect(registrar).not.toMatch(/extensions\/note-paper/);
    expect(registrar).not.toMatch(/open-note-paper-strict/);
    expect(registrar).not.toMatch(
      /note_document_hydrate|note_apply_ops|note_document_recent/
    );
    expect(registrar).not.toMatch(/\binvoke(?:Typed)?\s*\(/);
  });

  it('activate / noteViewFactory / NoteLeafHost 不 from ../../plugins、无 ContributeViewRegistry', () => {
    for (const name of [
      'activate.ts',
      'noteViewFactory.tsx',
      'NoteLeafHost.tsx',
    ] as const) {
      const src = readFileSync(join(HERE, name), 'utf8');
      expect(src, name).not.toMatch(/from\s+['"]\.\.\/\.\.\/plugins/);
      expect(src, name).not.toMatch(/\bContributeViewRegistry\b/);
    }
  });

  it('index.ts 公共出口不 re-export EmptyState / Workspace / Host', () => {
    const src = readFileSync(join(HERE, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/^export\s+\*\s+from/m);
    const names: string[] = [];
    for (const m of src.matchAll(/^export\s+\{([^}]+)\}/gm)) {
      for (const part of m[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        for (const bit of trimmed.split(/\s+as\s+/)) {
          const id = bit.trim();
          if (id) names.push(id);
        }
      }
    }
    expect(names).not.toContain('WorkspaceProductEmptyHost');
    expect(names).not.toContain('EmptyState');
    expect(names).not.toContain('Workspace');
    expect(names).not.toContain('Host');
    const froms = [
      ...src.matchAll(
        /^export\s+(?:\{[^}]+\}|\*)\s+from\s+['"]([^'"]+)['"]/gm
      ),
    ].map((m) => m[1].replace(/\\/g, '/'));
    expect(froms.some((s) => s.includes('components/workspace'))).toBe(
      false
    );
    expect(
      froms.some((s) =>
        /WorkspaceEmptyState|WorkspaceProductEmptyHost/.test(s)
      )
    ).toBe(false);
  });

  it('index.ts 出口不得出现 WorkspaceEmptyState / open-note-paper-strict / ConexFloatHandle', () => {
    const src = readFileSync(join(HERE, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/\bWorkspaceEmptyState\b/);
    expect(src).not.toMatch(/open-note-paper-strict/);
    expect(src).not.toMatch(/\bConexFloatHandle\b/);
  });
});
