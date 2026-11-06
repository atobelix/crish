// 端侧（本机）GGUF 模型目录清单：五条小模型，客户端直拉公开源，
// 不经我方服务器（用户口径 2026-11-06：没有服务器带宽，模型靠拉取）。
//
// 数值纪律：size 与 sha256 均为 Hugging Face tree API 的 LFS 实查值
// （可行性报告第四节，2026-11-06；其中 1.5B / 3B 的 sha256 报告里只印了
// 截断值，施工时已回 tree API 补全并交叉核对截断前缀一致），不是估算、
// 不是记忆默写。改任一数值必须同步回 HF 实查，禁止手填。
// urls 顺序与 ASR 先例同序：hf-mirror.com 第一（国内直达），
// huggingface.co 第二（回退）。内容可信度由固定 sha256 保证，与来源无关。
/** 模型许可证描述（UI 必须如实呈现，警示字段不得省略） */
export interface OnDeviceModelLicense {
  /** 许可证标识（如 'Apache-2.0'、'Qwen Research License'） */
  id: string;
  /** 面向用户的许可证说明文案 */
  label: string;
  /**
   * 许可警示（可选）：存在时管理面必须显式呈现。
   * 当前仅 Qwen2.5-3B 一条：其许可是 Qwen Research License
   * （非商用研究许可），与 1.5B 的 Apache-2.0 不是一回事，禁止混同。
   */
  warning?: string;
}
/**
 * 端侧推理参数（可选组，O3）：每模型与 llama.cpp 运行时的对接参数，
 * 缺省走客户端默认口径（n_ctx 4096、思考按模板默认、无追加停止词）。
 * 与下载身份字段（size/sha256）分开：这里的值是工程口径，不是 HF 实查值。
 */
export interface OnDeviceInferenceSpec {
  /** llama.cpp 上下文大小（n_ctx）；大模型压小以控内存（3B 为 2048） */
  contextSize?: number;
  /**
   * 是否允许模板思考（enable_thinking）；Qwen3 显式关闭——v1 纯对话
   * 口径 + 小模型思考速度代价，客户端经 enable_thinking 与
   * chat_template_kwargs 双路下发关闭。
   */
  enableThinking?: boolean;
  /** 追加停止词（模型 eos 的文本形；模板自身 eos 之外的兜底） */
  stop?: readonly string[];
}
/** 目录中的一条端侧模型（单 GGUF 文件） */
export interface OnDeviceModelSpec {
  /** 稳定 id：同时用作本地存储目录名与配置中的 modelId，禁止随意改名 */
  id: string;
  /** 显示名（模型选择器/管理面） */
  displayName: string;
  /** GGUF 文件名（HF 仓库内文件名，亦为本地落盘文件名） */
  fileName: string;
  /** 期望字节数（HF tree API 实查；快速校验 + 进度分母 + 空间预检基数） */
  size: number;
  /** 期望 SHA-256（HF LFS oid 实查；下载完成后必查，权威校验） */
  sha256: string;
  /** 下载源（按序尝试：hf-mirror 第一，huggingface.co 第二） */
  urls: readonly string[];
  /** 许可证（3B 条目带研究许可警示，见 OnDeviceModelLicense.warning） */
  license: OnDeviceModelLicense;
  /** 是否为默认推荐档（当前仅 Qwen2.5-1.5B） */
  recommended?: boolean;
  /** 端侧推理参数（O3 消费；见 OnDeviceInferenceSpec） */
  inference?: OnDeviceInferenceSpec;
}
const hfUrls = (repo: string, fileName: string): readonly string[] => [
  `https://hf-mirror.com/${repo}/resolve/main/${fileName}`,
  `https://huggingface.co/${repo}/resolve/main/${fileName}`,
];
const APACHE_2_0: OnDeviceModelLicense = {
  id: 'Apache-2.0',
  label: 'Apache-2.0 开源许可',
};
/** 端侧模型目录（五条；顺序即管理面呈现顺序，默认推荐在首位） */
export const ON_DEVICE_MODEL_CATALOG: readonly OnDeviceModelSpec[] = [
  {
    id: 'qwen2.5-1.5b-instruct-q4_k_m',
    displayName: 'Qwen2.5-1.5B-Instruct（Q4_K_M）',
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    size: 1117320736,
    sha256:
      '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    urls: hfUrls(
      'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
      'qwen2.5-1.5b-instruct-q4_k_m.gguf'
    ),
    license: APACHE_2_0,
    recommended: true,
    inference: { stop: ['<|im_end|>'] },
  },
  {
    id: 'qwen3-1.7b-q4_k_m',
    displayName: 'Qwen3-1.7B（Q4_K_M）',
    fileName: 'Qwen3-1.7B-Q4_K_M.gguf',
    size: 1107409472,
    sha256:
      'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
    urls: hfUrls('unsloth/Qwen3-1.7B-GGUF', 'Qwen3-1.7B-Q4_K_M.gguf'),
    license: APACHE_2_0,
    inference: { enableThinking: false, stop: ['<|im_end|>'] },
  },
  {
    id: 'smollm2-1.7b-instruct-q4_k_m',
    displayName: 'SmolLM2-1.7B-Instruct（Q4_K_M）',
    fileName: 'smollm2-1.7b-instruct-q4_k_m.gguf',
    size: 1055609536,
    sha256:
      'decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33',
    urls: hfUrls(
      'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF',
      'smollm2-1.7b-instruct-q4_k_m.gguf'
    ),
    license: APACHE_2_0,
    inference: { stop: ['<|im_end|>'] },
  },
  {
    id: 'llama-3.2-1b-instruct-q4_k_m',
    displayName: 'Llama-3.2-1B-Instruct（Q4_K_M）',
    fileName: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    size: 807694464,
    sha256:
      '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
    urls: hfUrls(
      'bartowski/Llama-3.2-1B-Instruct-GGUF',
      'Llama-3.2-1B-Instruct-Q4_K_M.gguf'
    ),
    license: {
      id: 'Llama 3.2 Community License',
      label: 'Llama 3.2 社区许可（非 OSI 开源，条款内可分发）',
    },
    inference: { stop: ['<|eot_id|>'] },
  },
  {
    id: 'qwen2.5-3b-instruct-q4_k_m',
    displayName: 'Qwen2.5-3B-Instruct（Q4_K_M）',
    fileName: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    size: 2104932768,
    sha256:
      '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d',
    urls: hfUrls(
      'Qwen/Qwen2.5-3B-Instruct-GGUF',
      'qwen2.5-3b-instruct-q4_k_m.gguf'
    ),
    license: {
      id: 'Qwen Research License',
      label: 'Qwen 研究许可（非商用）',
      warning:
        '该模型为 Qwen Research License（非商用研究许可），并非 Apache-2.0 开源许可；仅限非商用研究用途，使用前请自行确认许可条款。',
    },
    inference: { contextSize: 2048, stop: ['<|im_end|>'] },
  },
];
/** 全部目录模型总字节数（全量下载时的空间/流量提示用） */
export const ON_DEVICE_MODEL_TOTAL_BYTES = ON_DEVICE_MODEL_CATALOG.reduce(
  (sum, m) => sum + m.size,
  0
);
/** 按 id 查目录条目（未知 id 返回 undefined） */
export function findOnDeviceModel(
  modelId: string
): OnDeviceModelSpec | undefined {
  return ON_DEVICE_MODEL_CATALOG.find((m) => m.id === modelId);
}
