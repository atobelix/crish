/**
 * 错误分类统一规范测试：
 * Rust 侧已分类的 kebab 错误码（provider 错误（auth）：… / endpoint-unavailable）
 * 必须被前端 classifySoftFailure 正确识别——前端不再按英文文本重复猜测。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyErrorDomain,
  classifySoftFailure,
  domainUserMessage,
  networkUserMessage,
  softFailureMessage,
} from './userFacingErrors';

describe('classifySoftFailure：Rust kebab 错误码优先识别（统一规范）', () => {
  it('auth：Rust provider 错误（auth）包装被识别', () => {
    expect(
      classifySoftFailure('provider 错误（auth）：鉴权失败（HTTP Some(401)）')
    ).toBe('auth');
    expect(classifySoftFailure('provider 错误（auth）：invalid api key')).toBe(
      'auth'
    );
  });

  it('network：endpoint-unavailable / network / timeout 归为网络', () => {
    expect(
      classifySoftFailure(
        'provider 错误（endpoint-unavailable）：端点不可用（HTTP Some(404)）'
      )
    ).toBe('network');
    expect(
      classifySoftFailure('provider 错误（network）：connection reset')
    ).toBe('network');
    expect(
      classifySoftFailure('provider 错误（timeout）：request timed out')
    ).toBe('network');
  });

  it('quota 归为 blocked；server-error/rate-limit/gateway-challenge 拆为 provider_fault（S5 域）', () => {
    expect(
      classifySoftFailure('provider 错误（quota）：Insufficient balance')
    ).toBe('blocked');
    expect(
      classifySoftFailure('provider 错误（server-error）：HTTP Some(500)')
    ).toBe('provider_fault');
    expect(
      classifySoftFailure('provider 错误（rate-limit）：429 Too Many Requests')
    ).toBe('provider_fault');
    expect(
      classifySoftFailure('provider 错误（gateway-challenge）：cf_chl')
    ).toBe('provider_fault');
  });

  it('no_key：Rust 密钥缺失文案被识别', () => {
    expect(
      classifySoftFailure('引擎未就绪（provider 配置缺失或加载失败）')
    ).toBe('no_key');
  });

  it('ended：无法分类的通用失败', () => {
    expect(classifySoftFailure('boom')).toBeNull();
    expect(classifySoftFailure('task failed: boom')).toBe('ended');
    expect(classifySoftFailure('run error occurred')).toBe('ended');
    expect(classifySoftFailure('')).toBeNull();
    expect(classifySoftFailure(null)).toBeNull();
  });
});

describe('classifyErrorDomain：差异化八域判定（S1-S8）', () => {
  it('core_get_status 状态对象 → S1/S2/S3；就绪 → null', () => {
    expect(classifyErrorDomain({ initialized: false })).toBe('S1');
    expect(
      classifyErrorDomain({ initialized: true, restore: { state: 'pending' } })
    ).toBe('S3');
    expect(
      classifyErrorDomain({
        initialized: true,
        restore: { state: 'done' },
        engineReady: false,
      })
    ).toBe('S2');
    expect(
      classifyErrorDomain({ initialized: true, engineReady: true })
    ).toBeNull();
    // snake_case 兼容（isStatusLike 的 engine_ready 分支）
    expect(
      classifyErrorDomain({ initialized: true, engine_ready: false })
    ).toBe('S2');
  });

  it('kebab 码 → S4（network/timeout/endpoint-unavailable）/ S5（server-error/rate-limit/gateway-challenge）', () => {
    expect(
      classifyErrorDomain('provider 错误（network）：connection reset')
    ).toBe('S4');
    expect(
      classifyErrorDomain('provider 错误（timeout）：request timed out')
    ).toBe('S4');
    expect(
      classifyErrorDomain(
        'provider 错误（endpoint-unavailable）：端点不可用（HTTP Some(404)）'
      )
    ).toBe('S4');
    expect(
      classifyErrorDomain('provider 错误（server-error）：HTTP Some(500)')
    ).toBe('S5');
    expect(
      classifyErrorDomain('provider 错误（rate-limit）：429 Too Many Requests')
    ).toBe('S5');
    expect(
      classifyErrorDomain('provider 错误（gateway-challenge）：cf_chl')
    ).toBe('S5');
  });

  it('aborted 显式返回 null（用户取消/中断静默收口，绝不上抛 S6）', () => {
    expect(
      classifyErrorDomain('provider 错误（aborted）：user cancelled')
    ).toBeNull();
  });

  it('未登记 kebab 码（auth/quota）→ null（保留既有 classify 分类接管）', () => {
    expect(
      classifyErrorDomain('provider 错误（auth）：invalid api key')
    ).toBeNull();
    expect(
      classifyErrorDomain('provider 错误（quota）：Insufficient balance')
    ).toBeNull();
  });

  it('Rust 门禁文案 → S2（provider 配置缺失，含 engine not ready 前缀时优先于 S1）', () => {
    expect(
      classifyErrorDomain(
        'internal: provider 配置缺失（baseUrl/model/apiKey 三件套）'
      )
    ).toBe('S2');
    expect(classifyErrorDomain('engine not ready（provider 配置缺失）')).toBe(
      'S2'
    );
  });

  it('restore 门禁文案 → S3', () => {
    expect(
      classifyErrorDomain('internal: restore in progress：等待重启恢复完成')
    ).toBe('S3');
  });

  it('本地核心未就绪文案 → S1', () => {
    expect(classifyErrorDomain('internal: engine not ready')).toBe('S1');
    expect(classifyErrorDomain('核心未就绪（等待连接超时）')).toBe('S1');
    expect(classifyErrorDomain('引擎未就绪')).toBe('S1');
  });

  it('网络词面（无 kebab 包装）→ S4；provider 侧故障词面 → S5', () => {
    expect(classifyErrorDomain('Network request failed')).toBe('S4');
    expect(classifyErrorDomain('Network: connection reset')).toBe('S4');
    expect(classifyErrorDomain('HTTP Some(500)')).toBe('S5');
    expect(classifyErrorDomain('429 rate limit exceeded')).toBe('S5');
  });

  it('串行并发守卫 → S7（会话排队中）', () => {
    expect(
      classifyErrorDomain('InvalidInput: 会话 s1 已有活动 run（串行守卫）')
    ).toBe('S7');
    expect(classifyErrorDomain('SESSION_BUSY: 会话 s2 已有活动 run')).toBe(
      'S7'
    );
  });

  it('存储同步繁忙 → S8（数据同步中）', () => {
    expect(
      classifyErrorDomain(
        'Io: store.append_event: database locked (sqlite busy)'
      )
    ).toBe('S8');
    expect(classifyErrorDomain('sqlite busy: store.lock')).toBe('S8');
  });

  it('收窄后的内部错误（panic / 未捕获异常 / 命令缺失）→ S6；无法分类 → null', () => {
    expect(
      classifyErrorDomain(
        'Internal: panic: unexpected nil pointer at engine.rs:120'
      )
    ).toBe('S6');
    expect(
      classifyErrorDomain('Tauri command not available: core_run_task')
    ).toBe('S6');
    expect(classifyErrorDomain('unhandled exception: crash')).toBe('S6');
    expect(classifyErrorDomain('boom')).toBeNull();
    expect(classifyErrorDomain('')).toBeNull();
    expect(classifyErrorDomain(null)).toBeNull();
    expect(classifyErrorDomain(undefined)).toBeNull();
  });
});

describe('networkUserMessage：消费 detail 分域文案与 S4 锁定兜底', () => {
  it('S1-S8 detail 样本 → 对应差异化文案', () => {
    expect(networkUserMessage({ initialized: false })).toBe(
      '软件服务正在启动，请稍候片刻。'
    );
    expect(
      networkUserMessage(
        'internal: provider 配置缺失（baseUrl/model/apiKey 三件套）'
      )
    ).toBe('模型服务尚未配置，请打开 设置 → 模型 完成配置后再发送。');
    expect(
      networkUserMessage({ initialized: true, restore: { state: 'pending' } })
    ).toBe('正在恢复上次的会话数据，稍后即可发送。');
    expect(
      networkUserMessage('provider 错误（network）：connection reset')
    ).toBe('模型服务商暂时无法连接（网络问题），请检查网络后重发。');
    expect(
      networkUserMessage('provider 错误（rate-limit）：429 Too Many Requests')
    ).toBe('模型服务商侧出现故障，请稍后重试或切换模型。');
    expect(networkUserMessage('Internal: panic: crash')).toBe(
      '软件内部错误，请稍后重试；若反复出现请重启应用。'
    );
    expect(networkUserMessage('InvalidInput: 串行守卫')).toBe(
      '当前会话上一轮任务仍在收尾中，已自动为您排队。'
    );
    expect(networkUserMessage('Io: database locked')).toBe(
      '本地会话存储正在同步数据，请稍候片刻。'
    );
  });

  it('detail 缺失/无法分类 → S4 锁定兜底（网络连接异常，彻底消灭 S6 无参死循环）', () => {
    expect(networkUserMessage()).toBe(
      '模型服务商暂时无法连接（网络问题），请检查网络后重发。'
    );
    expect(networkUserMessage('boom')).toBe(
      '模型服务商暂时无法连接（网络问题），请检查网络后重发。'
    );
  });

  it('domainUserMessage：八域文案齐全且不含旧一刀切「正在自动恢复」', () => {
    for (const d of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'] as const) {
      const msg = domainUserMessage(d);
      expect(msg).toBeTruthy();
      expect(msg).not.toContain('正在自动恢复');
    }
  });
});

describe('softFailureMessage：分类文案覆盖与 detail 透传', () => {
  it('活跃分类均有用户可读文案，ended 显式静默返回 null', () => {
    for (const kind of [
      'network',
      'no_key',
      'auth',
      'no_project',
      'blocked',
      'provider_fault',
      'context',
    ] as const) {
      expect(softFailureMessage(kind)).toBeTruthy();
    }
    expect(softFailureMessage('ended')).toBeNull();
  });

  it('softFailureMessage("network") 默认与透传 detail 均锁定 S4 并不退回 S6', () => {
    expect(softFailureMessage('network')).toBe(
      '模型服务商暂时无法连接（网络问题），请检查网络后重发。'
    );
    expect(
      softFailureMessage(
        'network',
        'provider 错误（timeout）：request timed out'
      )
    ).toBe('模型服务商暂时无法连接（网络问题），请检查网络后重发。');
  });

  it('provider_fault（S5 域）与 network（无 detail 兜底 S4）不再是旧一刀切', () => {
    expect(softFailureMessage('provider_fault')).toBe(
      '模型服务商侧出现故障，请稍后重试或切换模型。'
    );
    expect(softFailureMessage('network')).not.toContain('正在自动恢复');
  });
});
