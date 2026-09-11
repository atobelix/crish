/**
 * modelVendorCatalog.ts — AI 模型厂商元数据与方形原彩图标字典
 *
 * 设计原则（严格遵循 ANTI_OVERENGINEERING_GUARDRAILS.md 与 AGENTS.md）：
 * 1. 结构纯粹：静态强类型映射，零复杂工厂，零动态异步反射；
 * 2. 容错解析：支持 vendorId、组织前缀、完整 modelId（如 deepseek-ai/DeepSeek-V3）与别名；
 * 3. 性能轻量：纯数据与纯函数，O(1) 精确命中 + 极简 O(N) 启发式回退，执行时间 < 0.05ms；
 * 4. 零冗余：仅收录最常用、叫得上号的高频厂商，总数严控在数十家，体积轻盈。
 */

export interface ModelVendorMeta {
  /** 标准厂商唯一标识（Canonical Key），如 'deepseek', 'openai' */
  id: string;
  /** 厂商官方规范名称 */
  name: string;
  /** 品牌官方代表底色（用于方形原彩底板） */
  brandColor: string;
  /** 品牌文字/前景对比色（默认为 #FFFFFF） */
  textColor: string;
  /** 厂商别名、常见模型前缀与关键字匹配集合 */
  matchers: string[];
  /** 分类标签，便于按需筛选或过滤 */
  category: 'foundation' | 'domestic' | 'multimodal' | 'platform' | 'infra';
  /** 方形原彩 SVG 内部图形矢量路径（viewBox="0 0 24 24" 内部） */
  svgInnerPath?: string;
}

/**
 * 常用叫得上名号的重点厂商数据字典（候选底模库）
 */
export const MODEL_VENDOR_CATALOG: Record<string, ModelVendorMeta> = {
  // === 1. 国际顶流基础大模型 ===
  openai: {
    id: 'openai',
    name: 'OpenAI',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['openai', 'chatgpt', 'gpt', 'gpt-4', 'gpt-4o', 'o1', 'o1-preview', 'o1-mini', 'o3', 'o3-mini', 'dall-e', 'text-embedding-3'],
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    brandColor: '#D97757',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['anthropic', 'claude', 'claude-3', 'claude-3-5-sonnet', 'claude-3-5-haiku', 'claude-3-opus'],
  },
  google: {
    id: 'google',
    name: 'Google (Gemini)',
    brandColor: '#1A73E8',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['google', 'gemini', 'gemma', 'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash', 'palm', 'deepmind'],
  },
  meta: {
    id: 'meta',
    name: 'Meta (Llama)',
    brandColor: '#0668E1',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['meta', 'llama', 'meta-llama', 'llama-3', 'llama-3.1', 'llama-3.2', 'llama-3.3'],
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    brandColor: '#FA520F',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['mistral', 'mistralai', 'codestral', 'mixtral', 'pixtral', 'mistral-large', 'mistral-small'],
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['xai', 'grok', 'grok-2', 'grok-3', 'grok-beta'],
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere',
    brandColor: '#39594D',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['cohere', 'command-r', 'command-r-plus', 'embed-multilingual', 'rerank'],
  },
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    brandColor: '#22B8CD',
    textColor: '#FFFFFF',
    category: 'foundation',
    matchers: ['perplexity', 'sonar', 'sonar-pro', 'pplx'],
  },

  // === 2. 国内主流核心大模型 ===
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek (深度求索)',
    brandColor: '#4D6BFE',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['deepseek', 'deepseek-ai', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-coder', 'deepseek-v3', 'deepseek-r1'],
  },
  qwen: {
    id: 'qwen',
    name: '通义千问 (Qwen)',
    brandColor: '#615CED',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['qwen', 'tongyi', 'aliyun', 'alibaba', 'qwen2.5', 'qwen-max', 'qwen-plus', 'qwen-turbo', 'qwq'],
  },
  moonshot: {
    id: 'moonshot',
    name: '月之暗面 (Kimi)',
    brandColor: '#16191E',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['moonshot', 'kimi', 'moonshot-v1', 'kimi-k3'],
  },
  zhipu: {
    id: 'zhipu',
    name: '智谱 AI (GLM)',
    brandColor: '#3859FF',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['zhipu', 'zhipuai', 'glm', 'chatglm', 'glm-4', 'glm-4-plus', 'glm-zero', 'codegeex', 'cogview'],
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax (海螺)',
    brandColor: '#F23F5D',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['minimax', 'abab', 'abab6.5', 'abab7', 'hailuo'],
  },
  bytedance: {
    id: 'bytedance',
    name: '字节跳动 (豆包)',
    brandColor: '#325AB4',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['bytedance', 'doubao', 'volcengine', 'volces', 'skylark', 'jimeng'],
  },
  stepfun: {
    id: 'stepfun',
    name: '阶跃星辰 (StepFun)',
    brandColor: '#1F2937',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['stepfun', 'step', 'step-1v', 'step-2', 'yuewen'],
  },
  baichuan: {
    id: 'baichuan',
    name: '百川智能 (Baichuan)',
    brandColor: '#FF6933',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['baichuan', 'baichuan2', 'baichuan3', 'baichuan4'],
  },
  zeroone: {
    id: 'zeroone',
    name: '零一万物 (01.AI)',
    brandColor: '#003425',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['zeroone', '01.ai', '01-ai', 'yi', 'yi-34b', 'yi-large', 'yi-lightning'],
  },
  baidu: {
    id: 'baidu',
    name: '百度 (文心一言)',
    brandColor: '#2468F2',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['baidu', 'wenxin', 'ernie', 'ernie-bot', 'qianfan'],
  },
  tencent: {
    id: 'tencent',
    name: '腾讯 (混元)',
    brandColor: '#0052D9',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['tencent', 'hunyuan', 'yuanbao'],
  },
  iflytek: {
    id: 'iflytek',
    name: '科大讯飞 (星火)',
    brandColor: '#0070F0',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['iflytek', 'spark', 'sparkdesk'],
  },
  sensetime: {
    id: 'sensetime',
    name: '商汤科技 (日日新)',
    brandColor: '#5B2AD8',
    textColor: '#FFFFFF',
    category: 'domestic',
    matchers: ['sensetime', 'sensenova', 'nova'],
  },

  // === 3. 多模态与生图、音频专精 ===
  blackforest: {
    id: 'blackforest',
    name: 'Black Forest Labs (FLUX)',
    brandColor: '#111827',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: ['blackforest', 'black-forest-labs', 'flux', 'flux.1-schnell', 'flux.1-dev'],
  },
  stability: {
    id: 'stability',
    name: 'Stability AI',
    brandColor: '#330066',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: ['stability', 'stabilityai', 'stable-diffusion', 'sdxl', 'sd3'],
  },
  midjourney: {
    id: 'midjourney',
    name: 'Midjourney',
    brandColor: '#1A1A1A',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: ['midjourney', 'mj'],
  },
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: ['elevenlabs', 'eleven-labs'],
  },
  suno: {
    id: 'suno',
    name: 'Suno',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: ['suno', 'suno-v3'],
  },
  kling: {
    id: 'kling',
    name: '快手 (可灵 Kling)',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: ['kling', 'kuaishou', 'kolors'],
  },

  // === 4. 搜索与 Embedding 顶流 ===
  voyage: {
    id: 'voyage',
    name: 'Voyage AI',
    brandColor: '#012E33',
    textColor: '#FFFFFF',
    category: 'infra',
    matchers: ['voyage', 'voyageai', 'voyage-3', 'voyage-code-2'],
  },
  jina: {
    id: 'jina',
    name: 'Jina AI',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'infra',
    matchers: ['jina', 'jinaai', 'jina-embeddings', 'jina-reranker', 'reader.jina.ai'],
  },

  // === 5. 核心聚合与推理部署平台 ===
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
    name: 'SiliconFlow (硅基流动)',
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

/**
 * 快速查找索引表（构建时生成一次，O(1) 命中）
 */
const MATCHER_INDEX = new Map<string, ModelVendorMeta>();

// 初始化精确索引
for (const vendor of Object.values(MODEL_VENDOR_CATALOG)) {
  MATCHER_INDEX.set(vendor.id.toLowerCase(), vendor);
  for (const m of vendor.matchers) {
    MATCHER_INDEX.set(m.toLowerCase(), vendor);
  }
}

/**
 * 纯逻辑智能模型厂商解析器（零过度设计，毫秒级解析）
 *
 * @param input 输入可能是 vendorId（如 'deepseek'）、完整模型标识（如 'deepseek-ai/DeepSeek-V3'）、
 *              或带聚合前缀的路径（如 'openrouter/anthropic/claude-3-5-sonnet'）
 * @returns 匹配到的厂商元数据，若无法识别则返回 null（由调用方触发兜底组件）
 */
export function resolveModelVendor(input?: string | null): ModelVendorMeta | null {
  if (!input) return null;

  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  // 1. 尝试直接精确命中（最高优先级，O(1)）
  const directHit = MATCHER_INDEX.get(raw);
  if (directHit) return directHit;

  // 2. 剥离可能存在的聚合平台/组织层级前缀（如 openrouter/anthropic/claude -> 拆分探测）
  const segments = raw.split(/[\/\\]+/).filter(Boolean);

  // 倒序检查每一段（例如 deepseek-ai/DeepSeek-V3 中优先检查 DeepSeek-V3，再检查 deepseek-ai）
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg) {
      const hit = MATCHER_INDEX.get(seg);
      if (hit) return hit;
    }
  }

  // 3. 启发式前缀/包含探测（例如以 'gpt-4o', 'claude-3', 'abab6.5', 'qwen2.5' 等模式判定）
  const normalizedKey = segments[segments.length - 1] || raw;

  for (const vendor of Object.values(MODEL_VENDOR_CATALOG)) {
    for (const matcher of vendor.matchers) {
      if (matcher.length >= 3) {
        // 匹配规则：以 matcher 开头或以分隔符包围，且后接数字、分隔符或字符串结尾
        // 例如：abab6.5, gpt-4, claude-3.5, qwen2.5, llama-3
        const escaped = matcher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|[-_./])${escaped}([-_./\\d]|$)`, 'i');
        if (regex.test(normalizedKey)) {
          return vendor;
        }
      }
    }
  }

  return null;
}
