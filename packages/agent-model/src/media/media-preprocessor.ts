import { readFile } from 'node:fs/promises';
import type {
  MediaInput,
  NormalizedMedia,
  ImageContent,
  AudioContent,
  VideoContent,
  FileContent,
  MediaValidateOptions,
  ImageCompressOptions,
  MediaSource,
} from './media-types';
import {
  DEFAULT_MAX_MEDIA_SIZE_BYTES,
  SUPPORTED_IMAGE_MIMES,
  SUPPORTED_AUDIO_MIMES,
  SUPPORTED_VIDEO_MIMES,
  SUPPORTED_FILE_MIMES,
  detectMimeFromBase64,
  estimateBase64Size,
} from './media-types';
import { MediaCache } from './media-cache';

// Whisper 模型的 token 率（约 0.3 tokens 每秒音频，按 16kHz 编码估算）
const WHISPER_TOKENS_PER_SECOND = 0.3;
// 音频默认采样率（假设未知时）
const DEFAULT_AUDIO_SAMPLE_RATE = 16000;
// 基于 16kHz 16bit 单声道 PCM 的码率
const BYTES_PER_SECOND_AUDIO = DEFAULT_AUDIO_SAMPLE_RATE * 2;

export class MediaPreprocessor {
  private cache: MediaCache;

  constructor(cache?: MediaCache) {
    this.cache = cache ?? new MediaCache();
  }

  async normalize(input: MediaInput): Promise<NormalizedMedia> {
    const key = await this.cache.cacheKey(input);
    const cached = this.cache.get(key);
    if (cached) return cached;

    let normalized: NormalizedMedia;

    if (input.bytes) {
      normalized = this.fromBytes(input);
    } else if (input.filePath) {
      normalized = await this.fromFile(input);
    } else if (input.source === 'base64' && input.data) {
      normalized = this.fromBase64(input);
    } else if (input.source === 'url' && input.url) {
      normalized = this.fromUrl(input);
    } else if (input.source === 'file_id' && input.fileId) {
      normalized = this.fromFileId(input);
    } else {
      throw new Error(
        `Invalid media input: no data, url, filePath, or bytes provided`
      );
    }

    this.cache.set(key, normalized);
    return normalized;
  }

  validate(
    media: NormalizedMedia,
    options?: MediaValidateOptions
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_MEDIA_SIZE_BYTES;

    if (media.sizeBytes > maxSize) {
      errors.push(`Media size ${media.sizeBytes} exceeds max ${maxSize}`);
    }

    const allowed = options?.allowedMimeTypes;
    if (allowed) {
      if (!allowed.includes(media.mimeType)) {
        errors.push(`Unsupported MIME type: ${media.mimeType}`);
      }
    } else {
      const supported = this.supportedMimesFor(media.type);
      if (
        supported &&
        !(supported as readonly string[]).includes(media.mimeType)
      ) {
        errors.push(
          `Unsupported MIME type for ${media.type}: ${media.mimeType}`
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }

  async compress(
    media: ImageContent,
    options?: ImageCompressOptions
  ): Promise<ImageContent> {
    const quality = options?.quality ?? 0.8;
    let targetWidth = media.width;
    let targetHeight = media.height;

    if (options?.maxWidth && targetWidth && targetWidth > options.maxWidth) {
      const ratio = options.maxWidth / targetWidth;
      targetWidth = options.maxWidth;
      if (targetHeight) targetHeight = Math.round(targetHeight * ratio);
    }
    if (
      options?.maxHeight &&
      targetHeight &&
      targetHeight > options.maxHeight
    ) {
      const ratio = options.maxHeight / targetHeight;
      targetHeight = options.maxHeight;
      if (targetWidth) targetWidth = Math.round(targetWidth * ratio);
    }

    const result: ImageContent = {
      ...media,
      ...(targetWidth !== undefined ? { width: targetWidth } : {}),
      ...(targetHeight !== undefined ? { height: targetHeight } : {}),
    };

    if (
      quality < 1 ||
      targetWidth !== media.width ||
      targetHeight !== media.height
    ) {
      result.data = await this.reencodeImage(media, {
        quality,
        ...(targetWidth !== undefined ? { width: targetWidth } : {}),
        ...(targetHeight !== undefined ? { height: targetHeight } : {}),
      });
    }

    return result;
  }

  /**
   * 估算多模态媒体的 token 消耗（参考 OpenAI 官方计费公式）。
   * - 图片: ceil(width / 512) * ceil(height / 512) * 170 + 85（高细节模式）
   *   低细节: 85 tokens
   * - 音频: 按 Whisper token 率估算（基于时长或字节数）
   * - 视频: 按帧数 * 单帧图片 token 估算
   * - PDF/文件: 按文本提取后字符数 / 4 估算
   */
  estimateTokens(media: NormalizedMedia): number {
    switch (media.type) {
      case 'image':
        return this.estimateImageTokens(media);
      case 'audio':
        return this.estimateAudioTokens(media);
      case 'video':
        return this.estimateVideoTokens(media);
      case 'file':
        return this.estimateFileTokens(media);
      default:
        return 0;
    }
  }

  private estimateImageTokens(image: ImageContent): number {
    if ('detail' in image && image.detail === 'low') return 85;
    const w = image.width ?? 1024;
    const h = image.height ?? 1024;
    const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
    return tiles * 170 + 85;
  }

  private estimateAudioTokens(audio: AudioContent): number {
    if (audio.durationMs && audio.durationMs > 0) {
      return Math.ceil((audio.durationMs / 1000) * WHISPER_TOKENS_PER_SECOND);
    }
    if (audio.sizeBytes > 0) {
      const estimatedSeconds = audio.sizeBytes / BYTES_PER_SECOND_AUDIO;
      return Math.ceil(estimatedSeconds * WHISPER_TOKENS_PER_SECOND);
    }
    return Math.ceil(audio.sizeBytes / 4);
  }

  private estimateVideoTokens(video: VideoContent): number {
    const framesPerSecond = 1;
    if (video.durationMs && video.durationMs > 0) {
      const frameCount = Math.ceil((video.durationMs / 1000) * framesPerSecond);
      const w = video.width ?? 1024;
      const h = video.height ?? 1024;
      const tiles = Math.ceil(w / 512) * Math.ceil(h / 512);
      return frameCount * (tiles * 170 + 85);
    }
    return Math.ceil(video.sizeBytes / 4);
  }

  private estimateFileTokens(file: FileContent): number {
    if ('textContent' in file && file.textContent) {
      return Math.ceil(file.textContent.length / 4);
    }
    return Math.ceil(file.sizeBytes / 4);
  }

  clearCache(): void {
    this.cache.clear();
  }

  private fromBytes(input: MediaInput): NormalizedMedia {
    const mimeType = input.mimeType ?? 'image/jpeg';
    const base64 = Buffer.from(input.bytes!).toString('base64');
    return this.buildContent(
      input.type,
      mimeType,
      'base64',
      base64,
      input.bytes!.length,
      input.filename
    );
  }

  private async fromFile(input: MediaInput): Promise<NormalizedMedia> {
    const bytes = await readFile(input.filePath!);
    const mimeType = input.mimeType ?? this.guessMimeFromPath(input.filePath!);
    const base64 = bytes.toString('base64');
    return this.buildContent(
      input.type,
      mimeType,
      'base64',
      base64,
      bytes.length,
      input.filename
    );
  }

  private fromBase64(input: MediaInput): NormalizedMedia {
    const mimeType = input.mimeType ?? detectMimeFromBase64(input.data!);
    const sizeBytes = estimateBase64Size(input.data!);
    return this.buildContent(
      input.type,
      mimeType,
      'base64',
      input.data!,
      sizeBytes,
      input.filename
    );
  }

  private fromUrl(input: MediaInput): NormalizedMedia {
    const mimeType = input.mimeType ?? 'image/jpeg';
    return this.buildContent(
      input.type,
      mimeType,
      'url',
      input.url!,
      0,
      input.filename
    );
  }

  private fromFileId(input: MediaInput): NormalizedMedia {
    const mimeType = input.mimeType ?? 'image/jpeg';
    return this.buildContent(
      input.type,
      mimeType,
      'file_id',
      input.fileId!,
      0,
      input.filename
    );
  }

  private buildContent(
    type: string,
    mimeType: string,
    source: MediaSource,
    data: string,
    sizeBytes: number,
    filename?: string
  ): NormalizedMedia {
    switch (type) {
      case 'image':
        return {
          type: 'image',
          mimeType,
          source,
          data,
          sizeBytes,
        } as ImageContent;
      case 'audio':
        return {
          type: 'audio',
          mimeType,
          source,
          data,
          sizeBytes,
        } as AudioContent;
      case 'video':
        return {
          type: 'video',
          mimeType,
          source,
          data,
          sizeBytes,
        } as VideoContent;
      case 'file':
        return {
          type: 'file',
          mimeType,
          source,
          data,
          sizeBytes,
          filename,
        } as FileContent;
      default:
        throw new Error(`Unsupported media type: ${type}`);
    }
  }

  private supportedMimesFor(type: string): readonly string[] | undefined {
    switch (type) {
      case 'image':
        return SUPPORTED_IMAGE_MIMES;
      case 'audio':
        return SUPPORTED_AUDIO_MIMES;
      case 'video':
        return SUPPORTED_VIDEO_MIMES;
      case 'file':
        return SUPPORTED_FILE_MIMES;
      default:
        return undefined;
    }
  }

  private guessMimeFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      mp4: 'video/mp4',
      webm: 'video/webm',
      pdf: 'application/pdf',
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
    };
    return map[ext ?? ''] ?? 'image/jpeg';
  }

  private async reencodeImage(
    _media: ImageContent,
    _options: { quality: number; width?: number; height?: number }
  ): Promise<string> {
    return _media.data;
  }
}
