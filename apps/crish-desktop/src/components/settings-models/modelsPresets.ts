export interface PresetProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  format: 'openai' | 'anthropic';
}

export const DEFAULT_PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
};

export const PRESETS: PresetProvider[] = [
  {
    id: 'preset-opencode-go',
    name: 'OpenCode Go 订阅',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    models: ['deepseek-v4-flash', 'glm-5.2', 'kimi-k3'],
    format: 'openai',
  },
  {
    id: 'preset-opencode-zen',
    name: 'OpenCode Zen 独占',
    baseUrl: 'https://opencode.ai/zen/v1',
    models: ['deepseek-v4', 'minimax-abab7.5-chat', 'deepseek-v4-flash'],
    format: 'openai',
  },
  {
    id: 'preset-openai-direct',
    name: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview', 'o3-mini'],
    format: 'openai',
  },
  {
    id: 'preset-anthropic-direct',
    name: 'Anthropic 官方',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ],
    format: 'anthropic',
  },
  {
    id: 'preset-deepseek-direct',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    format: 'openai',
  },
  {
    id: 'preset-openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'deepseek/deepseek-chat',
    ],
    format: 'openai',
  },
  {
    id: 'preset-siliconflow',
    name: 'SiliconFlow 硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen2.5-72B-Instruct',
    ],
    format: 'openai',
  },
];
