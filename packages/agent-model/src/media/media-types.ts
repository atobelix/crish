import type { AgentMessageBlock } from '@crish/shared-types';

export type MediaSource = 'base64' | 'url' | 'file_id';
export type MediaType = 'image' | 'audio' | 'video' | 'file';
export type ProviderFamily =
  'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini' | 'bedrock';

export const SUPPORTED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
] as const;

export const SUPPORTED_AUDIO_MIMES = [
  'audio/wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/flac',
  'audio/webm',
] as const;

export const SUPPORTED_VIDEO_MIMES = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
] as const;

export const SUPPORTED_FILE_MIMES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
] as const;

export const DEFAULT_MAX_MEDIA_SIZE_BYTES = 20 * 1024 * 1024;

// ─── Media Input ───

export interface BaseMediaInput {
  type: MediaType;
  source: MediaSource;
  data?: string;
  url?: string;
  fileId?: string;
  mimeType?: string;
  bytes?: Uint8Array;
  filePath?: string;
  filename?: string;
}

export type MediaInput = BaseMediaInput;

// ─── Normalized Media Content ───

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

export interface AudioContent {
  type: 'audio';
  mimeType: string;
  source: MediaSource;
  data: string;
  durationMs?: number;
  sizeBytes: number;
}

export interface VideoContent {
  type: 'video';
  mimeType: string;
  source: MediaSource;
  data: string;
  durationMs?: number;
  width?: number;
  height?: number;
  sizeBytes: number;
}

export interface FileContent {
  type: 'file';
  mimeType: string;
  source: MediaSource;
  data: string;
  filename?: string;
  textContent?: string;
  sizeBytes: number;
}

export type NormalizedMedia =
  ImageContent | AudioContent | VideoContent | FileContent;

// ─── Video Frame ───

export interface VideoFrame {
  timestampMs: number;
  mimeType: string;
  data: string;
  width: number;
  height: number;
}

// ─── Compression & Validation Options ───

export interface ImageCompressOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

export interface MediaValidateOptions {
  maxSizeBytes?: number;
  allowedMimeTypes?: readonly string[];
}

// ─── Tool Result Media Handling ───

export interface ToolResultMediaOutput {
  type: 'inline' | 'split';
  blocks: AgentMessageBlock[];
  mediaMessages?: Array<{ role: 'user'; content: AgentMessageBlock[] }>;
}

// ─── MIME helpers ───

export function mimeCategory(mime: string): MediaType | 'unknown' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || mime.startsWith('application/'))
    return 'file';
  return 'unknown';
}

export function detectMimeFromBase64(base64: string): string {
  if (base64.startsWith('/9j')) return 'image/jpeg';
  if (base64.startsWith('iVBOR')) return 'image/png';
  if (base64.startsWith('R0lGOD')) return 'image/gif';
  if (base64.startsWith('UklGR')) return 'image/webp';
  return 'image/jpeg';
}

export function estimateBase64Size(base64: string): number {
  return Math.ceil((base64.length * 3) / 4);
}
