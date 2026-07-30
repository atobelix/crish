/**
 * 媒体内容类型（从 agent-runtime/src/media/media-types.ts 下沉的纯类型）
 *
 * 依据 02-FILE-MAPPING.md §2.16 / §5.3 / §9.4，将多模态媒体类型下沉到 shared-types，
 * 使 agent-context 的 token 估算等模块无需跨层引用 agent-runtime。
 */

export type MediaSource = 'base64' | 'url' | 'file_id';
export type MediaType = 'image' | 'audio' | 'video' | 'file';

/**
 * 归一化后的图片内容。agent-context 的 token 估算器仅需此类型。
 * 迁移自 agent-runtime/src/media/media-types.ts
 */
export interface ImageContent {
  type: 'image';
  mimeType: string;
  source: MediaSource;
  data: string;
  width?: number;
  height?: number;
  detail?: 'low' | 'high' | 'auto';
  sizeBytes: number;
}
