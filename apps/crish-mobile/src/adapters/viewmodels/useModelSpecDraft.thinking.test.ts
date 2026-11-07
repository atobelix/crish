// 思考三字段独立提交契约（P4）：详情页与向导共用 withThinking* 提交函数。
// 钉死的历史事故：详情保存默认档时把 availableTiers 塌缩成 ['off', tier]，
// 一次编辑毁掉多档。本套断言每个提交函数只改自己名下的字段。
import type { LocalModelSpec } from '@/domain/types/localChat';
import {
  formatTokensText,
  withThinkingAvailableTiers,
  withThinkingDefaultTier,
  withThinkingSupported,
} from './useModelSpecDraft';

const baseSpec: LocalModelSpec = {
  id: 'm1',
  enabled: true,
  order: 3,
  contextWindow: 131072,
  thinking: {
    supported: true,
    availableTiers: ['off', 'low', 'medium', 'high'],
    defaultTier: 'low',
  },
};

describe('withThinkingDefaultTier（只改默认档）', () => {
  it('保存默认档后 availableTiers 长度与内容不变', () => {
    const next = withThinkingDefaultTier(baseSpec, 'high');
    expect(next.thinking?.availableTiers).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
    expect(next.thinking?.availableTiers).toHaveLength(4);
    expect(next.thinking?.defaultTier).toBe('high');
  });

  it('supported 与其它字段原样保留', () => {
    const next = withThinkingDefaultTier(baseSpec, 'medium');
    expect(next.thinking?.supported).toBe(true);
    expect(next.contextWindow).toBe(131072);
    expect(next.order).toBe(3);
    expect(next.enabled).toBe(true);
  });

  it('选「关闭」只改默认档，不顺带关掉 supported', () => {
    const next = withThinkingDefaultTier(baseSpec, 'off');
    expect(next.thinking?.supported).toBe(true);
    expect(next.thinking?.defaultTier).toBe('off');
    expect(next.thinking?.availableTiers).toHaveLength(4);
  });

  it('thinking 未配置时按所选档建立最小对象', () => {
    const bare: LocalModelSpec = { id: 'm2' };
    const next = withThinkingDefaultTier(bare, 'high');
    expect(next.thinking).toEqual({
      supported: true,
      availableTiers: ['off', 'high'],
      defaultTier: 'high',
    });
  });
});

describe('withThinkingSupported（只改支持开关）', () => {
  it('关掉支持不丢已配的可选档与默认档', () => {
    const next = withThinkingSupported(baseSpec, false);
    expect(next.thinking?.supported).toBe(false);
    expect(next.thinking?.availableTiers).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
    expect(next.thinking?.defaultTier).toBe('low');
  });

  it('thinking 未配置且关支持时保持未配置（不虚构对象）', () => {
    const bare: LocalModelSpec = { id: 'm2' };
    expect(withThinkingSupported(bare, false).thinking).toBeUndefined();
  });
});

describe('withThinkingAvailableTiers（只改可选档清单）', () => {
  it('默认档被移出清单时回落到清单首档，supported 不动', () => {
    const next = withThinkingAvailableTiers(baseSpec, ['off', 'high']);
    expect(next.thinking?.availableTiers).toEqual(['off', 'high']);
    expect(next.thinking?.defaultTier).toBe('off');
    expect(next.thinking?.supported).toBe(true);
  });

  it('默认档仍在清单内时保持不变', () => {
    const next = withThinkingAvailableTiers(baseSpec, ['off', 'low', 'max']);
    expect(next.thinking?.defaultTier).toBe('low');
  });

  it('空清单回落为仅关闭档，不产生空数组', () => {
    const next = withThinkingAvailableTiers(baseSpec, []);
    expect(next.thinking?.availableTiers).toEqual(['off']);
    expect(next.thinking?.defaultTier).toBe('off');
  });
});

describe('formatTokensText 未设置口径', () => {
  it('未设置显示「自动」，不伪造具体数值', () => {
    expect(formatTokensText(undefined)).toBe('自动');
    expect(formatTokensText(131072)).toBe('128k');
  });
});
