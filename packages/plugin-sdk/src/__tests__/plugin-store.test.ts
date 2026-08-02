// packages/plugin-sdk/src/__tests__/plugin-store.test.ts
// PluginStore 测试（审计发现：plugin-store.ts stmts 覆盖率 16.66%）
//
// 覆盖范围：
// - save/load 往返（version + updatedAt + plugins 格式）
// - save 自动创建嵌套父目录
// - load 容错：文件不存在 / JSON 解析失败 / 无 plugins 字段 → 静默返回空数组
// - 前向兼容：未知顶层字段与条目未知字段保留，不拒绝
// - updatePluginState：新增条目 / 更新已有条目（保留 manifest/origin/error）
// - removePlugin：删除已存在条目 / 不存在时 no-op
// - getPlugin：命中返回条目 / 未命中返回 undefined
// - 写入失败静默降级（console.warn，不抛错，不阻塞 Registry）
//
// 约束：全部使用临时目录（storePath 可注入，避免触碰用户真实 ~/.crish）

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PluginStore } from '../registry';
import type { StoredPluginEntry } from '../registry';
import type { PluginManifest } from '../manifest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── 测试基础设施（临时目录） ─────────────────────────────────

let tmpDirs: string[] = [];

/** 在系统临时目录创建独立的 store 文件路径 */
async function makeStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-sdk-store-'));
  tmpDirs.push(dir);
  return join(dir, 'store.json');
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: '@crish/p1',
    name: 'P1',
    version: '1.0.0',
    entrypoints: { main: './dist/index.js' },
    permissions: ['hook:observe'],
    trustLevel: 'restricted',
    engineVersion: '>=0.2.0 <0.3.0',
    declaredHooks: ['turn.start'],
    declaredTools: [],
    declaredMcpServers: [],
    origin: 'user-dir',
    ...overrides,
  } as PluginManifest;
}

function makeEntry(overrides: Partial<StoredPluginEntry> = {}): StoredPluginEntry {
  return {
    id: '@crish/p1',
    state: 'active',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ─── save / load 往返 ─────────────────────────────────────────

describe('PluginStore - save/load 往返', () => {
  it('save 写入 JSON 文件（version + updatedAt + plugins），load 原样读回', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);

    await store.save([makeEntry({ id: 'p1', origin: 'user-dir' })]);

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'p1', state: 'active', origin: 'user-dir' });

    // 文件格式：含版本与更新时间字段
    const raw = JSON.parse(await readFile(storePath, 'utf8')) as {
      version?: string;
      updatedAt?: string;
      plugins?: unknown[];
    };
    expect(raw.version).toBeDefined();
    expect(raw.updatedAt).toBeDefined();
    expect(raw.plugins).toHaveLength(1);
  });

  it('save 自动创建嵌套父目录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-sdk-store-'));
    tmpDirs.push(dir);
    const storePath = join(dir, 'nested', 'deep', 'store.json');
    const store = new PluginStore(storePath);

    await store.save([makeEntry()]);

    expect(await store.load()).toHaveLength(1);
  });

  it('load 返回的条目顺序与 save 一致', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);

    await store.save([makeEntry({ id: 'p1' }), makeEntry({ id: 'p2' })]);

    const loaded = await store.load();
    expect(loaded.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});

// ─── load 容错 ────────────────────────────────────────────────

describe('PluginStore - load 容错', () => {
  it('文件不存在 → 静默返回空数组（冷启动正常路径）', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);

    expect(await store.load()).toEqual([]);
  });

  it('JSON 解析失败 → 静默返回空数组', async () => {
    const storePath = await makeStorePath();
    await writeFile(storePath, 'not-json{{{', 'utf8');

    expect(await new PluginStore(storePath).load()).toEqual([]);
  });

  it('无 plugins 字段 → 静默返回空数组', async () => {
    const storePath = await makeStorePath();
    await writeFile(storePath, JSON.stringify({ version: '1', updatedAt: 't' }), 'utf8');

    expect(await new PluginStore(storePath).load()).toEqual([]);
  });

  it('前向兼容：未知顶层字段 + 条目未知字段保留，不拒绝', async () => {
    const storePath = await makeStorePath();
    await writeFile(
      storePath,
      JSON.stringify({
        version: '1',
        updatedAt: 't',
        futureTopField: { any: 1 },
        plugins: [
          { id: 'p1', state: 'active', updatedAt: 't', futureEntryField: 'keep-me' },
        ],
      }),
      'utf8',
    );

    const loaded = await new PluginStore(storePath).load();

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'p1', state: 'active' });
    // 未知字段运行时透传（类型层丢失，不拒绝）
    expect((loaded[0] as unknown as Record<string, unknown>).futureEntryField).toBe(
      'keep-me',
    );
  });
});

// ─── updatePluginState ────────────────────────────────────────

describe('PluginStore - updatePluginState', () => {
  it('插件不存在 → 新增条目', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);

    await store.updatePluginState('p1', 'loading');

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'p1', state: 'loading' });
  });

  it('插件已存在 → 更新状态，保留 manifest/origin，可携带 error 信息', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);
    const manifest = makeManifest();
    await store.save([
      makeEntry({ id: '@crish/p1', manifest, origin: 'user-dir' }),
    ]);

    await store.updatePluginState('@crish/p1', 'error', 'activate failed');

    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.state).toBe('error');
    expect(loaded[0]?.error).toBe('activate failed');
    expect(loaded[0]?.manifest).toEqual(manifest);
    expect(loaded[0]?.origin).toBe('user-dir');
  });

  it('不传 error 时，更新后不含 error 字段', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);

    await store.updatePluginState('p1', 'inactive');

    const [entry] = await store.load();
    expect(entry?.state).toBe('inactive');
    expect(entry?.error).toBeUndefined();
  });

  it('更新不影响其他插件条目', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);
    await store.save([makeEntry({ id: 'p1' }), makeEntry({ id: 'p2' })]);

    await store.updatePluginState('p1', 'error', 'boom');

    const loaded = await store.load();
    expect(loaded).toHaveLength(2);
    expect(loaded.find((p) => p.id === 'p2')).toMatchObject({ state: 'active' });
  });
});

// ─── removePlugin / getPlugin ─────────────────────────────────

describe('PluginStore - removePlugin / getPlugin', () => {
  it('removePlugin 删除已存在条目', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);
    await store.save([makeEntry({ id: 'p1' }), makeEntry({ id: 'p2' })]);

    await store.removePlugin('p1');

    const loaded = await store.load();
    expect(loaded.map((p) => p.id)).toEqual(['p2']);
  });

  it('removePlugin 不存在条目 → no-op（其他条目保留）', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);
    await store.save([makeEntry({ id: 'p1' })]);

    await store.removePlugin('ghost');

    expect(await store.load()).toHaveLength(1);
  });

  it('getPlugin 命中返回条目', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);
    await store.save([makeEntry({ id: 'p1', state: 'active' })]);

    const entry = await store.getPlugin('p1');
    expect(entry?.id).toBe('p1');
    expect(entry?.state).toBe('active');
  });

  it('getPlugin 未命中返回 undefined', async () => {
    const storePath = await makeStorePath();
    const store = new PluginStore(storePath);

    expect(await store.getPlugin('ghost')).toBeUndefined();
  });
});

// ─── 写入失败静默降级 ─────────────────────────────────────────

describe('PluginStore - 写入失败静默降级', () => {
  it('save 失败（父路径是文件）→ console.warn，不抛错', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-sdk-store-'));
    tmpDirs.push(dir);
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'file-not-dir', 'utf8');
    const storePath = join(blocker, 'store.json');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new PluginStore(storePath);
      await expect(store.save([makeEntry()])).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PluginStore] failed to save'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('load 在不可读路径 → 静默返回空数组（不抛错）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-sdk-store-'));
    tmpDirs.push(dir);
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'x', 'utf8');

    expect(await new PluginStore(join(blocker, 'store.json')).load()).toEqual([]);
  });
});
