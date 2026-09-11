import { describe, it, expect } from 'vitest';
import { resolveModelVendor, MODEL_VENDOR_CATALOG } from './modelVendorCatalog';

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
    expect(resolveModelVendor('meta-llama/Llama-3.3-70B-Instruct')?.id).toBe('meta');
  });

  it('应当能解析聚合服务平台的复合路径', () => {
    expect(resolveModelVendor('openrouter/anthropic/claude-3-5-sonnet')?.id).toBe('anthropic');
    expect(resolveModelVendor('siliconflow/deepseek-ai/DeepSeek-V3')?.id).toBe('deepseek');
  });

  it('应当能识别启发式核心模型名', () => {
    expect(resolveModelVendor('gpt-4o')?.id).toBe('openai');
    expect(resolveModelVendor('o3-mini')?.id).toBe('openai');
    expect(resolveModelVendor('claude-3-5-sonnet-20241022')?.id).toBe('anthropic');
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
