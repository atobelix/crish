import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTOCOL,
  PROTOCOLS,
  PROTOCOL_LABELS,
  THINKING_VOCABULARY,
  THINKING_VOCABULARY_LABELS,
  normalizeProtocol,
  normalizeThinkingFormat,
  normalizeThinkingKey,
  normalizeThinkingMap,
  thinkingKeyLabel,
  thinkingVocabularyDiagnostic,
  findUnsupportedThinkingKeys,
  isCredentialReference,
} from './modelsNormalize';

describe('协议与思考的规范边界', () => {
  it('四协议及标签唯一，默认协议属于公开契约', () => {
    expect(PROTOCOLS).toEqual([
      'openai/chat',
      'openai/responses',
      'anthropic/messages',
      'google/generate-content',
    ]);
    expect(Object.keys(PROTOCOL_LABELS)).toEqual([...PROTOCOLS]);
    expect(PROTOCOLS).toContain(DEFAULT_PROTOCOL);
    for (const protocol of PROTOCOLS)
      expect(normalizeProtocol(protocol)).toBe(protocol);
  });
  it.each(['google/interactions', 'not-a-protocol', 1, null, undefined])(
    '旧协议或未知输入不进入运行契约：%s',
    (value) => {
      expect(normalizeProtocol(value)).toBeUndefined();
    }
  );
  it('只支持内核六种格式，不接纳被删除的自定义和旧名', () => {
    for (const format of [
      'openai',
      'qwen',
      'deepseek',
      'anthropic',
      'gemini',
      'zai',
    ])
      expect(normalizeThinkingFormat(format)).toBe(format);
    for (const format of ['custom', 'google', 'qwen_enable_thinking'])
      expect(normalizeThinkingFormat(format)).toBeUndefined();
  });
  it('七档及中文标签顺序完整', () => {
    expect(THINKING_VOCABULARY).toEqual([
      'Off',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'XHigh',
      'Max',
    ]);
    expect(Object.keys(THINKING_VOCABULARY_LABELS)).toEqual([
      ...THINKING_VOCABULARY,
    ]);
    for (const title of THINKING_VOCABULARY)
      expect(THINKING_VOCABULARY_LABELS[title]).toBeTruthy();
  });
  it('读边界归一别名，只改变键，不改 wire 原文', () => {
    expect(
      normalizeThinkingMap({
        'X-High': '  wire value  ',
        None: 'disabled',
        high: 'HIGH',
      })
    ).toEqual({ XHigh: '  wire value  ', Off: 'disabled', High: 'HIGH' });
    expect(normalizeThinkingKey(' high ')).toBe('High');
    expect(thinkingKeyLabel('X-High')).toBe('极高');
  });
  it.each([
    { Low: 'low', Custom: 'custom' },
    { Off: 'off', None: 'none' },
    { High: '' },
    { High: '  ' },
    { High: 10 },
    [],
    'High',
  ])('未知、重复或非法映射必须报错：%j', (map) => {
    expect(() => normalizeThinkingMap(map)).toThrow();
  });
  it('原型属性不是合法档位', () => {
    expect(normalizeThinkingKey('toString')).toBeUndefined();
    expect(normalizeThinkingKey('__proto__')).toBeUndefined();
  });
  it('诊断可展示错误，不能把重复或空 wire 当作成功', () => {
    expect(
      thinkingVocabularyDiagnostic({ Off: 'off', None: 'none' })
    ).toContain('重复');
    expect(thinkingVocabularyDiagnostic({ High: '' })).toContain('不能为空');
    expect(findUnsupportedThinkingKeys({ Low: 'low', Xhigh: 'wire' })).toEqual([
      'Xhigh',
    ]);
    expect(thinkingVocabularyDiagnostic({ Xhigh: 'wire' })).toContain(
      '不受支持'
    );
    expect(thinkingVocabularyDiagnostic({ High: 'wire' })).toBeNull();
    expect(normalizeThinkingMap(undefined)).toBeUndefined();
    expect(normalizeThinkingMap({})).toEqual({});
  });
});

describe('凭据引用', () => {
  it.each([
    'env:MY_KEY',
    'env:_KEY2',
    'dpapi:805bc574-e2c8-44a8-9ee3-e062797d6e74',
  ])('接受明确引用：%s', (value) => {
    expect(isCredentialReference(value)).toBe(true);
  });
  it.each([
    'env:1KEY',
    'env:PATH/KEY',
    'dpapi:provider-name',
    'dpapi:../key',
    'plain-key',
    '$API_KEY',
    '',
  ])('拒绝明文、路径与旧隐式名：%s', (value) => {
    expect(isCredentialReference(value)).toBe(false);
  });
});
