import { describe, it, expect } from 'vitest';
import { resolveModelVendor, MODEL_VENDOR_CATALOG } from './modelVendorCatalog';
import { FOUNDATION_MODEL_VENDORS } from './modelVendors.foundation';
import { DOMESTIC_MODEL_VENDORS } from './modelVendors.domestic';
import { MULTIMODAL_MODEL_VENDORS } from './modelVendors.multimodal';
import { INFRA_MODEL_VENDORS } from './modelVendors.infra';
import { PLATFORM_MODEL_VENDORS } from './modelVendors.platform';
import { dictionaries, resolveDictionaryKey } from '../../i18n';

describe('modelVendorCatalog - resolveModelVendor', () => {
  it('应当能精确命中标准 vendor id', () => {
    expect(resolveModelVendor('deepseek')?.id).toBe('deepseek');
    expect(resolveModelVendor('openai')?.id).toBe('openai');
    expect(resolveModelVendor('anthropic')?.id).toBe('anthropic');
    expect(resolveModelVendor('qwen')?.id).toBe('qwen');
    expect(resolveModelVendor('moonshot')?.id).toBe('moonshot');
  });

  it('应当能兼容大小写与前后空格', () => {
    expect(resolveModelVendor('  DeepSeek  ')?.id).toBe('deepseek');
    expect(resolveModelVendor('OPENAI')?.id).toBe('openai');
    expect(resolveModelVendor('Claude')?.id).toBe('anthropic');
  });

  it('应当能智能剥离常见模型前缀与组织结构', () => {
    expect(resolveModelVendor('deepseek-ai/DeepSeek-V3')?.id).toBe('deepseek');
    expect(resolveModelVendor('deepseek-ai/DeepSeek-R1')?.id).toBe('deepseek');
    expect(resolveModelVendor('Qwen/Qwen2.5-72B-Instruct')?.id).toBe('qwen');
    expect(resolveModelVendor('meta-llama/Llama-3.3-70B-Instruct')?.id).toBe(
      'meta'
    );
  });

  it('应当能解析聚合服务平台的复合路径', () => {
    expect(
      resolveModelVendor('openrouter/anthropic/claude-3-5-sonnet')?.id
    ).toBe('anthropic');
    expect(resolveModelVendor('siliconflow/deepseek-ai/DeepSeek-V3')?.id).toBe(
      'deepseek'
    );
  });

  it('应当能识别启发式核心模型名', () => {
    expect(resolveModelVendor('gpt-4o')?.id).toBe('openai');
    expect(resolveModelVendor('o3-mini')?.id).toBe('openai');
    expect(resolveModelVendor('claude-3-5-sonnet-20241022')?.id).toBe(
      'anthropic'
    );
    expect(resolveModelVendor('gemini-2.0-flash-exp')?.id).toBe('google');
    expect(resolveModelVendor('glm-4-plus')?.id).toBe('zhipu');
    expect(resolveModelVendor('abab6.5s-chat')?.id).toBe('minimax');
  });

  it('对于未知或完全不匹配的模型，应当平稳返回 null（触发兜底组件）', () => {
    expect(resolveModelVendor('my-private-model-v1')).toBeNull();
    expect(resolveModelVendor('unknown-finetune:latest')).toBeNull();
    expect(resolveModelVendor('')).toBeNull();
    expect(resolveModelVendor(null)).toBeNull();
    expect(resolveModelVendor(undefined)).toBeNull();
  });
});

describe('modelVendorCatalog - 分组数据合并', () => {
  it('合并后保持原厂商集合与键序（键序决定启发式回退的命中优先级）', () => {
    expect(Object.keys(MODEL_VENDOR_CATALOG)).toEqual([
      'openai',
      'anthropic',
      'google',
      'meta',
      'mistral',
      'xai',
      'cohere',
      'perplexity',
      'deepseek',
      'qwen',
      'moonshot',
      'zhipu',
      'minimax',
      'bytedance',
      'stepfun',
      'baichuan',
      'zeroone',
      'baidu',
      'tencent',
      'iflytek',
      'sensetime',
      'blackforest',
      'stability',
      'midjourney',
      'elevenlabs',
      'suno',
      'kling',
      'voyage',
      'jina',
      'ollama',
      'openrouter',
      'siliconflow',
      'groq',
      'huggingface',
      'together',
      'fireworks',
      'deepinfra',
      'cerebras',
      'azure',
      'bedrock',
    ]);
  });

  it('每个分组文件只收录对应 category，且键与 id 一致', () => {
    const groups = [
      ['foundation', FOUNDATION_MODEL_VENDORS],
      ['domestic', DOMESTIC_MODEL_VENDORS],
      ['multimodal', MULTIMODAL_MODEL_VENDORS],
      ['infra', INFRA_MODEL_VENDORS],
      ['platform', PLATFORM_MODEL_VENDORS],
    ] as const;
    for (const [category, vendors] of groups) {
      for (const [key, vendor] of Object.entries(vendors)) {
        expect(vendor.category).toBe(category);
        expect(vendor.id).toBe(key);
      }
    }
  });
});

describe('modelVendorCatalog - 本地化展示名（nameKey）', () => {
  const CJK = /[\u4e00-\u9fff]/;

  it('nameKey 在 zh-CN 与 en-US 词典中都有词条，英文词条不含中文', () => {
    const withKey = Object.values(MODEL_VENDOR_CATALOG).filter(
      (v) => v.nameKey
    );
    expect(withKey.length).toBeGreaterThan(0);
    for (const vendor of withKey) {
      const key = vendor.nameKey!;
      const zh = resolveDictionaryKey(dictionaries['zh-CN'], key, null);
      const en = resolveDictionaryKey(dictionaries['en-US'], key, null);
      expect(zh, `${vendor.id} zh-CN`).toBeTruthy();
      expect(en, `${vendor.id} en-US`).toBeTruthy();
      expect(en, `${vendor.id} en-US`).not.toMatch(CJK);
    }
  });

  it('name 作为跨语言兜底不含中文；原中文品牌名全部经 nameKey 保留', () => {
    for (const vendor of Object.values(MODEL_VENDOR_CATALOG)) {
      expect(vendor.name, vendor.id).not.toMatch(CJK);
    }
    const zhName = (id: string) =>
      resolveDictionaryKey(
        dictionaries['zh-CN'],
        MODEL_VENDOR_CATALOG[id]?.nameKey ?? '',
        null
      );
    expect(zhName('deepseek')).toBe('DeepSeek (深度求索)');
    expect(zhName('bytedance')).toBe('字节跳动 (豆包)');
    expect(zhName('kling')).toBe('快手 (可灵 Kling)');
    expect(zhName('siliconflow')).toBe('SiliconFlow (硅基流动)');
  });
});
