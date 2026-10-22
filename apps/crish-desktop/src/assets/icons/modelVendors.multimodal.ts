/**
 * 模型厂商目录分组 · 多模态与生图、音频专精（category: multimodal）。
 * 由 modelVendorCatalog.ts 按固定顺序合并；组内键序参与启发式匹配优先级，勿随意重排。
 */
import type { ModelVendorMeta } from './modelVendorTypes';

export const MULTIMODAL_MODEL_VENDORS: Record<string, ModelVendorMeta> = {
  blackforest: {
    id: 'blackforest',
    name: 'Black Forest Labs (FLUX)',
    brandColor: '#111827',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: [
      'blackforest',
      'black-forest-labs',
      'flux',
      'flux.1-schnell',
      'flux.1-dev',
    ],
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
    name: 'Kuaishou (Kling)',
    nameKey: 'settings.models.vendor.kling',
    brandColor: '#000000',
    textColor: '#FFFFFF',
    category: 'multimodal',
    matchers: ['kling', 'kuaishou', 'kolors'],
  },
};
