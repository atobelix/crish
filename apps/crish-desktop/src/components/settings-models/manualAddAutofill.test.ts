// @vitest-environment jsdom
/**
 * 用户裁决「模型字典只做参考，实际以用户配置为准」——
 * 智能预填填出的价格只能是**参考值**（界面提示），绝不构成用户声明。
 *
 * 缺陷背景：字典/基线预估价曾随草稿被当作「用户声明」写进统一树
 * ~/.conex/models.yaml，此后与用户真手输的价格不可区分。
 */
import { describe, expect, it } from 'vitest';
import { calculateAutofillDraft } from './manualAddAutofill';
import { addDraftToModelInput } from './catalogWriteGate';
import { emptyAddDraft } from './modelsIpcHelpers';
import type { AddDraft } from './useModelProfilesState';

/** 字典命中项（deepseek/deepseek-v4-pro 基线含 CNY 价）。 */
const HIT_ID = 'deepseek-v4-pro';
const HIT_VENDOR = 'deepseek';

function referenceDraft(): AddDraft {
  return calculateAutofillDraft(HIT_ID, HIT_VENDOR, emptyAddDraft());
}

describe('智能预填：参考价只作提示', () => {
  it('字典命中时草稿携带参考价（供界面提示），但不置 pricingExplicit', () => {
    const draft = referenceDraft();

    // 参考价确实填进来了 —— 界面提示可用
    expect(draft.pricing).toEqual({
      currency: 'CNY',
      input: '3',
      output: '12',
      cacheRead: '0.3',
      cacheWrite: '',
    });

    // 但绝不构成用户声明
    expect(draft.pricingExplicit).not.toBe(true);
    expect(draft.pricingExplicit).toBe(false);
  });

  it('负向断言：字典参考价不得落树，落树补丁不含 pricing 键', () => {
    const patch = addDraftToModelInput(HIT_ID, referenceDraft());

    expect(Object.hasOwn(patch, 'pricing')).toBe(false);
    expect(patch).not.toHaveProperty('pricing');
  });

  it('负向断言：非价格预填字段仍正常落树，闸门只掐价格', () => {
    const patch = addDraftToModelInput(HIT_ID, referenceDraft());

    expect(patch.displayName).toBe('DeepSeek V4 Pro');
    expect(patch.contextWindow).toBe(1048576);
    expect(patch.maxOutputTokens).toBe(393216);
    expect(patch.thinking).toEqual({
      Low: 'low',
      Medium: 'medium',
      High: 'high',
      Max: 'max',
    });
  });

  it('无字典/探针命中时不留下 pricing: undefined 自有键（避免被读成「明确清空」）', () => {
    const draft = calculateAutofillDraft(
      'no-such-model-zzz',
      'no-such-vendor',
      emptyAddDraft()
    );

    expect(Object.hasOwn(draft, 'pricing')).toBe(false);
    expect(draft.pricingExplicit).toBe(false);
    expect(
      Object.hasOwn(addDraftToModelInput('no-such-model-zzz', draft), 'pricing')
    ).toBe(false);
  });

  it('预填会清掉上一轮残留的显式标记（换 id 后参考价不等于用户声明）', () => {
    const declared: AddDraft = {
      ...emptyAddDraft(),
      pricing: { currency: 'USD', input: '9' },
      pricingExplicit: true,
    };
    const next = calculateAutofillDraft(HIT_ID, HIT_VENDOR, declared);

    expect(next.pricingExplicit).toBe(false);
    expect(Object.hasOwn(addDraftToModelInput(HIT_ID, next), 'pricing')).toBe(
      false
    );
  });
});

describe('用户显式声明价格：必须仍能落树', () => {
  it('pricingExplicit === true 时补丁含 pricing 且值正确', () => {
    const patch = addDraftToModelInput(HIT_ID, {
      ...referenceDraft(),
      pricingExplicit: true,
    });

    expect(Object.hasOwn(patch, 'pricing')).toBe(true);
    expect(patch.pricing).toEqual({
      currency: 'CNY',
      input: 3,
      output: 12,
      cacheRead: 0.3,
    });
  });

  it('用户手输的价（非字典价）原值落树，不做倍率换算', () => {
    const patch = addDraftToModelInput('my-model', {
      ...emptyAddDraft(),
      modelId: 'my-model',
      pricing: {
        currency: 'USD',
        input: '0.99',
        output: '2.5',
        perImage: '1e-6',
      },
      pricingExplicit: true,
    });

    expect(patch.pricing).toEqual({
      currency: 'USD',
      input: 0.99,
      output: 2.5,
      perImage: 0.000001,
    });
  });

  it('未置标记时即使填了价也不落树（默认拒收，非默认放行）', () => {
    const patch = addDraftToModelInput('my-model', {
      ...emptyAddDraft(),
      modelId: 'my-model',
      pricing: { currency: 'USD', input: '0.99' },
    });

    expect(Object.hasOwn(patch, 'pricing')).toBe(false);
  });
});
