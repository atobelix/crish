/**
 * 模型厂商目录分组 · 核心聚合与推理部署平台（category: platform）。
 * 由 modelVendorCatalog.ts 按固定顺序合并；组内键序参与启发式匹配优先级，勿随意重排。
 */
import type { ModelVendorMeta } from './modelVendorTypes';

export const PLATFORM_MODEL_VENDORS: Record<string, ModelVendorMeta> = {
  ollama: {
    id: 'ollama',
    name: 'Ollama',
    brandColor: '#FFFFFF',
    textColor: '#000000',
    category: 'platform',
    matchers: ['ollama', 'localhost:11434'],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    brandColor: '#7B2BF9',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['openrouter', 'openrouter.ai'],
  },
  siliconflow: {
    id: 'siliconflow',
    name: 'SiliconFlow',
    nameKey: 'settings.models.vendor.siliconflow',
    brandColor: '#6E29F6',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['siliconflow', 'siliconcloud', 'siliconflow.cn'],
  },
  groq: {
    id: 'groq',
    name: 'Groq (LPU)',
    brandColor: '#F55036',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['groq', 'groqcloud'],
  },
  huggingface: {
    id: 'huggingface',
    name: 'Hugging Face',
    brandColor: '#FFD21E',
    textColor: '#000000',
    category: 'platform',
    matchers: ['huggingface', 'hf', 'hf.co'],
  },
  together: {
    id: 'together',
    name: 'Together AI',
    brandColor: '#0F6FFF',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['together', 'together.ai'],
  },
  fireworks: {
    id: 'fireworks',
    name: 'Fireworks AI',
    brandColor: '#5019C5',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['fireworks', 'fireworks.ai'],
  },
  deepinfra: {
    id: 'deepinfra',
    name: 'DeepInfra',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['deepinfra', 'deepinfra.com'],
  },
  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    brandColor: '#F15A29',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['cerebras'],
  },
  azure: {
    id: 'azure',
    name: 'Microsoft Azure AI',
    brandColor: '#0078D4',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['azure', 'azure-openai', 'azureai'],
  },
  bedrock: {
    id: 'bedrock',
    name: 'AWS Bedrock',
    brandColor: '#222F3E',
    textColor: '#FFFFFF',
    category: 'platform',
    matchers: ['bedrock', 'aws-bedrock'],
  },
};
