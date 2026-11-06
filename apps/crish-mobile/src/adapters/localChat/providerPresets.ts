// 移动端供应商预置字典与厂商推断（纯数据驱动、纯函数）：
// 对齐桌面端 crates/agent-provider 契约与移动端抽屉原型设计。
// 零副作用、零 I/O、无假延迟模拟，作为向导与配置管理的单一真理来源。
import type {
  LocalModelSpec as DomainModelSpec,
  LocalVendorKey,
} from '@/domain/types/localChat';

// 厂商预置标识 LocalVendorKey 的唯一声明在 domain/types/localChat
// （O4 收敛：本文件与 vendorLogosData 曾各有一份独立同名声明，已删，
// 一律引用领域声明，禁止再分叉）。其语义是「官方预置厂商」——驱动
// 预置端点字典与官方 Logo 映射；端侧内置条目（'ondevice'）无端点、
// 无密钥、无预置，不属于该枚举（O4 裁决，见 onDeviceProviderSync）。

/** 标准思考强度档位 */
export type LocalThinkingTier =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/** 思考规格规范 */
export interface LocalThinkingSpec {
  supported: boolean;
  availableTiers: LocalThinkingTier[];
  defaultTier: LocalThinkingTier;
}

/** 模态能力规范 */
export interface LocalModalitiesSpec {
  input: string[];
  output: string[];
}

/** 定价规格规范 */
export interface LocalPricingSpec {
  currency: 'CNY' | 'USD';
  input?: number;
  output?: number;
}

/** 扩展的模型条目规范（对齐桌面 ModelSpec 与移动真机） */
export interface LocalModelSpec extends DomainModelSpec {
  displayName?: string;
  enabled?: boolean;
  order?: number;
  tags?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  thinking?: LocalThinkingSpec;
  modalities?: LocalModalitiesSpec;
  pricing?: LocalPricingSpec;
}

/** 预置供应商条目定义 */
export interface ProviderPreset {
  /** 厂商标识 */
  vendor: LocalVendorKey;
  /** 厂商展示名称 */
  name: string;
  /** 官方默认 Base URL（OpenAI 兼容端点，以 /v1 结尾） */
  defaultBaseUrl: string;
  /** 推荐预置模型清单（具备完整能力规格与标签） */
  recommendedModels: LocalModelSpec[];
  /** 官方控制台/网站链接 */
  websiteUrl?: string;
  /** API Key 占位提示文字 */
  apiKeyPlaceholder: string;
  /** 针对局域网（如 Ollama）的连接指引与提示 */
  ipNote?: string;

  // ── 兼容别名字段（无缝对齐原型与后续视图调用） ──
  baseUrl?: string;
  keyPlaceholder?: string;
  models?: LocalModelSpec[];
  officialWebsite?: string;
  displayName?: string;
  latencyDefault?: string;
}

/**
 * 官方预置供应商字典（只读纯数据）：
 * 涵盖 DeepSeek、硅基流动、Ollama、OpenAI、Anthropic、Google、自定义。
 */
export const PROVIDER_PRESETS: Record<LocalVendorKey, ProviderPreset> = {
  deepseek: {
    vendor: 'deepseek',
    name: 'DeepSeek',
    displayName: 'DeepSeek (深度求索)',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyPlaceholder: 'sk-d7...',
    keyPlaceholder: 'sk-d7...',
    websiteUrl: 'https://platform.deepseek.com',
    officialWebsite: 'https://platform.deepseek.com',
    latencyDefault: '24ms',
    recommendedModels: [
      {
        id: 'deepseek-chat',
        displayName: 'DeepSeek-V3',
        enabled: true,
        tags: ['通用对话', '128k', '高性价比'],
        contextWindow: 131072,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'image', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 1.0, output: 2.0 },
      },
      {
        id: 'deepseek-reasoner',
        displayName: 'DeepSeek-R1',
        enabled: true,
        tags: ['深度推理', '64k', '思维链'],
        contextWindow: 65536,
        maxOutputTokens: 8192,
        thinking: {
          supported: true,
          availableTiers: ['high'],
          defaultTier: 'high',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 4.0, output: 16.0 },
      },
    ],
  },

  siliconflow: {
    vendor: 'siliconflow',
    name: '硅基流动',
    displayName: '硅基流动 (SiliconFlow)',
    defaultBaseUrl: 'https://api.siliconflow.cn/v1',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKeyPlaceholder: 'sk-sf...',
    keyPlaceholder: 'sk-sf...',
    websiteUrl: 'https://siliconflow.cn',
    officialWebsite: 'https://siliconflow.cn',
    latencyDefault: '36ms',
    recommendedModels: [
      {
        id: 'deepseek-ai/DeepSeek-V3',
        displayName: 'DeepSeek-V3 (满血)',
        enabled: true,
        tags: ['满血旗舰', '64k'],
        contextWindow: 65536,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'image', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 2.0, output: 4.0 },
      },
      {
        id: 'deepseek-ai/DeepSeek-R1',
        displayName: 'DeepSeek-R1 (满血)',
        enabled: true,
        tags: ['满血推理', '64k'],
        contextWindow: 65536,
        maxOutputTokens: 8192,
        thinking: {
          supported: true,
          availableTiers: ['high'],
          defaultTier: 'high',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 4.0, output: 16.0 },
      },
      {
        id: 'Qwen/Qwen2.5-72B-Instruct',
        displayName: '通义千问 2.5 72B',
        enabled: true,
        tags: ['通义千问', '32k'],
        contextWindow: 32768,
        maxOutputTokens: 4096,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 1.5, output: 3.0 },
      },
      {
        id: 'black-forest-labs/FLUX.1-schnell',
        displayName: 'FLUX.1 schnell',
        enabled: true,
        tags: ['生图模型', '图像生成'],
        contextWindow: 4096,
        maxOutputTokens: 2048,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text'], output: ['image'] },
        pricing: { currency: 'CNY', input: 0.05, output: 0.1 },
      },
    ],
  },

  ollama: {
    vendor: 'ollama',
    name: 'Ollama',
    displayName: 'Ollama (本地/局域网)',
    defaultBaseUrl: 'http://192.168.1.100:11434/v1',
    baseUrl: 'http://192.168.1.100:11434/v1',
    apiKeyPlaceholder: '本地无需密钥（可留空）',
    keyPlaceholder: '本地无需密钥（可留空）',
    websiteUrl: 'https://ollama.com',
    officialWebsite: 'https://ollama.com',
    latencyDefault: '4ms',
    ipNote:
      '手机真机无法直接访问 127.0.0.1 或 localhost。请确保手机与运行 Ollama 的电脑连接相同 Wi-Fi 局域网，并将 192.168.1.100 替换为电脑的局域网 IP（需配置 OLLAMA_HOST=0.0.0.0 允许外部访问）。',
    recommendedModels: [
      {
        id: 'qwen2.5-coder:7b',
        displayName: 'Qwen2.5 Coder 7B',
        enabled: true,
        tags: ['本地代码', '32k', '零延迟'],
        contextWindow: 32768,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 0.0, output: 0.0 },
      },
      {
        id: 'deepseek-r1:7b',
        displayName: 'DeepSeek-R1 7B',
        enabled: true,
        tags: ['本地推理蒸馏', '32k'],
        contextWindow: 32768,
        maxOutputTokens: 8192,
        thinking: {
          supported: true,
          availableTiers: ['high'],
          defaultTier: 'high',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 0.0, output: 0.0 },
      },
      {
        id: 'llama3.2:latest',
        displayName: 'Llama 3.2 Latest',
        enabled: true,
        tags: ['轻量视觉', 'Vision'],
        contextWindow: 131072,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'image', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 0.0, output: 0.0 },
      },
    ],
  },

  openai: {
    vendor: 'openai',
    name: 'OpenAI',
    displayName: 'OpenAI 官方',
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyPlaceholder: 'sk-proj-...',
    keyPlaceholder: 'sk-proj-...',
    websiteUrl: 'https://platform.openai.com',
    officialWebsite: 'https://platform.openai.com',
    latencyDefault: '180ms',
    recommendedModels: [
      {
        id: 'gpt-4o',
        displayName: 'GPT-4o',
        enabled: true,
        tags: ['全模态旗舰', '128k', 'Vision'],
        contextWindow: 131072,
        maxOutputTokens: 16384,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: {
          input: ['text', 'image', 'audio', 'file'],
          output: ['text', 'audio'],
        },
        pricing: { currency: 'USD', input: 2.5, output: 10.0 },
      },
      {
        id: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        enabled: true,
        tags: ['极速小模型', '128k', '低成本'],
        contextWindow: 131072,
        maxOutputTokens: 16384,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'image', 'file'], output: ['text'] },
        pricing: { currency: 'USD', input: 0.15, output: 0.6 },
      },
      {
        id: 'o1-preview',
        displayName: 'o1-preview',
        enabled: true,
        tags: ['深思推理', '128k'],
        contextWindow: 131072,
        maxOutputTokens: 32768,
        thinking: {
          supported: true,
          availableTiers: ['max'],
          defaultTier: 'max',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'USD', input: 15.0, output: 60.0 },
      },
      {
        id: 'o3-mini',
        displayName: 'o3-mini',
        enabled: true,
        tags: ['代码推理', '200k'],
        contextWindow: 200000,
        maxOutputTokens: 65536,
        thinking: {
          supported: true,
          availableTiers: ['high'],
          defaultTier: 'high',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'USD', input: 1.1, output: 4.4 },
      },
    ],
  },

  anthropic: {
    vendor: 'anthropic',
    name: 'Anthropic',
    displayName: 'Anthropic Claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    baseUrl: 'https://api.anthropic.com/v1',
    apiKeyPlaceholder: 'sk-ant-...',
    keyPlaceholder: 'sk-ant-...',
    websiteUrl: 'https://console.anthropic.com',
    officialWebsite: 'https://console.anthropic.com',
    latencyDefault: '210ms',
    recommendedModels: [
      {
        id: 'claude-3-5-sonnet-20241022',
        displayName: 'Claude 3.5 Sonnet',
        enabled: true,
        tags: ['高智能旗舰', '200k', 'Vision'],
        contextWindow: 200000,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'image', 'file'], output: ['text'] },
        pricing: { currency: 'USD', input: 3.0, output: 15.0 },
      },
      {
        id: 'claude-3-5-haiku-20241022',
        displayName: 'Claude 3.5 Haiku',
        enabled: true,
        tags: ['极速响应', '200k'],
        contextWindow: 200000,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'file'], output: ['text'] },
        pricing: { currency: 'USD', input: 0.8, output: 4.0 },
      },
    ],
  },

  google: {
    vendor: 'google',
    name: 'Google Gemini',
    displayName: 'Google Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyPlaceholder: 'AIzaSy...',
    keyPlaceholder: 'AIzaSy...',
    websiteUrl: 'https://aistudio.google.com',
    officialWebsite: 'https://aistudio.google.com',
    latencyDefault: '150ms',
    recommendedModels: [
      {
        id: 'gemini-2.0-flash',
        displayName: 'Gemini 2.0 Flash',
        enabled: true,
        tags: ['新一代多模态', '1M', 'Vision'],
        contextWindow: 1048576,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: {
          input: ['text', 'image', 'audio', 'file'],
          output: ['text'],
        },
        pricing: { currency: 'USD', input: 0.1, output: 0.4 },
      },
      {
        id: 'gemini-1.5-pro',
        displayName: 'Gemini 1.5 Pro',
        enabled: true,
        tags: ['超长上下文', '2M', '高精度'],
        contextWindow: 2097152,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: {
          input: ['text', 'image', 'audio', 'file'],
          output: ['text'],
        },
        pricing: { currency: 'USD', input: 1.25, output: 5.0 },
      },
    ],
  },

  custom: {
    vendor: 'custom',
    name: '自定义供应商',
    displayName: '自定义 OpenAI 兼容接口',
    defaultBaseUrl: '',
    baseUrl: '',
    apiKeyPlaceholder: 'sk-...',
    keyPlaceholder: 'sk-...',
    latencyDefault: '45ms',
    recommendedModels: [
      {
        id: 'custom-model-chat',
        displayName: '默认对话模型',
        enabled: true,
        tags: ['自定义模型', '128k'],
        contextWindow: 131072,
        maxOutputTokens: 8192,
        thinking: {
          supported: false,
          availableTiers: ['off'],
          defaultTier: 'off',
        },
        modalities: { input: ['text', 'image', 'file'], output: ['text'] },
        pricing: { currency: 'CNY', input: 1.0, output: 2.0 },
      },
    ],
  },
};

// 确保 models 别名与 recommendedModels 一致
for (const preset of Object.values(PROVIDER_PRESETS)) {
  preset.models = preset.recommendedModels;
}

/**
 * 智能厂商推断纯函数：
 * 支持传入厂商名称、URL，或结构化对象 { vendorKey, name, baseUrl }。
 * 根据名称与 URL 关键字特征精确识别厂商，未能识别则回退为 'custom'。
 */
export function detectVendorKey(
  input:
    | string
    | {
        vendorKey?: string | null;
        name?: string | null;
        baseUrl?: string | null;
      }
    | null
    | undefined
): LocalVendorKey {
  if (!input) return 'custom';

  if (typeof input === 'object') {
    if (input.vendorKey && input.vendorKey in PROVIDER_PRESETS) {
      return input.vendorKey as LocalVendorKey;
    }
    const combined = `${input.name ?? ''} ${input.baseUrl ?? ''}`;
    return detectVendorKey(combined);
  }

  const s = input.trim().toLowerCase();
  if (s in PROVIDER_PRESETS) {
    return s as LocalVendorKey;
  }

  if (s.includes('deepseek')) return 'deepseek';
  if (s.includes('siliconflow') || s.includes('硅基')) return 'siliconflow';
  if (s.includes('ollama') || s.includes(':11434')) return 'ollama';
  if (s.includes('openai')) return 'openai';
  if (s.includes('anthropic') || s.includes('claude')) return 'anthropic';
  if (s.includes('google') || s.includes('gemini')) return 'google';

  return 'custom';
}
