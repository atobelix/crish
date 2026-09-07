/**
 * 模型视觉多模态能力判定（SSOT 权威判定模块）
 * 依据 docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md 与 catalog.json
 *
 * 判别优先级：
 * 1. 用户显式配置或探针扫描的 ModelMeta.capabilities?.image（首要最高真源）
 * 2. 外部 YAML 字典镜像 modelsCatalogStore 的 capabilities?.image
 * 3. 基于全球主流模型全景调研字典的模式规则精准匹配
 * 4. 默认保守返回 false（避免盲目发送 image_url 导致纯文本 API 抛 400 崩溃）
 */

import { getModelMeta } from './modelCatalogMeta';
import { findCatalogModel } from './modelsCatalogStore';

/**
 * 确定具备视觉多模态图像理解能力的知名模型族特征匹配正则
 */
const VISION_MODEL_PATTERNS: RegExp[] = [
  // Google: 全部 Gemini 家族与 Gemma 视觉版
  /^gemini(-|\/)/i,
  /gemma-4-(31b|26b)/i,

  // Anthropic: Claude 3+ 全系 (3, 3.5, 3.7, 4, 5)
  /claude-(3|3\.5|3-5|3\.7|3-7|sonnet|opus|haiku|fable)/i,

  // OpenAI: GPT-4o, GPT-4-turbo, GPT-4.1, GPT-5, o1 (除 o1-mini / o1-preview 外)
  /gpt-4o/i,
  /gpt-4-turbo/i,
  /gpt-4\.[1-9]/i,
  /gpt-5/i,
  /^o1(?!(?:-mini|-preview))/i,

  // Meta: Muse 全系与 Llama 3.2 Vision
  /muse-(spark|glimmer|image)/i,
  /llama-3\.2-(11b|90b)-vision/i,

  // 阿里通义: Qwen-VL, Qwen2-VL, Qwen2.5-VL
  /qwen.*-vl/i,

  // 智谱: GLM-4V, GLM-5V, GLM-V
  /glm-(4v|5v|.*-v)/i,

  // 月之暗面 Kimi: 视觉版
  /kimi-.*(vl|vision|code)/i,

  // xAI: Grok Vision
  /grok.*-vision/i,

  // Mistral: Pixtral 全系
  /pixtral/i,

  // 阶跃星辰: Step 视觉版
  /step-(1v|1\.5v|2v|3\.7)/i,

  // 百度千帆: ERNIE 4.5/5.0 VL
  /ernie-.*vl/i,

  // 通用视觉关键词标识
  /(?:^|[-_/])(vision|vl|multimodal)(?:[-_/]|$)/i,
];

/**
 * 明确不支持视觉的纯文本/代码专属模型（负向阻断）
 */
const NON_VISION_MODEL_PATTERNS: RegExp[] = [
  // DeepSeek: 纯文本模型
  /deepseek-(chat|coder|reasoner|r1|v3)/i,

  // OpenAI: 历史纯文本与轻量推理
  /gpt-3\.5/i,
  /o1-mini/i,
  /o1-preview/i,

  // 阿里通义: 纯文本
  /qwen-(plus|turbo|max|long|coder)/i,

  // 智谱: 纯文本
  /glm-(4|4-air|4-flash|4-plus|5)(?!v)/i,

  // Llama 纯文本版
  /llama-3(\.1|\.3)?-(8b|70b|405b)/i,

  // Mistral 纯文本
  /mistral-(large|medium|small)/i,
  /codestral/i,
];

/**
 * 判定指定模型是否支持图像多模态输入（统一真源）
 * @param modelId 模型唯一标识（如 gpt-4o, deepseek-chat, gemini-2.5-flash）
 * @param profileId 可选的服务商档案标识
 */
export function isModelVisionSupported(
  modelId: string,
  profileId?: string | null
): boolean {
  const rawModel = (modelId || '').trim();
  if (!rawModel) return false;

  // 1. 优先读取用户在设置或通过探针探测的明确能力配置
  if (profileId) {
    const meta = getModelMeta(profileId, rawModel);
    if (meta?.capabilities?.image !== undefined) {
      return Boolean(meta.capabilities.image);
    }
  }

  // 2. 检查外部模型字典 models.yaml 的镜像定义
  const spec = findCatalogModel(rawModel);
  if (spec?.capabilities?.image !== undefined) {
    return Boolean(spec.capabilities.image);
  }

  // 3. 负向白名单优先排除明确的纯文本模型
  for (const nonPattern of NON_VISION_MODEL_PATTERNS) {
    if (nonPattern.test(rawModel)) {
      return false;
    }
  }

  // 4. 正向规则精准匹配知名视觉模型族
  for (const pattern of VISION_MODEL_PATTERNS) {
    if (pattern.test(rawModel)) {
      return true;
    }
  }

  // 5. 保守策略：未知模型默认不支持视觉，防止发送 image_url 导致第三方服务商报错 400
  return false;
}
