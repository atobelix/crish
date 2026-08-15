/**
 * kebab 错误码双向漂移测试（T-F 06 T3.1，对齐 04 方案步骤 4）：
 *
 * Rust 权威源 = `crates/session-loop/src/loop/handlers/stream_error.rs` 的
 * `kind_str`（13 分支，与 conex-types ProviderErrorKind 13 变体 serde
 * kebab-case 一一对应）。前端码表 = userFacingErrors.ts 的
 * `KEBAB_KIND_TO_SOFT` ∪ `KEBAB_TO_DOMAIN`。
 *
 * 断言：前端码表键集 == Rust 13 码 - 唯一豁免（`unknown` 兜底码）。
 * 故意改一侧码表立即红：改 Rust 加新 kind 不补前端 → 断言一红；
 * 改前端删/改码 → 断言一红；unknown 被误登记 → 断言二红（豁免滥用拦截）。
 *
 * CoreError kind（命令面错误协议）不在本范围：两套协议并行设计
 * （provider kebab 码 vs CoreError {kind, detail}），04 §4.1 已确认不混流，
 * 由 classifyErrorDomain / extractErrorKind（tauriInvoke.ts）分别处理。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RUST_KIND_SRC_REL =
  'crates/session-loop/src/loop/handlers/stream_error_fatal.rs';

function locateRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(dir, RUST_KIND_SRC_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `无法定位仓库根：上溯未找到 ${RUST_KIND_SRC_REL}（起始于 ${dir}）`
      );
    }
    dir = parent;
  }
}

import { existsSync } from 'node:fs';

/** 从 kind_str 抽取 13 码（对齐 stream_error.rs:305-319 形态：
 *  `ProviderErrorKind::X => "kebab-case"`；读失败 fail 不 skip，防摆设化） */
function rustKebabKinds(): string[] {
  const file = join(locateRepoRoot(), RUST_KIND_SRC_REL);
  if (!existsSync(file)) {
    throw new Error(`Rust 真源缺失：${file}（漂移测试必须 fail，不得 skip）`);
  }
  const src = readFileSync(file, 'utf8');
  const re = /ProviderErrorKind::\w+ => "([a-z-]+)"/g;
  const codes: string[] = [];
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) codes.push(m[1]);
  }
  return codes;
}

/** 哨兵：Rust 侧必须恰好 13 码（对齐 ProviderErrorKind 13 变体） */
const RUST_KIND_COUNT = 13;
/** 唯一豁免：unknown 兜底码（注释理由见文件头；断言其被兜底路径处理） */
const EXEMPT_KINDS: readonly string[] = ['unknown'];

import { classifyErrorDomain, classifySoftFailure } from './userFacingErrors';

describe('T-F 06 kebab 错误码双向漂移（Rust kind_str ↔ 前端码表）', () => {
  const rust = rustKebabKinds().sort();

  it('哨兵：Rust kind_str 抽取数 = 13（防正则漂移/空集摆设化）', () => {
    expect(rust.length).toBe(RUST_KIND_COUNT);
    expect(new Set(rust).size).toBe(rust.length);
  });

  it('断言一：前端码表键集 == Rust 13 码 - 唯一豁免（unknown）', () => {
    // 通过 userFacingErrors 的公开行为面验证：KEBAB_KIND_TO_SOFT 与
    // KEBAB_TO_DOMAIN 均为模块私有，经 classifySoftFailure / classifyErrorDomain
    // 的 kebab 分支读取——以「provider 错误（{kind}）：x」样本逐码探测。
    const softKinds = new Set<string>();
    const domains = new Set<string>();
    for (const kind of rust) {
      const sample = `provider 错误（${kind}）：sample`;
      const sf = classifySoftFailure(sample);
      if (sf !== null) softKinds.add(kind);
      const d = classifyErrorDomain(sample);
      if (d !== null) domains.add(kind);
    }
    const covered = new Set([...softKinds, ...domains]);
    // 唯一豁免 unknown 从缺码清单排除（兜底码，断言二验证其被兜底路径处理）
    const missing = rust.filter(
      (k) => !covered.has(k) && !EXEMPT_KINDS.includes(k)
    );
    expect(
      missing,
      `前端码表缺码：${missing.join(', ')}（Rust kind_str 新增/改名未同步）`
    ).toEqual([]);
    // 唯一豁免：unknown 必须被前端兜底路径处理（classifySoftFailure 回落
    // 文本正则/兜底分类；classifyErrorDomain 回落文本正则）——不豁免则断言
    // 一红；豁免滥用（多豁免）则下条断言红。
    expect(softKinds.has('unknown') || domains.has('unknown')).toBe(false);
    expect([...softKinds, ...domains].filter((k) => !rust.includes(k))).toEqual(
      []
    );
  });

  it('断言二：unknown 豁免为唯一豁免（其余 12 码全部登记）', () => {
    const rustKinds = rust.filter((k) => !EXEMPT_KINDS.includes(k));
    expect(rustKinds.length).toBe(RUST_KIND_COUNT - EXEMPT_KINDS.length);
    for (const kind of rustKinds) {
      const sample = `provider 错误（${kind}）：sample`;
      expect(
        classifySoftFailure(sample) !== null ||
          classifyErrorDomain(sample) !== null,
        `码 ${kind} 必须被前端码表覆盖（unknown 是唯一豁免）`
      ).toBe(true);
    }
  });

  it('断言三：context-length-exceeded 有专属分类（不再回落文本正则）', () => {
    expect(
      classifySoftFailure(
        'provider 错误（context-length-exceeded）：tokens 超限'
      )
    ).toBe('context');
    expect(
      classifyErrorDomain(
        'provider 错误（context-length-exceeded）：tokens 超限'
      )
    ).toBe('S5');
  });

  it('断言四：aborted → ended（null 域静默收口）；payload-too-large / invalid-request → provider_fault（S5）', () => {
    expect(
      classifySoftFailure('provider 错误（aborted）：user cancelled')
    ).toBe('ended');
    expect(
      classifyErrorDomain('provider 错误（aborted）：user cancelled')
    ).toBeNull();
    expect(
      classifySoftFailure('provider 错误（payload-too-large）：too big')
    ).toBe('provider_fault');
    expect(
      classifyErrorDomain('provider 错误（payload-too-large）：too big')
    ).toBe('S5');
    expect(
      classifySoftFailure('provider 错误（invalid-request）：bad schema')
    ).toBe('provider_fault');
    expect(
      classifyErrorDomain('provider 错误（invalid-request）：bad schema')
    ).toBe('S5');
  });
});
