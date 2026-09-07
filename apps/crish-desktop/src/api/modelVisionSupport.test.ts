import { describe, expect, it } from 'vitest';
import { isModelVisionSupported } from './modelVisionSupport';

describe('modelVisionSupport', () => {
  it('正确识别主流多模态视觉模型', () => {
    expect(isModelVisionSupported('gpt-4o')).toBe(true);
    expect(isModelVisionSupported('gpt-4o-mini')).toBe(true);
    expect(isModelVisionSupported('gpt-4-turbo')).toBe(true);
    expect(isModelVisionSupported('gpt-5.6')).toBe(true);
    expect(isModelVisionSupported('claude-3-5-sonnet-20241022')).toBe(true);
    expect(isModelVisionSupported('claude-3-7-sonnet')).toBe(true);
    expect(isModelVisionSupported('claude-sonnet-4.6')).toBe(true);
    expect(isModelVisionSupported('gemini-2.5-flash')).toBe(true);
    expect(isModelVisionSupported('gemini-3.8-flash')).toBe(true);
    expect(isModelVisionSupported('qwen2.5-vl-72b')).toBe(true);
    expect(isModelVisionSupported('glm-4v-plus')).toBe(true);
    expect(isModelVisionSupported('glm-5v-turbo')).toBe(true);
    expect(isModelVisionSupported('pixtral-12b')).toBe(true);
  });

  it('正确识别主流纯文本模型并返回 false（防止 API 400 崩溃）', () => {
    expect(isModelVisionSupported('deepseek-chat')).toBe(false);
    expect(isModelVisionSupported('deepseek-reasoner')).toBe(false);
    expect(isModelVisionSupported('deepseek-r1')).toBe(false);
    expect(isModelVisionSupported('gpt-3.5-turbo')).toBe(false);
    expect(isModelVisionSupported('o1-mini')).toBe(false);
    expect(isModelVisionSupported('qwen-2.5-coder-32b')).toBe(false);
    expect(isModelVisionSupported('glm-4-flash')).toBe(false);
    expect(isModelVisionSupported('llama-3.1-70b')).toBe(false);
  });

  it('空字符串或未知模型默认保守返回 false', () => {
    expect(isModelVisionSupported('')).toBe(false);
    expect(isModelVisionSupported('my-custom-private-model')).toBe(false);
  });
});
