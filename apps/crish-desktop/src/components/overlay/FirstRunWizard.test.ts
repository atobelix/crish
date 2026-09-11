/**
 * 首次向导：gate / 手填 model 校验 / 页内 error 映射 / 联合类型守卫 / overlay 分工
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.localStorage !== 'undefined') return;
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
      setItem: (k: string, v: string) => {
        map.set(k, String(v));
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
    },
    configurable: true,
  });
});

vi.mock('../api/engineConfig', () => ({
  updateEngineConfig: vi.fn(async () => ({ ok: true })),
  pushRecentModel: vi.fn((m: string) => [m]),
  fetchEngineStatus: vi.fn(async () => ({
    ok: true,
    model: '',
    hasApiKey: false,
  })),
}));

import {
  DEFAULT_WIZARD_PROTOCOL,
  decideWizardKeySave,
  isFirstRunDone,
  isWizardModelIdError,
  isWizardModelIdOk,
  isWizardStep,
  markFirstRunDone,
  nextWizardStep,
  normalizeHandFilledModelId,
  prevWizardStep,
  shouldShowFirstRunWizard,
  validateWizardConnectForm,
  validateWizardModelId,
  wizardActivatePageError,
  WIZARD_MODEL_ID_MAX_LEN,
  type WizardKeySaveDecision,
  type WizardModelIdResult,
  type WizardStep,
} from '../firstRunWizardLib';
import { isFirstRunOverlayOpen } from '../firstRunOverlayFlag';
import {
  getDefaultProviderProfiles,
  saveProfiles,
  setProfileKey,
} from '../../api/providerProfiles';

const DONE_KEY = 'crish_first_run_done_v1';

describe('FirstRunWizard gate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows when not done and no local keys', () => {
    saveProfiles(getDefaultProviderProfiles());
    expect(isFirstRunDone()).toBe(false);
    expect(shouldShowFirstRunWizard()).toBe(true);
  });

  it('hides and marks done when any profile has key', async () => {
    saveProfiles([
      {
        id: 'custom-demo',
        name: '演示服务',
        baseUrl: 'https://api.example.com/v1',
        models: [],
        hasKey: false,
      },
    ]);
    // PE-07 T07.4：setProfileKey 已改异步（config_secret_set 落 DPAPI；
    // 非 Tauri 环境降级为本地 hasKey 草稿标记，不落明文）
    await setProfileKey('custom-demo', 'sk-test');
    expect(shouldShowFirstRunWizard()).toBe(false);
    expect(localStorage.getItem(DONE_KEY)).toBe('1');
    expect(isFirstRunDone()).toBe(true);
  });

  it('hides when already marked done even without keys', () => {
    markFirstRunDone();
    saveProfiles(getDefaultProviderProfiles());
    expect(shouldShowFirstRunWizard()).toBe(false);
  });

  it('default seeds: empty (neutral product, no third-party shells)', () => {
    // 中立产品：DEFAULT_PROFILES 恒为空；用户在向导/设置自建服务商
    expect(getDefaultProviderProfiles()).toEqual([]);
    expect(shouldShowFirstRunWizard()).toBe(true);
  });

  it('validateWizardConnectForm requires name/baseUrl/key', () => {
    expect(
      validateWizardConnectForm({ name: '', baseUrl: 'https://x', apiKey: 'k', protocol: 'openai/chat' })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/名称/) });
    expect(
      validateWizardConnectForm({ name: 'n', baseUrl: '', apiKey: 'k', protocol: 'openai/chat' })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Base URL/) });
    expect(
      validateWizardConnectForm({ name: 'n', baseUrl: 'ftp://x', apiKey: 'k', protocol: 'openai/chat' })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/http/) });
    expect(
      validateWizardConnectForm({ name: 'n', baseUrl: 'https://x/v1', apiKey: '', protocol: 'openai/chat' })
    ).toMatchObject({ ok: false, error: expect.stringMatching(/密钥/) });
    const ok = validateWizardConnectForm({
      name: ' 本地 ',
      baseUrl: ' https://api.example.com/v1 ',
      apiKey: ' sk-x ',
      protocol: '',
    });
    expect(ok).toEqual({
      ok: true,
      name: '本地',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      protocol: DEFAULT_WIZARD_PROTOCOL,
    });
  });

  it('overlay is closed outside mounted wizard (soft-hint may show)', () => {
    // 无组件挂载时 overlay 为 false；ChatStatusRibbons 据此决定是否让位
    expect(isFirstRunOverlayOpen()).toBe(false);
  });
});

describe('hand-filled model id', () => {
  it('normalize trims whitespace', () => {
    expect(normalizeHandFilledModelId('  deepseek-chat  ')).toBe('deepseek-chat');
    expect(normalizeHandFilledModelId('')).toBe('');
    expect(normalizeHandFilledModelId('   ')).toBe('');
  });

  it('normalize coerces nullish to empty string', () => {
    expect(normalizeHandFilledModelId(null as unknown as string)).toBe('');
    expect(normalizeHandFilledModelId(undefined as unknown as string)).toBe('');
  });

  it('validate accepts plain model ids', () => {
    const r = validateWizardModelId(' gpt-4o ');
    expect(r).toEqual({ ok: true, modelId: 'gpt-4o' });
    expect(isWizardModelIdOk(r)).toBe(true);
    if (isWizardModelIdOk(r)) {
      // 联合收窄：可读 modelId，不可当 error 用
      expect(r.modelId).toBe('gpt-4o');
    }
  });

  it('validate rejects empty (page error, no toast contract)', () => {
    const r = validateWizardModelId('  ');
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/手填|模型/) });
    expect(isWizardModelIdError(r)).toBe(true);
    if (isWizardModelIdError(r)) {
      expect(typeof r.error).toBe('string');
      expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('validate rejects internal spaces', () => {
    const r = validateWizardModelId('bad model');
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/空格/) });
  });

  it('validate rejects control characters', () => {
    const r = validateWizardModelId('gpt-4o\u0000evil');
    expect(isWizardModelIdError(r)).toBe(true);
    if (isWizardModelIdError(r)) {
      expect(r.error).toMatch(/非法/);
    }
  });

  it('validate rejects overlong hand-filled id', () => {
    const r = validateWizardModelId('m'.repeat(WIZARD_MODEL_ID_MAX_LEN + 1));
    expect(isWizardModelIdError(r)).toBe(true);
    if (isWizardModelIdError(r)) {
      expect(r.error).toMatch(/过长/);
    }
  });

  it('validate accepts id at max length', () => {
    const id = 'm'.repeat(WIZARD_MODEL_ID_MAX_LEN);
    expect(validateWizardModelId(id)).toEqual({ ok: true, modelId: id });
  });
});

describe('union type guards (WizardModelIdResult)', () => {
  it('isWizardModelIdOk / Error are mutually exclusive', () => {
    const ok: WizardModelIdResult = { ok: true, modelId: 'x' };
    const bad: WizardModelIdResult = { ok: false, error: 'e' };
    expect(isWizardModelIdOk(ok)).toBe(true);
    expect(isWizardModelIdError(ok)).toBe(false);
    expect(isWizardModelIdOk(bad)).toBe(false);
    expect(isWizardModelIdError(bad)).toBe(true);
  });
});

describe('page error mappers (no toast)', () => {
  it('decideWizardKeySave continues on ok', () => {
    const d = decideWizardKeySave({ ok: true, synced: true } as { ok: boolean; error?: string });
    expect(d).toEqual({ action: 'continue' });
  });

  it('decideWizardKeySave blocks empty_key with page copy', () => {
    const d = decideWizardKeySave({ ok: false, error: 'empty_key' });
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      expect(d.error).toMatch(/密钥/);
    }
  });

  it('decideWizardKeySave blocks not_connected with network page copy', () => {
    const d = decideWizardKeySave({ ok: false, error: 'not_connected' });
    expect(d.action).toBe('block');
    if (d.action === 'block') {
      expect(d.error.length).toBeGreaterThan(0);
    }
  });

  it('decideWizardKeySave blocks profile_not_found', () => {
    const d = decideWizardKeySave({ ok: false, error: 'profile_not_found' });
    expect(d).toMatchObject({ action: 'block', error: expect.stringMatching(/服务商/) });
  });

  it('decideWizardKeySave continues on soft engine sync failure (key already local)', () => {
    const d: WizardKeySaveDecision = decideWizardKeySave({
      ok: false,
      error: 'engine_timeout',
    });
    expect(d).toEqual({ action: 'continue' });
  });

  it('wizardActivatePageError returns null on success', () => {
    expect(wizardActivatePageError({ ok: true })).toBeNull();
  });

  it('wizardActivatePageError maps known codes to page copy', () => {
    expect(wizardActivatePageError({ ok: false, error: 'empty_model' })).toMatch(/模型/);
    expect(wizardActivatePageError({ ok: false, error: 'profile_not_found' })).toMatch(/服务商/);
    expect(wizardActivatePageError({ ok: false, error: 'not_connected' })?.length).toBeGreaterThan(
      0,
    );
    expect(wizardActivatePageError({ ok: false, error: 'mystery' })).toMatch(/启用失败/);
    expect(wizardActivatePageError({ ok: false })).toMatch(/启用失败/);
  });
});

describe('WizardStep union navigation', () => {
  it('isWizardStep accepts only 0..4', () => {
    expect(isWizardStep(0)).toBe(true);
    expect(isWizardStep(3)).toBe(true);
    expect(isWizardStep(4)).toBe(true);
    expect(isWizardStep(-1)).toBe(false);
    expect(isWizardStep(5)).toBe(false);
    expect(isWizardStep(1.5)).toBe(false);
  });

  it('prev/next clamp without unsafe casts', () => {
    const start: WizardStep = 0;
    expect(prevWizardStep(start)).toBe(0);
    expect(nextWizardStep(start)).toBe(1);
    expect(nextWizardStep(1)).toBe(2);
    expect(nextWizardStep(2)).toBe(3);
    expect(nextWizardStep(3)).toBe(4);
    expect(nextWizardStep(4)).toBe(4);
    expect(prevWizardStep(4)).toBe(3);
    expect(prevWizardStep(3)).toBe(2);
    expect(prevWizardStep(1)).toBe(0);
  });
});
