import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { errorStore as ErrorStoreInstance } from '../services/ErrorStore';

/**
 * oauthTokenManager：OAuth 刷新 / 单飞锁 / 定时调度 / 失败升级。
 * 外部边界仅 mock：profile 持久化面（providerProfiles load/save）与 fetch。
 */
const store = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, unknown>>,
  saveCalls: 0,
}));

vi.mock('./providerProfiles', () => ({
  loadProfiles: () => store.profiles,
  saveProfiles: (list: Array<Record<string, unknown>>) => {
    store.saveCalls += 1;
    store.profiles = list;
  },
}));

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const MIN = 60_000;

function oauthProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'qwen',
    enabled: true,
    authType: 'oauth2',
    hasKey: false,
    oauthConfig: {
      tokenUrl: 'https://auth.example/token',
      clientId: 'client-1',
    },
    oauthToken: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: NOW + 2 * MIN,
      tokenType: 'Bearer',
      issuedAt: NOW - 60 * MIN,
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** 被测模块持有模块级状态（单飞锁/计数/定时器），每个用例重新加载一份。 */
let errorStore: typeof ErrorStoreInstance;

async function loadManager() {
  vi.resetModules();
  // 重新加载后 errorStore 也是新实例，须取被测模块实际使用的那一份
  errorStore = (await import('../services/ErrorStore')).errorStore;
  return import('./oauthTokenManager');
}

function activeOauthErrors(code: string) {
  return errorStore.getActiveErrors().filter((e) => e.code === code);
}

describe('oauthTokenManager', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store.profiles = [];
    store.saveCalls = 0;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('即将过期的 token 启动时立即刷新：POST 表单体正确，结果持久化并标记 hasKey', async () => {
    store.profiles = [
      oauthProfile({
        oauthConfig: {
          tokenUrl: 'https://auth.example/token',
          refreshUrl: 'https://auth.example/refresh',
          clientId: 'client-1',
          clientSecret: 's3cret',
          scopes: ['openid', 'model.read'],
        },
      }),
    ];
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        token_type: 'bearer',
        scope: 'openid',
      })
    );
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.example/refresh');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: 'client-1',
      client_secret: 's3cret',
      scope: 'openid model.read',
    });

    expect(store.saveCalls).toBe(1);
    const saved = store.profiles[0] as ReturnType<typeof oauthProfile>;
    expect(saved.hasKey).toBe(true);
    expect(saved.oauthToken).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: NOW + 3600 * 1000,
      tokenType: 'bearer',
      issuedAt: NOW,
      scope: 'openid',
    });
  });

  it('无 refreshUrl/secret/scopes 时回落 tokenUrl，表单体不带可选字段；缺省字段沿用旧值与默认', async () => {
    store.profiles = [
      oauthProfile({
        oauthToken: {
          accessToken: '',
          refreshToken: 'keep-refresh',
          expiresAt: 0,
          tokenType: 'Bearer',
          issuedAt: 0,
          scope: 'old-scope',
        },
      }),
    ];
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'a2' }));
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.example/token');
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'keep-refresh',
      client_id: 'client-1',
    });
    const token = (store.profiles[0] as ReturnType<typeof oauthProfile>)
      .oauthToken;
    // 未返回 expires_in → 默认 1 小时；refresh_token/scope 沿用旧值；类型默认 Bearer
    expect(token).toEqual({
      accessToken: 'a2',
      refreshToken: 'keep-refresh',
      expiresAt: NOW + 60 * MIN,
      tokenType: 'Bearer',
      issuedAt: NOW,
      scope: 'old-scope',
    });
  });

  it('expires_at（秒）优先于 expires_in', async () => {
    store.profiles = [oauthProfile()];
    const expiresAtSec = Math.floor((NOW + 90 * MIN) / 1000);
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'x',
        expires_in: 10,
        expires_at: expiresAtSec,
      })
    );
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);

    const token = (store.profiles[0] as ReturnType<typeof oauthProfile>)
      .oauthToken;
    expect(token.expiresAt).toBe(expiresAtSec * 1000);
  });

  it('未到刷新窗口的 token 只调度，在过期前 5 分钟才发起刷新，之后按新 token 继续调度', async () => {
    store.profiles = [
      oauthProfile({
        oauthToken: {
          accessToken: 'fresh',
          refreshToken: 'r',
          expiresAt: NOW + 30 * MIN,
          tokenType: 'Bearer',
          issuedAt: NOW,
        },
      }),
    ];
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        access_token: `t-${fetchMock.mock.calls.length}`,
        expires_in: 20 * 60,
      })
    );
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(25 * MIN - 1);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      (store.profiles[0] as ReturnType<typeof oauthProfile>).oauthToken
        .accessToken
    ).toBe('t-1');

    // 新 token 20 分钟有效 → 15 分钟后再次刷新
    await vi.advanceTimersByTimeAsync(15 * MIN - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超长有效期（超过 setTimeout 上限）不会因定时器溢出而立即反复刷新', async () => {
    const thirtyDays = 30 * 24 * 60 * MIN;
    store.profiles = [
      oauthProfile({
        oauthToken: {
          accessToken: 'long-lived',
          refreshToken: 'r',
          expiresAt: NOW + thirtyDays,
          tokenType: 'Bearer',
          issuedAt: NOW,
        },
      }),
    ];
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'renewed', expires_in: thirtyDays / 1000 })
    );
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    // 推进 1 天：远未进入刷新窗口，不得发请求
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(fetchMock).not.toHaveBeenCalled();

    // 推进到过期前 5 分钟：恰好刷新一次
    await vi.advanceTimersByTimeAsync(thirtyDays - 24 * 60 * MIN - 5 * MIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('跳过禁用、非 oauth2、无 token 的 profile', async () => {
    store.profiles = [
      oauthProfile({ id: 'disabled', enabled: false }),
      oauthProfile({ id: 'apikey', authType: 'apiKey' }),
      oauthProfile({ id: 'no-token', oauthToken: undefined }),
    ];
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(60 * MIN);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.saveCalls).toBe(0);
  });

  it('缺 refreshToken：不发请求、不写库、不推 errorStore（配置问题而非运行时故障）', async () => {
    store.profiles = [
      oauthProfile({
        oauthToken: {
          accessToken: '',
          refreshToken: '',
          expiresAt: 0,
          tokenType: 'Bearer',
          issuedAt: 0,
        },
      }),
    ];
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.saveCalls).toBe(0);
    expect(activeOauthErrors('OAUTH_TOKEN_REFRESH_FAILED')).toHaveLength(0);
  });

  it('HTTP 失败：不写库，推 warning；连续第 3 次失败升级为 error', async () => {
    store.profiles = [oauthProfile()];
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.saveCalls).toBe(0);
    const first = activeOauthErrors('OAUTH_TOKEN_REFRESH_FAILED');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      severity: 'warning',
      module: 'oauthTokenManager',
      technical: 'OAuth 刷新请求失败 HTTP 401',
    });
    expect(first[0]?.message).toContain('连续 1 次');

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);
    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const escalated = activeOauthErrors('OAUTH_TOKEN_REFRESH_FAILED').filter(
      (e) => e.severity === 'error'
    );
    expect(escalated).toHaveLength(1);
    expect(escalated[0]?.message).toContain('连续 3 次');
  });

  it('响应缺 access_token 视为失败，旧 token 保持不变', async () => {
    store.profiles = [oauthProfile()];
    fetchMock.mockResolvedValue(
      jsonResponse({ refresh_token: 'only-refresh' })
    );
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.saveCalls).toBe(0);
    expect(
      (store.profiles[0] as ReturnType<typeof oauthProfile>).oauthToken
        .accessToken
    ).toBe('old-access');
    expect(activeOauthErrors('OAUTH_TOKEN_REFRESH_FAILED')[0]?.technical).toBe(
      '刷新接口未返回有效 access_token'
    );
  });

  it('成功一次后连续失败计数清零', async () => {
    store.profiles = [oauthProfile()];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'ok', expires_in: 3600 })
      )
      .mockResolvedValue(jsonResponse({}, 500));
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);
    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);
    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);
    errorStore.resolveByModule('oauthTokenManager');

    // 成功后 token 1 小时有效 → 55 分钟后定时刷新并失败：计数应从 1 重新开始
    await vi.advanceTimersByTimeAsync(55 * MIN);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const errs = activeOauthErrors('OAUTH_TOKEN_REFRESH_FAILED');
    expect(errs).toHaveLength(1);
    expect(errs[0]?.severity).toBe('warning');
    expect(errs[0]?.message).toContain('连续 1 次');
  });

  it('单飞锁：同一 profile 进行中的刷新不会重复发请求', async () => {
    store.profiles = [oauthProfile()];
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve))
    );
    const { initOAuthTokenScheduler } = await loadManager();

    initOAuthTokenScheduler();
    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(jsonResponse({ access_token: 'single', expires_in: 3600 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.saveCalls).toBe(1);

    // 锁释放后可再次刷新
    store.profiles = [oauthProfile()];
    initOAuthTokenScheduler();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('读取 profile 抛错：调度器初始化失败推 info 级可自动解决错误，不向外抛', async () => {
    const { initOAuthTokenScheduler } = await loadManager();
    const original = store.profiles;
    Object.defineProperty(store, 'profiles', {
      configurable: true,
      get: () => {
        throw new Error('storage corrupted');
      },
    });
    try {
      expect(() => initOAuthTokenScheduler()).not.toThrow();
    } finally {
      Object.defineProperty(store, 'profiles', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
    const errs = activeOauthErrors('OAUTH_SCHEDULER_INIT_FAILED');
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({
      severity: 'info',
      autoResolve: true,
      technical: 'storage corrupted',
    });
  });
});
