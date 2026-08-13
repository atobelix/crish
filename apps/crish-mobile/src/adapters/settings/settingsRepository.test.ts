// settingsRepository 测试（R2-06 设置接线，B5 批命令面）：
// getSettings/setSettings/queryPresence 命令构造 + 发送 + 生成面解析；
// GatewayError 归一化；解析失败 → internal
import { WsGateway, GatewayError } from '@/network/WsGateway';
import {
  GatewaySettingsRepository,
  SETTINGS_ERROR_INTERNAL,
  SettingsCommandError,
  type SettingsRepository,
} from './settingsRepository';

/** 假网关（invoke 记录调用并返回注入结果） */
function makeGateway(
  onInvoke: (kind: string, body: unknown) => Promise<unknown>
): WsGateway {
  return { invoke: jest.fn(onInvoke) } as unknown as WsGateway;
}

describe('GatewaySettingsRepository', () => {
  it('getSettings：invoke remote.getSettings（C28 镜像拉取，无参 → 空参数信封）', async () => {
    const invoke = jest.fn(async () => ({
      settings: { responseStyle: 'balanced', permissionMode: 'ask' },
    }));
    const repo: SettingsRepository = new GatewaySettingsRepository(
      makeGateway(invoke)
    );
    const res = await repo.getSettings();
    expect(invoke).toHaveBeenCalledWith('remote.getSettings', {
      command: 'getSettings',
      params: {},
    });
    expect(res.settings).toEqual({
      responseStyle: 'balanced',
      permissionMode: 'ask',
    });
  });

  it('getSettings：keys 白名单子集透传', async () => {
    const invoke = jest.fn(async () => ({ settings: {} }));
    const repo = new GatewaySettingsRepository(makeGateway(invoke));
    await repo.getSettings({ keys: ['responseStyle', 'enableAnalytics'] });
    expect(invoke).toHaveBeenCalledWith('remote.getSettings', {
      command: 'getSettings',
      params: { keys: ['responseStyle', 'enableAnalytics'] },
    });
  });

  it('setSettings：invoke remote.setSettings（C29，key/value 信封；两态响应 applied）', async () => {
    const invoke = jest.fn(async () => ({ ok: true, applied: true }));
    const repo = new GatewaySettingsRepository(makeGateway(invoke));
    const res = await repo.setSettings({
      key: 'enableAnalytics',
      value: false,
    });
    expect(invoke).toHaveBeenCalledWith('remote.setSettings', {
      command: 'setSettings',
      params: { key: 'enableAnalytics', value: false },
    });
    expect(res).toEqual({ ok: true, applied: true });
  });

  it('setSettings：pending 待桌面确认响应原样透传（M6 §4.5.2）', async () => {
    const invoke = jest.fn(async () => ({
      ok: true,
      pending: true,
      confirmRequestId: 'cfm_1',
    }));
    const repo = new GatewaySettingsRepository(makeGateway(invoke));
    const res = await repo.setSettings({ key: 'responseStyle', value: 'high' });
    expect(res).toEqual({
      ok: true,
      pending: true,
      confirmRequestId: 'cfm_1',
    });
  });

  it('queryPresence：invoke remote.queryPresence（C32 桌面在场）', async () => {
    const invoke = jest.fn(async () => ({
      desktopOnline: true,
      engineVersion: '1.4.2',
    }));
    const repo = new GatewaySettingsRepository(makeGateway(invoke));
    const res = await repo.queryPresence();
    expect(invoke).toHaveBeenCalledWith('remote.queryPresence', {
      command: 'queryPresence',
      params: {},
    });
    expect(res).toEqual({ desktopOnline: true, engineVersion: '1.4.2' });
  });

  it('GatewayError → SettingsCommandError（code/retryable 透传，未连接语义）', async () => {
    const invoke = jest.fn(async () => {
      throw new GatewayError(
        'transport.closed',
        '连接未就绪，无法发送请求',
        true
      );
    });
    const repo = new GatewaySettingsRepository(makeGateway(invoke));
    await expect(repo.queryPresence()).rejects.toMatchObject({
      name: 'SettingsCommandError',
      code: 'transport.closed',
      retryable: true,
    });
  });

  it('响应解析失败（必填缺省）→ internal 错误', async () => {
    const invoke = jest.fn(async () => ({ desktopOnline: 'not-bool' }));
    const repo = new GatewaySettingsRepository(makeGateway(invoke));
    const err = (await repo
      .queryPresence()
      .catch((e) => e)) as SettingsCommandError;
    expect(err.code).toBe(SETTINGS_ERROR_INTERNAL);
    expect(err.retryable).toBe(false);
  });

  it('未知异常 → internal 错误', async () => {
    const invoke = jest.fn(async () => {
      throw new Error('boom');
    });
    const repo = new GatewaySettingsRepository(makeGateway(invoke));
    const err = (await repo
      .getSettings()
      .catch((e) => e)) as SettingsCommandError;
    expect(err.code).toBe(SETTINGS_ERROR_INTERNAL);
  });
});
