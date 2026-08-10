// packages/shared-types/src/generated/device/drift.test.ts
// R0-03 生成产物漂移护栏（注册表 ↔ 生成产物一致性，参考 engine 域 CI
// engine-bindings-drift job 的机制，提升为 vitest 单元门禁，本地即可红→绿）：
//
// - 漂移红：注册表（device-protocol.json）更新但未重跑生成器（或生成产物被
//   手改）→ 本测试用当前注册表在临时目录重新生成，与入库产物逐字节比对 →
//   不一致即失败；
// - 幂等：同注册表两次运行字节一致（无时间戳/随机数）；
// - 防假绿：故意篡改注册表副本 → 重新生成 → 产物必然变化（证明生成器真实
//   反映注册表，而非恒输出旧内容）；
// - 回归保障：engine 域 4 件套同样纳入比对（泛化后引擎产物字节不变）；
// - 运行时冒烟：抽样解析合法信封帧成功、非法 kind 被拒（连接层消费位）。
//
// 红→绿验证方式：`npm run test`（unit 项目含本文件）或 CI 中层 test job；
// 修复方式：node scripts/generate-engine-bindings.mjs 后提交生成产物。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');
const GENERATOR = join(ROOT, 'scripts', 'generate-engine-bindings.mjs');
const CONTRACTS_DIR = join(ROOT, 'crates', 'conex-types', 'contracts');
const GENERATED_DIR = join(ROOT, 'packages', 'shared-types', 'src', 'generated');

/** 生成器对指定注册表在临时目录执行一次（--out 直接作为输出目录） */
function regenerateTo(tmpDir: string, registryPath: string) {
  execFileSync(process.execPath, [GENERATOR, '--registry', registryPath, '--out', tmpDir], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

const DEVICE_REGISTRY = join(CONTRACTS_DIR, 'device-protocol.json');
const ENGINE_REGISTRY = join(CONTRACTS_DIR, 'engine-events.json');

/** 指定注册表的全部生成产物（与脚本输出集合一致，防比对漏文件） */
function generatedFiles(contract: 'engine-events' | 'device-protocol') {
  return contract === 'engine-events'
    ? ['events.ts', 'types.ts', 'parser.ts', 'index.ts']
    : [
        'types.ts',
        'kinds.ts',
        'commands.ts',
        'events.ts',
        'stream.ts',
        'errors.ts',
        'capabilities.ts',
        'parser.ts',
        'index.ts',
      ];
}

describe('R0-03 device 生成产物漂移护栏（注册表 ↔ 生成产物一致性）', () => {
  it('注册表 ↔ 入库产物零漂移（改注册表不重跑 → 红）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'device-bindings-drift-'));
    try {
      for (const [registry, sub] of [
        [DEVICE_REGISTRY, 'device'],
        [ENGINE_REGISTRY, 'engine'],
      ] as const) {
        const outDir = join(tmp, sub);
        regenerateTo(outDir, registry);
        const committedDir = join(GENERATED_DIR, sub);
        for (const file of generatedFiles(registry === DEVICE_REGISTRY ? 'device-protocol' : 'engine-events')) {
          const regenerated = readFileSync(join(outDir, file), 'utf8');
          const committed = readFileSync(join(committedDir, file), 'utf8');
          expect(
            committed,
            `${file} 与注册表漂移：注册表已更新但生成产物未同步（运行 node scripts/generate-engine-bindings.mjs 并提交产物）`,
          ).toBe(regenerated);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('生成器两次运行字节一致（幂等，无时间戳/随机数）', () => {
    const tmp1 = mkdtempSync(join(tmpdir(), 'device-bindings-idem1-'));
    const tmp2 = mkdtempSync(join(tmpdir(), 'device-bindings-idem2-'));
    try {
      regenerateTo(tmp1, DEVICE_REGISTRY);
      regenerateTo(tmp2, DEVICE_REGISTRY);
      for (const file of generatedFiles('device-protocol')) {
        expect(readFileSync(join(tmp1, file), 'utf8')).toBe(
          readFileSync(join(tmp2, file), 'utf8'),
        );
      }
    } finally {
      rmSync(tmp1, { recursive: true, force: true });
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  it('注册表变更必然反映到生成产物（防生成器假绿）', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'device-bindings-mut-'));
    try {
      const registry = JSON.parse(readFileSync(DEVICE_REGISTRY, 'utf8'));
      // 篡改一个会进入产物的字段：能力位名称（capabilities.ts 与
      // 校验/护栏全量引用）——非法名称不会被本测试误当合法契约
      registry.capabilities[0] = { ...registry.capabilities[0], name: 'fileReadX' };
      const modifiedRegistry = join(tmp, 'device-protocol.modified.json');
      writeFileSync(modifiedRegistry, JSON.stringify(registry), 'utf8');
      regenerateTo(tmp, modifiedRegistry);
      const regenerated = readFileSync(join(tmp, 'capabilities.ts'), 'utf8');
      const committed = readFileSync(
        join(GENERATED_DIR, 'device', 'capabilities.ts'),
        'utf8',
      );
      expect(regenerated).not.toBe(committed);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── 运行时冒烟：生成产物可解析（连接层消费位自检）──
import {
  DEVICE_CAPABILITIES,
  DEVICE_ERROR_CODES,
  DEVICE_KINDS,
  EVENT_SYNC_ELIGIBLE,
} from './index';
import { parseDeviceFrame } from './parser';

describe('R0-03 device 生成产物运行时冒烟', () => {
  it('静态账目锁定：103 kind / 45 错误码 / 17 能力位 / 20 同步面（M6 §1.1/§5.0）', () => {
    expect(DEVICE_KINDS.length).toBe(103);
    expect(DEVICE_ERROR_CODES.length).toBe(45);
    expect(DEVICE_CAPABILITIES.length).toBe(17);
    expect(EVENT_SYNC_ELIGIBLE.length).toBe(20);
  });

  it('合法信封帧解析成功（heartbeat 消息）', () => {
    const frame = {
      v: 1,
      kind: 'heartbeat',
      msgId: 'm-mob-0001',
      ts: 1754651200000,
      from: 'mobile',
      to: 'desktop',
      auth: { deviceId: 'dev-01HZ', ts: 1754651200000, nonce: 'n-1', sig: 's-1' },
      body: { ts: 1754651200000, deviceTimeMs: 1754651199500 },
    };
    const result = parseDeviceFrame(frame);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.kind).toBe('heartbeat');
      // body 为未打标联合（kind 与 body 类型无判别关联），用 in 守卫收窄
      const body = result.data.body;
      if (!('ts' in body)) {
        throw new Error('heartbeat body 缺少 ts 字段');
      }
      expect(body.ts).toBe(1754651200000);
    }
  });

  it('remote 命令信封校验 body.command 与 kind 后缀一致', () => {
    const ok = parseDeviceFrame({
      v: 1,
      kind: 'remote.getStatus',
      msgId: 'm-mob-0002',
      ts: 1754651200000,
      from: 'mobile',
      to: 'desktop',
      auth: { deviceId: 'dev-01HZ', ts: 1754651200000, nonce: 'n-2', sig: 's-2' },
      body: { command: 'getStatus', params: {} },
    });
    expect(ok.ok).toBe(true);
    const mismatch = parseDeviceFrame({
      v: 1,
      kind: 'remote.getStatus',
      msgId: 'm-mob-0003',
      ts: 1754651200000,
      from: 'mobile',
      to: 'desktop',
      auth: { deviceId: 'dev-01HZ', ts: 1754651200000, nonce: 'n-3', sig: 's-3' },
      body: { command: 'approve', params: {} },
    });
    expect(mismatch.ok).toBe(false);
  });

  it('未注册 kind 与非法协议版本被拒（fail-closed）', () => {
    const badKind = parseDeviceFrame({
      v: 1,
      kind: 'pair.bogus',
      msgId: 'm-mob-0004',
      ts: 1754651200000,
      from: 'mobile',
      to: 'desktop',
      auth: { deviceId: 'dev-01HZ', ts: 1754651200000, nonce: 'n-4', sig: 's-4' },
      body: {},
    });
    expect(badKind.ok).toBe(false);
    const badVersion = parseDeviceFrame({
      v: 2,
      kind: 'heartbeat',
      msgId: 'm-mob-0005',
      ts: 1754651200000,
      from: 'mobile',
      to: 'desktop',
      auth: { deviceId: 'dev-01HZ', ts: 1754651200000, nonce: 'n-5', sig: 's-5' },
      body: { ts: 1754651200000, deviceTimeMs: 1754651199500 },
    });
    expect(badVersion.ok).toBe(false);
  });
});
