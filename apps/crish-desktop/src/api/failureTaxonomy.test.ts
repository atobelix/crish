/**
 * 失败分类表测试（批 C 第 2 件，2026-11-03）：
 * - 表完备性：每家族 zh/en 标题 + 一句话说明齐全，动作至多一个；
 * - 标题唯一性：家族间标题不重复（「同失败两个叫法」的结构防线）；
 * - kebab 码覆盖：与 Rust 13 码对齐（aborted 唯一不登记，静默收口）；
 * - i18n 归一钉死：20 条既有错误标题已与家族标题逐字一致（双语）；
 * - 与移动端 13 类家族命名对齐；
 * - presentFailure 查表行为（kebab → 域 → 软分类；aborted/未知 → null）。
 */
import { describe, expect, it } from 'vitest';
import {
  FAILURE_FAMILIES,
  FAMILY_TO_DOMAIN,
  FAMILY_TO_SOFT,
  KEBAB_CODE_TO_FAMILY,
  type FailureFamily,
} from './failureTaxonomy';
import { DOMAIN_MESSAGES, presentFailure } from './userFacingErrors';
import { error as zhError } from '../i18n/locales/zh-CN/error';
import { error as enError } from '../i18n/locales/en-US/error';

const ALL_FAMILIES = Object.keys(FAILURE_FAMILIES) as FailureFamily[];

describe('失败分类表完备性与唯一性', () => {
  it('每家族标题/说明双语齐全，动作至多一个且标签齐全', () => {
    for (const family of ALL_FAMILIES) {
      const copy = FAILURE_FAMILIES[family];
      expect(copy.titleZh, family).toBeTruthy();
      expect(copy.titleEn, family).toBeTruthy();
      expect(copy.guidanceZh, family).toBeTruthy();
      expect(copy.guidanceEn, family).toBeTruthy();
      if (copy.action) {
        expect(copy.action.labelZh, family).toBeTruthy();
        expect(copy.action.labelEn, family).toBeTruthy();
      }
    }
  });

  it('家族标题全局唯一（zh/en 各自不重复）', () => {
    const zh = ALL_FAMILIES.map((f) => FAILURE_FAMILIES[f].titleZh);
    const en = ALL_FAMILIES.map((f) => FAILURE_FAMILIES[f].titleEn);
    expect(new Set(zh).size).toBe(zh.length);
    expect(new Set(en).size).toBe(en.length);
  });

  it('移动端 13 类家族命名全部对齐（kebab 化后同名）', () => {
    const mobile13: FailureFamily[] = [
      'network',
      'auth',
      'quota',
      'model-not-found',
      'endpoint-unavailable',
      'rate-limit',
      'context-length',
      'invalid-request',
      'payload-too-large',
      'server',
      'stream',
      'not-configured',
      'unknown',
    ];
    for (const family of mobile13) {
      expect(FAILURE_FAMILIES[family], family).toBeDefined();
    }
  });
});

describe('kebab 码 → 家族覆盖（Rust 13 码）', () => {
  const RUST13 = [
    'auth',
    'quota',
    'network',
    'timeout',
    'endpoint-unavailable',
    'server-error',
    'rate-limit',
    'gateway-challenge',
    'context-length-exceeded',
    'payload-too-large',
    'invalid-request',
    'aborted',
    'unknown',
  ];

  it('除 aborted 外 12 码全部登记；aborted 故意不登记（静默收口）', () => {
    for (const code of RUST13) {
      if (code === 'aborted') {
        expect(KEBAB_CODE_TO_FAMILY[code]).toBeUndefined();
      } else {
        expect(KEBAB_CODE_TO_FAMILY[code], code).toBeDefined();
      }
    }
    expect(Object.keys(KEBAB_CODE_TO_FAMILY).sort()).toEqual(
      RUST13.filter((c) => c !== 'aborted').sort()
    );
  });

  it('投影与既有软分类/域口径一致（抽查关键码）', () => {
    const fam = (code: string) => KEBAB_CODE_TO_FAMILY[code]!;
    expect(FAMILY_TO_SOFT[fam('quota')]).toBe('blocked');
    expect(FAMILY_TO_SOFT[fam('context-length-exceeded')]).toBe('context');
    expect(FAMILY_TO_SOFT[fam('gateway-challenge')]).toBe('provider_fault');
    expect(FAMILY_TO_DOMAIN[fam('timeout')]).toBe('S4');
    expect(FAMILY_TO_DOMAIN[fam('server-error')]).toBe('S5');
    expect(FAMILY_TO_DOMAIN[fam('invalid-request')]).toBe('S5');
    expect(FAMILY_TO_DOMAIN[fam('auth')]).toBeUndefined();
  });
});

describe('i18n 20 条标题异文归一（旧标题 → 家族唯一标题）', () => {
  // 归一映射：i18n 错误码 → 家族。标题值必须与分类表逐字一致（双语）。
  const UNIFIED: Record<string, FailureFamily> = {
    'provider.network': 'network',
    'network.unreachable': 'network',
    'provider.connection_error': 'network',
    'provider.timeout': 'timeout',
    'runtime.timeout': 'timeout',
    'provider.endpoint_unavailable': 'endpoint-unavailable',
    'provider.auth': 'auth',
    'provider.reauth_required': 'auth',
    'provider.refresh_failed': 'auth',
    'provider.no_token': 'not-configured',
    'provider.quota': 'quota',
    'provider.rate_limit': 'rate-limit',
    'provider.server': 'server',
    'provider.fatal': 'server',
    'provider.gateway_challenge': 'server',
    'provider.stream_interrupted': 'stream',
    'provider.schema': 'invalid-request',
    'provider.unknown': 'unknown',
    'context.length_exceeded': 'context-length',
    'network.daemon_dead': 'local-core-not-ready',
  };

  it('恰好 20 条，且 zh/en 标题与分类表逐字一致', () => {
    expect(Object.keys(UNIFIED)).toHaveLength(20);
    for (const [code, family] of Object.entries(UNIFIED)) {
      const key = `${code}.title`;
      expect(zhError[key], `zh ${key}`).toBe(FAILURE_FAMILIES[family].titleZh);
      expect(enError[key], `en ${key}`).toBe(FAILURE_FAMILIES[family].titleEn);
    }
  });
});

describe('presentFailure 查表', () => {
  it('kebab 码优先：auth → 认证失败；quota → 额度家族（不再出拦截文案）', () => {
    const auth = presentFailure('provider 错误（auth）：invalid api key');
    expect(auth?.family).toBe('auth');
    expect(auth?.title).toBe('认证失败');
    const quota = presentFailure(
      'provider 错误（quota）：Insufficient balance'
    );
    expect(quota?.family).toBe('quota');
    expect(quota?.guidance).toContain('额度已用尽');
  });

  it('状态对象 → 域家族；文本网络错误 → network 家族', () => {
    expect(presentFailure({ initialized: false })?.family).toBe(
      'local-core-not-ready'
    );
    expect(presentFailure('Network request failed')?.family).toBe('network');
    expect(presentFailure('InvalidInput: 串行守卫')?.family).toBe(
      'session-busy'
    );
  });

  it('aborted 静默（null）；完全未知输入 → null（调用方走通用兜底）', () => {
    expect(
      presentFailure('provider 错误（aborted）：user cancelled')
    ).toBeNull();
    expect(presentFailure('boom')).toBeNull();
    expect(presentFailure('')).toBeNull();
    expect(presentFailure(null)).toBeNull();
  });

  it('呈现形状：一句话说明 + 至多一个动作，永不回吐原始串', () => {
    const p = presentFailure(
      'provider 错误（server-error）：HTTP Some(500) stack…'
    );
    expect(p?.family).toBe('server');
    expect(p?.guidance).toBe('模型服务商侧出现故障，请稍后重试或切换模型。');
    expect(p?.guidance).not.toContain('HTTP');
    expect(p?.action?.kind).toBe('retry');
  });
});

describe('DOMAIN_MESSAGES 与分类表同源（防漂移）', () => {
  it('S1-S8/engine_crash 文案 == 对应家族 guidanceZh', () => {
    expect(DOMAIN_MESSAGES.S1).toBe(
      FAILURE_FAMILIES['local-core-not-ready'].guidanceZh
    );
    expect(DOMAIN_MESSAGES.S2).toBe(
      FAILURE_FAMILIES['not-configured'].guidanceZh
    );
    expect(DOMAIN_MESSAGES.S3).toBe(FAILURE_FAMILIES.restoring.guidanceZh);
    expect(DOMAIN_MESSAGES.S4).toBe(FAILURE_FAMILIES.network.guidanceZh);
    expect(DOMAIN_MESSAGES.S5).toBe(FAILURE_FAMILIES.server.guidanceZh);
    expect(DOMAIN_MESSAGES.S6).toBe(FAILURE_FAMILIES.internal.guidanceZh);
    expect(DOMAIN_MESSAGES.S7).toBe(
      FAILURE_FAMILIES['session-busy'].guidanceZh
    );
    expect(DOMAIN_MESSAGES.S8).toBe(
      FAILURE_FAMILIES['storage-busy'].guidanceZh
    );
    expect(DOMAIN_MESSAGES.engine_crash).toBe(
      FAILURE_FAMILIES['engine-crash'].guidanceZh
    );
  });
});
