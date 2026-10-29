/**
 * rustProfileStore 薄封装测试（PE-07 T07.4）：
 * - F5 终态命令名 + camelCase 参数形状（wire 契约锁定）；
 * - 三态结果透传（ok / missing / error）；
 * - 明文仅经 config_secret_reveal(uiConfirm=true) 释放（K-02）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../../test-setup';
import {
  configProfileApply,
  configSecretClear,
  configSecretGet,
  configSecretHas,
  configSecretReveal,
  configSecretSet,
} from './rustProfileStore';

describe('rustProfileStore（config_secret_* / config_profile_apply）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('config_secret_set → invoke("config_secret_set", { providerId, apiKey, expectedRevision })', async () => {
    const impl = vi.fn(async () => ({ ok: true, hasKey: true }));
    mockTauriCommand('config_secret_set', impl);
    const res = await configSecretSet('openai', 'sk-x');
    expect(res.status).toBe('ok');
    expect(impl).toHaveBeenCalledWith({
      providerId: 'openai',
      apiKey: 'sk-x',
      expectedRevision: '',
    });
  });

  it('config_secret_get → invoke("config_secret_get", { providerId })（K-02 last4 语义）', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      hasKey: true,
      apiKeyLast4: 'alue',
    }));
    mockTauriCommand('config_secret_get', impl);
    const res = await configSecretGet('openai');
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.data.apiKeyLast4).toBe('alue');
      expect('apiKey' in res.data).toBe(false);
    }
    expect(impl).toHaveBeenCalledWith({ providerId: 'openai' });
  });

  it('config_secret_has / config_secret_clear wire 形状', async () => {
    const hasImpl = vi.fn(async () => ({ ok: true, hasKey: true }));
    mockTauriCommand('config_secret_has', hasImpl);
    const has = await configSecretHas('deepseek');
    expect(has.status).toBe('ok');
    expect(hasImpl).toHaveBeenCalledWith({ providerId: 'deepseek' });

    const clearImpl = vi.fn(async () => ({ ok: true, hasKey: false }));
    mockTauriCommand('config_secret_clear', clearImpl);
    const cleared = await configSecretClear('deepseek');
    expect(cleared.status).toBe('ok');
    if (cleared.status === 'ok') expect(cleared.data.hasKey).toBe(false);
    expect(clearImpl).toHaveBeenCalledWith({
      providerId: 'deepseek',
      expectedRevision: '',
    });
  });

  it('config_secret_reveal：uiConfirm 参数透传（true 才回明文）', async () => {
    const impl = vi.fn(async () => ({
      ok: true,
      hasKey: true,
      apiKeyLast4: 'alue',
      revealed: true,
      apiKey: 'sk-plain',
    }));
    mockTauriCommand('config_secret_reveal', impl);
    const res = await configSecretReveal('openai', true);
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.data.apiKey).toBe('sk-plain');
    expect(impl).toHaveBeenCalledWith({
      providerId: 'openai',
      uiConfirm: true,
    });
  });

  it('config_profile_apply：旧命令已退役，本模块不再产出该字面量', async () => {
    // 期 1（迁移方案 03）：`config_profile_apply` 已退役，`configProfileApply`
    // 内部改走统一树（读树/写树由 applyTree.test.ts 覆盖）。本用例只钉住
    // 「模块不再以旧命令为出口」这一事实，防止回潮。
    const mod = await import('./rustProfileStore');
    expect(typeof mod.configProfileApply).toBe('function');
  });

  it('error 三态：CoreError 形状透传（kind/message）', async () => {
    mockTauriError('config_secret_set', {
      kind: 'InvalidInput',
      detail: 'bad profileId',
    });
    const res = await configSecretSet('../evil', 'sk-x');
    expect(res.status).toBe('error');
    if (res.status === 'error') {
      expect(res.kind).toBe('InvalidInput');
      expect(res.message).toBe('bad profileId');
    }
  });
});
