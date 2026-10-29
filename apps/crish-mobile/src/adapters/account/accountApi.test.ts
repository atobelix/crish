// 账号 HTTP 客户端测试：登录 / 刷新 / 资料 / 中继设备发现 / 客户端票据。
//
// 重点覆盖错误分支（HTTP 非 2xx、超时、网络异常、响应形状异常）——这些是
// 生产事故的高发面，而旧覆盖率对 accountApi 仅 3.63%。
import {
  AccountApiError,
  confirmEmailContinue,
  continueEmail,
  deleteAccountRemote,
  fetchAccountMe,
  fetchClientTicket,
  fetchRelayDevices,
  loginAccount,
  refreshAccount,
  setAccountPassword,
  verifyEmailCode,
} from './accountApi';

interface MockResponse {
  ok?: boolean;
  status?: number;
  text?: string;
}

function mockFetchOnce(response: MockResponse): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    text: async () => response.text ?? '',
  }));
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const login = (email = 'a@b.c', password = 'pw') =>
  loginAccount(email, password, 'dev-1');

afterEach(() => {
  jest.restoreAllMocks();
});

describe('loginAccount', () => {
  it('解析 token 与用户资料', async () => {
    mockFetchOnce({
      text: JSON.stringify({
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        user: { id: 'u-1', email: 'a@b.c', nickname: '小明' },
      }),
    });

    const result = await login();

    expect(result.accessToken).toBe('at-1');
    expect(result.refreshToken).toBe('rt-1');
    expect(result.user).toEqual({ id: 'u-1', email: 'a@b.c', name: '小明' });
  });

  it('响应缺 token 时抛 bad_response', async () => {
    mockFetchOnce({ text: JSON.stringify({ accessToken: 'at-1' }) });
    await expect(login()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('HTTP 401 携带服务端 error 码', async () => {
    mockFetchOnce({
      ok: false,
      status: 401,
      text: JSON.stringify({ error: 'invalid_credentials' }),
    });
    await expect(login()).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
  });

  it('HTTP 错误但无 error 字段时回落到 http_<status>', async () => {
    mockFetchOnce({ ok: false, status: 500, text: '' });
    await expect(login()).rejects.toMatchObject({ code: 'http_500' });
  });

  it('响应体非 JSON 时不崩溃，按空体处理', async () => {
    mockFetchOnce({ text: 'not-json' });
    await expect(login()).rejects.toBeInstanceOf(AccountApiError);
  });

  it('非对象响应（null）抛 bad_response', async () => {
    mockFetchOnce({ text: 'null' });
    await expect(login()).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('统一邮箱入口 / 先码后密码', () => {
  it('continueEmail 解析 isNewUser / hasPassword / resendAfter', async () => {
    const fetchMock = mockFetchOnce({
      text: JSON.stringify({
        ok: true,
        expiresIn: 600,
        resendAfter: 60,
        isNewUser: true,
        hasPassword: false,
      }),
    });

    const ticket = await continueEmail(' a@b.c ');

    expect(ticket).toMatchObject({
      ok: true,
      expiresIn: 600,
      resendAfter: 60,
      isNewUser: true,
      hasPassword: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/email/continue');
    expect(JSON.parse(String(init.body))).toEqual({ email: 'a@b.c' });
  });

  it('confirmEmailContinue：新用户返回 setupToken，老用户返回会话', async () => {
    mockFetchOnce({
      text: JSON.stringify({ status: 'password_required', setupToken: 'st-1' }),
    });
    await expect(
      confirmEmailContinue('a@b.c', '123456', 'dev-1', '手机')
    ).resolves.toEqual({ kind: 'password_required', setupToken: 'st-1' });

    const fetchMock = mockFetchOnce({
      text: JSON.stringify({
        status: 'signed_in',
        accessToken: 'at',
        refreshToken: 'rt',
        user: { id: 'u', email: 'a@b.c' },
      }),
    });
    await expect(
      confirmEmailContinue('a@b.c', '123456', 'dev-1', '手机')
    ).resolves.toMatchObject({
      kind: 'signed_in',
      session: { accessToken: 'at', refreshToken: 'rt' },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      email: 'a@b.c',
      code: '123456',
      deviceId: 'dev-1',
      deviceName: '手机',
    });
  });

  it('verifyEmailCode 返回 setupToken，缺字段抛 bad_response', async () => {
    mockFetchOnce({ text: JSON.stringify({ setupToken: 'st-2' }) });
    await expect(
      verifyEmailCode('a@b.c', '123456', 'reset_password')
    ).resolves.toBe('st-2');

    mockFetchOnce({ text: JSON.stringify({}) });
    await expect(
      verifyEmailCode('a@b.c', '123456', 'register')
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('setAccountPassword 带 deviceName 建立会话', async () => {
    const fetchMock = mockFetchOnce({
      text: JSON.stringify({
        accessToken: 'at',
        refreshToken: 'rt',
        user: { id: 'u', email: 'a@b.c' },
      }),
    });

    const pair = await setAccountPassword('st-1', 'pw-123456', 'dev-1', '手机');

    expect(pair.accessToken).toBe('at');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/email/password/set');
    expect(JSON.parse(String(init.body))).toMatchObject({
      setupToken: 'st-1',
      deviceId: 'dev-1',
      deviceName: '手机',
    });
  });
});

describe('错误体 code / retryAfter / 注销', () => {
  it('优先使用服务端 code，并解析 retryAfter', async () => {
    mockFetchOnce({
      ok: false,
      status: 429,
      text: JSON.stringify({
        code: 'send_cooldown',
        error: 'Too Many Requests',
        message: '发送过于频繁',
        retryAfter: 42,
      }),
    });

    await expect(continueEmail('a@b.c')).rejects.toMatchObject({
      status: 429,
      code: 'send_cooldown',
      message: '发送过于频繁',
      retryAfter: 42,
    });
  });

  it('注销使用 POST /account/delete 并携带确认邮箱', async () => {
    const fetchMock = mockFetchOnce({ text: JSON.stringify({ ok: true }) });

    await deleteAccountRemote('tok', 'a@b.c');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/account/delete');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ confirmEmail: 'a@b.c' });
  });
});

describe('refreshAccount', () => {
  it('刷新成功后保留原 refreshToken 兜底', async () => {
    mockFetchOnce({
      text: JSON.stringify({ accessToken: 'at-2', refreshToken: '' }),
    });

    const result = await refreshAccount('rt-old');

    expect(result.accessToken).toBe('at-2');
    expect(result.refreshToken).toBe('rt-old');
  });
});

describe('fetchAccountMe', () => {
  it('解析扁平用户结构', async () => {
    mockFetchOnce({
      text: JSON.stringify({ id: 'u-9', email: 'x@y.z', name: '阿花' }),
    });
    await expect(fetchAccountMe('tok')).resolves.toEqual({
      id: 'u-9',
      email: 'x@y.z',
      name: '阿花',
    });
  });

  it('支持嵌套 user 结构', async () => {
    mockFetchOnce({
      text: JSON.stringify({ user: { accountId: 'u-7', email: 'n@m.o' } }),
    });
    await expect(fetchAccountMe('tok')).resolves.toMatchObject({ id: 'u-7' });
  });

  it('资料缺字段时抛 bad_response', async () => {
    mockFetchOnce({ text: JSON.stringify({ nickname: 'no-id' }) });
    await expect(fetchAccountMe('tok')).rejects.toMatchObject({
      code: 'bad_response',
    });
  });
});

describe('fetchRelayDevices', () => {
  it('只保留 desktop 平台设备，name 缺省回落到 id', async () => {
    mockFetchOnce({
      text: JSON.stringify({
        items: [
          { id: 'd-1', platform: 'desktop', online: true },
          { id: 'm-1', platform: 'mobile' },
          { id: '', platform: 'desktop' },
          'not-an-object',
        ],
      }),
    });

    const devices = await fetchRelayDevices('tok');

    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: 'd-1', name: 'd-1', online: true });
  });

  it('online 缺省视为在线，显式 false 才离线', async () => {
    mockFetchOnce({
      text: JSON.stringify({
        items: [
          { id: 'd-1', platform: 'desktop' },
          { id: 'd-2', platform: 'desktop', online: false },
        ],
      }),
    });

    const devices = await fetchRelayDevices('tok');

    expect(devices[0]?.online).toBe(true);
    expect(devices[1]?.online).toBe(false);
  });

  it('items 缺失时返回空数组', async () => {
    mockFetchOnce({ text: JSON.stringify({}) });
    await expect(fetchRelayDevices('tok')).resolves.toEqual([]);
  });

  it('lastSeenAt 非法时回落到当前时间', async () => {
    mockFetchOnce({
      text: JSON.stringify({
        items: [{ id: 'd-1', platform: 'desktop', lastSeenAt: 'bad' }],
      }),
    });

    const devices = await fetchRelayDevices('tok');

    expect(Number.isFinite(devices[0]?.lastSeenAt)).toBe(true);
  });
});

describe('fetchClientTicket', () => {
  it('解析票据与中继地址', async () => {
    mockFetchOnce({
      text: JSON.stringify({
        ticket: 'tk',
        relayUrl: 'wss://relay/x',
        exp: 123,
      }),
    });

    await expect(
      fetchClientTicket('tok', 'd-1', '手机', 'd-2')
    ).resolves.toEqual({ ticket: 'tk', relayUrl: 'wss://relay/x', exp: 123 });
  });

  it('缺 relayUrl 时抛 bad_response', async () => {
    mockFetchOnce({ text: JSON.stringify({ ticket: 'tk' }) });
    await expect(
      fetchClientTicket('tok', 'd-1', '手机', 'd-2')
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('非对象响应抛 bad_response', async () => {
    mockFetchOnce({ text: 'null' });
    await expect(
      fetchClientTicket('tok', 'd-1', '手机', 'd-2')
    ).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('网络层错误归一', () => {
  it('AbortError → timeout 码', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    global.fetch = jest.fn(async () => {
      throw abortError;
    }) as unknown as typeof fetch;

    await expect(login()).rejects.toMatchObject({ code: 'timeout', status: 0 });
  });

  it('其他网络异常 → network 码并保留原始消息', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('dns failure');
    }) as unknown as typeof fetch;

    await expect(login()).rejects.toMatchObject({
      code: 'network',
      message: 'dns failure',
    });
  });
});
